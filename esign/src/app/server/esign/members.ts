import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './app.ts';
import { can, type Caller } from './identity.ts';
import { emailKey, isClient, ownerSummary, shareableEmail } from './ownership.ts';
import { unknownKeys } from './metadata.ts';

/**
 * The organization's members and API clients as Esign has seen them (`members`). Esign has no
 * directory of its own: the platform tells it who calls, at each request, and nothing else. So each
 * caller is recorded as they use Esign, which is how a document's owner is shown by name, how people
 * are found to share with, how an organization owner finds whose documents to take over, and how an
 * API client shows up in Esign's settings to be given someone to share its documents with.
 *
 * - `/api/members`: people to share with.
 * - `/api/owners` and its transfer: an organization owner takes over everything someone owns (someone
 *   who left, or an API client), becoming its owner. Nobody else's role in those documents changes.
 * - `/api/api-clients`: an organization's owners and admins choose, for each API client, one person its
 *   new documents are shared with as admin (`api_clients`). Without one, they are the client's alone.
 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const MAX_QUERY = 100;

/** Records the caller: added the first time, refreshed when what the platform says of them changed or after an hour. */
export function recordMember(db: D1Database, tenantId: string, caller: Caller, now: number): Promise<unknown> {
  const client = isClient(caller);
  const email = client ? null : caller.email;
  return db.prepare(`INSERT INTO members (tenant_id, user_id, kind, email, email_key, name, org_role, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET kind = excluded.kind, email = excluded.email, email_key = excluded.email_key, name = excluded.name, org_role = excluded.org_role, last_seen_at = excluded.last_seen_at
      WHERE members.last_seen_at < ?9 OR members.email IS NOT excluded.email OR members.name IS NOT excluded.name OR members.org_role IS NOT excluded.org_role OR members.kind IS NOT excluded.kind`)
    .bind(tenantId, caller.userId, client ? 'client' : 'person', email, email ? emailKey(email) : null, caller.name, caller.role, now, now - TOUCH_INTERVAL_MS).run();
}

const likeContaining = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** An organization owner, or owner or admin, who may also manage Esign (a custom role that only views may not). */
const orgOwner = (caller: Caller) => caller.role === 'OWNER' && can(caller, 'esign.manage');
const orgAdmin = (caller: Caller) => (caller.role === 'OWNER' || caller.role === 'ADMIN') && can(caller, 'esign.manage');

export function mountMemberRoutes(app: Hono<Env>) {
  // People to share with: members seen in Esign whose name or email contains `q`, most recently seen first.
  app.get('/api/members', async (context) => {
    const limit = context.req.query('limit') === undefined ? 20 : Number(context.req.query('limit'));
    const q = (context.req.query('q') ?? '').trim();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || q.length > MAX_QUERY) return context.json({ error: 'invalid_query' }, 400);
    const pattern = q ? likeContaining(q.toLowerCase()) : null;
    const { results } = await context.env.DB.prepare(`SELECT user_id, email, name FROM members WHERE tenant_id = ? AND kind = 'person' AND email IS NOT NULL
        AND (? IS NULL OR email_key LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\') ORDER BY last_seen_at DESC, user_id LIMIT ?`)
      .bind(context.get('tenantId'), pattern, pattern, pattern, limit).all<{ user_id: string; email: string; name: string | null }>();
    return context.json({ members: results.map((row) => ({ id: row.user_id, email: row.email, ...(row.name ? { name: row.name } : {}) })) });
  });

  // Everyone who owns templates or envelopes, with how many: for an organization owner to take some over.
  app.get('/api/owners', async (context) => {
    if (!orgOwner(context.get('caller'))) return context.json({ error: 'forbidden' }, 403);
    const tenantId = context.get('tenantId');
    const { results } = await context.env.DB.prepare(`SELECT o.owner_user_id, sum(o.templates) AS templates, sum(o.envelopes) AS envelopes, m.kind, m.email, m.name, m.last_seen_at
        FROM (SELECT owner_user_id, count(*) AS templates, 0 AS envelopes FROM templates WHERE tenant_id = ?1 AND archived_at IS NULL GROUP BY owner_user_id
              UNION ALL SELECT owner_user_id, 0, count(*) FROM envelopes WHERE tenant_id = ?1 GROUP BY owner_user_id) o
        LEFT JOIN members m ON m.tenant_id = ?1 AND m.user_id = o.owner_user_id
        GROUP BY o.owner_user_id ORDER BY m.name IS NULL, lower(m.name), o.owner_user_id`)
      .bind(tenantId).all<{ owner_user_id: string; templates: number; envelopes: number; kind: string | null; email: string | null; name: string | null; last_seen_at: number | null }>();
    return context.json({
      owners: results.map((row) => ({ ...ownerSummary(row.owner_user_id, row.kind ? { kind: row.kind, email: row.email, name: row.name } : null), templates: row.templates, envelopes: row.envelopes, ...(row.last_seen_at == null ? {} : { lastSeenAt: row.last_seen_at }) })),
    });
  });

  // An organization owner takes over every template and envelope someone owns. Shares stay as they are,
  // but the new owner's own (they now own those documents).
  app.post('/api/owners/:id/transfer', async (context) => {
    const caller = context.get('caller');
    if (!orgOwner(caller)) return context.json({ error: 'forbidden' }, 403);
    const from = context.req.param('id'), tenantId = context.get('tenantId'), db = context.env.DB;
    if (from === caller.userId) return context.json({ error: 'already_owner' }, 422);
    const own = caller.email ? emailKey(caller.email) : null;
    const [, , templates, envelopes] = await db.batch([
      db.prepare("DELETE FROM document_shares WHERE tenant_id = ?1 AND grantee_email_key = ?2 AND resource_type = 'template' AND resource_id IN (SELECT id FROM templates WHERE tenant_id = ?1 AND owner_user_id = ?3)").bind(tenantId, own, from),
      db.prepare("DELETE FROM document_shares WHERE tenant_id = ?1 AND grantee_email_key = ?2 AND resource_type = 'envelope' AND resource_id IN (SELECT id FROM envelopes WHERE tenant_id = ?1 AND owner_user_id = ?3)").bind(tenantId, own, from),
      db.prepare('UPDATE templates SET owner_user_id = ? WHERE tenant_id = ? AND owner_user_id = ?').bind(caller.userId, tenantId, from),
      db.prepare('UPDATE envelopes SET owner_user_id = ? WHERE tenant_id = ? AND owner_user_id = ?').bind(caller.userId, tenantId, from),
    ]);
    if (!templates.meta.changes && !envelopes.meta.changes) return context.json({ error: 'not_found' }, 404);
    return context.json({ from, to: caller.userId, templates: templates.meta.changes, envelopes: envelopes.meta.changes });
  });

  // The API clients that have called Esign, each with whom its documents are shared, if anyone.
  app.get('/api/api-clients', async (context) => {
    if (!orgAdmin(context.get('caller'))) return context.json({ error: 'forbidden' }, 403);
    const { results } = await context.env.DB.prepare(`SELECT m.user_id, m.name, m.first_seen_at, m.last_seen_at, a.share_email, a.updated_at,
        (SELECT p.name FROM members p WHERE p.tenant_id = m.tenant_id AND p.email_key = a.share_email_key AND p.kind = 'person' ORDER BY p.last_seen_at DESC LIMIT 1) AS share_name
        FROM members m LEFT JOIN api_clients a ON a.tenant_id = m.tenant_id AND a.client_user_id = m.user_id
        WHERE m.tenant_id = ? AND m.kind = 'client' ORDER BY m.last_seen_at DESC, m.user_id`)
      .bind(context.get('tenantId')).all<{ user_id: string; name: string | null; first_seen_at: number; last_seen_at: number; share_email: string | null; updated_at: number | null; share_name: string | null }>();
    return context.json({
      clients: results.map((row) => ({
        id: row.user_id, ...(row.name ? { name: row.name } : {}), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
        ...(row.share_email ? { shareWith: { email: row.share_email, ...(row.share_name ? { name: row.share_name } : {}), since: row.updated_at } } : {}),
      })),
    });
  });

  // Sets whom an API client's new documents are shared with, as admin (`shareEmail`, or null for nobody); with
  // `shareExisting`, also those it already owns (a lower share of that person's is raised to admin).
  app.post('/api/api-clients/:id', bodyLimit({ maxSize: 4096 }), async (context) => {
    const caller = context.get('caller');
    if (!orgAdmin(caller)) return context.json({ error: 'forbidden' }, 403);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_client' }, 422);
    const unknown = unknownKeys(body, ['shareEmail', 'shareExisting']);
    if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
    const { shareEmail, shareExisting } = body as { shareEmail?: unknown; shareExisting?: unknown };
    if ((shareEmail !== null && !shareableEmail(shareEmail)) || (shareExisting !== undefined && typeof shareExisting !== 'boolean')) return context.json({ error: 'invalid_client' }, 422);
    const tenantId = context.get('tenantId'), id = context.req.param('id'), db = context.env.DB, now = Date.now();
    if (!await db.prepare("SELECT 1 FROM members WHERE tenant_id = ? AND user_id = ? AND kind = 'client'").bind(tenantId, id).first()) return context.json({ error: 'not_found' }, 404);
    if (shareEmail === null) {
      await db.prepare('DELETE FROM api_clients WHERE tenant_id = ? AND client_user_id = ?').bind(tenantId, id).run();
      return context.json({ id, shared: 0 });
    }
    const email = (shareEmail as string).trim(), key = emailKey(email);
    const statements = [db.prepare(`INSERT INTO api_clients (tenant_id, client_user_id, share_email, share_email_key, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, client_user_id) DO UPDATE SET share_email = excluded.share_email, share_email_key = excluded.share_email_key, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(tenantId, id, email, key, caller.userId, now)];
    if (shareExisting) for (const [type, table] of [['template', 'templates'], ['envelope', 'envelopes']] as const) {
      statements.push(db.prepare(`INSERT INTO document_shares (tenant_id, resource_type, resource_id, grantee_email_key, grantee_email, role, granted_by, granted_at)
          SELECT ?1, '${type}', id, ?2, ?3, 'admin', ?4, ?5 FROM ${table} WHERE tenant_id = ?1 AND owner_user_id = ?6
          ON CONFLICT (resource_type, resource_id, grantee_email_key) DO UPDATE SET role = 'admin'`)
        .bind(tenantId, key, email, caller.userId, now, id));
    }
    const results = await db.batch(statements);
    return context.json({ id, shareWith: { email }, shared: results.slice(1).reduce((n, r) => n + r.meta.changes, 0) });
  });
}
