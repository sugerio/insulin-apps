// The operator console at /super (DESIGN.md §11): off unless configured; sign-in through a stand-in Google Workspace
// SAML app with the operators' group (and every way of failing it); operators read, admins act; suspending, disabling
// and reinstating organizations and accounts, and what each closes at once; an organization created past its owner
// domain's limit; the audit log; the pages. All data is synthetic.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, SECRET_KEY, TOKENS, UUID, startGateway, uniqueEmail } from './helpers/harness.mjs'
import { appToken, connect, rpc } from './helpers/oauth.mjs'
import { encode, makeIdentityProviderKey, requestIdFrom, samlResponse, signResponse } from './helpers/saml-idp.mjs'

const IDP_KEY = makeIdentityProviderKey('Stand-in Workspace')
const OTHER_KEY = makeIdentityProviderKey('Somebody Else')
const IDP_ENTITY = 'https://accounts.example.test/o/saml2/workspace'
const IDP_SSO = 'https://accounts.example.test/o/saml2/sso'
const IDP_ORIGIN = 'https://accounts.example.test'
const GROUP = 'operators@staff.example.test'
const ADMIN = 'ada.admin@staff.example.test'
const OPERATOR = 'otto.operator@staff.example.test'

// Synthetic: a Cloudflare account is 32 hex digits, and the token any printable string.
const CLOUDFLARE_ACCOUNT = 'c'.repeat(32)
const CLOUDFLARE_TOKEN = 'synthetic-read-only-token-0123456789'

const SUPER_VARS = {
  SUPER_SAML_IDP_ENTITY_ID: IDP_ENTITY,
  SUPER_SAML_IDP_SSO_URL: IDP_SSO,
  SUPER_SAML_IDP_CERT: IDP_KEY.certificate,
  SUPER_GOOGLE_GROUP: GROUP,
  SUPER_ADMIN_EMAILS: `${ADMIN}, not-an-address`,
  SUPER_CLOUDFLARE_ACCOUNT_ID: CLOUDFLARE_ACCOUNT,
  SUPER_CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN,
}

let h
let off
before(async () => {
  ;[h, off] = await Promise.all([startGateway({ vars: SUPER_VARS }), startGateway()])
})
after(async () => { await Promise.all([h?.close(), off?.close()]) })

const ACS = () => h.url('apex', '/super/saml/acs')

/** Starts a sign-in in `client`: the redirect to the identity provider and the AuthnRequest's id. */
async function startSignIn(client) {
  const start = await client.get(h.url('apex', '/super/login'))
  assert.equal(start.status, 302, start.text)
  assert.ok(start.location.startsWith(`${IDP_SSO}?SAMLRequest=`), start.location)
  return requestIdFrom(start.location)
}

/** A signed answer from the stand-in Workspace app for `requestId`. */
function answer(requestId, { email = OPERATOR, groups = [GROUP], key = IDP_KEY, ...rest } = {}) {
  const xml = samlResponse({
    issuer: IDP_ENTITY, email, displayName: 'Synthetic Operator', acs: ACS(), entityId: h.url('apex', '/super'), requestId,
    attributes: groups ? { groups } : {}, ...rest,
  })
  return encode(signResponse(xml, key))
}

const acs = (client, samlResponse) => client.post(ACS(), { SAMLResponse: samlResponse }, { origin: IDP_ORIGIN })

/** A browser signed in to the console as `email`. */
async function operator(email = OPERATOR) {
  const client = h.client()
  const { id } = await startSignIn(client)
  const signedIn = await acs(client, answer(id, { email }))
  assert.equal(signedIn.status, 303, signedIn.text.slice(0, 500))
  assert.equal(signedIn.location, h.url('apex', '/super'))
  return client
}

/** An account with an organization and a member, all signed in. */
async function orgWithMember() {
  const owner = await h.user({ name: 'Olive Owner' })
  const orgId = await h.org(owner.client, 'Watched Org')
  const member = await h.user({ name: 'Mo Member' })
  await h.join(owner, orgId, member, 'EDITOR')
  return { owner, member, orgId }
}

const echo = (person) => person.client.get(h.url('captable', '/api/echo'))

test('without its configuration the console is not there', async () => {
  for (const path of ['/super', '/super/login', '/super/orgs', '/super/saml/metadata']) {
    assert.equal((await off.client().get(off.url('apex', path))).status, 404, path)
  }
  const posted = await off.client().post(off.url('apex', '/super/saml/acs'), { SAMLResponse: 'x' }, { origin: IDP_ORIGIN })
  assert.equal(posted.status, 404)
})

test('a set of the settings that is incomplete keeps the console off, and the rest of the site up', async () => {
  const partial = await startGateway({ vars: { SUPER_SAML_IDP_ENTITY_ID: IDP_ENTITY, SUPER_GOOGLE_GROUP: GROUP } })
  try {
    assert.equal((await partial.client().get(partial.url('apex', '/super'))).status, 404)
    assert.equal((await partial.client().get(partial.url('apex', '/'))).status, 200)
    assert.match(partial.logText(), /"event":"config_super_off","problems":"SUPER_SAML_IDP_SSO_URL, SUPER_SAML_IDP_CERT"/)
  } finally {
    await partial.close()
  }
})

test('signed out, the console offers only its sign-in; the metadata names its entity id and ACS', async () => {
  const page = await h.client().get(h.url('apex', '/super'))
  assert.equal(page.status, 200)
  assert.match(page.text, /href="\/super\/login"/)
  assert.match(page.text, /<meta name="robots" content="noindex, nofollow"\/>/)
  assert.equal(page.headers.get('x-robots-tag'), 'noindex')
  assert.doesNotMatch(page.text, /Organizations/)
  for (const path of ['/super/orgs', '/super/users', '/super/apps', '/super/cloudflare', '/super/audit']) {
    const other = await h.client().get(h.url('apex', path))
    assert.equal(other.status, 200, path)
    assert.match(other.text, /href="\/super\/login"/, path)
  }
  const metadata = await h.client().get(h.url('apex', '/super/saml/metadata'))
  assert.equal(metadata.status, 200)
  assert.match(metadata.text, /entityID="http:\/\/insulinapps\.localhost\/super"/)
  assert.match(metadata.text, /Location="http:\/\/insulinapps\.localhost\/super\/saml\/acs"/)
})

test('a member of the operators\' group signs in; the session is the console\'s own, host-only cookie', async () => {
  const client = h.client()
  const { id, xml } = await startSignIn(client)
  assert.match(xml, /AssertionConsumerServiceURL="http:\/\/insulinapps\.localhost\/super\/saml\/acs"/)
  assert.match(xml, /<saml:Issuer>http:\/\/insulinapps\.localhost\/super<\/saml:Issuer>/)
  assert.ok(client.jar.get('insulin_super_flow'), 'the flow cookie binds the sign-in to this browser')
  const signedIn = await acs(client, answer(id))
  assert.equal(signedIn.status, 303, signedIn.text.slice(0, 300))
  const cookie = signedIn.cookies.find((line) => line.startsWith('insulin_super='))
  assert.match(cookie, /^insulin_super=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; HttpOnly; SameSite=Lax$/)
  const overview = await client.get(h.url('apex', '/super'))
  assert.equal(overview.status, 200)
  assert.match(overview.text, /<h1>Overview<\/h1>/)
  assert.match(overview.text, new RegExp(OPERATOR.replaceAll('.', '\\.')))
  assert.match(overview.text, />Operator</, 'not an admin')
  const [row] = await h.sql("SELECT operator_email FROM super_audit WHERE action = 'sign_in' ORDER BY id DESC LIMIT 1")
  assert.equal(row.operator_email, OPERATOR)
  // The console's cookie means nothing to the customers' pages, and a customer's session nothing here.
  assert.equal((await client.get(h.url('apex', '/account'))).status, 302)
  const customer = await h.user()
  assert.match((await customer.client.get(h.url('apex', '/super'))).text, /href="\/super\/login"/)
  // Signing out ends it.
  assert.equal((await client.post(h.url('apex', '/super/logout'))).status, 303)
  assert.match((await client.get(h.url('apex', '/super'))).text, /href="\/super\/login"/)
})

test('everyone else is turned away: no group, another group, another key, a replay, another browser', async () => {
  const outsider = h.client()
  const first = await startSignIn(outsider)
  const noGroup = await acs(outsider, answer(first.id, { email: 'someone@staff.example.test', groups: null }))
  assert.equal(noGroup.status, 403)
  assert.ok(!noGroup.cookies.some((line) => line.startsWith('insulin_super=') && !line.startsWith('insulin_super=;')))

  const second = await startSignIn(outsider)
  assert.equal((await acs(outsider, answer(second.id, { groups: ['everyone@staff.example.test'] }))).status, 403)

  const third = await startSignIn(outsider)
  assert.equal((await acs(outsider, answer(third.id, { key: OTHER_KEY }))).status, 400, 'signed with another key')

  const fourth = await startSignIn(outsider)
  assert.equal((await acs(outsider, answer(fourth.id, { audience: 'https://elsewhere.example.test' }))).status, 400, 'for another service')

  // A good answer works once, in the browser that asked for it.
  const browser = h.client()
  const fifth = await startSignIn(browser)
  const good = answer(fifth.id)
  assert.equal((await acs(h.client(), good)).status, 400, 'another browser')
  assert.equal((await acs(browser, good)).status, 303)
  const sixth = await startSignIn(browser)
  const once = answer(sixth.id)
  assert.equal((await acs(browser, once)).status, 303)
  assert.equal((await acs(browser, once)).status, 400, 'a replay')
  assert.match(h.logText(), /"event":"super_group_refused"/)
  assert.doesNotMatch(h.logText(), /someone@staff\.example\.test/, 'logs carry no address')
})

test('operators read; only admins change a standing or create an organization', async () => {
  const { orgId, member } = await orgWithMember()
  const reader = await operator()
  for (const path of ['/super/orgs', `/super/orgs/${orgId}`, '/super/users', `/super/users/${member.id}`, '/super/apps', '/super/apps/captable', '/super/cloudflare', '/super/audit']) {
    const page = await reader.get(h.url('apex', path))
    assert.equal(page.status, 200, path)
    assert.doesNotMatch(page.text, /Change standing/, path)
  }
  assert.equal((await reader.get(h.url('apex', '/super/orgs/new'))).status, 403)
  const refused = await reader.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'suspended', reason: 'Not allowed to' })
  assert.equal(refused.status, 403)
  assert.equal((await reader.post(h.url('apex', `/super/users/${member.id}/status`), { status: 'disabled', reason: 'Not allowed to' })).status, 403)
  assert.equal((await reader.post(h.url('apex', '/super/orgs'), { email: member.email, name: 'Sneaky', reason: 'Not allowed to' })).status, 403)
  assert.equal((await h.sql('SELECT status FROM orgs WHERE id = ?1', orgId))[0].status, 'active')

  const admin = await operator(ADMIN)
  const page = await admin.get(h.url('apex', `/super/orgs/${orgId}`))
  assert.match(page.text, /Change standing/)
  assert.match(page.text, />Admin</)
  // A form from elsewhere is refused, as on every apex page.
  assert.equal((await admin.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'suspended', reason: 'Cross-site' }, { origin: 'https://evil.example.test' })).status, 403)
  // A reason is required.
  const noReason = await admin.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'suspended', reason: ' ' })
  assert.equal(noReason.status, 400)
  assert.match(noReason.text, /Give a reason/)
})

test('a suspended organization gives its people nothing, at once, and reinstating gives it back', async () => {
  const { owner, member, orgId } = await orgWithMember()
  const agent = await connect(h, member, orgId)
  const token = appToken(SECRET_KEY, 'captable')
  assert.equal((await echo(member)).status, 200)
  assert.equal((await rpc(h, agent.access_token, 'tools/list')).status, 200)

  const admin = await operator(ADMIN)
  const suspended = await admin.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'suspended', reason: 'Phishing reported by a recipient' })
  assert.equal(suspended.status, 303)
  assert.match(suspended.location, /\?notice=suspended$/)

  const app = await echo(member)
  assert.equal(app.status, 403, 'the app')
  assert.match(app.text, /no_organization/)
  assert.equal((await rpc(h, agent.access_token, 'tools/list')).status, 401, 'an AI agent')
  const refresh = await h.client().post(h.url('apex', '/oauth/token'), { grant_type: 'refresh_token', refresh_token: agent.refresh_token, client_id: agent.client.client_id })
  assert.equal(refresh.status, 400, 'its refresh token')
  assert.equal((await owner.client.get(h.url('apex', `/settings/users?org=${orgId}`))).status, 404, "the organization's pages")
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/rename`), { name: 'Renamed' })).status, 404, 'its forms')
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/delete`), { confirm: 'Watched Org' })).status, 404, 'deleting it')
  const home = await owner.client.get(h.url('apex', '/'))
  assert.match(home.text, /Insulin Apps has suspended <strong>Watched Org<\/strong>/)
  const relay = await h.client().post(h.url('apex', '/__insulin/mail'), {}, {
    contentType: 'application/json', headers: { Authorization: `Bearer ${token}`, 'x-suger-organization-id': orgId },
    body: JSON.stringify({ to: uniqueEmail(), subject: 'Hi', text: 'Hello' }),
  })
  assert.equal(relay.status, 403, 'the mail relay')
  assert.equal(JSON.parse(relay.text).error, 'organization_unavailable')
  assert.equal((await h.sql('SELECT status, status_reason FROM orgs WHERE id = ?1', orgId))[0].status_reason, 'Phishing reported by a recipient')
  const repeated = await admin.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'suspended', reason: 'Again' })
  assert.match(repeated.location, /\?notice=unchanged$/)

  const reinstated = await admin.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'active', reason: 'Cleared after review' })
  assert.match(reinstated.location, /\?notice=active$/)
  assert.equal((await echo(member)).status, 200)
  assert.equal((await rpc(h, agent.access_token, 'tools/list')).status, 200, 'a suspension keeps the agent')
  const history = await h.sql("SELECT action, reason, operator_email FROM super_audit WHERE target_id = ?1 ORDER BY id", orgId)
  assert.deepEqual(history, [
    { action: 'org.suspend', reason: 'Phishing reported by a recipient', operator_email: ADMIN },
    { action: 'org.reinstate', reason: 'Cleared after review', operator_email: ADMIN },
  ], 'the repeated suspension changed and recorded nothing')
  const page = await admin.get(h.url('apex', `/super/orgs/${orgId}`))
  assert.match(page.text, /Phishing reported by a recipient/)
})

test('disabling an organization also ends its agents, API clients, invitations and SCIM tokens for good', async () => {
  const { owner, member, orgId } = await orgWithMember()
  await connect(h, member, orgId)
  const invited = await owner.client.post(h.url('apex', `/orgs/${orgId}/invitations`), { email: uniqueEmail('later'), role: 'VIEWER' })
  assert.equal(invited.status, 303)
  const created = await owner.client.post(h.url('apex', '/apps/captable/settings/api/clients'), { org_id: orgId, name: 'Nightly export', role: 'VIEWER' })
  assert.equal(created.status, 200, created.text.slice(0, 300))
  await h.sql("INSERT INTO scim_tokens (id, org_id, name, token_hash, created_by, created_at) VALUES ('00000000-0000-4000-8000-00000000c1a1', ?1, 'IdP', 'synthetic-hash', ?2, 0)", orgId, owner.id)

  const admin = await operator(ADMIN)
  assert.equal((await admin.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'disabled', reason: 'Fraud confirmed' })).status, 303)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_grants WHERE org_id = ?1', orgId))[0].n, 0)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM service_accounts WHERE org_id = ?1 AND revoked_at IS NULL', orgId))[0].n, 0)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM invitations WHERE org_id = ?1 AND status = 'pending'", orgId))[0].n, 0)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM scim_tokens WHERE org_id = ?1', orgId))[0].n, 0)
  assert.match((await owner.client.get(h.url('apex', '/'))).text, /Insulin Apps has disabled <strong>Watched Org<\/strong>/)
  // Reinstating lifts it; what disabling ended stays ended.
  await admin.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'active', reason: 'Appeal granted' })
  assert.equal((await echo(member)).status, 200)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM service_accounts WHERE org_id = ?1 AND revoked_at IS NULL', orgId))[0].n, 0)
})

test('a suspended account is signed out everywhere and can\'t sign in; disabling also deletes its sessions', async () => {
  const { member, orgId } = await orgWithMember()
  const agent = await connect(h, member, orgId)
  const admin = await operator(ADMIN)
  assert.equal((await admin.post(h.url('apex', `/super/users/${member.id}/status`), { status: 'suspended', reason: 'Spam invitations' })).status, 303)
  assert.equal((await echo(member)).status, 401, 'the app')
  const home = await member.client.get(h.url('apex', '/'))
  assert.doesNotMatch(home.text, /Your apps|Apps in/, 'signed out')
  assert.equal((await rpc(h, agent.access_token, 'tools/list')).status, 401, 'an AI agent')
  const signIn = await h.signIn(h.client(), { email: member.email })
  assert.equal(signIn.status, 403)
  assert.match(signIn.text, /This account is suspended/)
  assert.doesNotMatch(signIn.text, /Spam invitations/, 'the reason is the operators\' own')
  assert.ok((await h.sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1', member.id))[0].n > 0, 'suspending keeps the sessions')

  assert.equal((await admin.post(h.url('apex', `/super/users/${member.id}/status`), { status: 'active', reason: 'Owner vouched' })).status, 303)
  assert.equal((await echo(member)).status, 200, 'the same session works again')

  assert.equal((await admin.post(h.url('apex', `/super/users/${member.id}/status`), { status: 'disabled', reason: 'Account takeover' })).status, 303)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1', member.id))[0].n, 0)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?1', member.id))[0].n, 0)
  assert.match((await h.signIn(h.client(), { email: member.email })).text, /This account is disabled/)
  await admin.post(h.url('apex', `/super/users/${member.id}/status`), { status: 'active', reason: 'Recovered' })
  assert.equal((await echo(member)).status, 401, 'disabling ended the old session for good')
  const again = h.client()
  assert.equal((await h.signIn(again, { email: member.email })).status, 303, 'a new sign-in works')
})

test('an admin creates an organization for someone past their owner domain\'s limit; it counts for the domain', async () => {
  const email = `pat.${Date.now()}@limit-reached.test`
  const person = await h.user({ name: 'Pat Person', email })
  await h.org(person.client, 'First')
  await h.org(person.client, 'Second')
  assert.match((await person.client.get(h.url('apex', '/orgs/new'))).text, /Request more organizations/, 'at the limit')

  const admin = await operator(ADMIN)
  const form = await admin.get(h.url('apex', '/super/orgs/new'))
  assert.equal(form.status, 200)
  assert.equal((await admin.post(h.url('apex', '/super/orgs'), { email: uniqueEmail('nobody'), name: 'X', reason: 'Support request' })).status, 404)
  assert.equal((await admin.post(h.url('apex', '/super/orgs'), { email, name: 'Third', reason: '' })).status, 400)
  const created = await admin.post(h.url('apex', '/super/orgs'), { email, name: 'Third', reason: 'Support request about a third team' })
  assert.equal(created.status, 303, created.text.slice(0, 300))
  const orgId = new RegExp(`/super/orgs/(${UUID})\\?notice=created$`).exec(created.location)[1]
  const [org] = await h.sql('SELECT name, owner_domain, created_by, created_by_operator FROM orgs WHERE id = ?1', orgId)
  assert.deepEqual(org, { name: 'Third', owner_domain: 'limit-reached.test', created_by: person.id, created_by_operator: ADMIN })
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, person.id))[0].role, 'OWNER')
  const [mail] = (await h.waitForMail(email, 2)).filter((message) => message.subject === 'Insulin Apps created Third for you')
  assert.ok(mail, 'the owner is told')
  assert.doesNotMatch(mail.text, /ada\.admin/, 'without the operator')
  assert.match(mail.text, new RegExp(`/settings/organization\\?org=${orgId}`))
  const [entry] = await h.sql("SELECT reason, target_label FROM super_audit WHERE action = 'org.create' AND target_id = ?1", orgId)
  assert.equal(entry.reason, 'Support request about a third team')
  assert.match(entry.target_label, /^Third \(for pat\./)
  assert.match((await person.client.get(h.url('apex', '/orgs/new'))).text, /Request more organizations/, 'still at the limit')
})

test('lists search by name, id, owner domain and address; pages show people, usage and history', async () => {
  const { owner, member, orgId } = await orgWithMember()
  await h.sql("UPDATE orgs SET name = 'Zebra Findable Co' WHERE id = ?1", orgId)
  const reader = await operator()
  const byName = await reader.get(h.url('apex', '/super/orgs?q=zebra+findable'))
  assert.match(byName.text, /Zebra Findable Co/)
  assert.match((await reader.get(h.url('apex', `/super/orgs?q=${orgId}`))).text, /Zebra Findable Co/)
  assert.match((await reader.get(h.url('apex', `/super/orgs?q=${encodeURIComponent(member.email)}`))).text, /Zebra Findable Co/)
  assert.doesNotMatch((await reader.get(h.url('apex', '/super/orgs?q=zebra+findable&status=suspended'))).text, /Zebra Findable Co/)
  assert.match((await reader.get(h.url('apex', '/super/orgs?q=100%25_'))).text, /No organization matches/, 'wildcards are literal')
  const detail = await reader.get(h.url('apex', `/super/orgs/${orgId}`))
  assert.match(detail.text, new RegExp(owner.email.replaceAll('.', '\\.')))
  assert.match(detail.text, /Mo Member/)
  assert.match(detail.text, />Editor</)
  assert.match(detail.text, /Within the hour/, 'last active')
  assert.equal((await reader.get(h.url('apex', '/super/orgs/00000000-0000-4000-8000-000000000000'))).status, 404)
  const users = await reader.get(h.url('apex', `/super/users?q=${encodeURIComponent(member.email)}`))
  assert.match(users.text, /Mo Member/)
  const person = await reader.get(h.url('apex', `/super/users/${member.id}`))
  assert.match(person.text, /Zebra Findable Co/)
  assert.doesNotMatch(person.text, /password|google_sub|totp/i, 'nothing of the account but who it is')
})

test('accounts show when they were last active, from the hourly session touch', async () => {
  const person = await h.user()
  const [row] = await h.sql('SELECT last_active_at FROM users WHERE id = ?1', person.id)
  assert.ok(row.last_active_at > Date.now() - 60_000, 'a sign-in counts')
  await h.sql('UPDATE sessions SET last_seen_at = 0 WHERE user_id = ?1', person.id)
  await h.sql('UPDATE users SET last_active_at = 0 WHERE id = ?1', person.id)
  const orgId = await h.org(person.client, 'Touched Org')
  await h.sql('UPDATE sessions SET last_seen_at = 0, active_org_id = ?2 WHERE user_id = ?1', person.id, orgId)
  await h.sql('UPDATE orgs SET last_active_at = 0 WHERE id = ?1', orgId)
  await person.client.get(h.url('apex', '/'))
  assert.ok((await h.sql('SELECT last_active_at FROM users WHERE id = ?1', person.id))[0].last_active_at > 0)
  assert.ok((await h.sql('SELECT last_active_at FROM orgs WHERE id = ?1', orgId))[0].last_active_at > 0)
})

test('signing in with a password, a reset link or the code step all refuse a suspended account', async () => {
  const person = await h.user()
  const admin = await operator(ADMIN)
  await admin.post(h.url('apex', `/super/users/${person.id}/status`), { status: 'suspended', reason: 'Checking a report' })
  const forgot = await h.client().post(h.url('apex', '/forgot-password'), { email: person.email, 'cf-turnstile-response': TOKENS.forgot })
  assert.equal(forgot.status, 200)
  const link = await h.link(person.email, '/reset-password')
  const reset = await h.client().post(h.url('apex', '/reset-password'), { token: new URL(link).searchParams.get('token'), password: `${PASSWORD} again` })
  assert.equal(reset.status, 403)
  assert.match(reset.text, /This account is suspended/)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1', person.id))[0].n, 0, 'no new session')
})

/** An hourly usage report from an app, as its tick sends it. */
function report(body, { app = 'captable', token = appToken(SECRET_KEY, app), site = 'apex' } = {}) {
  return h.client().post(h.url(site, '/__insulin/metrics'), {}, {
    contentType: 'application/json', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const HOUR = 60 * 60 * 1000
const topOfHour = (offset = 0) => new Date(Math.floor(Date.now() / HOUR) * HOUR + offset * HOUR).toISOString().replace('.000Z', 'Z')

test('apps report usage with their own token: checked, stored per hour and day, resent safely', async () => {
  const { orgId } = await orgWithMember()
  const unknown = '00000000-0000-4000-8000-00000000f00d'
  const hour = topOfHour()
  assert.equal((await report({ hour, app: { database_bytes: 1 } }, { token: null })).status, 401)
  assert.equal((await report({ hour, app: { database_bytes: 1 } }, { token: appToken(Buffer.alloc(32, 1).toString('base64'), 'captable') })).status, 401)
  assert.equal((await report({ hour, app: { database_bytes: 1 } }, { site: 'captable' })).status, 404, 'the apex only')
  assert.equal((await h.client().get(h.url('apex', '/__insulin/metrics'))).status, 405)

  const sent = await report({
    hour,
    app: { database_bytes: 4096, organizations: 2 },
    organizations: [{ id: orgId, metrics: { companies: 1, storage_bytes: 2048 } }, { id: unknown, metrics: { companies: 9 } }],
  })
  assert.equal(sent.status, 202, sent.text)
  assert.deepEqual(JSON.parse(sent.text), { status: 'accepted', organizations: 1, skipped: 1 })
  const stored = await h.sql("SELECT org_id, metrics FROM app_metrics_hourly WHERE app = 'captable' AND hour = ?1 ORDER BY org_id", Date.parse(hour))
  assert.deepEqual(stored.map((row) => [row.org_id, JSON.parse(row.metrics)]), [['', { database_bytes: 4096, organizations: 2 }], [orgId, { companies: 1, storage_bytes: 2048 }]])
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM app_metrics_daily WHERE app = 'captable' AND org_id = ?1", orgId))[0].n, 1)

  // Resending the hour replaces its values; an earlier hour of the same day doesn't overwrite the day's later one.
  assert.equal((await report({ hour, organizations: [{ id: orgId, metrics: { companies: 2, storage_bytes: 4096 } }] })).status, 202)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM app_metrics_hourly WHERE app = 'captable' AND hour = ?1", Date.parse(hour)))[0].n, 2)
  const [latest] = await h.sql("SELECT metrics FROM app_metrics_hourly WHERE app = 'captable' AND hour = ?1 AND org_id = ?2", Date.parse(hour), orgId)
  assert.deepEqual(JSON.parse(latest.metrics), { companies: 2, storage_bytes: 4096 })
  if (new Date(Date.parse(hour)).getUTCHours() > 0) {
    assert.equal((await report({ hour: topOfHour(-1), organizations: [{ id: orgId, metrics: { companies: 1 } }] })).status, 202)
    const [day] = await h.sql("SELECT hour, metrics FROM app_metrics_daily WHERE app = 'captable' AND org_id = ?1", orgId)
    assert.equal(day.hour, Date.parse(hour))
    assert.deepEqual(JSON.parse(day.metrics), { companies: 2, storage_bytes: 4096 })
  }
  assert.match(h.logText(), /"event":"app_metrics","app":"captable"/)
})

test('a report that breaks the rules is refused whole, naming the rule', async () => {
  const { orgId } = await orgWithMember()
  const hour = topOfHour()
  const org = (metrics) => ({ hour, organizations: [{ id: orgId, metrics }] })
  const cases = [
    ['not json', '{', /not JSON/],
    ['an array', '[]', /JSON object/],
    ['no metrics', { hour }, /no metrics/],
    ['an hour that is not the top of one', { hour: hour.replace(':00:00Z', ':30:00Z'), app: { a: 1 } }, /top of a UTC hour/],
    ['milliseconds', { hour: hour.replace('Z', '.000Z'), app: { a: 1 } }, /top of a UTC hour/],
    ['the future', { hour: topOfHour(2), app: { a: 1 } }, /future/],
    ['more than a week old', { hour: topOfHour(-24 * 8), app: { a: 1 } }, /seven days/],
    ['an unknown field', { hour, app: { a: 1 }, extra: true }, /unknown field/],
    ['an upper-case name', org({ Companies: 1 }), /metrics/],
    ['a negative value', org({ companies: -1 }), /metrics/],
    ['a string value', org({ companies: '1' }), /metrics/],
    ['too large a value', org({ companies: 1e16 }), /metrics/],
    ['too many metrics', org(Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`m${index}`, index]))), /metrics/],
    ['a duplicate organization', { hour, organizations: [{ id: orgId, metrics: { a: 1 } }, { id: orgId, metrics: { a: 2 } }] }, /unique/],
    ['an id that is not one', { hour, organizations: [{ id: 'acme', metrics: { a: 1 } }] }, /unique/],
    ['too many organizations', { hour, organizations: Array.from({ length: 501 }, () => ({ id: orgId, metrics: {} })) }, /at most 500/],
  ]
  for (const [name, body, detail] of cases) {
    const refused = await report(body)
    assert.equal(refused.status, 400, name)
    assert.match(JSON.parse(refused.text).detail, detail, name)
  }
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM app_metrics_hourly WHERE org_id = ?1', orgId))[0].n, 0)
})

test('five hundred organizations are stored in one report; the console ranks them and shows each one\'s numbers', async () => {
  const owner = await h.user({ name: 'Many Orgs' })
  const ids = []
  for (let index = 0; index < 3; index += 1) ids.push(await h.org(owner.client, `Ranked ${index}`))
  const filler = Array.from({ length: 497 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, metrics: { envelopes: 1 } }))
  const hour = topOfHour()
  const sent = await report({
    hour,
    app: { database_bytes: 5 * 1024 ** 2 },
    organizations: [...ids.map((id, index) => ({ id, metrics: { envelopes: (index + 1) * 10, storage_bytes: (index + 1) * 1024 ** 2 } })), ...filler],
  }, { app: 'captable' })
  assert.equal(sent.status, 202)
  assert.equal(JSON.parse(sent.text).organizations, 3)
  const reader = await operator()
  const app = await reader.get(h.url('apex', '/super/apps/captable'))
  assert.equal(app.status, 200)
  assert.ok(app.text.indexOf('Ranked 2') < app.text.indexOf('Ranked 0'), 'the largest storage first')
  assert.match(app.text, /3\.00 MB/)
  const byEnvelopes = await reader.get(h.url('apex', '/super/apps/captable?sort=envelopes'))
  assert.match(byEnvelopes.text, /aria-current="true"[^>]*>Envelopes</)
  const apps = await reader.get(h.url('apex', '/super/apps'))
  assert.match(apps.text, /5\.00 MB/, 'the app as a whole')
  const org = await reader.get(h.url('apex', `/super/orgs/${ids[1]}`))
  assert.match(org.text, /<h2>Cap Table<\/h2>/)
  assert.match(org.text, /2\.00 MB/)
})

// The synthetic Cap Table database's uuid, as the D1 list and the analytics name it.
const CAPTABLE_DB = '00000000-0000-4000-8000-0000000000d2'

/** Answers Cloudflare's API like the account would, counting the calls; `fail` makes one part answer 500. */
function cloudflareApi({ fail = null } = {}) {
  const calls = []
  const answer = (part, body) => (fail === part ? new Response('{}', { status: 500 }) : body)
  const stop = h.outbound.on('https://api.cloudflare.com/client/v4/', (request, url, params, body) => {
    calls.push({ path: url.pathname, auth: request.headers.get('authorization'), body })
    if (url.pathname.endsWith('/workers/scripts')) {
      return answer('workers', { success: true, result: [{ id: 'insulin-apps-gateway' }, { id: 'insulin-apps-captable' }, { id: 'someone-elses-worker' }] })
    }
    if (url.pathname.endsWith('/d1/database')) {
      return answer('databases', { success: true, result: [
        { name: 'insulin-apps-gateway', uuid: '00000000-0000-4000-8000-0000000000d1', file_size: 9 * 1024 ** 3, num_tables: 40 },
        { name: 'insulin-apps-captable', uuid: CAPTABLE_DB, file_size: 1024 ** 2, num_tables: 12 },
        { name: 'unrelated', uuid: '00000000-0000-4000-8000-0000000000d3', file_size: 1, num_tables: 1 },
      ] })
    }
    if (url.pathname === '/client/v4/graphql') {
      return answer('analytics', { data: { viewer: { accounts: [{
        day: [{ dimensions: { scriptName: 'insulin-apps-captable' }, sum: { requests: 1200, errors: 12 }, quantiles: { cpuTimeP50: 2500, cpuTimeP99: 40_000 } }],
        month: [{ dimensions: { scriptName: 'insulin-apps-captable' }, sum: { requests: 9_000_000, errors: 100 } }],
        d1Day: [{ dimensions: { databaseId: CAPTABLE_DB }, sum: { rowsRead: 5000, rowsWritten: 50 } }],
        d1Month: [{ dimensions: { databaseId: CAPTABLE_DB }, sum: { rowsRead: 900_000, rowsWritten: 9000 } }],
      }] } } })
    }
    return new Response('unexpected', { status: 404 })
  })
  return { calls, stop }
}

async function tick() {
  await (await h.mf.getWorker('gateway')).scheduled({ cron: '*/5 * * * *' })
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await check()
    if (value) return value
    await new Promise((accept) => setTimeout(accept, 25))
  }
  assert.fail('timed out')
}

test('the hourly tick reads the Cloudflare resources once an hour, with the token, and the console shows the headroom', async () => {
  await h.sql('DELETE FROM super_jobs')
  await h.sql('DELETE FROM super_cloudflare_snapshots')
  const api = cloudflareApi()
  try {
    await tick()
    const [job] = await waitFor(async () => (await h.sql("SELECT outcome FROM super_jobs WHERE name = 'cloudflare' AND finished_at IS NOT NULL")).length ? h.sql("SELECT outcome FROM super_jobs WHERE name = 'cloudflare'") : null)
    assert.equal(job.outcome, 'ok')
    assert.equal(api.calls.length, 3)
    assert.ok(api.calls.every((call) => call.auth === `Bearer ${CLOUDFLARE_TOKEN}`))
    assert.ok(api.calls.some((call) => call.path === `/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/workers/scripts`))
    const [{ data }] = await h.sql('SELECT data FROM super_cloudflare_snapshots')
    const snapshot = JSON.parse(data)
    assert.deepEqual(snapshot.workers.map((worker) => worker.name), ['insulin-apps-captable', 'insulin-apps-gateway'])
    assert.deepEqual(snapshot.databases.map((db) => db.name), ['insulin-apps-captable', 'insulin-apps-gateway'])
    assert.deepEqual(snapshot.problems, [])

    await tick()
    await new Promise((accept) => setTimeout(accept, 300))
    assert.equal(api.calls.length, 3, 'the hour is taken: no second read')
    assert.doesNotMatch(h.logText(), new RegExp(CLOUDFLARE_TOKEN), 'the token is never logged')

    const reader = await operator()
    const page = await reader.get(h.url('apex', '/super/cloudflare'))
    assert.equal(page.status, 200)
    assert.match(page.text, /insulin-apps-captable/)
    assert.doesNotMatch(page.text, /someone-elses-worker|unrelated/)
    assert.match(page.text, /9,000,000 of 10,000,000 \(90%\)/, 'the month\'s requests against the plan')
    assert.match(page.text, /Largest database \(insulin-apps-gateway\)/)
    assert.match(page.text, /Above 80%/)
    const overview = await reader.get(h.url('apex', '/super'))
    assert.match(overview.text, /Worker requests this month<\/a>: 9,000,000 of 10,000,000/, 'on the watch list')
  } finally {
    api.stop()
  }
})

test('a part of Cloudflare that fails is named, and the rest is kept', async () => {
  await h.sql('DELETE FROM super_jobs')
  await h.sql('DELETE FROM super_cloudflare_snapshots')
  const api = cloudflareApi({ fail: 'analytics' })
  try {
    await tick()
    await waitFor(async () => (await h.sql("SELECT 1 FROM super_jobs WHERE name = 'cloudflare' AND finished_at IS NOT NULL")).length)
    assert.equal((await h.sql("SELECT outcome FROM super_jobs WHERE name = 'cloudflare'"))[0].outcome, 'partial')
    const snapshot = JSON.parse((await h.sql('SELECT data FROM super_cloudflare_snapshots'))[0].data)
    assert.deepEqual(snapshot.problems, ['analytics:http_500'])
    assert.equal(snapshot.workers.length, 2, 'the lists still came')
    const reader = await operator()
    assert.match((await reader.get(h.url('apex', '/super/cloudflare'))).text, /couldn(?:&#x27;|')t be read: analytics:http_500/)
  } finally {
    api.stop()
  }
})

// Last in the file: the gateway stops reading a body past its limit, and the connection it came on may not be usable
// again, so nothing may follow it on Miniflare's pooled connections.
test('a report over 512 KB is refused before it is read', async () => {
  assert.equal((await report('x'.repeat(512 * 1024 + 1))).status, 413)
})
