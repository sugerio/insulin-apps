import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './app.ts';
import { documentRole, type ResourceType } from './ownership.ts';
import { unknownKeys } from './metadata.ts';

/**
 * Tags: each person's own words on the templates and envelopes they can see (`document_tags`), to
 * find them again. Nobody else sees a person's tags, the document's owner included, and they say
 * nothing about the document to anyone: never evidence, never shown to signers. A tag is compared
 * trimmed and case-insensitive (`tag_key`) and kept as written. Anyone who sees a document may tag it.
 */
const MAX_TAGS = 20;
const MAX_TAG = 50;
const CONTROL = /[\u0000-\u001f\u007f]/;
export const tagKey = (tag: string) => tag.trim().toLowerCase();

/** A document's tags as given: an array of at most 20, each 1 to 50 characters; repeats (by key) dropped. Undefined is none. */
export function parseTags(value: unknown): string[] | 'invalid' {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS) return 'invalid';
  const byKey = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== 'string') return 'invalid';
    const tag = item.trim();
    if (!tag || tag.length > MAX_TAG || CONTROL.test(tag)) return 'invalid';
    if (!byKey.has(tagKey(tag))) byKey.set(tagKey(tag), tag);
  }
  return [...byKey.values()];
}

/** The `tag` query of a list: up to 5 tags, each document having all of them. */
export function parseTagFilter(values: string[] | undefined): string[] | 'invalid' {
  const tags = parseTags(values ?? []);
  return tags === 'invalid' || tags.length > 5 ? 'invalid' : tags.map(tagKey);
}

/**
 * SQL: the ids of the user's documents of `type` having every one of `count` tags, as an `IN (...)` set.
 * Binds: tenant, user id, the tag keys as a JSON array, count.
 */
export const taggedIds = (type: ResourceType) =>
  `(SELECT resource_id FROM document_tags WHERE tenant_id = ? AND user_id = ? AND resource_type = '${type}' AND tag_key IN (SELECT value FROM json_each(?)) GROUP BY resource_id HAVING count(*) = ?)`;

/** The statements that set the user's tags on a document, replacing theirs: for a batch. */
export function tagWrites(db: D1Database, tenantId: string, userId: string, type: ResourceType, id: string, tags: string[]): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM document_tags WHERE tenant_id = ? AND user_id = ? AND resource_type = ? AND resource_id = ?').bind(tenantId, userId, type, id),
    ...tags.map((tag) => db.prepare('INSERT INTO document_tags (tenant_id, user_id, resource_type, resource_id, tag_key, tag) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(tenantId, userId, type, id, tagKey(tag), tag)),
  ];
}

/** The user's own tags on a template, for a new envelope or an edited copy of it to start with. */
export async function tagsOf(db: D1Database, tenantId: string, userId: string, type: ResourceType, id: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT tag FROM document_tags WHERE tenant_id = ? AND user_id = ? AND resource_type = ? AND resource_id = ? ORDER BY tag_key').bind(tenantId, userId, type, id).all<{ tag: string }>();
  return results.map((row) => row.tag);
}

/** The user's tags on each of these documents, by id. */
export async function tagsByDocument(db: D1Database, tenantId: string, userId: string, type: ResourceType, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const { results } = await db.prepare('SELECT resource_id, tag FROM document_tags WHERE tenant_id = ? AND user_id = ? AND resource_type = ? AND resource_id IN (SELECT value FROM json_each(?)) ORDER BY tag_key')
    .bind(tenantId, userId, type, JSON.stringify(ids)).all<{ resource_id: string; tag: string }>();
  for (const row of results) out.get(row.resource_id)?.push(row.tag);
  return out;
}

/** Merges tag lists, the first spelling of each kept. */
export const mergeTags = (...lists: string[][]): string[] => {
  const byKey = new Map<string, string>();
  for (const tag of lists.flat()) if (!byKey.has(tagKey(tag))) byKey.set(tagKey(tag), tag);
  return [...byKey.values()].slice(0, MAX_TAGS);
};

export function mountTagRoutes(app: Hono<Env>) {
  // The caller's own tags, most used first, optionally only those containing `q`: for suggestions as they type.
  app.get('/api/tags', async (context) => {
    const limit = context.req.query('limit') === undefined ? 20 : Number(context.req.query('limit'));
    const q = (context.req.query('q') ?? '').trim().toLowerCase();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || q.length > MAX_TAG) return context.json({ error: 'invalid_query' }, 400);
    const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const { results } = await context.env.DB.prepare(`SELECT min(tag) AS tag, count(*) AS uses FROM document_tags WHERE tenant_id = ? AND user_id = ?
        AND (? IS NULL OR tag_key LIKE ? ESCAPE '\\') GROUP BY tag_key ORDER BY uses DESC, tag_key LIMIT ?`)
      .bind(context.get('tenantId'), context.get('caller').userId, pattern, pattern, limit).all<{ tag: string; uses: number }>();
    return context.json({ tags: results.map((row) => ({ tag: row.tag, uses: row.uses })) });
  });
  for (const type of ['template', 'envelope'] as const) {
    // Replaces the caller's tags on a document they see ([] clears them).
    app.post(`/api/${type}s/:id/tags`, bodyLimit({ maxSize: 4096 }), async (context) => {
      let body: unknown;
      try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_tags' }, 422);
      const unknown = unknownKeys(body, ['tags']);
      if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
      const value = (body as { tags?: unknown }).tags;
      const tags = value === undefined ? 'invalid' : parseTags(value);
      if (tags === 'invalid') return context.json({ error: 'invalid_tags' }, 422);
      const tenantId = context.get('tenantId'), caller = context.get('caller'), id = context.req.param('id') ?? '';
      if (!await documentRole(context.env.DB, tenantId, caller, type, id)) return context.json({ error: 'not_found' }, 404);
      await context.env.DB.batch(tagWrites(context.env.DB, tenantId, caller.userId, type, id, tags));
      return context.json({ id, tags });
    });
  }
}
