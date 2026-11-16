import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './app.ts';
import { can, type Caller } from './identity.ts';
import { unknownKeys } from './metadata.ts';

/**
 * Who may see and change a template or an envelope. Each has one owner: the member or API client
 * that created it (`owner_user_id`), or whom an organization owner transferred it to (members.ts).
 * Nobody else sees it, an organization's owners and admins included, unless it is shared with them
 * (`document_shares`): by email, as admin, editor or viewer; or with everyone in the organization, as editor or viewer
 * (the row whose key is `EVERYONE`). Everyone means the organization's people: an API client sees only what it owns
 * or is shared with by email, which it never is. And everything an API client owns is seen, as admin, by every person
 * on its list (`api_client_people`, set on Esign's page for the client, linked from the platform's API access page:
 * members.ts), for as long as they are on it and the owner is an API client (`members.kind`, so a list made for an id
 * that turns out to be a person's never reaches that person's documents): worked out each time from the list, never
 * written per document. Someone shared several ways has the highest role.
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
/** The roles a document can be shared with everyone in the organization as: sharing it on is for its admins. */
export const ORG_SHARE_ROLES: readonly ShareRole[] = ['editor', 'viewer'];
/** The `grantee_email_key` of the share with everyone in the organization: never an email key, which has an `@`. */
export const EVERYONE = '*';

/** The address the platform gives an API client (a service account): on a reserved domain nobody can own (RFC 2606). */
const CLIENT_EMAIL = /@service-accounts\.invalid$/i;
/** Whether the caller is an API client (a service account), not a person or a person's AI agent. */
export const isClient = (caller: Caller): boolean => caller.accessVia === 'api';
/** The key the caller's shares are found by: their email, trimmed and lower-cased. An API client has none. */
export const shareKey = (caller: Caller): string | null => (isClient(caller) || !caller.email ? null : emailKey(caller.email));
export const emailKey = (email: string) => email.trim().toLowerCase();
/**
 * The keys the caller's shares are found by, as a JSON array for `json_each`: their email's, and, for a person (not an
 * API client), the organization's.
 */
export const shareKeys = (caller: Caller): string => JSON.stringify([shareKey(caller), isClient(caller) ? null : EVERYONE].filter((key) => key !== null));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** An address a document can be shared with: a person's, never an API client's. */
export const shareableEmail = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length <= 254 && EMAIL.test(value.trim()) && !CLIENT_EMAIL.test(value.trim());

const TABLE: Record<ResourceType, string> = { template: 'templates', envelope: 'envelopes' };

/**
 * SQL: the ids of the documents of `type` the caller sees, owned (`mine`), shared with them (`shared`: by email, with
 * everyone, or as a person on the list of the API client that owns them; never their own) or both, as an `IN (...)` set.
 * Each side reads its own index (the shares by grantee, the API clients' lists by email, the documents by owner), so
 * the cost is that of the documents the caller sees. Binds: `visibleBinds`.
 */
export function visibleIds(type: ResourceType, scope: 'all' | 'mine' | 'shared' = 'all'): string {
  const mine = `SELECT id FROM ${TABLE[type]} WHERE tenant_id = ? AND owner_user_id = ?`;
  const shared = `SELECT resource_id FROM document_shares WHERE tenant_id = ? AND grantee_email_key IN (SELECT value FROM json_each(?)) AND resource_type = '${type}'
    UNION SELECT id FROM ${TABLE[type]} WHERE tenant_id = ? AND owner_user_id IN (SELECT p.client_user_id FROM api_client_people p JOIN members m ON m.tenant_id = p.tenant_id AND m.user_id = p.client_user_id AND m.kind = 'client' WHERE p.tenant_id = ? AND p.email_key = ?)`;
  return `(${scope === 'mine' ? mine : scope === 'shared' ? `${shared} EXCEPT ${mine}` : `${mine} UNION ${shared}`})`;
}
/** The binds of `visibleIds` for this caller and scope. */
export function visibleBinds(tenantId: string, caller: Caller, scope: 'all' | 'mine' | 'shared' = 'all'): (string | null)[] {
  const mine = [tenantId, caller.userId], shared = [tenantId, shareKeys(caller), tenantId, tenantId, shareKey(caller)];
  return scope === 'mine' ? mine : scope === 'shared' ? [...shared, ...mine] : [...mine, ...shared];
}

/** The caller's role in a document as stored, before the cap of their role in Esign. */
const storedRole = (ownerId: string, sharedRole: string | null, caller: Caller): DocumentRole | null =>
  ownerId === caller.userId ? 'owner' : sharedRole && (SHARE_ROLES as readonly string[]).includes(sharedRole) ? sharedRole as ShareRole : null;
/** The role, at most a viewer's for someone who may only view Esign. */
export function effectiveRole(ownerId: string, sharedRole: string | null, caller: Caller): DocumentRole | null {
  const role = storedRole(ownerId, sharedRole, caller);
  return role && !can(caller, 'esign.manage') ? 'viewer' : role;
}
/**
 * SQL: the caller's share role in the row `alias` of `type`, as a column: admin when they are on the list of the API
 * client that owns it, else the higher of theirs and everyone's. Binds: `sharedRoleBinds`.
 */
export const sharedRoleColumn = (type: ResourceType, alias: string) =>
  `(CASE WHEN EXISTS (SELECT 1 FROM api_client_people p JOIN members m ON m.tenant_id = p.tenant_id AND m.user_id = p.client_user_id AND m.kind = 'client' WHERE p.tenant_id = ${alias}.tenant_id AND p.client_user_id = ${alias}.owner_user_id AND p.email_key = ?) THEN 'admin'
    ELSE (SELECT s.role FROM document_shares s WHERE s.resource_type = '${type}' AND s.resource_id = ${alias}.id AND s.grantee_email_key IN (SELECT value FROM json_each(?))
    ORDER BY CASE s.role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END DESC LIMIT 1) END)`;
/** The binds of `sharedRoleColumn`: the caller's email key (none for an API client), then `shareKeys`. */
export const sharedRoleBinds = (caller: Caller): (string | null)[] => [shareKey(caller), shareKeys(caller)];

/**
 * The caller's role in one document of their organization, or null when they can't see it (or it doesn't exist). An
 * archived template (deleted, or replaced by a new version) is no different here: archiving only takes it off the lists.
 */
export async function documentRole(db: D1Database, tenantId: string, caller: Caller, type: ResourceType, id: string): Promise<{ role: DocumentRole; ownerId: string } | null> {
  const row = await db.prepare(`SELECT x.owner_user_id, ${sharedRoleColumn(type, 'x')} AS shared_role FROM ${TABLE[type]} x WHERE x.id = ? AND x.tenant_id = ?`)
    .bind(...sharedRoleBinds(caller), id, tenantId).first<{ owner_user_id: string; shared_role: string | null }>();
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

/** A share: with a person, by email, or with everyone in the organization. */
export type Share = { email: string; role: ShareRole } | { organization: true; role: ShareRole };
const MAX_SHARES = 20;
/** The `grantee_email_key` of a share. */
const keyOf = (share: Share) => ('organization' in share ? EVERYONE : emailKey(share.email));

/**
 * The `share` of a create request: whom else a new document is shared with, at most 20, each
 * `{email, role}`, or `{organization: true, role}` (editor or viewer) for everyone in the organization.
 * Undefined is none; anything malformed is 'invalid'.
 */
export function parseShares(value: unknown): Share[] | 'invalid' {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SHARES) return 'invalid';
  const out: Share[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || unknownKeys(item, ['email', 'role', 'organization']).length) return 'invalid';
    const { email, role, organization } = item as { email?: unknown; role?: unknown; organization?: unknown };
    if (organization !== undefined) {
      if (organization !== true || email !== undefined || typeof role !== 'string' || !(ORG_SHARE_ROLES as readonly string[]).includes(role)) return 'invalid';
      out.push({ organization: true, role: role as ShareRole });
      continue;
    }
    if (!shareableEmail(email) || typeof role !== 'string' || !(SHARE_ROLES as readonly string[]).includes(role)) return 'invalid';
    out.push({ email: email.trim(), role: role as ShareRole });
  }
  return out;
}

/**
 * The shares a new document gets, from the caller: one per person and one for everyone, the highest role each is
 * given, the caller (its owner) left out.
 */
export function sharesFor(shares: Share[], caller: Caller): Share[] {
  const byKey = new Map<string, Share>();
  const own = shareKey(caller);
  for (const share of shares) {
    const key = keyOf(share);
    if (key === own) continue;
    const seen = byKey.get(key);
    byKey.set(key, seen ? { ...seen, role: higher(seen.role, share.role) } : share);
  }
  return [...byKey.values()];
}

/** The statements that share a new document (`sharesFor`), granted by `grantedBy`: for the creating request's batch. */
export function shareInserts(db: D1Database, tenantId: string, type: ResourceType, id: string, shares: Share[], grantedBy: string, now: number): D1PreparedStatement[] {
  return shares.map((share) => db.prepare(`INSERT INTO document_shares (tenant_id, resource_type, resource_id, grantee_email_key, grantee_email, role, granted_by, granted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (resource_type, resource_id, grantee_email_key) DO NOTHING`)
    .bind(tenantId, type, id, keyOf(share), 'organization' in share ? EVERYONE : share.email, share.role, grantedBy, now));
}

type ShareRow = { grantee_email_key: string; grantee_email: string; role: ShareRole; granted_at: number; name: string | null };

/**
 * A document's owner (as Esign has seen them, members.ts), the people it is shared with, by name where known,
 * `organization`, its share with everyone in the organization, when it has one, and `client`, the people on the list of
 * the API client that owns it, who see it as admins.
 */
async function sharing(db: D1Database, tenantId: string, type: ResourceType, id: string, ownerId: string) {
  const owner = await db.prepare('SELECT user_id, kind, email, name FROM members WHERE tenant_id = ? AND user_id = ?').bind(tenantId, ownerId).first<{ user_id: string; kind: string; email: string | null; name: string | null }>();
  const { results } = await db.prepare(`SELECT s.grantee_email_key, s.grantee_email, s.role, s.granted_at,
      (SELECT m.name FROM members m WHERE m.tenant_id = s.tenant_id AND m.email_key = s.grantee_email_key AND m.kind = 'person' ORDER BY m.last_seen_at DESC LIMIT 1) AS name
      FROM document_shares s WHERE s.tenant_id = ? AND s.resource_type = ? AND s.resource_id = ? ORDER BY s.granted_at, s.grantee_email_key`)
    .bind(tenantId, type, id).all<ShareRow>();
  const everyone = results.find((row) => row.grantee_email_key === EVERYONE);
  // Owned by an API client: the people on its list, who see it as admins (`client`).
  const listed = owner?.kind === 'client' ? (await db.prepare(`SELECT p.email,
      (SELECT m.name FROM members m WHERE m.tenant_id = p.tenant_id AND m.email_key = p.email_key AND m.kind = 'person' ORDER BY m.last_seen_at DESC LIMIT 1) AS name
      FROM api_client_people p WHERE p.tenant_id = ? AND p.client_user_id = ? ORDER BY p.added_at, p.email_key`).bind(tenantId, ownerId).all<{ email: string; name: string | null }>()).results : [];
  return {
    owner: ownerSummary(ownerId, owner),
    ...(listed.length ? { client: { people: listed.map((row) => ({ email: row.email, ...(row.name ? { name: row.name } : {}) })) } } : {}),
    ...(everyone ? { organization: { role: everyone.role, sharedAt: everyone.granted_at } } : {}),
    shares: results.filter((row) => row !== everyone).map((row) => ({ email: row.grantee_email, ...(row.name ? { name: row.name } : {}), role: row.role, sharedAt: row.granted_at })),
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
    // Shares it with someone, or with everyone in the organization (as editor or viewer), or changes their role:
    // admins and the owner, as admin at most.
    app.post(base, bodyLimit({ maxSize: 4096 }), async (context) => {
      let body: unknown;
      try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_share' }, 422);
      const unknown = unknownKeys(body, ['email', 'role', 'organization']);
      if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
      const parsed = parseShares([body]);
      if (parsed === 'invalid') return context.json({ error: 'invalid_share' }, 422);
      const [share] = parsed;
      const tenantId = context.get('tenantId'), caller = context.get('caller'), id = context.req.param('id') ?? '';
      const found = await documentRole(context.env.DB, tenantId, caller, type, id);
      if (!found) return context.json({ error: 'not_found' }, 404);
      if (!atLeast(found.role, 'admin')) return context.json({ error: 'forbidden', role: found.role }, 403);
      // The owner is never a share: sharing with their own email changes nothing they may do.
      if ('email' in share) {
        const owner = await context.env.DB.prepare("SELECT email_key FROM members WHERE tenant_id = ? AND user_id = ? AND kind = 'person'").bind(tenantId, found.ownerId).first<{ email_key: string | null }>();
        if (owner?.email_key === emailKey(share.email)) return context.json({ error: 'owner_not_shared' }, 422);
      }
      await context.env.DB.prepare(`INSERT INTO document_shares (tenant_id, resource_type, resource_id, grantee_email_key, grantee_email, role, granted_by, granted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (resource_type, resource_id, grantee_email_key) DO UPDATE SET role = excluded.role, grantee_email = excluded.grantee_email`)
        .bind(tenantId, type, id, keyOf(share), 'email' in share ? share.email : EVERYONE, share.role, caller.userId, Date.now()).run();
      return context.json({ id, myRole: found.role, ...await sharing(context.env.DB, tenantId, type, id, found.ownerId) });
    });
    // Stops sharing it with someone (`{email}`), or with everyone (`{organization: true}`): admins and the owner, or
    // anyone for themselves.
    app.post(`${base}/delete`, bodyLimit({ maxSize: 4096 }), async (context) => {
      let body: unknown;
      try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || unknownKeys(body, ['email', 'organization']).length) return context.json({ error: 'invalid_share' }, 422);
      const { email, organization } = body as { email?: unknown; organization?: unknown };
      if (organization === undefined ? typeof email !== 'string' : organization !== true || email !== undefined) return context.json({ error: 'invalid_share' }, 422);
      const key = organization === true ? EVERYONE : emailKey(email as string);
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
