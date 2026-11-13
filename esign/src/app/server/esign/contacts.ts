import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './app.ts';
import { envelopeDetails } from './details.ts';
import { unknownKeys } from './metadata.ts';

/**
 * The organization's contacts: an address book of the people its envelopes name, for filling in
 * signers. Every envelope adds or refreshes a contact for each of its signers (in the batch that
 * creates it), and members add, change and delete contacts by hand.
 *
 * A contact is a convenience, never evidence: an envelope keeps the name and email it was sent
 * with, whatever later happens to the contact, and nothing signed or sealed reads this table.
 * Deleting a contact deletes no envelope; the next envelope that names them adds them again.
 *
 * Contacts are one per email address in an organization, compared as Esign compares a signer's
 * (trimmed and case-insensitive). How many of the organization's envelopes name them, and when the
 * latest was created, are counted from the envelopes themselves, those sent before the contact was
 * added included (by `tasks_by_recipient_email`); the list is ordered by when an envelope last named
 * them since, or when they were added. An envelope's name, title and company for them replace the
 * contact's (what the sender said last), except that a title or company it leaves out is kept.
 */

const MAX_NAME = 200;
const MAX_EMAIL = 254;
const MAX_TITLE = 128;
const MAX_COMPANY = 200;
const MAX_QUERY = 100;
/** How many of a contact's envelopes its page lists, newest first. */
const CONTACT_ENVELOPES = 50;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CURSOR = /^(\d{1,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The key a contact is found by: the email, trimmed and lower-cased. */
export const emailKey = (email: string) => email.trim().toLowerCase();

type Row = { id: string; email: string; name: string; title: string | null; company: string | null; envelope_count: number; last_used_at: number | null; recent_at: number; created_at: number; updated_at: number };

/**
 * A contact's columns with how many of the organization's envelopes name them and when the latest was created.
 * Signers' emails have no spaces (every recipient's is checked), so lower() alone matches the key; it is the
 * expression `tasks_by_recipient_email` indexes.
 */
const CONTACT_COLUMNS = `c.*,
  (SELECT count(DISTINCT t.envelope_id) FROM tasks t JOIN envelopes e ON e.id = t.envelope_id WHERE lower(t.recipient_email) = c.email_key AND e.tenant_id = c.tenant_id) AS envelope_count,
  (SELECT max(e.created_at) FROM tasks t JOIN envelopes e ON e.id = t.envelope_id WHERE lower(t.recipient_email) = c.email_key AND e.tenant_id = c.tenant_id) AS last_used_at`;
const readContact = (db: D1Database, tenantId: string, id: string) => db.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE c.id = ? AND c.tenant_id = ?`).bind(id, tenantId).first<Row>();
export type Contact = { id: string; email: string; name: string; title?: string; company?: string; envelopeCount: number; lastUsedAt?: number; createdAt: number; updatedAt: number };

const contact = (row: Row): Contact => ({
  id: row.id, email: row.email, name: row.name,
  ...(row.title ? { title: row.title } : {}), ...(row.company ? { company: row.company } : {}),
  envelopeCount: row.envelope_count, ...(row.last_used_at == null ? {} : { lastUsedAt: row.last_used_at }),
  createdAt: row.created_at, updatedAt: row.updated_at,
});

/**
 * The statements that add or refresh a contact for each signer of a new envelope, to run in the
 * envelope's own batch: they commit with it or not at all. A person named twice in one envelope is
 * refreshed once, with what the last of those names says.
 */
export function contactUpserts(db: D1Database, tenantId: string, signers: { name: string; email: string; title?: string; onBehalfOf?: string }[], now: number): D1PreparedStatement[] {
  const byKey = new Map<string, (typeof signers)[number]>();
  for (const signer of signers) byKey.set(emailKey(signer.email), signer);
  return [...byKey].map(([key, signer]) => db.prepare(`INSERT INTO contacts (id, tenant_id, email, email_key, name, title, company, recent_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)
      ON CONFLICT (tenant_id, email_key) DO UPDATE SET email = excluded.email, name = excluded.name,
        title = COALESCE(excluded.title, contacts.title), company = COALESCE(excluded.company, contacts.company),
        recent_at = excluded.recent_at, updated_at = excluded.updated_at`)
    .bind(crypto.randomUUID(), tenantId, signer.email.trim(), key, signer.name.trim(), signer.title ?? null, signer.onBehalfOf ?? null, now));
}

/** One optional text of a contact: undefined (leave it), null (clear it, also for ''), the trimmed text, or 'invalid'. */
function optionalText(value: unknown, max: number): string | null | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return 'invalid';
  const text = value.trim();
  if (text.length > max || CONTROL.test(text)) return 'invalid';
  return text || null;
}

function contactName(value: unknown): string | 'invalid' {
  if (typeof value !== 'string') return 'invalid';
  const name = value.trim();
  return name && name.length <= MAX_NAME && !CONTROL.test(name) ? name : 'invalid';
}

/** `%` and `_` match themselves in a LIKE pattern (with ESCAPE '\'). */
const likeContaining = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function readBody(context: import('hono').Context<Env>): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_contact' }, 422);
  return body as Record<string, unknown>;
}

export function mountContactRoutes(app: Hono<Env>) {
  // The organization's contacts, most recently used (or added) first; `q` keeps those whose name or
  // email contains it. `next` is the cursor of the following page, when there may be one.
  app.get('/api/contacts', async (context) => {
    const limit = context.req.query('limit') === undefined ? 50 : Number(context.req.query('limit'));
    const q = (context.req.query('q') ?? '').trim();
    const cursor = context.req.query('cursor');
    const after = cursor === undefined ? null : CURSOR.exec(cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || q.length > MAX_QUERY || (cursor !== undefined && !after)) return context.json({ error: 'invalid_query' }, 400);
    const pattern = q ? likeContaining(q) : null;
    const { results } = await context.env.DB.prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE c.tenant_id = ?1
        AND (?2 IS NULL OR c.email_key LIKE ?2 ESCAPE '\\' OR c.name LIKE ?2 ESCAPE '\\')
        AND (?3 IS NULL OR c.recent_at < ?3 OR (c.recent_at = ?3 AND c.id > ?4))
        ORDER BY c.recent_at DESC, c.id LIMIT ?5`)
      .bind(context.get('tenantId'), pattern, after ? Number(after[1]) : null, after ? after[2] : null, limit).all<Row>();
    const last = results.length === limit ? results[results.length - 1] : undefined;
    return context.json({ contacts: results.map(contact), ...(last ? { next: `${last.recent_at}.${last.id}` } : {}) });
  });

  // A contact, with the envelopes that name them as a signer, newest first.
  app.get('/api/contacts/:id', async (context) => {
    const tenantId = context.get('tenantId');
    const row = await readContact(context.env.DB, tenantId, context.req.param('id'));
    if (!row) return context.json({ error: 'not_found' }, 404);
    const { results } = await context.env.DB.prepare(`SELECT e.id, e.status, e.created_at, e.details_json, t.role, t.status AS task_status
        FROM tasks t JOIN envelopes e ON e.id = t.envelope_id
        WHERE e.tenant_id = ? AND lower(t.recipient_email) = ? ORDER BY e.created_at DESC, e.id LIMIT ?`)
      .bind(tenantId, emailKey(row.email), CONTACT_ENVELOPES).all<{ id: string; status: string; created_at: number; details_json: string; role: string; task_status: string }>();
    return context.json({
      ...contact(row),
      envelopes: results.map((e) => {
        const name = envelopeDetails(e.details_json).documentName;
        return { id: e.id, status: e.status, createdAt: e.created_at, ...(name ? { documentName: name } : {}), role: e.role, taskStatus: e.task_status };
      }),
    });
  });

  // Adds a contact, or changes the one with this email: 201 when added, 200 when changed. A title or
  // company left out is kept; null or '' clears it.
  app.post('/api/contacts', bodyLimit({ maxSize: 4096 }), async (context) => {
    const body = await readBody(context);
    if (body instanceof Response) return body;
    const unknown = unknownKeys(body, ['email', 'name', 'title', 'company']);
    if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
    const name = contactName(body.name), title = optionalText(body.title, MAX_TITLE), company = optionalText(body.company, MAX_COMPANY);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (name === 'invalid' || title === 'invalid' || company === 'invalid' || email.length > MAX_EMAIL || !EMAIL.test(email)) return context.json({ error: 'invalid_contact' }, 422);
    const id = crypto.randomUUID(), now = Date.now();
    const saved = await context.env.DB.prepare(`INSERT INTO contacts (id, tenant_id, email, email_key, name, title, company, recent_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?10, ?10, ?10)
        ON CONFLICT (tenant_id, email_key) DO UPDATE SET email = excluded.email, name = excluded.name,
          title = CASE WHEN ?8 THEN excluded.title ELSE contacts.title END, company = CASE WHEN ?9 THEN excluded.company ELSE contacts.company END,
          updated_at = excluded.updated_at
        RETURNING id`)
      .bind(id, context.get('tenantId'), email, emailKey(email), name, title ?? null, company ?? null, title === undefined ? 0 : 1, company === undefined ? 0 : 1, now).first<{ id: string }>();
    const row = await readContact(context.env.DB, context.get('tenantId'), saved!.id);
    return context.json(contact(row!), saved!.id === id ? 201 : 200);
  });

  // Changes a contact's name, title or company; its email stays (another email is another contact).
  app.post('/api/contacts/:id', bodyLimit({ maxSize: 4096 }), async (context) => {
    const body = await readBody(context);
    if (body instanceof Response) return body;
    const unknown = unknownKeys(body, ['name', 'title', 'company']);
    if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
    const name = body.name === undefined ? undefined : contactName(body.name), title = optionalText(body.title, MAX_TITLE), company = optionalText(body.company, MAX_COMPANY);
    if (name === 'invalid' || title === 'invalid' || company === 'invalid') return context.json({ error: 'invalid_contact' }, 422);
    const saved = await context.env.DB.prepare(`UPDATE contacts SET name = COALESCE(?3, name),
        title = CASE WHEN ?5 THEN ?4 ELSE title END, company = CASE WHEN ?7 THEN ?6 ELSE company END, updated_at = ?8
        WHERE id = ?1 AND tenant_id = ?2 RETURNING id`)
      .bind(context.req.param('id'), context.get('tenantId'), name ?? null, title ?? null, title === undefined ? 0 : 1, company ?? null, company === undefined ? 0 : 1, Date.now()).first<{ id: string }>();
    const row = saved && await readContact(context.env.DB, context.get('tenantId'), saved.id);
    if (!row) return context.json({ error: 'not_found' }, 404);
    return context.json(contact(row));
  });

  // Deletes a contact. Their envelopes are untouched; the next envelope that names them adds them again.
  app.post('/api/contacts/:id/delete', async (context) => {
    const id = context.req.param('id');
    const deleted = await context.env.DB.prepare('DELETE FROM contacts WHERE id = ? AND tenant_id = ?').bind(id, context.get('tenantId')).run();
    if (deleted.meta.changes !== 1) return context.json({ error: 'not_found' }, 404);
    return context.json({ id, deleted: true });
  });
}
