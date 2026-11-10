/**
 * One-time access codes and the short-lived sessions they open (tables `access_codes` and
 * `access_sessions`, migrations/0005_access.sql), shared by the two browser pages:
 *
 * - scope `recipient`: the signing page. The subject is a task; the code and the session are
 *   bound to the page origin the code was issued for.
 * - scope `editor`: the embedded template editor. The subject is an editor session
 *   (`editor_sessions`); the origin is the parent page allowed to frame it.
 *
 * Every function takes the scope explicitly and every statement requires it, so a code or token
 * of one scope is never accepted where the other is expected. Only SHA-256 hashes of codes and
 * tokens are stored. Internal primitives, not an HTTP authorization boundary by themselves.
 */
export type AccessScope = 'recipient' | 'editor';

/** A code is exchanged once, within two minutes. */
export const ACCESS_CODE_TTL_MS = 2 * 60 * 1000;
/** A session (its bearer token) lasts fifteen minutes. */
export const ACCESS_SESSION_TTL_MS = 15 * 60 * 1000;

const HEX64 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');

/** SHA-256 of a code or token, as stored. */
export const accessHash = async (value: string): Promise<string> => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
/** 32 random bytes as 64 lowercase hex characters: the format of every code, token and editor session id. */
export const randomHex = (): string => hex(crypto.getRandomValues(new Uint8Array(32)));

/** An https origin, or http on localhost or 127.0.0.1, exactly as `URL.origin` prints it. */
export function validAccessOrigin(origin: string): boolean {
  try { const url = new URL(origin); return url.origin === origin && (url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))); } catch { return false; }
}

/**
 * An origin the deployment may list for the editor (ESIGN_FRAME_ANCESTORS, kept in
 * `app_settings.editor_origins`): a valid access origin spelled only with lowercase host
 * characters, digits, dots, hyphens, an optional bracketed IPv6 literal and an optional port. It
 * therefore holds no quote, backslash, semicolon or space and is safe in SQL and in JSON. Checked
 * wherever the list is written and on every origin an editing session is started for.
 */
export function validEditorOrigin(origin: string): boolean {
  return /^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/.test(origin) && validAccessOrigin(origin);
}

/**
 * SQL: `origin` is one of the editor origins the deployment allows, both SQL expressions of the
 * caller's statement (`tenant` is the session's organization; every organization gets the same
 * list). The list is the JSON array `app_settings.editor_origins`; only its string elements are
 * compared, by exact equality. It is read inside the caller's statement, so an origin dropped from
 * ESIGN_FRAME_ANCESTORS stops working at the next editor request, once `syncEditorOrigins` ran.
 */
export const editorOriginAllowed = (tenant: string, origin: string): string =>
  `(${tenant} IS NOT NULL AND EXISTS (SELECT 1 FROM app_settings eos, json_each(eos.value) eoo WHERE eos.name='editor_origins' AND eoo.type='text' AND eoo.value=${origin}))`;

/**
 * Records the editor origins the deployment allows (`origins`, from ESIGN_FRAME_ANCESTORS) where
 * the editor's SQL reads them. Writes only when the list changed. Invalid origins are dropped.
 */
export async function syncEditorOrigins(db: D1Database, origins: readonly string[]): Promise<void> {
  const value = JSON.stringify(origins.filter(validEditorOrigin));
  await db.prepare(`INSERT INTO app_settings (name, value) VALUES ('editor_origins', ?)
    ON CONFLICT (name) DO UPDATE SET value = excluded.value WHERE app_settings.value IS NOT excluded.value`).bind(value).run();
}

function assertScope(scope: AccessScope): void {
  if (scope !== 'recipient' && scope !== 'editor') throw new Error('Invalid scope');
}

/**
 * SQL: the subject of access row `a` still exists and may be accessed, per scope. A recipient's
 * task is ACTIVE in an IN_PROGRESS envelope of the row's tenant. An editor session belongs to the
 * row's tenant and its parent origin, the row's origin, is still an editor origin the deployment allows.
 */
function subjectOpen(scope: AccessScope, a: string): string {
  if (scope === 'recipient') return `EXISTS (SELECT 1 FROM tasks at JOIN envelopes ae ON ae.id=at.envelope_id
    WHERE at.id=${a}.subject_id AND ae.tenant_id=${a}.tenant_id AND ae.status='IN_PROGRESS' AND at.status='ACTIVE')`;
  return `EXISTS (SELECT 1 FROM editor_sessions ax
    WHERE ax.id=${a}.subject_id AND ax.tenant_id=${a}.tenant_id AND ax.parent_origin=${a}.origin AND ${editorOriginAllowed('ax.tenant_id', 'ax.parent_origin')})`;
}

/**
 * SQL for the signing routes: a recipient session `s` joined to its task `t` and the task's
 * envelope `e` of the session's tenant. The caller's WHERE must still say `s.scope='recipient'`.
 */
export const RECIPIENT_SESSION_FROM = 'access_sessions s JOIN tasks t ON t.id=s.subject_id JOIN envelopes e ON e.id=t.envelope_id AND e.tenant_id=s.tenant_id';

export type CodeRequest = {
  scope: AccessScope;
  tenantId: string;
  subjectId: string;
  origin: string;
  now: number;
  /** An extra precondition on the new row, aliased `v` (for example the task's envelope). */
  where?: { sql: string; binds: unknown[] };
};

/**
 * Issues a one-time code for a subject that is open now. `before` are statements sent in the
 * same batch ahead of the code (the editor session the code is for). The code row is the commit
 * point: it is inserted only while the subject is open, and the code is returned only when that
 * insert added one row.
 */
export async function issueAccessCode(db: D1Database, request: CodeRequest, before: D1PreparedStatement[] = []): Promise<string> {
  assertScope(request.scope);
  if (!validAccessOrigin(request.origin)) throw new Error('Invalid origin');
  const code = randomHex();
  const insert = db.prepare(`INSERT INTO access_codes (code_hash, scope, tenant_id, subject_id, origin, expires_at)
    SELECT v.code_hash, v.scope, v.tenant_id, v.subject_id, v.origin, v.expires_at
    FROM (SELECT ? AS code_hash, ? AS scope, ? AS tenant_id, ? AS subject_id, ? AS origin, ? AS expires_at) v
    WHERE ${subjectOpen(request.scope, 'v')}${request.where ? ` AND ${request.where.sql}` : ''}`)
    .bind(await accessHash(code), request.scope, request.tenantId, request.subjectId, request.origin, request.now + ACCESS_CODE_TTL_MS, ...(request.where?.binds ?? []));
  const results = await db.batch([...before, insert]);
  if (results[results.length - 1].meta.changes !== 1) throw new Error('Subject unavailable');
  return code;
}

export type ExchangeRequest = {
  scope: AccessScope;
  code: string;
  now: number;
  /** The code must have been issued for this origin (the signing page's origin). */
  origin?: string;
  /** The code must have been issued for this subject (the editor page's session id). */
  subjectId?: string;
};

/**
 * Exchanges a one-time code of the given scope for a session token. The session row is written
 * first: its token is returned only if the code is then marked used. The commit point is that
 * compare-and-set on `used_at IS NULL`, so a code is exchanged at most once even under
 * concurrency; a session row whose CAS lost is an unreachable, harmless orphan.
 */
export async function exchangeAccessCode(db: D1Database, request: ExchangeRequest): Promise<string> {
  assertScope(request.scope);
  if (!HEX64.test(request.code)) throw new Error('Invalid code');
  if (request.origin !== undefined && !validAccessOrigin(request.origin)) throw new Error('Invalid code');
  if (request.origin === undefined && request.subjectId === undefined) throw new Error('Unbound exchange');
  const token = randomHex(), tokenHash = await accessHash(token);
  const conditions = ['c.scope=?', 'c.code_hash=?', 'c.used_at IS NULL', 'c.expires_at>?'];
  const binds: unknown[] = [request.scope, await accessHash(request.code), request.now];
  if (request.origin !== undefined) { conditions.push('c.origin=?'); binds.push(request.origin); }
  if (request.subjectId !== undefined) { conditions.push('c.subject_id=?'); binds.push(request.subjectId); }
  const valid = `${conditions.join(' AND ')} AND ${subjectOpen(request.scope, 'c')}`;
  const [, used] = await db.batch([
    db.prepare(`INSERT INTO access_sessions (token_hash, scope, tenant_id, subject_id, origin, expires_at)
      SELECT ?, c.scope, c.tenant_id, c.subject_id, c.origin, ? FROM access_codes c WHERE ${valid}`)
      .bind(tokenHash, request.now + ACCESS_SESSION_TTL_MS, ...binds),
    db.prepare(`UPDATE access_codes AS c SET used_at=? WHERE ${valid}
      AND EXISTS (SELECT 1 FROM access_sessions s WHERE s.token_hash=? AND s.scope=c.scope AND s.tenant_id=c.tenant_id AND s.subject_id=c.subject_id)`)
      .bind(request.now, ...binds, tokenHash),
  ]);
  if (used.meta.changes !== 1) throw new Error('Invalid code');
  return token;
}

export type AccessSession = { tenantId: string; subjectId: string; origin: string; tokenHash: string };

/**
 * The live session of the given scope that a bearer token opens, whose subject is still open.
 * With `origin`, the session must also have been opened for that origin.
 */
export async function authorizeAccess(db: D1Database, request: { scope: AccessScope; token: string; now: number; origin?: string }): Promise<AccessSession> {
  assertScope(request.scope);
  if (!HEX64.test(request.token)) throw new Error('Invalid session');
  if (request.origin !== undefined && !validAccessOrigin(request.origin)) throw new Error('Invalid session');
  const tokenHash = await accessHash(request.token);
  const binds: unknown[] = [request.scope, tokenHash, request.now];
  if (request.origin !== undefined) binds.push(request.origin);
  const row = await db.prepare(`SELECT s.tenant_id, s.subject_id, s.origin FROM access_sessions s
    WHERE s.scope=? AND s.token_hash=? AND s.expires_at>?${request.origin !== undefined ? ' AND s.origin=?' : ''} AND ${subjectOpen(request.scope, 's')}`)
    .bind(...binds).first<{ tenant_id: string; subject_id: string; origin: string }>();
  if (!row) throw new Error('Invalid session');
  return { tenantId: row.tenant_id, subjectId: row.subject_id, origin: row.origin, tokenHash };
}
