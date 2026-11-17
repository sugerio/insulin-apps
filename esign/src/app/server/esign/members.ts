import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './app.ts';
import { can, type Caller } from './identity.ts';
import { DIRECTORY_MAX, directoryMembers } from './directory.ts';
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
 * - `/api/client-settings/{id}`: for each OAuth client, the people who see everything it owns, as admin
 *   (`api_client_people`, ownership.ts). The page that sets them (`/client-settings/{id}`, package.json
 *   `insulin.clientSettings`) is reached only from the platform's API access page. Organization owners and admins, in
 *   the browser. Without anyone, what a client creates is its own alone.
 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** The most people an API client's documents are seen by (`/api/client-settings`). */
export const MAX_CLIENT_PEOPLE = 50;
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
/**
 * An organization owner, or owner or admin (x-suger-org-role, identity.ts: an Admin of Esign by grant is neither), who
 * may also manage Esign (a custom role that only views may not).
 */
export const orgOwner = (caller: Caller) => caller.orgRole === 'OWNER' && can(caller, 'esign.manage');
const orgAdmin = (caller: Caller) => (caller.orgRole === 'OWNER' || caller.orgRole === 'ADMIN') && can(caller, 'esign.manage');

export function mountMemberRoutes(app: Hono<Env>) {
  // People to share with: the organization's people who can use Esign, as the platform says (directory.ts), whose name
  // or email contains `q`; else, when the platform can't be asked, those Esign has seen, most recently seen first.
  app.get('/api/members', async (context) => {
    const limit = context.req.query('limit') === undefined ? 20 : Number(context.req.query('limit'));
    const q = (context.req.query('q') ?? '').trim();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || q.length > MAX_QUERY) return context.json({ error: 'invalid_query' }, 400);
    const directory = await directoryMembers(context.env, context.get('tenantId'), { q, limit });
    // Who they are, not their roles, which only the scheduled sends' check reads (scheduled-send.ts).
    if (directory) return context.json({ members: directory.map(({ id, email, name }) => ({ id, email, ...(name ? { name } : {}) })) });
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

  // Esign's page for one OAuth client (package.json `insulin.clientSettings`, linked from the platform's API access page
  // with the client's service account id, the `x-suger-user-id` its calls carry, and its name). A client that hasn't
  // called Esign yet is recorded here, with that name, so that it is named as an owner from the start; an id Esign knows
  // as a person's is not a client's (404).
  const settingsCaller = (context: import('hono').Context<Env>) => {
    const caller = context.get('caller');
    return orgAdmin(caller) && caller.accessVia === 'browser' ? caller : null;
  };
  const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
  const clientSettings = async (db: D1Database, tenantId: string, id: string) => {
    const client = await db.prepare("SELECT name FROM members WHERE tenant_id = ? AND user_id = ? AND kind = 'client'").bind(tenantId, id).first<{ name: string | null }>();
    const { results } = await db.prepare(`SELECT p.email,
        (SELECT m.name FROM members m WHERE m.tenant_id = p.tenant_id AND m.email_key = p.email_key AND m.kind = 'person' ORDER BY m.last_seen_at DESC LIMIT 1) AS name
        FROM api_client_people p WHERE p.tenant_id = ? AND p.client_user_id = ? ORDER BY p.added_at, p.email_key`).bind(tenantId, id).all<{ email: string; name: string | null }>();
    return { id, ...(client?.name ? { name: client.name } : {}), people: results.map((row) => ({ email: row.email, ...(row.name ? { name: row.name } : {}) })) };
  };
  app.get('/api/client-settings/:id', async (context) => {
    const caller = settingsCaller(context), id = context.req.param('id'), tenantId = context.get('tenantId'), db = context.env.DB;
    if (!caller) return context.json({ error: 'forbidden' }, 403);
    if (!CLIENT_ID.test(id)) return context.json({ error: 'not_found' }, 404);
    const known = await db.prepare('SELECT kind FROM members WHERE tenant_id = ? AND user_id = ?').bind(tenantId, id).first<{ kind: string }>();
    if (known && known.kind !== 'client') return context.json({ error: 'not_found' }, 404);
    if (!known) {
      const name = (context.req.query('name') ?? '').trim().slice(0, 200) || null, now = Date.now();
      await db.prepare(`INSERT INTO members (tenant_id, user_id, kind, email, email_key, name, org_role, first_seen_at, last_seen_at) VALUES (?, ?, 'client', NULL, NULL, ?, '', ?, ?)
          ON CONFLICT (tenant_id, user_id) DO NOTHING`).bind(tenantId, id, name, now, now).run();
    }
    return context.json(await clientSettings(db, tenantId, id));
  });
  // Saves the people for one OAuth client, `{people: [email]}`: the whole list, replacing the one before.
  app.post('/api/client-settings/:id', bodyLimit({ maxSize: 16384 }), async (context) => {
    const caller = settingsCaller(context), id = context.req.param('id'), tenantId = context.get('tenantId'), db = context.env.DB;
    if (!caller) return context.json({ error: 'forbidden' }, 403);
    if (!CLIENT_ID.test(id)) return context.json({ error: 'not_found' }, 404);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_people' }, 422);
    const unknown = unknownKeys(body, ['people']);
    if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
    const people = (body as { people?: unknown }).people;
    if (!Array.isArray(people) || people.length > MAX_CLIENT_PEOPLE || people.some((email) => !shareableEmail(email))) return context.json({ error: 'invalid_people' }, 422);
    if (!await db.prepare("SELECT 1 FROM members WHERE tenant_id = ? AND user_id = ? AND kind = 'client'").bind(tenantId, id).first()) return context.json({ error: 'not_found' }, 404);
    // Only people who can use Esign, as the platform says (directory.ts); when it can't be asked, people Esign has seen.
    let outside = people as string[], answered = false;
    const directory = outside.length ? await directoryMembers(context.env, tenantId) : null;
    if (directory) {
      const allowed = new Set(directory.map((m) => emailKey(m.email)));
      outside = outside.filter((email) => !allowed.has(emailKey(email)));
      answered = true;
      // An organization larger than one answer: those it left out, asked for by email.
      if (outside.length && directory.length >= DIRECTORY_MAX) {
        const found = await Promise.all(outside.map((email) => directoryMembers(context.env, tenantId, { q: email.trim().slice(0, 100), limit: 20 })));
        if (found.some((members) => members === null)) answered = false;
        else outside = outside.filter((email, i) => !found[i]!.some((m) => emailKey(m.email) === emailKey(email)));
      }
    }
    if (outside.length && !answered) {
      const { results } = await db.prepare("SELECT email_key FROM members WHERE tenant_id = ? AND kind = 'person' AND email_key IN (SELECT value FROM json_each(?))")
        .bind(tenantId, JSON.stringify(outside.map(emailKey))).all<{ email_key: string }>();
      const seen = new Set(results.map((row) => row.email_key));
      outside = outside.filter((email) => !seen.has(emailKey(email)));
    }
    if (outside.length) return context.json({ error: 'not_members', emails: outside }, 422);
    const byKey = new Map<string, string>();
    for (const email of people as string[]) if (!byKey.has(emailKey(email))) byKey.set(emailKey(email), email.trim());
    const now = Date.now();
    await db.batch([
      db.prepare('DELETE FROM api_client_people WHERE tenant_id = ? AND client_user_id = ?').bind(tenantId, id),
      ...[...byKey].map(([key, email]) => db.prepare('INSERT INTO api_client_people (tenant_id, client_user_id, email_key, email, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)').bind(tenantId, id, key, email, caller.userId, now)),
    ]);
    return context.json(await clientSettings(db, tenantId, id));
  });
}
