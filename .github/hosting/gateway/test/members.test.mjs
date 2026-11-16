// What apps learn about their organizations' people (DESIGN.md §2.4, §8.9): the x-suger-org-role and
// x-suger-member-lookup headers (and where they are never sent), the member lookup, member status and member events
// endpoints (an app's own token only, organizations where it is used only), and a member event for every way
// membership, app access, roles, owners, API clients and organizations change. All data is synthetic.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, hkdfSync } from 'node:crypto'
import { APPS, NAVIGATE, SECRET_KEY, UUID, startGateway, uniqueEmail } from './helpers/harness.mjs'
import { appToken, connect, form, tool } from './helpers/oauth.mjs'
import { housekeeping } from '../src/housekeeping.ts'
import { insertCustomRole, removeGrant, updateCustomRole, upsertGrant } from '../src/db/grants.ts'
import { joinOrg, joinOrgByScim, leaveBySso } from '../src/db/sso.ts'
import { setOrgStatus, setUserStatus } from '../src/super/db.ts'
import { memberEventFor } from '../src/members/events.ts'
import { signMemberLookup, verifyMemberLookup } from '../src/members/lookup-token.ts'

const CAPTABLE = APPS.find((app) => app.name === 'captable')
const PERMISSIONS = [
  { key: 'captable.view', label: 'View the cap table', description: 'See holdings.', role: 'VIEWER' },
  { key: 'captable.edit', label: 'Change the cap table', description: 'Record transactions.', role: 'EDITOR' },
  { key: 'captable.people', label: 'Manage holders', description: 'Add and remove holders.', role: 'ADMIN' },
]
// Cap Table with a permission catalog, a public path and a tick; Ledger, a second app deployed here too.
const UNDER_TEST = [
  { ...CAPTABLE, permissions: PERMISSIONS, publicPaths: ['/api/public/'], scheduled: '/api/scheduled' },
  { name: 'ledger', title: 'Ledger', summary: 'A second app, deployed in these tests.', binding: 'APP_LEDGER' },
]
const CAPTABLE_TOKEN = appToken(SECRET_KEY, 'captable')
const LEDGER_TOKEN = appToken(SECRET_KEY, 'ledger')
const OPERATOR = { id: '00000000-0000-4000-8000-0000000000aa', email: 'ops@staff.example.test', name: 'Synthetic Operator' }
const DAY_MS = 24 * 60 * 60 * 1000

let h
let keyless
let limited
before(async () => {
  ;[h, keyless, limited] = await Promise.all([
    startGateway({ apps: UNDER_TEST, stubBindings: ['APP_LEDGER'] }),
    startGateway({ vars: { GATEWAY_SECRET_KEY: undefined } }),
    startGateway({ appLimit: 3 }),
  ])
})
after(async () => { await Promise.all([h?.close(), keyless?.close(), limited?.close()]) })

/** What the stub app received for a request as `person` (a browser, signed in). */
async function echo(person, app = 'captable', headers = {}, harness = h) {
  const response = await person.client.get(harness.url(app, '/api/echo'), { headers })
  assert.equal(response.status, 200, response.text.slice(0, 300))
  return JSON.parse(response.text).headers
}

/** A GET to one of the app endpoints, with an app's token unless `token` is null. */
function appGet(path, { token = CAPTABLE_TOKEN, headers = {}, harness = h, site = 'apex', client } = {}) {
  return (client ?? harness.client()).get(harness.url(site, path), { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } })
}

function appPost(path, body, { token = CAPTABLE_TOKEN, harness = h, site = 'apex', client } = {}) {
  return (client ?? harness.client()).request(harness.url(site, path), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  })
}

const parsed = (response) => JSON.parse(response.text)

/** The current member-events cursor for an app. */
async function cursor(token = CAPTABLE_TOKEN) {
  const response = await appGet('/__insulin/member-events', { token })
  assert.equal(response.status, 200, response.text)
  return parsed(response).cursor
}

/** Every event an app reads after `since`, page by page, and those of one organization. */
async function eventsSince(since, { token = CAPTABLE_TOKEN, org } = {}) {
  const all = []
  let at = since
  for (;;) {
    const response = await appGet(`/__insulin/member-events?since=${at}`, { token })
    assert.equal(response.status, 200, response.text)
    const page = parsed(response)
    all.push(...page.events)
    at = page.cursor
    if (!page.more) break
  }
  return org ? all.filter((event) => event.org === org) : all
}

/** Events without ids and times, for comparing. */
const shape = (events) => events.map(({ id, at, ...rest }) => rest)

/** An owner with an organization where Cap Table is used. */
async function team(name = 'Members Org') {
  const owner = await h.user({ name: 'Olga Owner' })
  const orgId = await h.org(owner.client, name)
  await echo(owner)
  return { owner, orgId }
}

/** Invites `invitee` with an organization role, or to specific apps (`grants`: { captable: 'EDITOR' }), and accepts. */
async function invite(owner, orgId, invitee, role, grants = {}) {
  const fields = { email: invitee.email, role, ...Object.fromEntries(Object.entries(grants).map(([app, grant]) => [`app:${app}`, grant])) }
  const invited = await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations`), fields)
  assert.equal(invited.status, 303, invited.text.slice(0, 300))
  const link = await h.link(invitee.email, '/invitations/', (await h.mails(invitee.email)).length)
  const accepted = await invitee.client.post(`${link}/accept`, {})
  assert.ok([200, 303].includes(accepted.status), `accept: ${accepted.status}`)
}

async function person(name) {
  return h.user({ name })
}

/** An API client of Cap Table made on its API access page, and an access token for it. */
async function apiClient(owner, orgId, name = 'Nightly sync', role = 'EDITOR', harness = h) {
  const created = await owner.client.post(harness.url('apex', '/apps/captable/settings/api/clients'), { org_id: orgId, name, role })
  assert.equal(created.status, 200, created.text.slice(0, 300))
  const clientId = /(ia_sa_[A-Za-z0-9_-]{22})/.exec(created.text)[1]
  const secret = /(ia_sk_[A-Za-z0-9_-]{43})/.exec(created.text)[1]
  const [row] = await harness.sql('SELECT id FROM service_accounts WHERE client_id = ?1', clientId)
  const token = await form(harness.client(), harness.url('apex', '/oauth/token'), { grant_type: 'client_credentials', resource: harness.url('captable').replace(/\/$/, '') }, {
    Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
  })
  assert.equal(token.status, 200, token.text)
  return { id: row.id, accessToken: token.json.access_token }
}

/** The member lookup header the gateway signed on `person`'s last browser request. */
async function lookupHeader(person, harness = h) {
  return (await echo(person, 'captable', {}, harness))['x-suger-member-lookup']
}

function lookup(q, header, { token = CAPTABLE_TOKEN, harness = h } = {}) {
  return appGet(`/__insulin/members?q=${encodeURIComponent(q)}`, { token, harness, headers: header ? { 'x-suger-member-lookup': header } : {} })
}

/** The test's own HMAC of the member lookup header (HKDF "insulin-apps:member-lookup"), to forge one. */
function sign(app, org, user, expires) {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET_KEY, 'base64'), Buffer.alloc(0), 'insulin-apps:member-lookup', 32))
  return createHmac('sha256', key).update(`v1|${app}|${org}|${user}|${expires}`).digest('base64url')
}

test('browser requests carry x-suger-org-role and a member lookup header signed for the app, the organization and the person', async () => {
  const { owner, orgId } = await team('Header Org')
  const editor = await person('Eddie Editor')
  const apps = await person('Ada Apps')
  await invite(owner, orgId, editor, 'EDITOR')
  await invite(owner, orgId, apps, 'APPS', { captable: 'VIEWER' })
  assert.equal((await echo(owner))['x-suger-org-role'], 'OWNER')
  assert.equal((await echo(editor))['x-suger-org-role'], 'EDITOR')
  const seen = await echo(apps)
  assert.equal(seen['x-suger-org-role'], 'APPS', 'a specific-apps member')
  assert.equal(seen['x-suger-app-role'], 'VIEWER')
  const header = seen['x-suger-member-lookup']
  const match = new RegExp(`^v1\\.(${UUID})\\.(${UUID})\\.(\\d+)\\.([A-Za-z0-9_-]{43})$`).exec(header)
  assert.ok(match, header)
  assert.equal(match[1], orgId)
  assert.equal(match[2], apps.id)
  const expires = Number(match[3])
  assert.ok(Math.abs(expires - (Math.floor(Date.now() / 1000) + 300)) <= 5, 'five minutes ahead')
  assert.equal(match[4], sign('captable', orgId, apps.id, expires), 'an HMAC from a key derived from GATEWAY_SECRET_KEY, over them and the app')
  // Another app's request carries its own signature.
  const ledger = (await echo(owner, 'ledger'))['x-suger-member-lookup'].split('.')
  assert.equal(ledger[4], sign('ledger', orgId, owner.id, Number(ledger[3])))
})

test('ACC-14: forged identity headers do nothing: a Viewer claiming OWNER and ADMIN, or another member lookup, is sent as they are', async () => {
  const { owner, orgId } = await team('Forgery Org')
  const viewer = await person('Vic Viewer')
  await invite(owner, orgId, viewer, 'VIEWER')
  const forged = `v1.${orgId}.${owner.id}.${Math.floor(Date.now() / 1000) + 300}.${'A'.repeat(43)}`
  const seen = await echo(viewer, 'captable', {
    'x-suger-org-role': 'OWNER', 'X-Suger-App-Role': 'ADMIN', 'x-suger-member-lookup': forged, 'X-SUGER-ORG-ROLE': 'ADMIN',
  })
  assert.equal(seen['x-suger-org-role'], 'VIEWER')
  assert.equal(seen['x-suger-app-role'], 'VIEWER')
  assert.equal(seen['x-suger-app-permissions'], 'captable.view')
  assert.notEqual(seen['x-suger-member-lookup'], forged)
  assert.equal(seen['x-suger-member-lookup'].split('.')[2], viewer.id, 'the header names the person who sent the request')
  // The owner's own forged header gets the owner nothing either.
  assert.equal((await lookup('Olga', forged)).status, 403)
})

test('AI agents get the organization role but no member lookup; API clients, public paths and the tick get neither', async () => {
  const { owner, orgId } = await team('Ways In Org')
  const spoof = { 'x-suger-org-role': 'OWNER', 'x-suger-member-lookup': 'v1.forged' }

  const agent = await connect(h, owner, orgId)
  const mcp = (await tool(h, agent.access_token, 'read', { path: '/api/echo' })).structuredContent.body.headers
  assert.equal(mcp['x-suger-access-via'], 'mcp')
  assert.equal(mcp['x-suger-org-role'], 'OWNER')
  assert.equal(mcp['x-suger-member-lookup'], undefined)

  const client = await apiClient(owner, orgId)
  const api = await h.client().get(h.url('captable', '/api/echo'), { headers: { Authorization: `Bearer ${client.accessToken}`, ...spoof } })
  assert.equal(api.status, 200, api.text)
  const viaApi = parsed(api).headers
  assert.equal(viaApi['x-suger-access-via'], 'api')
  assert.equal(viaApi['x-suger-org-role'], undefined, 'an API client has no organization role')
  assert.equal(viaApi['x-suger-member-lookup'], undefined)

  const open = parsed(await owner.client.get(h.url('captable', '/api/public/echo'), { headers: spoof })).headers
  assert.equal(open['x-suger-access-via'], 'public')
  assert.equal(open['x-suger-org-role'], undefined)
  assert.equal(open['x-suger-member-lookup'], undefined)

  const start = (await h.ticks()).length
  const result = await (await h.mf.getWorker('gateway')).scheduled({ cron: '*/5 * * * *' })
  assert.equal(result.outcome, 'ok')
  let ticks = []
  for (let attempt = 0; attempt < 200 && ticks.length <= start; attempt += 1) {
    ticks = await h.ticks()
    if (ticks.length <= start) await new Promise((accept) => setTimeout(accept, 25))
  }
  const tick = ticks[start].headers
  assert.equal(tick['x-suger-access-via'], 'schedule')
  assert.equal(tick['x-suger-org-role'], undefined)
  assert.equal(tick['x-suger-member-lookup'], undefined)
})

test('LIM-08: without GATEWAY_SECRET_KEY browser requests go on without a member lookup header, and the endpoints answer 503', async () => {
  const owner = await keyless.user()
  await keyless.org(owner.client, 'Keyless Org')
  const seen = await echo(owner, 'captable', {}, keyless)
  assert.equal(seen['x-suger-org-role'], 'OWNER')
  assert.equal(seen['x-suger-member-lookup'], undefined)
  for (const path of ['/__insulin/limits', '/__insulin/members?q=a', '/__insulin/member-events']) {
    const answer = await appGet(path, { harness: keyless })
    assert.equal(answer.status, 503, path)
    assert.deepEqual(parsed(answer), { error: 'not_configured' })
  }
  const status = await appPost('/__insulin/members/status', { org: '00000000-0000-4000-8000-000000000001', ids: [] }, { harness: keyless })
  assert.equal(status.status, 503)
})

test('the endpoints take only an app\'s own token, on the apex: no token, a session, an agent\'s or an API client\'s token, or an app host get nothing', async () => {
  const { owner, orgId } = await team('Auth Org')
  const agent = await connect(h, owner, orgId)
  const client = await apiClient(owner, orgId)
  const header = await lookupHeader(owner)
  const gets = ['/__insulin/limits', '/__insulin/member-events', '/__insulin/members?q=Olga']
  for (const path of gets) {
    const extra = { 'x-suger-member-lookup': header }
    assert.equal((await appGet(path, { token: null, headers: extra })).status, 401, `${path}: no token`)
    assert.equal((await appGet(path, { token: null, headers: extra, client: owner.client })).status, 401, `${path}: a session`)
    assert.equal((await appGet(path, { token: agent.access_token, headers: extra })).status, 401, `${path}: an AI agent's token`)
    assert.equal((await appGet(path, { token: client.accessToken, headers: extra })).status, 401, `${path}: an API client's token`)
    assert.equal((await appGet(path, { token: appToken(Buffer.alloc(32, 7).toString('base64'), 'captable'), headers: extra })).status, 401, `${path}: another key's token`)
    assert.equal((await appGet(path, { site: 'captable', headers: extra })).status, 404, `${path}: an app host`)
    assert.equal((await appPost(path, {})).status, 405, `${path}: POST`)
  }
  const body = { org: orgId, ids: [owner.id] }
  assert.equal((await appPost('/__insulin/members/status', body, { token: null })).status, 401)
  assert.equal((await appPost('/__insulin/members/status', body, { token: null, client: owner.client })).status, 401)
  assert.equal((await appPost('/__insulin/members/status', body, { token: agent.access_token })).status, 401)
  assert.equal((await appPost('/__insulin/members/status', body, { token: client.accessToken })).status, 401)
  assert.equal((await appPost('/__insulin/members/status', body, { site: 'captable' })).status, 404)
  assert.equal((await appGet('/__insulin/members/status')).status, 405)
  assert.equal((await appPost('/__insulin/members/status', body)).status, 200, 'the app\'s own token')
  assert.doesNotMatch(h.logText(), new RegExp(CAPTABLE_TOKEN), 'tokens are never logged')
})

test('ACC-18: the member lookup shows no more than a sharing dialog needs, to people who can use the app', async () => {
  const { owner, orgId } = await team('Lookup Org')
  const admin = await person('Sam Search')
  await invite(owner, orgId, admin, 'APPS', { captable: 'ADMIN' })
  const findable = [await person('Searchable Editor'), await person('Searchable Viewer')]
  await invite(owner, orgId, findable[0], 'EDITOR')
  await invite(owner, orgId, findable[1], 'APPS', { captable: 'VIEWER' })
  const ledgerOnly = await person('Searchable Ledger Only')
  await invite(owner, orgId, ledgerOnly, 'APPS', { ledger: 'ADMIN' })
  const elsewhere = await h.user({ name: 'Searchable Elsewhere' })
  await h.org(elsewhere.client, 'Another Org')
  const live = await apiClient(owner, orgId, 'Searchable Sync', 'VIEWER')
  const revoked = await apiClient(owner, orgId, 'Searchable Revoked', 'VIEWER')
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/oauth-clients/api/${revoked.id}/revoke`), {})).status, 303)

  const header = await lookupHeader(admin)
  const found = await lookup('searchable', header)
  assert.equal(found.status, 200, found.text)
  const { members } = parsed(found)
  assert.deepEqual(members, [
    { type: 'person', id: findable[0].id, name: 'Searchable Editor', email: findable[0].email, appRole: 'EDITOR' },
    { type: 'person', id: findable[1].id, name: 'Searchable Viewer', email: findable[1].email, appRole: 'VIEWER' },
    { type: 'client', id: live.id, name: 'Searchable Sync' },
  ], 'people without Cap Table, other organizations\' people and revoked clients are never found; nothing but these fields')
  // By address too, and wildcards are literal.
  assert.deepEqual(parsed(await lookup(findable[0].email, header)).members.map((member) => member.id), [findable[0].id])
  assert.deepEqual(parsed(await lookup('100%', header)).members, [])

  // At most 20.
  for (let index = 0; index < 22; index += 1) {
    await h.sql("INSERT INTO users (id, email, name, email_verified_at, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, 0)", `00000000-0000-4000-8000-${String(index).padStart(4, '0')}${orgId.slice(-8)}`, uniqueEmail('many'), `Many Searchable ${index}`)
    await h.sql("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'VIEWER', 0, 0)", orgId, `00000000-0000-4000-8000-${String(index).padStart(4, '0')}${orgId.slice(-8)}`)
  }
  assert.equal(parsed(await lookup('searchable', header)).members.length, 20)

  // The header must be this app's, unexpired, untouched, and for someone who can still use the app.
  const [version, org, user, expires] = header.split('.')
  assert.equal((await lookup('searchable', null)).status, 403, 'without the header')
  assert.equal((await lookup('searchable', `${version}.${org}.${owner.id}.${expires}.${header.split('.')[4]}`)).status, 403, 'another person')
  assert.equal((await lookup('searchable', `${version}.${org}.${user}.${Number(expires) + 60}.${header.split('.')[4]}`)).status, 403, 'a later expiry')
  const past = Math.floor(Date.now() / 1000) - 1
  assert.equal((await lookup('searchable', `v1.${org}.${user}.${past}.${sign('captable', org, user, past)}`)).status, 403, 'expired')
  assert.equal((await lookup('searchable', header, { token: LEDGER_TOKEN })).status, 403, "another app's token")
  assert.equal((await lookup('', header)).status, 400, 'a query is required')
  assert.equal((await lookup('x'.repeat(101), header)).status, 400)
  const ledgerHeader = (await echo(ledgerOnly, 'ledger'))['x-suger-member-lookup']
  assert.equal((await lookup('searchable', ledgerHeader)).status, 403, 'a header signed for another app')
  assert.equal((await lookup('searchable', ledgerHeader, { token: LEDGER_TOKEN })).status, 200, 'that app reads its own')
  assert.deepEqual(parsed(await lookup('searchable ledger', ledgerHeader, { token: LEDGER_TOKEN })).members.map((member) => member.id), [ledgerOnly.id])
  // Losing access to the app ends it at once, header or not.
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${admin.id}/remove`), {})).status, 303)
  assert.equal((await lookup('searchable', header)).status, 403)
  assert.match(h.logText(), /"event":"member_lookup_refused","app":"captable","reason":"invalid"/)
})

test('the member lookup is limited per person', async () => {
  const owner = await limited.user()
  await limited.org(owner.client, 'Limited Org')
  const header = await lookupHeader(owner, limited)
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await lookup('a', header, { harness: limited })).status, 200)
  const refused = await lookup('a', header, { harness: limited })
  assert.equal(refused.status, 429)
  assert.equal(refused.headers.get('retry-after'), '60')
  const other = await limited.user()
  await limited.org(other.client, 'Other Limited Org')
  assert.equal((await lookup('a', await lookupHeader(other, limited), { harness: limited })).status, 200, 'another person isn\'t held up')
})

test('ACC-13: member status: who can still use the app with their roles, who left, API clients, gone ids, the owners since when; another organization\'s people are no members', async () => {
  const { owner, orgId } = await team('Status Org')
  const editor = await person('Stan Editor')
  const leaver = await person('Lee Leaver')
  const ledgerOnly = await person('Lena Ledger')
  const suspended = await person('Sue Suspended')
  await invite(owner, orgId, editor, 'EDITOR')
  await invite(owner, orgId, leaver, 'VIEWER')
  await invite(owner, orgId, ledgerOnly, 'APPS', { ledger: 'EDITOR' })
  await invite(owner, orgId, suspended, 'VIEWER')
  await setUserStatus(h.db, { userId: suspended.id, status: 'suspended', reason: 'Synthetic check', operator: OPERATOR, label: suspended.email, now: Date.now() })
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${leaver.id}/remove`), {})).status, 303)
  const live = await apiClient(owner, orgId, 'Live client', 'EDITOR')
  const revoked = await apiClient(owner, orgId, 'Revoked client', 'VIEWER')
  await owner.client.post(h.url('apex', `/orgs/${orgId}/oauth-clients/api/${revoked.id}/revoke`), {})
  const other = await team('Status Other Org')
  const gone = '00000000-0000-4000-8000-00000000dead'

  const ids = [owner.id, editor.id, leaver.id, ledgerOnly.id, suspended.id, live.id, revoked.id, other.owner.id, gone]
  const answer = await appPost('/__insulin/members/status', { org: orgId, ids })
  assert.equal(answer.status, 200, answer.text)
  const body = parsed(answer)
  assert.equal(body.org, orgId)
  assert.deepEqual(body.owners.map((entry) => entry.user), [owner.id])
  assert.match(body.owners[0].since, /^\d{4}-\d{2}-\d{2}T/)
  const byId = Object.fromEntries(body.members.map((entry) => [entry.id, entry]))
  assert.deepEqual(byId[owner.id], { id: owner.id, type: 'person', status: 'member', orgRole: 'OWNER', appRole: 'ADMIN', permissions: ['captable.view', 'captable.edit', 'captable.people'] })
  assert.deepEqual(byId[editor.id], { id: editor.id, type: 'person', status: 'member', orgRole: 'EDITOR', appRole: 'EDITOR', permissions: ['captable.view', 'captable.edit'] })
  assert.deepEqual(byId[leaver.id], { id: leaver.id, type: 'person', status: 'left' })
  assert.deepEqual(byId[ledgerOnly.id], { id: ledgerOnly.id, type: 'person', status: 'left' }, 'a member without this app')
  assert.equal(byId[suspended.id].status, 'member', 'a suspended account still counts')
  assert.deepEqual(byId[live.id], { id: live.id, type: 'client', status: 'member', appRole: 'EDITOR', permissions: ['captable.view', 'captable.edit'] })
  assert.deepEqual(byId[revoked.id], { id: revoked.id, type: 'client', status: 'revoked' })
  assert.deepEqual(byId[other.owner.id], { id: other.owner.id, type: 'person', status: 'left' }, 'someone of another organization is no member here')
  assert.deepEqual(byId[gone], { id: gone, type: null, status: 'gone' })
  assert.doesNotMatch(answer.text, /@example\.test|Stan Editor/, 'no names or addresses')

  // A suspended organization still counts; Ledger sees the member who has it.
  await setOrgStatus(h.db, { orgId, status: 'suspended', reason: 'Synthetic check', operator: OPERATOR, label: 'Status Org', now: Date.now() })
  assert.equal(parsed(await appPost('/__insulin/members/status', { org: orgId, ids: [editor.id] })).members[0].status, 'member')
  assert.equal((await appPost('/__insulin/members/status', { org: orgId, ids: [ledgerOnly.id] }, { token: LEDGER_TOKEN })).status, 404, 'Ledger has not been used there')
  await setOrgStatus(h.db, { orgId, status: 'active', reason: 'Synthetic check', operator: OPERATOR, label: 'Status Org', now: Date.now() })
  await echo(ledgerOnly, 'ledger')
  assert.deepEqual(parsed(await appPost('/__insulin/members/status', { org: orgId, ids: [ledgerOnly.id] }, { token: LEDGER_TOKEN })).members[0],
    { id: ledgerOnly.id, type: 'person', status: 'member', orgRole: 'APPS', appRole: 'EDITOR' }, 'Ledger has no catalog, so no permissions')
  assert.deepEqual(parsed(await appPost('/__insulin/members/status', { org: orgId, ids: [live.id] }, { token: LEDGER_TOKEN })).members[0],
    { id: live.id, type: null, status: 'gone' }, "another app's client is none of Ledger's")

  // Requests the endpoint refuses.
  assert.equal((await appPost('/__insulin/members/status', { org: orgId, ids: Array.from({ length: 101 }, () => gone) })).status, 400, 'more than 100 ids')
  assert.equal((await appPost('/__insulin/members/status', { org: orgId, ids: ['not-an-id'] })).status, 400)
  assert.equal((await appPost('/__insulin/members/status', { org: 'nope', ids: [] })).status, 400)
  assert.equal((await appPost('/__insulin/members/status', { org: gone, ids: [] })).status, 404)
  assert.equal(parsed(await appPost('/__insulin/members/status', { org: gone, ids: [] })).error, 'org_deleted')
  // A deleted organization.
  assert.equal((await other.owner.client.post(h.url('apex', `/orgs/${other.orgId}/delete`), { confirm: 'Status Other Org' })).status, 303)
  const deleted = await appPost('/__insulin/members/status', { org: other.orgId, ids: [other.owner.id] })
  assert.equal(deleted.status, 404)
  assert.deepEqual(parsed(deleted), { error: 'org_deleted' })
})

test('member events: no cursor gives the current one; then the app\'s own events, oldest first, never another organization\'s or app\'s', async () => {
  const empty = await appGet('/__insulin/member-events')
  assert.equal(empty.status, 200)
  assert.equal(parsed(empty).events.length, 0)
  assert.equal(parsed(empty).more, false)
  const start = parsed(empty).cursor
  assert.match(start, /^\d+$/)
  const { owner, orgId } = await team('Events Org')
  const viewer = await person('Val Viewer')
  await invite(owner, orgId, viewer, 'VIEWER')
  // An organization where Cap Table is never used, and a Ledger-only member's grant.
  const unused = await h.user()
  const unusedOrg = await h.org(unused.client, 'Unused Org')
  const ledgerOnly = await person('Lou Ledger')
  await invite(owner, orgId, ledgerOnly, 'APPS', { ledger: 'VIEWER' })

  const events = await eventsSince(start)
  assert.ok(events.every((event) => event.org !== unusedOrg), 'an organization where the app is not used')
  const mine = events.filter((event) => event.org === orgId)
  assert.deepEqual(shape(mine), [
    { type: 'returned', org: orgId, user: owner.id, orgRole: 'OWNER', appRole: 'ADMIN', permissions: ['captable.view', 'captable.edit', 'captable.people'] },
    { type: 'owners', org: orgId, owners: [{ user: owner.id, since: mine[1].owners[0].since }] },
    { type: 'returned', org: orgId, user: viewer.id, orgRole: 'VIEWER', appRole: 'VIEWER', permissions: ['captable.view'] },
  ], 'the Ledger-only grant is Ledger\'s')
  assert.ok(mine.every((event, index) => index === 0 || Number(event.id) > Number(mine[index - 1].id)), 'oldest first')
  assert.ok(Number.isFinite(Date.parse(mine[0].at)))
  // Ledger, once used there, sees its own grant and the organization-wide events.
  await echo(ledgerOnly, 'ledger')
  const ledgerEvents = shape(await eventsSince(start, { token: LEDGER_TOKEN, org: orgId }))
  assert.deepEqual(ledgerEvents.map((event) => event.type), ['returned', 'owners', 'returned', 'returned'])
  assert.deepEqual(ledgerEvents[3], { type: 'returned', org: orgId, user: ledgerOnly.id, orgRole: 'APPS', appRole: 'VIEWER' })
  // The cursor moves past everything read.
  const last = parsed(await appGet(`/__insulin/member-events?since=${start}`))
  assert.equal((await eventsSince(last.cursor)).filter((event) => event.org === orgId).length, 0)
  assert.equal((await appGet('/__insulin/member-events?since=abc')).status, 400)
  assert.equal((await appGet('/__insulin/member-events?since=-1')).status, 400)
})

test('member events come 1,000 a page with a cursor; a cursor from before the 90 days\' cleanup, or one never given, gets 410', async () => {
  const { orgId } = await team('Paging Org')
  const start = await cursor()
  await h.sql(
    `INSERT INTO member_events (app, org_id, type, subject, payload, at)
     SELECT '*', ?1, 'left', printf('00000000-0000-4000-8000-%012d', n), '{}', ?2 FROM (
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1500) SELECT n FROM seq)`,
    orgId, Date.now(),
  )
  const first = parsed(await appGet(`/__insulin/member-events?since=${start}`))
  assert.equal(first.events.length, 1000)
  assert.equal(first.more, true)
  assert.equal(first.cursor, first.events[999].id)
  const second = parsed(await appGet(`/__insulin/member-events?since=${first.cursor}`))
  assert.equal(second.events.length, 500)
  assert.equal(second.more, false)
  assert.deepEqual(new Set([...first.events, ...second.events].map((event) => event.user)).size, 1500, 'each once')

  // An event past 90 days goes with the cleanup, and a cursor before it can no longer be trusted.
  const before = await cursor()
  await h.sql("INSERT INTO member_events (app, org_id, type, subject, payload, at) VALUES ('*', ?1, 'left', ?2, '{}', ?3)", orgId, '00000000-0000-4000-8000-00000000beef', Date.now() - 91 * DAY_MS)
  const after = await cursor()
  await housekeeping(h.db, Date.now())
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM member_events WHERE subject = '00000000-0000-4000-8000-00000000beef'"))[0].n, 0)
  const expired = await appGet(`/__insulin/member-events?since=${before}`)
  assert.equal(expired.status, 410)
  assert.deepEqual(parsed(expired), { error: 'cursor_expired' })
  assert.equal((await appGet(`/__insulin/member-events?since=${after}`)).status, 200, 'a cursor at or after it is fine')
  assert.equal((await appGet(`/__insulin/member-events?since=${Number(after) + 10_000}`)).status, 410, 'a cursor this gateway never gave')
})

test('events: an invitation with a role or with the app, a change of role, and owners made and unmade (ACC-16)', async () => {
  const { owner, orgId } = await team('Roles Org')
  const start = await cursor()
  const editor = await person('Rae Editor')
  const second = await person('Sid Second')
  await invite(owner, orgId, editor, 'EDITOR')
  await invite(owner, orgId, second, 'ADMIN')
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${editor.id}/role`), { role: 'VIEWER' })).status, 303)
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${second.id}/role`), { role: 'OWNER' })).status, 303)
  assert.equal((await second.client.post(h.url('apex', `/orgs/${orgId}/members/${owner.id}/role`), { role: 'ADMIN' })).status, 303)
  const events = shape(await eventsSince(start, { org: orgId }))
  const [{ since: secondSince }] = events[4].owners.filter((entry) => entry.user === second.id)
  assert.deepEqual(events, [
    { type: 'returned', org: orgId, user: editor.id, orgRole: 'EDITOR', appRole: 'EDITOR', permissions: ['captable.view', 'captable.edit'] },
    { type: 'returned', org: orgId, user: second.id, orgRole: 'ADMIN', appRole: 'ADMIN', permissions: ['captable.view', 'captable.edit', 'captable.people'] },
    { type: 'role_changed', org: orgId, user: editor.id, orgRole: 'VIEWER', appRole: 'VIEWER', permissions: ['captable.view'] },
    { type: 'role_changed', org: orgId, user: second.id, orgRole: 'OWNER', appRole: 'ADMIN', permissions: ['captable.view', 'captable.edit', 'captable.people'] },
    { type: 'owners', org: orgId, owners: events[4].owners },
    { type: 'role_changed', org: orgId, user: owner.id, orgRole: 'ADMIN', appRole: 'ADMIN', permissions: ['captable.view', 'captable.edit', 'captable.people'] },
    { type: 'owners', org: orgId, owners: [{ user: second.id, since: secondSince }] },
  ])
  assert.deepEqual(events[4].owners.map((entry) => entry.user), [owner.id, second.id], 'the longest-standing owner first')
  assert.ok(Date.parse(events[4].owners[0].since) <= Date.parse(secondSince))
})

test('events: moving to specific apps is one change for an app kept and a departure for the others; moving back is a return', async () => {
  const { owner, orgId } = await team('Apps Move Org')
  const mover = await person('Mo Mover')
  await invite(owner, orgId, mover, 'EDITOR')
  await echo(mover, 'ledger')
  const start = await cursor()
  const ledgerStart = await cursor(LEDGER_TOKEN)
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${mover.id}/role`), { role: 'APPS', 'app:captable': 'VIEWER' })).status, 303)
  assert.deepEqual(shape(await eventsSince(start, { org: orgId })), [
    { type: 'role_changed', org: orgId, user: mover.id, orgRole: 'APPS', appRole: 'VIEWER', permissions: ['captable.view'] },
  ], 'one change, no false departure')
  assert.deepEqual(shape(await eventsSince(ledgerStart, { token: LEDGER_TOKEN, org: orgId })), [
    { type: 'left', org: orgId, user: mover.id },
  ], 'Ledger, which they no longer have')
  const back = await cursor()
  const ledgerBack = await cursor(LEDGER_TOKEN)
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${mover.id}/role`), { role: 'EDITOR' })).status, 303)
  assert.deepEqual(shape(await eventsSince(back, { org: orgId })), [
    { type: 'role_changed', org: orgId, user: mover.id, orgRole: 'EDITOR', appRole: 'EDITOR', permissions: ['captable.view', 'captable.edit'] },
  ])
  assert.deepEqual(shape(await eventsSince(ledgerBack, { token: LEDGER_TOKEN, org: orgId })), [
    { type: 'returned', org: orgId, user: mover.id, orgRole: 'EDITOR', appRole: 'EDITOR' },
  ], 'back in Ledger')
})

test('events: an app\'s own people page: invited, role changed, and removed from the app, with the organization going with the last app', async () => {
  const { owner, orgId } = await team('App People Org')
  const member = await person('Pat Apps')
  await invite(owner, orgId, member, 'APPS', { ledger: 'VIEWER' })
  const start = await cursor()
  const appPost = (path, fields) => owner.client.post(h.url('apex', `/apps/captable/settings/users${path}`), { org_id: orgId, ...fields })
  assert.equal((await appPost('/invite', { email: member.email, role: 'VIEWER' })).status, 303, 'an existing specific-apps member gets the app at once')
  assert.equal((await appPost(`/${member.id}/role`, { role: 'EDITOR' })).status, 303)
  assert.equal((await appPost(`/${member.id}/remove`, {})).status, 303)
  assert.deepEqual(shape(await eventsSince(start, { org: orgId })), [
    { type: 'returned', org: orgId, user: member.id, orgRole: 'APPS', appRole: 'VIEWER', permissions: ['captable.view'] },
    { type: 'role_changed', org: orgId, user: member.id, orgRole: 'APPS', appRole: 'EDITOR', permissions: ['captable.view', 'captable.edit'] },
    { type: 'left', org: orgId, user: member.id },
  ])
  // The database functions behind those pages, and removing the last app, which takes the membership with it.
  const next = await cursor()
  await echo(owner, 'ledger')
  const ledgerStart = await cursor(LEDGER_TOKEN)
  assert.equal(await upsertGrant(h.db, { orgId, userId: member.id, grant: { app: 'captable', role: 'ADMIN', customRoleId: null }, actorId: owner.id, now: Date.now() }), true)
  assert.equal(await removeGrant(h.db, { orgId, userId: member.id, app: 'ledger', actorId: owner.id }), true)
  assert.equal(await removeGrant(h.db, { orgId, userId: member.id, app: 'captable', actorId: owner.id }), true)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, member.id))[0].n, 0)
  assert.deepEqual(shape(await eventsSince(next, { org: orgId })).map((event) => event.type), ['returned', 'left'])
  assert.deepEqual(shape(await eventsSince(ledgerStart, { token: LEDGER_TOKEN, org: orgId })), [{ type: 'left', org: orgId, user: member.id }])
})

test('ACC-15: someone removed and invited again: left, then returned, and member status follows', async () => {
  const { owner, orgId } = await team('Return Org')
  const editor = await person('Ren Returner')
  await invite(owner, orgId, editor, 'EDITOR')
  const start = await cursor()
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${editor.id}/remove`), {})).status, 303)
  assert.equal(parsed(await appPost('/__insulin/members/status', { org: orgId, ids: [editor.id] })).members[0].status, 'left')
  assert.equal((await editor.client.get(h.url('captable', '/api/echo'))).status, 403, 'their next request is refused')
  await invite(owner, orgId, editor, 'EDITOR')
  assert.deepEqual(shape(await eventsSince(start, { org: orgId })), [
    { type: 'left', org: orgId, user: editor.id },
    { type: 'returned', org: orgId, user: editor.id, orgRole: 'EDITOR', appRole: 'EDITOR', permissions: ['captable.view', 'captable.edit'] },
  ])
  assert.equal(parsed(await appPost('/__insulin/members/status', { org: orgId, ids: [editor.id] })).members[0].status, 'member')
})

test('events: removed, leaving, and an owner leaving: each left, and the owners after it', async () => {
  const { owner, orgId } = await team('Leaving Org')
  const removed = await person('Rex Removed')
  const leaver = await person('Lia Leaver')
  const coOwner = await person('Cole Owner')
  await invite(owner, orgId, removed, 'EDITOR')
  await invite(owner, orgId, leaver, 'VIEWER')
  await invite(owner, orgId, coOwner, 'OWNER')
  const start = await cursor()
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/members/${removed.id}/remove`), {})).status, 303)
  assert.equal((await leaver.client.post(h.url('apex', `/orgs/${orgId}/leave`), {})).status, 303)
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/leave`), {})).status, 303)
  const events = shape(await eventsSince(start, { org: orgId }))
  assert.deepEqual(events.map((event) => [event.type, event.user]), [
    ['left', removed.id], ['left', leaver.id], ['left', owner.id], ['owners', undefined],
  ])
  assert.deepEqual(events[3].owners.map((entry) => entry.user), [coOwner.id])
})

test('events: deleting an account is leaving every organization; suspending one is no departure', async () => {
  const { owner, orgId } = await team('Account Org')
  const doomed = await person('Dee Deleted')
  const paused = await person('Pia Paused')
  await invite(owner, orgId, doomed, 'APPS', { captable: 'EDITOR', ledger: 'VIEWER' })
  await invite(owner, orgId, paused, 'VIEWER')
  await echo(owner, 'ledger')
  const start = await cursor()
  const ledgerStart = await cursor(LEDGER_TOKEN)
  await setUserStatus(h.db, { userId: paused.id, status: 'suspended', reason: 'Synthetic check', operator: OPERATOR, label: paused.email, now: Date.now() })
  assert.equal((await doomed.client.post(h.url('apex', '/account/delete'), { confirm: doomed.email })).status, 200)
  assert.deepEqual(shape(await eventsSince(start, { org: orgId })), [{ type: 'left', org: orgId, user: doomed.id }])
  assert.deepEqual(shape(await eventsSince(ledgerStart, { token: LEDGER_TOKEN, org: orgId })), [{ type: 'left', org: orgId, user: doomed.id }])
})

test('DEL-05: deleting an organization tells each app that used it org_deleted, and nothing else; it is answered for no more', async () => {
  const { owner, orgId } = await team('Deleted Org')
  const editor = await person('Ed Gone')
  await invite(owner, orgId, editor, 'EDITOR')
  await apiClient(owner, orgId, 'Doomed client')
  const start = await cursor()
  const ledgerStart = await cursor(LEDGER_TOKEN)
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/delete`), { confirm: 'Deleted Org' })).status, 303)
  assert.deepEqual(shape(await eventsSince(start, { org: orgId })), [{ type: 'org_deleted', org: orgId }])
  assert.deepEqual(await eventsSince(ledgerStart, { token: LEDGER_TOKEN, org: orgId }), [], 'Ledger was never used there')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM app_orgs WHERE org_id = ?1', orgId))[0].n, 0, 'the gateway forgets where it was used')
  // An organization deleted with its only member's account says so too.
  const solo = await h.user()
  const soloOrg = await h.org(solo.client, 'Solo Org')
  await echo(solo)
  const next = await cursor()
  assert.equal((await solo.client.post(h.url('apex', '/account/delete'), { confirm: solo.email })).status, 200)
  assert.deepEqual(shape(await eventsSince(next, { org: soloOrg })), [{ type: 'org_deleted', org: soloOrg }])
})

test('events: SCIM provisioning and deprovisioning, a domain\'s removal, and single sign-on joining', async () => {
  const domain = 'members-scim.test'
  const { owner, orgId } = await team('SCIM Events Org')
  await h.sql('INSERT INTO sso_domains (org_id, domain, token, created_at, verified_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, domain, 'synthetic-token', Date.now())
  const created = await owner.client.post(h.url('auth', `/orgs/${orgId}/sso/scim-tokens`), { name: 'Test IdP' })
  const token = /<code[^>]*>([A-Za-z0-9_-]{43})<\/code>/.exec(created.text)[1]
  const scim = (method, path, body) => h.client().request(h.url('apex', `/scim/v2${path}`), {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json' }, body: body ? JSON.stringify(body) : undefined,
  })
  const start = await cursor()
  const user = 'urn:ietf:params:scim:schemas:core:2.0:User'
  const first = parsed(await scim('POST', '/Users', { schemas: [user], userName: `first@${domain}`, active: true }))
  const second = parsed(await scim('POST', '/Users', { schemas: [user], userName: `second@${domain}`, active: true }))
  assert.equal((await scim('PATCH', `/Users/${first.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] })).status, 200)
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/sso/domains/remove`), { domain })).status, 303)
  const events = shape(await eventsSince(start, { org: orgId }))
  assert.deepEqual(events.map((event) => [event.type, event.user]), [
    ['returned', first.id], ['returned', second.id], ['left', first.id], ['left', second.id],
  ])
  // The statements SCIM and single sign-on use, directly.
  const next = await cursor()
  const sso = await person('Sso Joiner')
  assert.equal(await joinOrg(h.db, orgId, sso.id, 'VIEWER', Date.now(), 1000), true)
  await h.sql('INSERT INTO sso_domains (org_id, domain, token, created_at, verified_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, 'example.test', 'synthetic-token', Date.now())
  const scimJoin = await person('Scim Joiner')
  assert.equal(await joinOrgByScim(h.db, orgId, scimJoin.id, 'EDITOR', Date.now(), 1000), true)
  assert.equal(await leaveBySso(h.db, orgId, scimJoin.id), 'removed')
  assert.deepEqual(shape(await eventsSince(next, { org: orgId })).map((event) => [event.type, event.user, event.orgRole]), [
    ['returned', sso.id, 'VIEWER'], ['returned', scimJoin.id, 'EDITOR'], ['left', scimJoin.id, undefined],
  ])
})

test('events: an API client revoked, deleted, or revoked with its organization disabled; a custom role\'s new permissions', async () => {
  const { owner, orgId } = await team('Clients Org')
  const revoked = await apiClient(owner, orgId, 'Revoked here')
  const deletedLive = await apiClient(owner, orgId, 'Deleted live')
  const deletedFromApi = await apiClient(owner, orgId, 'Deleted from its page')
  const disabledWith = await apiClient(owner, orgId, 'Disabled with the organization')
  const start = await cursor()
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/oauth-clients/api/${revoked.id}/revoke`), {})).status, 303)
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/oauth-clients/api/${revoked.id}/delete`), {})).status, 303, 'deleting a revoked one says nothing new')
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/oauth-clients/api/${deletedLive.id}/delete`), {})).status, 303)
  assert.equal((await owner.client.post(h.url('apex', `/apps/captable/settings/api/clients/${deletedFromApi.id}/delete`), { org_id: orgId })).status, 303)
  await setOrgStatus(h.db, { orgId, status: 'disabled', reason: 'Synthetic check', operator: OPERATOR, label: 'Clients Org', now: Date.now() })
  assert.deepEqual(shape(await eventsSince(start, { org: orgId })), [
    { type: 'client_revoked', org: orgId, client: revoked.id },
    { type: 'client_revoked', org: orgId, client: deletedLive.id },
    { type: 'client_revoked', org: orgId, client: deletedFromApi.id },
    { type: 'client_revoked', org: orgId, client: disabledWith.id },
  ], 'disabling is no departure of its people')
  await setOrgStatus(h.db, { orgId, status: 'active', reason: 'Synthetic check', operator: OPERATOR, label: 'Clients Org', now: Date.now() })

  // A custom role whose permissions change changes the role of everyone who has it.
  const roleId = '00000000-0000-4000-8000-0000000c0de1'
  assert.equal(await insertCustomRole(h.db, { id: roleId, orgId, app: 'captable', name: 'Board observer', description: '', permissions: ['captable.view'], actorId: owner.id, now: Date.now() }), true)
  const board = await person('Bo Board')
  await invite(owner, orgId, board, 'APPS', { captable: `custom:${roleId}` })
  const next = await cursor()
  assert.equal(await updateCustomRole(h.db, { id: roleId, orgId, name: 'Board observer', description: '', permissions: ['captable.view', 'captable.edit'], actorId: owner.id, now: Date.now() }), true)
  assert.deepEqual(shape(await eventsSince(next, { org: orgId })), [
    { type: 'role_changed', org: orgId, user: board.id, orgRole: 'APPS', appRole: 'EDITOR', permissions: ['captable.view', 'captable.edit'] },
  ])
})

test('the member lookup header and member events, as pure functions', async () => {
  const master = Buffer.from(SECRET_KEY, 'base64')
  const org = '00000000-0000-4000-8000-000000000001'
  const user = '00000000-0000-4000-8000-000000000002'
  const now = Date.UTC(2026, 10, 16, 12)
  const header = await signMemberLookup(master, 'captable', org, user, now)
  assert.deepEqual(await verifyMemberLookup(master, 'captable', header, now), { org, user })
  assert.deepEqual(await verifyMemberLookup(master, 'captable', header, now + 300_000), { org, user }, 'good for five minutes')
  assert.deepEqual(await verifyMemberLookup(master, 'captable', header, now + 301_000), { problem: 'expired' })
  assert.deepEqual(await verifyMemberLookup(master, 'ledger', header, now), { problem: 'invalid' })
  assert.deepEqual(await verifyMemberLookup(Buffer.alloc(32, 1), 'captable', header, now), { problem: 'invalid' })
  assert.deepEqual(await verifyMemberLookup(master, 'captable', null, now), { problem: 'missing' })
  assert.deepEqual(await verifyMemberLookup(master, 'captable', header.replace('v1.', 'v2.'), now), { problem: 'malformed' })
  assert.deepEqual(await verifyMemberLookup(master, 'captable', `${header}.extra`, now), { problem: 'malformed' })
  const swapped = header.split('.')
  ;[swapped[1], swapped[2]] = [swapped[2], swapped[1]]
  assert.deepEqual(await verifyMemberLookup(master, 'captable', swapped.join('.'), now), { problem: 'invalid' })

  const app = { name: 'captable', permissions: PERMISSIONS }
  const row = (type, payload, extra = {}) => ({ id: 7, app: '*', org_id: org, type, subject: user, payload: JSON.stringify(payload), at: now, ...extra })
  assert.equal(memberEventFor(app, row('returned', { orgRole: 'APPS' })), null, 'a specific-apps membership gives no app by itself')
  assert.deepEqual(memberEventFor(app, row('role_changed', { orgRole: 'APPS', from: 'VIEWER', grantsAfter: { ledger: { role: 'ADMIN' } } })),
    { id: '7', org, at: new Date(now).toISOString(), type: 'left', user })
  assert.deepEqual(memberEventFor(app, row('role_changed', { orgRole: 'APPS', from: 'VIEWER', grantsAfter: { captable: { role: 'CUSTOM', permissions: ['captable.people'] } } })),
    { id: '7', org, at: new Date(now).toISOString(), type: 'role_changed', user, orgRole: 'APPS', appRole: 'ADMIN', permissions: ['captable.people'] })
  assert.equal(memberEventFor(app, row('role_changed', { orgRole: 'EDITOR', from: 'APPS', grantsBefore: ['ledger'] })).type, 'returned')
  assert.equal(memberEventFor(app, row('role_changed', { orgRole: 'EDITOR', from: 'APPS', grantsBefore: ['captable'] })).type, 'role_changed')
  assert.equal(memberEventFor(app, row('role_changed', { orgRole: 'NOBODY' })), null)
  assert.equal(memberEventFor(app, row('returned', 'not json')), null)
})
