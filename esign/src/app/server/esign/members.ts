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
 * are found to share with, and how an organization owner finds whose documents to take over.
 *
 * - `/api/members`: people to share with.
 * - `/api/owners` and its transfer: an organization owner takes over everything someone owns (someone
 *   who left, or an API client), becoming its owner. Nobody else's role in those documents changes.
 * - `/api/client-settings/{id}`: the platform's API access page shows, for each OAuth client, the people who see
 *   everything it owns, as admin (`api_client_people`, ownership.ts), and saves them (package.json
 *   `insulin.clientSettings`). Only organization owners and admins, in the browser. Without anyone, what a client
 *   creates is its own alone.
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

  // The platform's API access page (package.json `insulin.clientSettings`): for one OAuth client (its service account
  // id, the `x-suger-user-id` its calls carry), the section the page shows and saves. The client may not have called
  // Esign yet: it is recorded here, with the name the page gives, so that it is named as an owner from the start.
  const settingsCaller = (context: import('hono').Context<Env>) => {
    const caller = context.get('caller');
    return orgAdmin(caller) && caller.accessVia === 'browser' ? caller : null;
  };
  const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
  app.get('/api/client-settings/:id', async (context) => {
    const caller = settingsCaller(context), id = context.req.param('id'), tenantId = context.get('tenantId'), db = context.env.DB;
    if (!caller) return context.json({ error: 'forbidden' }, 403);
    if (!CLIENT_ID.test(id)) return context.json({ error: 'not_found' }, 404);
    const name = (context.req.query('name') ?? '').trim().slice(0, 200) || null, now = Date.now();
    const known = await db.prepare('SELECT kind FROM members WHERE tenant_id = ? AND user_id = ?').bind(tenantId, id).first<{ kind: string }>();
    if (known && known.kind !== 'client') return context.json({ error: 'not_found' }, 404);
    if (!known) await db.prepare(`INSERT INTO members (tenant_id, user_id, kind, email, email_key, name, org_role, first_seen_at, last_seen_at) VALUES (?, ?, 'client', NULL, NULL, ?, '', ?, ?)
        ON CONFLICT (tenant_id, user_id) DO NOTHING`).bind(tenantId, id, name, now, now).run();
    const { results } = await db.prepare('SELECT email FROM api_client_people WHERE tenant_id = ? AND client_user_id = ? ORDER BY added_at, email_key').bind(tenantId, id).all<{ email: string }>();
    return context.json({
      title: 'Who sees what it creates',
      description: 'Everything this client creates in Esign, templates and envelopes, is seen by these people, as admins, for as long as they are chosen here. Without anyone, only the client sees it.',
      status: results.length ? `Seen by ${results.length} ${results.length === 1 ? 'person' : 'people'}` : 'Seen by the client only',
      fields: [{ name: 'people', type: 'members', label: 'Share with', value: results.map((row) => row.email) }],
    });
  });
  // Saves the people for one OAuth client: the whole list, replacing the one before.
  app.post('/api/client-settings/:id', bodyLimit({ maxSize: 16384 }), async (context) => {
    const caller = settingsCaller(context), id = context.req.param('id'), tenantId = context.get('tenantId'), db = context.env.DB;
    if (!caller) return context.json({ error: 'forbidden' }, 403);
    if (!CLIENT_ID.test(id)) return context.json({ error: 'not_found' }, 404);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
    const values = (body as { values?: unknown } | null)?.values;
    if (!body || typeof body !== 'object' || Array.isArray(body) || unknownKeys(body, ['values']).length || !values || typeof values !== 'object' || Array.isArray(values) || unknownKeys(values, ['people']).length) return context.json({ message: 'Unexpected settings.' }, 422);
    const people = (values as { people?: unknown }).people ?? [];
    if (!Array.isArray(people) || people.length > 50 || people.some((email) => !shareableEmail(email))) return context.json({ errors: { people: 'Choose at most 50 people, by their email address.' } }, 422);
    const known = await db.prepare('SELECT kind FROM members WHERE tenant_id = ? AND user_id = ?').bind(tenantId, id).first<{ kind: string }>();
    if (!known || known.kind !== 'client') return context.json({ error: 'not_found' }, 404);
    const byKey = new Map((people as string[]).map((email) => [emailKey(email), email.trim()]));
    const now = Date.now();
    await db.batch([
      db.prepare('DELETE FROM api_client_people WHERE tenant_id = ? AND client_user_id = ?').bind(tenantId, id),
      ...[...byKey].map(([key, email]) => db.prepare('INSERT INTO api_client_people (tenant_id, client_user_id, email_key, email, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)').bind(tenantId, id, key, email, caller.userId, now)),
    ]);
    return context.json({ notice: byKey.size ? `Everything this client creates is seen by ${byKey.size} ${byKey.size === 1 ? 'person' : 'people'}, as admins.` : 'Only the client sees what it creates.' });
  });
  // The OAuth client was deleted on the platform: its list goes too. Its documents stay, with their owner.
  app.delete('/api/client-settings/:id', async (context) => {
    const caller = settingsCaller(context), id = context.req.param('id');
    if (!caller) return context.json({ error: 'forbidden' }, 403);
    if (!CLIENT_ID.test(id)) return context.json({ error: 'not_found' }, 404);
    await context.env.DB.prepare('DELETE FROM api_client_people WHERE tenant_id = ? AND client_user_id = ?').bind(context.get('tenantId'), id).run();
    return context.body(null, 204);
  });
}
