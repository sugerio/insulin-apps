// Plays the hosting gateway for tests that drive Esign as a host product does. A host's key, kept
// in the test gateway's `api_keys` table (platform.ts), stands for a service account of its
// organization: a request with `Authorization: Bearer <key>` reaches the app as that organization's
// ADMIN identity (x-suger-* headers, `x-suger-access-via: api`), without the key, as the gateway
// forwards a real service-account token. A request on one of the declared public paths reaches the
// app as production's gateway sends it: Authorization dropped, x-suger-* stripped, marked public.
// The organizations' `editor_origins_json` stand for ESIGN_FRAME_ANCESTORS when a test doesn't set it.
import { readFileSync } from 'node:fs';
import './platform.ts';
import app, { type Bindings } from '../../src/app/server/esign/app.ts';
import { validEditorOrigin } from '../../src/app/server/esign/access.ts';

const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (n) => n.toString(16).padStart(2, '0')).join('');

async function hostTenant(db: D1Database, request: Request): Promise<string | null> {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('authorization') ?? '');
  if (!match) return null;
  try {
    const row = await db.prepare('SELECT tenant_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').bind(await sha256(match[1]!)).first<{ tenant_id: string }>();
    return row?.tenant_id ?? null;
  } catch {
    return null;
  }
}

async function editorOrigins(db: D1Database): Promise<string> {
  try {
    const { results } = await db.prepare('SELECT editor_origins_json FROM tenants').all<{ editor_origins_json: string }>();
    // Only entries that are bare origins, as the setting holds: anything else in the list never matches.
    return [...new Set(results.flatMap((row) => (JSON.parse(row.editor_origins_json) as unknown[]).filter((o): o is string => typeof o === 'string' && validEditorOrigin(o))))].join(' ');
  } catch {
    return '';
  }
}

/** The public paths Esign declares in package.json `insulin.publicPaths`. */
const PUBLIC_PATHS: string[] = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { insulin: { publicPaths: string[] } }).insulin.publicPaths;

/** Whether the gateway treats a path as public: the entry itself, or below it (an entry ending in / matches below only). */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((entry) => pathname === entry || (entry.endsWith('/') ? pathname.startsWith(entry) : pathname.startsWith(`${entry}/`)));
}

export default {
  async fetch(request: Request, env: Partial<Bindings> & { DB: D1Database }): Promise<Response> {
    // A test that sends the platform identity itself keeps it.
    const headers = new Headers(request.headers);
    // As the production gateway does on a public path: no identity at all, whatever the request sent. Authorization is
    // dropped and every x-suger-* header stripped, so a page session travels only in Esign's own x-esign-session.
    if (isPublicPath(new URL(request.url).pathname)) {
      headers.delete('authorization');
      for (const name of [...headers.keys()]) if (name.startsWith('x-suger-')) headers.delete(name);
      headers.set('x-suger-access-via', 'public');
      const ancestors = env.SIGNING_PAGE_FRAME_ANCESTORS ?? await editorOrigins(env.DB);
      const bindings = { ...env, APP_ORIGIN: env.APP_ORIGIN ?? new URL(request.url).origin, ...(ancestors ? { SIGNING_PAGE_FRAME_ANCESTORS: ancestors } : {}) } as Bindings;
      return app.fetch(new Request(request, { headers }), bindings);
    }
    const tenant = await hostTenant(env.DB, request);
    if (tenant) {
      headers.delete('authorization');
      headers.set('x-suger-user-id', `service-account-${tenant}`);
      headers.set('x-suger-organization-id', tenant);
      headers.set('x-suger-app-id', 'insulin-apps-esign');
      headers.set('x-suger-app-role', 'ADMIN');
      headers.set('x-suger-user-email', encodeURIComponent(`service-account-${tenant}@service-accounts.invalid`));
      headers.set('x-suger-user-name', encodeURIComponent('Host product'));
      headers.set('x-suger-access-via', 'api');
    }
    const ancestors = env.SIGNING_PAGE_FRAME_ANCESTORS ?? await editorOrigins(env.DB);
    const bindings = { ...env, APP_ORIGIN: env.APP_ORIGIN ?? new URL(request.url).origin, ...(ancestors ? { SIGNING_PAGE_FRAME_ANCESTORS: ancestors } : {}) } as Bindings;
    return app.fetch(new Request(request, { headers }), bindings);
  },
};
