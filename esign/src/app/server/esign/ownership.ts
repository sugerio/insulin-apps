import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './app.ts';
import { can, type Caller } from './identity.ts';
import { unknownKeys } from './metadata.ts';

/**
 * Who may see and change a template or an envelope. Each has one owner: the member or API client
 * that created it (`owner_user_id`), or whom an organization owner transferred it to (members.ts).
 * Nobody else sees it, an organization's owners and admins included, unless it is shared with them
 * (`document_shares`): by email, as admin, editor or viewer.
 *
 * - viewer: sees it (its audit trail, certificate and signed PDF too) and its sharing; sends envelopes
 *   from a template; tags it for themselves (tags.ts).
 * - editor: and changes it: a template's default signers; an envelope's void, invitations and signing pages.
 * - admin: and shares it, with anyone, as admin at most.
 * - owner: all of that; the owner is never a share.
 *
 * A role in a document never exceeds the caller's role in Esign: someone who may only view Esign
 * (`esign.view`) is a viewer at most, whatever they own or are shared. Every route asks here, and a
 * document the caller can't see answers 404, as one that doesn't exist.
 */
export type ResourceType = 'template' | 'envelope';
export type DocumentRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type ShareRole = Exclude<DocumentRole, 'owner'>;
export const SHARE_ROLES: readonly ShareRole[] = ['admin', 'editor', 'viewer'];
const RANK: Record<DocumentRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export const atLeast = (role: DocumentRole | null, needed: DocumentRole): role is DocumentRole => role !== null && RANK[role] >= RANK[needed];
const higher = (a: ShareRole, b: ShareRole): ShareRole => (RANK[a] >= RANK[b] ? a : b);

/** The address the platform gives an API client (a service account): on a reserved domain nobody can own (RFC 2606). */
const CLIENT_EMAIL = /@service-accounts\.invalid$/i;
/** Whether the caller is an API client (a service account), not a person or a person's AI agent. */
export const isClient = (caller: Caller): boolean => caller.accessVia === 'api';
/** The key the caller's shares are found by: their email, trimmed and lower-cased. An API client has none. */
export const shareKey = (caller: Caller): string | null => (isClient(caller) || !caller.email ? null : emailKey(caller.email));
export const emailKey = (email: string) => email.trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** An address a document can be shared with: a person's, never an API client's. */
export const shareableEmail = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length <= 254 && EMAIL.test(value.trim()) && !CLIENT_EMAIL.test(value.trim());

const TABLE: Record<ResourceType, string> = { template: 'templates', envelope: 'envelopes' };

/**
 * SQL: the ids of the documents of `type` the caller sees, owned (`mine`), shared with them (`shared`)
 * or both, as an `IN (...)` set. Each side reads its own index, so the cost is that of the caller's own
 * documents, not the organization's. Binds, in order: tenant, user id, tenant, share key (both sides);
 * tenant, user id (`mine`); tenant, share key (`shared`).
 */
export function visibleIds(type: ResourceType, scope: 'all' | 'mine' | 'shared' = 'all'): string {
  const mine = `SELECT id FROM ${TABLE[type]} WHERE tenant_id = ? AND owner_user_id = ?`;
  const shared = `SELECT resource_id FROM document_shares WHERE tenant_id = ? AND grantee_email_key = ? AND resource_type = '${type}'`;
  return `(${scope === 'mine' ? mine : scope === 'shared' ? shared : `${mine} UNION ${shared}`})`;
}
/** The binds of `visibleIds` for this caller and scope. */
export function visibleBinds(tenantId: string, caller: Caller, scope: 'all' | 'mine' | 'shared' = 'all'): (string | null)[] {
  const mine = [tenantId, caller.userId], shared = [tenantId, shareKey(caller)];
  return scope === 'mine' ? mine : scope === 'shared' ? shared : [...mine, ...shared];
}

/** The caller's role in a document as stored, before the cap of their role in Esign. */
const storedRole = (ownerId: string, sharedRole: string | null, caller: Caller): DocumentRole | null =>
  ownerId === caller.userId ? 'owner' : sharedRole && (SHARE_ROLES as readonly string[]).includes(sharedRole) ? sharedRole as ShareRole : null;
/** The role, at most a viewer's for someone who may only view Esign. */
export function effectiveRole(ownerId: string, sharedRole: string | null, caller: Caller): DocumentRole | null {
  const role = storedRole(ownerId, sharedRole, caller);
  return role && !can(caller, 'esign.manage') ? 'viewer' : role;
}
/** SQL: the caller's share role in the row `alias` of `type`, as a column. Binds: share key. */
export const sharedRoleColumn = (type: ResourceType, alias: string) =>
  `(SELECT s.role FROM document_shares s WHERE s.resource_type = '${type}' AND s.resource_id = ${alias}.id AND s.grantee_email_key = ?)`;

/** The caller's role in one document of their organization, or null when they can't see it (or it doesn't exist). */
export async function documentRole(db: D1Database, tenantId: string, caller: Caller, type: ResourceType, id: string): Promise<{ role: DocumentRole; ownerId: string } | null> {
  const row = await db.prepare(`SELECT x.owner_user_id, ${sharedRoleColumn(type, 'x')} AS shared_role FROM ${TABLE[type]} x WHERE x.id = ? AND x.tenant_id = ?`)
    .bind(shareKey(caller), id, tenantId).first<{ owner_user_id: string; shared_role: string | null }>();
  const role = row ? effectiveRole(row.owner_user_id, row.shared_role, caller) : null;
  return role && row ? { role, ownerId: row.owner_user_id } : null;
}

/**
 * Checks the caller has at least `needed` in the document: null when they do, else the answer to
 * return (404 when they can't see it, 403 when they can but not enough).
 */
export async function requireRole(context: import('hono').Context<Env>, type: ResourceType, id: string, needed: DocumentRole): Promise<Response | null> {
  const found = await documentRole(context.env.DB, context.get('tenantId'), context.get('caller'), type, id);
  if (!found) return context.json({ error: 'not_found' }, 404);
  if (!atLeast(found.role, needed)) return context.json({ error: 'forbidden', role: found.role }, 403);
  return null;
}

export type Share = { email: string; role: ShareRole };
const MAX_SHARES = 20;

/**
 * The `share` of a create request: whom else a new document is shared with, at most 20, each
 * `{email, role}`. Undefined is none; anything malformed is 'invalid'.
 */
export function parseShares(value: unknown): Share[] | 'invalid' {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SHARES) return 'invalid';
  const out: Share[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || unknownKeys(item, ['email', 'role']).length) return 'invalid';
    const { email, role } = item as { email?: unknown; role?: unknown };
    if (!shareableEmail(email) || typeof role !== 'string' || !(SHARE_ROLES as readonly string[]).includes(role)) return 'invalid';
    out.push({ email: email.trim(), role: role as ShareRole });
  }
  return out;
}

/** The share an API client's settings give its documents (members.ts), if any: its person, as admin. */
export async function clientShare(db: D1Database, tenantId: string, caller: Caller): Promise<Share | null> {
  if (!isClient(caller)) return null;
  const row = await db.prepare('SELECT share_email FROM api_clients WHERE tenant_id = ? AND client_user_id = ?').bind(tenantId, caller.userId).first<{ share_email: string }>();
  return row ? { email: row.share_email, role: 'admin' } : null;
}

/**
 * The shares a new document gets, from the caller: one per person, the highest role each is given, the
 * caller (its owner) left out.
 */
export function sharesFor(shares: Share[], caller: Caller): Share[] {
  const byKey = new Map<string, Share>();
  const own = shareKey(caller);
  for (const share of shares) {
    const key = emailKey(share.email);
    if (key === own) continue;
    const seen = byKey.get(key);
    byKey.set(key, seen ? { email: seen.email, role: higher(seen.role, share.role) } : share);
  }
  return [...byKey.values()];
}

/** The statements that share a new document (`sharesFor`), granted by `grantedBy`: for the creating request's batch. */
export function shareInserts(db: D1Database, tenantId: string, type: ResourceType, id: string, shares: Share[], grantedBy: string, now: number): D1PreparedStatement[] {
  return shares.map((share) => db.prepare(`INSERT INTO document_shares (tenant_id, resource_type, resource_id, grantee_email_key, grantee_email, role, granted_by, granted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (resource_type, resource_id, grantee_email_key) DO NOTHING`)
    .bind(tenantId, type, id, emailKey(share.email), share.email, share.role, grantedBy, now));
}

type ShareRow = { grantee_email: string; role: ShareRole; granted_at: number; name: string | null };

/** A document's owner (as Esign has seen them, members.ts) and the people it is shared with, by name where known. */
async function sharing(db: D1Database, tenantId: string, type: ResourceType, id: string, ownerId: string) {
  const owner = await db.prepare('SELECT user_id, kind, email, name FROM members WHERE tenant_id = ? AND user_id = ?').bind(tenantId, ownerId).first<{ user_id: string; kind: string; email: string | null; name: string | null }>();
  const { results } = await db.prepare(`SELECT s.grantee_email, s.role, s.granted_at,
      (SELECT m.name FROM members m WHERE m.tenant_id = s.tenant_id AND m.email_key = s.grantee_email_key AND m.kind = 'person' ORDER BY m.last_seen_at DESC LIMIT 1) AS name
      FROM document_shares s WHERE s.tenant_id = ? AND s.resource_type = ? AND s.resource_id = ? ORDER BY s.granted_at, s.grantee_email_key`)
    .bind(tenantId, type, id).all<ShareRow>();
  return {
    owner: ownerSummary(ownerId, owner),
    shares: results.map((row) => ({ email: row.grantee_email, ...(row.name ? { name: row.name } : {}), role: row.role, sharedAt: row.granted_at })),
  };
}

export type OwnerSummary = { id: string; kind: 'person' | 'client'; name?: string; email?: string };
/** How an owner is shown: their name and email, or an API client's name. */
export function ownerSummary(id: string, row: { kind: string; email: string | null; name: string | null } | null | undefined): OwnerSummary {
  const kind = row?.kind === 'client' ? 'client' : 'person';
  return { id, kind, ...(row?.name ? { name: row.name } : {}), ...(row?.email && kind === 'person' ? { email: row.email } : {}) };
}

/** The owners (members.ts) of these documents, by id. */
export async function ownersOf(db: D1Database, tenantId: string, ownerIds: string[]): Promise<Map<string, OwnerSummary>> {
  const ids = [...new Set(ownerIds)];
  const { results } = ids.length ? await db.prepare('SELECT user_id, kind, email, name FROM members WHERE tenant_id = ? AND user_id IN (SELECT value FROM json_each(?))')
    .bind(tenantId, JSON.stringify(ids)).all<{ user_id: string; kind: string; email: string | null; name: string | null }>() : { results: [] };
  const found = new Map(results.map((row) => [row.user_id, row]));
  return new Map(ids.map((id) => [id, ownerSummary(id, found.get(id))]));
}

export function mountShareRoutes(app: Hono<Env>) {
  for (const type of ['template', 'envelope'] as const) {
    const base = `/api/${TABLE[type]}/:id/shares`;
    // Who can see it: its owner and the people it is shared with, and the caller's own role. Anyone who sees it.
    app.get(base, async (context) => {
      const tenantId = context.get('tenantId'), id = context.req.param('id') ?? '';
      const found = await documentRole(context.env.DB, tenantId, context.get('caller'), type, id);
      if (!found) return context.json({ error: 'not_found' }, 404);
      return context.json({ id, myRole: found.role, ...await sharing(context.env.DB, tenantId, type, id, found.ownerId) });
    });
    // Shares it with someone, or changes their role: admins and the owner, as admin at most.
    app.post(base, bodyLimit({ maxSize: 4096 }), async (context) => {
      let body: unknown;
      try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_share' }, 422);
      const unknown = unknownKeys(body, ['email', 'role']);
      if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
      const parsed = parseShares([body]);
      if (parsed === 'invalid') return context.json({ error: 'invalid_share' }, 422);
      const [share] = parsed;
      const tenantId = context.get('tenantId'), caller = context.get('caller'), id = context.req.param('id') ?? '';
      const found = await documentRole(context.env.DB, tenantId, caller, type, id);
      if (!found) return context.json({ error: 'not_found' }, 404);
      if (!atLeast(found.role, 'admin')) return context.json({ error: 'forbidden', role: found.role }, 403);
      // The owner is never a share: sharing with their own email changes nothing they may do.
      const owner = await context.env.DB.prepare("SELECT email_key FROM members WHERE tenant_id = ? AND user_id = ? AND kind = 'person'").bind(tenantId, found.ownerId).first<{ email_key: string | null }>();
      if (owner?.email_key === emailKey(share.email)) return context.json({ error: 'owner_not_shared' }, 422);
      await context.env.DB.prepare(`INSERT INTO document_shares (tenant_id, resource_type, resource_id, grantee_email_key, grantee_email, role, granted_by, granted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (resource_type, resource_id, grantee_email_key) DO UPDATE SET role = excluded.role, grantee_email = excluded.grantee_email`)
        .bind(tenantId, type, id, emailKey(share.email), share.email, share.role, caller.userId, Date.now()).run();
      return context.json({ id, myRole: found.role, ...await sharing(context.env.DB, tenantId, type, id, found.ownerId) });
    });
    // Stops sharing it with someone: admins and the owner, or anyone for themselves.
    app.post(`${base}/delete`, bodyLimit({ maxSize: 4096 }), async (context) => {
      let body: unknown;
      try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || unknownKeys(body, ['email']).length || typeof (body as { email?: unknown }).email !== 'string') return context.json({ error: 'invalid_share' }, 422);
      const key = emailKey((body as { email: string }).email);
      const tenantId = context.get('tenantId'), caller = context.get('caller'), id = context.req.param('id') ?? '';
      const found = await documentRole(context.env.DB, tenantId, caller, type, id);
      if (!found) return context.json({ error: 'not_found' }, 404);
      const self = key === shareKey(caller);
      if (!self && !atLeast(found.role, 'admin')) return context.json({ error: 'forbidden', role: found.role }, 403);
      const removed = await context.env.DB.prepare('DELETE FROM document_shares WHERE tenant_id = ? AND resource_type = ? AND resource_id = ? AND grantee_email_key = ?').bind(tenantId, type, id, key).run();
      if (removed.meta.changes !== 1) return context.json({ error: 'not_shared' }, 404);
      // Someone who removed themselves no longer sees it.
      if (self && found.role !== 'owner') return context.json({ id, removed: true });
      return context.json({ id, myRole: found.role, ...await sharing(context.env.DB, tenantId, type, id, found.ownerId) });
    });
  }
}
