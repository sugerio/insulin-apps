// SCIM 2.0 at /scim/v2 (RFC 7643, 7644; DESIGN.md §7): an organization's identity provider adds and removes its
// people with a bearer token an owner created. Only addresses in the organization's verified domains. Creating adds
// the person with the connection's default role; deactivating or deleting removes them from the organization (never
// its last owner). Their sessions stay: without the membership they can't act in this organization, and they may
// belong to others. Roles stay managed on /settings/users.
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { UUID_PATTERN, newId, sha256Hex } from '../crypto.ts'
import {
  confirmByIdentityProvider, domainOf, findConnection, findScimUser, isVerifiedDomain, joinOrgByScim, leaveBySso, linkScimUser,
  listScimUsers, unlinkScimUser, useScimToken, type ScimUserRow,
} from '../db/sso.ts'
import { findUserByEmail, insertUser, setUserName } from '../db/users.ts'
import { jsonHeaders } from '../http/headers.ts'
import { BodyTooLarge, readText } from '../http/request.ts'
import { log, logError } from '../log.ts'
import { MEMBER_LIMIT } from '../orgs/invitations.ts'
import { NAME_MAX, cleanText, normalizeEmail, truncate } from '../validate.ts'

export const SCIM_BASE = '/scim/v2'
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User'
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const BODY_LIMIT_BYTES = 64 * 1024
const PAGE_MAX = 100
const USER_PATH = new RegExp(`^/Users/(${UUID_PATTERN})$`)

function scim(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const headers = jsonHeaders()
  headers.set('Content-Type', 'application/scim+json; charset=utf-8')
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return new Response(body === null ? null : JSON.stringify(body), { status, headers })
}

/** An error in RFC 7644 §3.12's shape. */
function problem(status: number, detail: string, scimType?: string, extra: Record<string, string> = {}): Response {
  return scim({ schemas: [ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status, extra)
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function resource(ctx: Context, row: ScimUserRow): Record<string, unknown> {
  return {
    schemas: [USER],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.email,
    name: { formatted: row.name },
    displayName: row.name,
    emails: [{ value: row.email, type: 'work', primary: true }],
    active: Boolean(row.member),
    meta: { resourceType: 'User', created: iso(row.created_at), lastModified: iso(row.updated_at), location: apexUrl(ctx, `${SCIM_BASE}/Users/${row.id}`) },
  }
}

const SERVICE_PROVIDER_CONFIG = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: PAGE_MAX },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A token an owner creates under Single sign-on settings.' }],
}

function resourceType(ctx: Context): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    id: 'User', name: 'User', endpoint: '/Users', schema: USER,
    meta: { resourceType: 'ResourceType', location: apexUrl(ctx, `${SCIM_BASE}/ResourceTypes/User`) },
  }
}

function userSchema(ctx: Context): Record<string, unknown> {
  const attribute = (name: string, extra: Record<string, unknown> = {}) => ({
    name, type: 'string', multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra,
  })
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    id: USER, name: 'User', description: 'A person in the organization',
    attributes: [
      attribute('userName', { required: true, uniqueness: 'server', mutability: 'immutable' }),
      attribute('displayName'),
      { ...attribute('name'), type: 'complex', subAttributes: [attribute('formatted'), attribute('givenName'), attribute('familyName')] },
      { ...attribute('emails'), type: 'complex', multiValued: true, mutability: 'readOnly', subAttributes: [attribute('value'), attribute('type'), { ...attribute('primary'), type: 'boolean' }] },
      { ...attribute('active'), type: 'boolean' },
      attribute('externalId', { caseExact: true }),
    ],
    meta: { resourceType: 'Schema', location: apexUrl(ctx, `${SCIM_BASE}/Schemas/${USER}`) },
  }
}

/**
 * Per token, on the app limiter (RL_APP): an identity provider syncing a directory sends far more than a person signs
 * in. Fails open, like the app limit: abuse protection, not access control.
 */
async function allowScim(ctx: Context, tokenHash: string): Promise<boolean> {
  try {
    const { success } = await ctx.config.rlApp.limit({ key: `scim:token:${tokenHash}` })
    if (!success) log('rate_limited', { action: 'scim' })
    return success
  } catch (error) {
    logError('rate_limit_failed', error, { action: 'scim' })
    return true
  }
}

/** The organization a request's bearer token belongs to, or the 401 to send. */
async function authenticate(ctx: Context): Promise<{ orgId: string; tokenHash: string } | Response> {
  const header = ctx.request.headers.get('Authorization') ?? ''
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header)?.[1]
  const challenge = { 'WWW-Authenticate': 'Bearer realm="scim"' }
  if (!token) return problem(401, 'A SCIM bearer token is required.', undefined, challenge)
  const tokenHash = await sha256Hex(token)
  const orgId = await useScimToken(ctx.config.db, tokenHash, ctx.now)
  if (!orgId) {
    log('scim_token_rejected')
    return problem(401, 'This token is not valid. It may have been revoked.', undefined, challenge)
  }
  return { orgId, tokenHash }
}

async function readBody(ctx: Context): Promise<Record<string, unknown> | Response> {
  if (!/^application\/(scim\+)?json(\s*;|$)/i.test(ctx.request.headers.get('Content-Type') ?? '')) {
    return problem(415, 'Send application/scim+json.')
  }
  let text: string
  try {
    text = await readText(ctx.request, BODY_LIMIT_BYTES)
  } catch (error) {
    if (error instanceof BodyTooLarge) return problem(413, 'The request is too large.')
    throw error
  }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Falls through to the error below.
  }
  return problem(400, 'The body must be a JSON object.', 'invalidSyntax')
}

export async function scimRoutes(ctx: Context): Promise<Response> {
  const auth = await authenticate(ctx)
  if (auth instanceof Response) return auth
  if (!(await allowScim(ctx, auth.tokenHash))) return problem(429, 'Too many requests. Slow down and try again.', undefined, { 'Retry-After': '60' })
  const path = ctx.url.pathname.slice(SCIM_BASE.length) || '/'
  const method = ctx.request.method === 'HEAD' ? 'GET' : ctx.request.method
  const only = (allowed: string, handle: () => Promise<Response> | Response) => (method === allowed ? handle() : problem(405, 'Method not allowed.', undefined, { Allow: allowed }))
  if (path === '/ServiceProviderConfig') return only('GET', () => scim({ ...SERVICE_PROVIDER_CONFIG, meta: { resourceType: 'ServiceProviderConfig', location: apexUrl(ctx, `${SCIM_BASE}/ServiceProviderConfig`) } }))
  if (path === '/ResourceTypes') return only('GET', () => scim({ schemas: [LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [resourceType(ctx)] }))
  if (path === '/ResourceTypes/User') return only('GET', () => scim(resourceType(ctx)))
  if (path === '/Schemas') return only('GET', () => scim({ schemas: [LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [userSchema(ctx)] }))
  if (path === `/Schemas/${USER}`) return only('GET', () => scim(userSchema(ctx)))
  if (path === '/Users') {
    if (method === 'GET') return listUsers(ctx, auth.orgId)
    if (method === 'POST') return createUser(ctx, auth.orgId)
    return problem(405, 'Method not allowed.', undefined, { Allow: 'GET, POST' })
  }
  const match = USER_PATH.exec(path)
  if (match) {
    const userId = match[1]!
    if (method === 'GET') return getUser(ctx, auth.orgId, userId)
    if (method === 'PUT') return replaceUser(ctx, auth.orgId, userId)
    if (method === 'PATCH') return patchUser(ctx, auth.orgId, userId)
    if (method === 'DELETE') return deleteUser(ctx, auth.orgId, userId)
    return problem(405, 'Method not allowed.', undefined, { Allow: 'GET, PUT, PATCH, DELETE' })
  }
  return problem(404, 'There is no such SCIM resource.')
}

/** `userName eq "…"`, the one filter SCIM clients use to find a person; anything else is refused. */
function parseFilter(filter: string | null): { email: string | null } | Response {
  if (filter === null || filter.trim() === '') return { email: null }
  const match = /^\s*userName\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter)
  if (!match) return problem(400, 'Only the filter userName eq "…" is supported.', 'invalidFilter')
  return { email: normalizeEmail(match[1]!.replace(/\\(.)/g, '$1')) ?? '' }
}

async function listUsers(ctx: Context, orgId: string): Promise<Response> {
  const params = ctx.url.searchParams
  const filter = parseFilter(params.get('filter'))
  if (filter instanceof Response) return filter
  const startIndex = Math.max(1, Number.parseInt(params.get('startIndex') ?? '1', 10) || 1)
  const requested = Number.parseInt(params.get('count') ?? String(PAGE_MAX), 10)
  const count = Math.min(PAGE_MAX, Math.max(0, Number.isNaN(requested) ? PAGE_MAX : requested))
  const { total, users } = filter.email === ''
    ? { total: 0, users: [] }
    : await listScimUsers(ctx.config.db, orgId, { email: filter.email, offset: startIndex - 1, count })
  return scim({ schemas: [LIST], totalResults: total, startIndex, itemsPerPage: users.length, Resources: users.map((row) => resource(ctx, row)) })
}

async function getUser(ctx: Context, orgId: string, userId: string): Promise<Response> {
  const row = await findScimUser(ctx.config.db, orgId, userId)
  return row ? scim(resource(ctx, row)) : problem(404, 'There is no such user in this organization.')
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' ? truncate(cleanText(value), max) || null : null
}

/** A display name from SCIM's name, displayName or nothing. */
function nameFrom(body: Record<string, unknown>): string | null {
  const name = typeof body.name === 'object' && body.name !== null ? (body.name as Record<string, unknown>) : {}
  return text(name.formatted, NAME_MAX)
    ?? text([name.givenName, name.familyName].filter((part) => typeof part === 'string').join(' '), NAME_MAX)
    ?? text(body.displayName, NAME_MAX)
}

/** The address a SCIM user names: its userName, or its primary e-mail. */
function emailFrom(body: Record<string, unknown>): string | null {
  const userName = normalizeEmail(body.userName)
  if (userName) return userName
  const emails = Array.isArray(body.emails) ? (body.emails as Record<string, unknown>[]) : []
  const primary = emails.find((entry) => entry?.primary === true) ?? emails[0]
  return primary ? normalizeEmail(primary.value) : null
}

/** SCIM booleans arrive as true/false, or (Entra) "True"/"False". */
function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true'
  return null
}

async function defaultRole(ctx: Context, orgId: string): Promise<'EDITOR' | 'VIEWER'> {
  return (await findConnection(ctx.config.db, orgId))?.default_role ?? 'VIEWER'
}

/**
 * Makes membership follow `active`: joins with the default role, or leaves (never the last owner). Joining re-checks,
 * in the same statement, that the address is in one of the organization's verified domains now.
 */
async function setActive(ctx: Context, orgId: string, userId: string, active: boolean): Promise<Response | null> {
  const db = ctx.config.db
  if (active) {
    if (!(await joinOrgByScim(db, orgId, userId, await defaultRole(ctx, orgId), ctx.now, MEMBER_LIMIT))) {
      return problem(409, `The person can't join: the organization has reached its limit of ${MEMBER_LIMIT} members, or their address is no longer in one of its verified domains.`)
    }
    return null
  }
  if ((await leaveBySso(db, orgId, userId)) === 'last_owner') {
    return problem(409, 'This person is the organization\'s only owner, so they can\'t be removed. Make someone else an owner first.')
  }
  return null
}

async function createUser(ctx: Context, orgId: string): Promise<Response> {
  const body = await readBody(ctx)
  if (body instanceof Response) return body
  const db = ctx.config.db
  const email = emailFrom(body)
  if (!email) return problem(400, 'userName must be an e-mail address.', 'invalidValue')
  // SCIM compares domains as stored (punycode), so an address must use that form too.
  if (domainOf(email) !== email.slice(email.lastIndexOf('@') + 1)) return problem(400, 'Write the address\'s domain in its ASCII (punycode) form.', 'invalidValue')
  if (!(await isVerifiedDomain(db, orgId, domainOf(email)))) return problem(400, 'The address isn\'t in one of the organization\'s verified domains.', 'invalidValue')
  let user = await findUserByEmail(db, email)
  if (user && await findScimUser(db, orgId, user.id)) return problem(409, 'This user already exists in the organization.', 'uniqueness')
  if (user) {
    if (user.email_verified_at === null) await confirmByIdentityProvider(db, user.id, ctx.now)
  } else {
    const id = newId()
    await insertUser(db, { id, email, name: nameFrom(body) ?? email, passwordHash: null, verifiedAt: ctx.now, googleSub: null, now: ctx.now })
    user = await findUserByEmail(db, email)
    if (user) log('scim_user_created', { org: orgId, user: user.id })
  }
  if (!user) return problem(500, 'The user could not be created.')
  if (bool(body.active) !== false) {
    const refused = await setActive(ctx, orgId, user.id, true)
    if (refused) return refused
  }
  await linkScimUser(db, orgId, user.id, text(body.externalId, 200), ctx.now)
  log('scim_user_provisioned', { org: orgId, user: user.id })
  const row = await findScimUser(db, orgId, user.id)
  if (!row) return problem(409, 'The address is no longer in one of the organization\'s verified domains.', 'invalidValue')
  return scim(resource(ctx, row), 201, { Location: apexUrl(ctx, `${SCIM_BASE}/Users/${row.id}`) })
}

/** Applies a name, an active flag and an external id (any may be absent) to a provisioned person. */
async function apply(ctx: Context, orgId: string, row: ScimUserRow, change: { name: string | null; active: boolean | null; externalId: string | null }): Promise<Response> {
  const db = ctx.config.db
  if (change.name && change.name !== row.name) await setUserName(db, row.id, change.name, ctx.now)
  if (change.active !== null && change.active !== Boolean(row.member)) {
    const refused = await setActive(ctx, orgId, row.id, change.active)
    if (refused) return refused
    log(change.active ? 'scim_user_activated' : 'scim_user_deactivated', { org: orgId, user: row.id })
  }
  await linkScimUser(db, orgId, row.id, change.externalId, ctx.now)
  const fresh = await findScimUser(db, orgId, row.id) ?? { ...row, member: 0 }
  return scim(resource(ctx, fresh))
}

async function replaceUser(ctx: Context, orgId: string, userId: string): Promise<Response> {
  const row = await findScimUser(ctx.config.db, orgId, userId)
  if (!row) return problem(404, 'There is no such user in this organization.')
  const body = await readBody(ctx)
  if (body instanceof Response) return body
  const email = emailFrom(body)
  if (email && email !== row.email) return problem(400, 'userName can\'t be changed.', 'mutability')
  return apply(ctx, orgId, row, { name: nameFrom(body), active: bool(body.active) ?? true, externalId: text(body.externalId, 200) })
}

async function patchUser(ctx: Context, orgId: string, userId: string): Promise<Response> {
  const row = await findScimUser(ctx.config.db, orgId, userId)
  if (!row) return problem(404, 'There is no such user in this organization.')
  const body = await readBody(ctx)
  if (body instanceof Response) return body
  if (!Array.isArray(body.schemas) || !body.schemas.includes(PATCH) || !Array.isArray(body.Operations)) {
    return problem(400, 'Send a PatchOp with Operations.', 'invalidSyntax')
  }
  const change: { name: string | null; active: boolean | null; externalId: string | null } = { name: null, active: null, externalId: null }
  const names: { given?: string; family?: string } = {}
  const set = (path: string, value: unknown): Response | null => {
    switch (path.toLowerCase()) {
      case 'active': {
        const active = bool(value)
        if (active === null) return problem(400, 'active must be true or false.', 'invalidValue')
        change.active = active
        return null
      }
      case 'displayname':
      case 'name.formatted':
        change.name = text(value, NAME_MAX) ?? change.name
        return null
      case 'name.givenname':
        if (typeof value === 'string') names.given = value
        return null
      case 'name.familyname':
        if (typeof value === 'string') names.family = value
        return null
      case 'name':
        if (typeof value === 'object' && value !== null) change.name = nameFrom({ name: value }) ?? change.name
        return null
      case 'externalid':
        change.externalId = text(value, 200)
        return null
      case 'username':
        return normalizeEmail(value) === row.email ? null : problem(400, 'userName can\'t be changed.', 'mutability')
      default:
        // Attributes this service doesn't keep (titles, phone numbers…) are accepted and ignored.
        return null
    }
  }
  for (const operation of body.Operations as Record<string, unknown>[]) {
    const op = typeof operation?.op === 'string' ? operation.op.toLowerCase() : ''
    if (op === 'remove') continue
    if (op !== 'add' && op !== 'replace') return problem(400, 'Only add, replace and remove operations are supported.', 'invalidSyntax')
    if (typeof operation.path === 'string' && operation.path) {
      const refused = set(operation.path, operation.value)
      if (refused) return refused
    } else if (typeof operation.value === 'object' && operation.value !== null) {
      for (const [path, value] of Object.entries(operation.value as Record<string, unknown>)) {
        const refused = set(path, value)
        if (refused) return refused
      }
    } else {
      return problem(400, 'An operation without a path needs an object value.', 'invalidSyntax')
    }
  }
  if (!change.name && (names.given || names.family)) change.name = text([names.given, names.family].filter(Boolean).join(' '), NAME_MAX)
  return apply(ctx, orgId, row, change)
}

async function deleteUser(ctx: Context, orgId: string, userId: string): Promise<Response> {
  const db = ctx.config.db
  const row = await findScimUser(db, orgId, userId)
  if (!row) return problem(404, 'There is no such user in this organization.')
  if (row.member) {
    const refused = await setActive(ctx, orgId, userId, false)
    if (refused) return refused
  }
  await unlinkScimUser(db, orgId, userId)
  log('scim_user_deleted', { org: orgId, user: userId })
  return scim(null, 204)
}
