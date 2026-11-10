/**
 * Tenant provisioning for the host application. E-sign has one host today; each of its
 * organizations is one tenant whose id is the host's organization id, with its own management
 * key. Instead of provisioning each tenant by hand (scripts/provision-tenant.ts), the host asks
 * for a tenant's key the first time that organization uses E-sign:
 *
 *   POST /v1/tenants  Authorization: Bearer <PROVISIONING_KEY>  {"tenantId": "<org id>"}
 *   → 201 {"tenantId", "apiKey"}   the key, returned this once (only its SHA-256 is kept)
 *
 * - The provisioning key (Worker secret PROVISIONING_KEY, at least 32 characters) can only create
 *   tenants and issue their first key. It reads nothing, and cannot take over a tenant in use:
 *   for a tenant that already has a template, an envelope or an editing session the answer is
 *   409 tenant_in_use. Without the secret the route does not exist (404).
 * - A tenant with no data yet may be asked for again: its earlier keys are revoked and a new one
 *   is issued. That recovers a host that lost the response before saving the key. The host must
 *   not ask concurrently for one tenant (it serializes per organization): the second answer would
 *   revoke the key the first one returned.
 * - The tenant's editor origins are the origins allowed to embed the signing page
 *   (SIGNING_PAGE_FRAME_ANCESTORS): the host's consoles.
 */
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { validEditorOrigin } from './access.ts';
import { isProd } from './environment.ts';
import { frameAncestors } from './signing-page.ts';

/** A tenant id: the host's organization id. */
export const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_PROVISIONING_KEY = 32;

export type ProvisioningEnv = {
  DB: D1Database;
  PROVISIONING_KEY?: string;
  SIGNING_PAGE_FRAME_ANCESTORS?: string;
  ESIGN_ENV?: string;
};

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
const sha256 = async (value: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

/** Whether the bearer token is the provisioning key: compared by SHA-256, in constant time. */
async function isProvisioningKey(authorization: string, key: string): Promise<boolean> {
  const match = /^Bearer (\S{1,512})$/.exec(authorization);
  if (!match) return false;
  const [given, expected] = await Promise.all([sha256(match[1]), sha256(key)]);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** A new management key: 32 random bytes, hex. */
function newKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes.buffer);
}

/** SQL: tenant `?` has no template, envelope or editing session yet. */
const UNUSED = `NOT EXISTS (SELECT 1 FROM templates WHERE tenant_id=?1)
  AND NOT EXISTS (SELECT 1 FROM envelopes WHERE tenant_id=?1)
  AND NOT EXISTS (SELECT 1 FROM editor_sessions WHERE tenant_id=?1)`;

/**
 * Creates the tenant (when new) and issues its key, in one batch: the tenant row, then, only
 * while the tenant has no data, its earlier keys revoked and the new key added. Returns the key,
 * or null when the tenant is in use.
 */
export async function provisionTenant(db: D1Database, tenantId: string, editorOrigins: string[], now: number): Promise<string | null> {
  if (!TENANT_ID.test(tenantId)) throw new Error('invalid tenant id');
  if (!editorOrigins.every(validEditorOrigin)) throw new Error('invalid editor origin');
  const key = newKey();
  const results = await db.batch([
    db.prepare('INSERT INTO tenants (id, editor_origins_json) VALUES (?, ?) ON CONFLICT (id) DO NOTHING').bind(tenantId, JSON.stringify(editorOrigins)),
    db.prepare(`UPDATE api_keys SET revoked_at=?2 WHERE tenant_id=?1 AND revoked_at IS NULL AND ${UNUSED}`).bind(tenantId, now),
    db.prepare(`INSERT INTO api_keys (key_hash, tenant_id) SELECT ?2, ?1 WHERE ${UNUSED}`).bind(tenantId, await sha256(key)),
  ]);
  return results[2].meta.changes === 1 ? key : null;
}

// biome-ignore lint/suspicious/noExplicitAny: mounted on the Worker's app, whose bindings include ProvisioningEnv
export function mountTenantProvisioning(app: Hono<any>): void {
  app.post('/v1/tenants', bodyLimit({ maxSize: 1024 }), async (c) => {
    const env = c.env as ProvisioningEnv;
    const key = env.PROVISIONING_KEY ?? '';
    if (key.length < MIN_PROVISIONING_KEY) return c.notFound();
    if (!(await isProvisioningKey(c.req.header('authorization') ?? '', key))) return c.json({ error: 'unauthorized' }, 401);
    let body: { tenantId?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request' }, 400); }
    const tenantId = typeof body?.tenantId === 'string' ? body.tenantId : '';
    if (!TENANT_ID.test(tenantId)) return c.json({ error: 'invalid_tenant_id' }, 400);
    const origins = frameAncestors(env.SIGNING_PAGE_FRAME_ANCESTORS, isProd(env)).filter(validEditorOrigin);
    const apiKey = await provisionTenant(env.DB, tenantId, origins, Date.now());
    c.header('Cache-Control', 'no-store');
    return apiKey ? c.json({ tenantId, apiKey }, 201) : c.json({ error: 'tenant_in_use' }, 409);
  });
}
