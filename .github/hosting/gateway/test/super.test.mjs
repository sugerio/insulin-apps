// The operator console at /super (DESIGN.md §11): off unless configured; sign-in through a stand-in Google Workspace
// SAML app with the operators' group (and every way of failing it); operators read, admins act; suspending, disabling
// and reinstating organizations and accounts, and what each closes at once; an organization created past its owner
// domain's limit; the audit log; the pages. All data is synthetic.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { PASSWORD, SECRET_KEY, TOKENS, UUID, startGateway, uniqueEmail } from './helpers/harness.mjs'
import { randomUUID } from 'node:crypto'
import { LOOPBACK, appToken, connect, registerClient, rpc } from './helpers/oauth.mjs'
import { insertGrantWithCode, redeemCode, touchGrant, touchServiceAccount } from '../src/db/oauth.ts'
import { changeRole, deleteOrg, leaveOrg, removeMember, renameOrg, setAppAccess } from '../src/db/orgs.ts'
import { insertInvitation, revokeInvitation } from '../src/db/invitations.ts'
import { joinOrg, joinOrgByScim } from '../src/db/sso.ts'
import { PLAN, headroom, isWarning } from '../src/super/cloudflare.ts'
import { base32Decode, hotp, timeStep } from '../src/auth/totp.ts'
import { authorizeUrl, form, openConsent, pkce } from './helpers/oauth.mjs'
import { setOrgStatus, setUserStatus } from '../src/super/db.ts'
import { encode, makeIdentityProviderKey, requestIdFrom, samlResponse, signResponse } from './helpers/saml-idp.mjs'

const IDP_KEY = makeIdentityProviderKey('Stand-in Workspace')
const OTHER_KEY = makeIdentityProviderKey('Somebody Else')
const IDP_ENTITY = 'https://accounts.example.test/o/saml2/workspace'
const IDP_SSO = 'https://accounts.example.test/o/saml2/sso'
const IDP_ORIGIN = 'https://accounts.example.test'
// Google's group membership mapping sends each group's name, not its address.
const GROUP = 'Insulin Apps Operators'
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
  // Google sends the name as the group is called; the console compares it without regard to case.
  const signedIn = await acs(client, answer(id, { groups: ['Everyone at Staff', GROUP.toUpperCase()] }))
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
  assert.equal((await acs(outsider, answer(second.id, { groups: ['Everyone at Staff'] }))).status, 403)
  const named = await startSignIn(outsider)
  assert.equal((await acs(outsider, answer(named.id, { groups: ['operators@staff.example.test'] }))).status, 403, "the group's address isn't its name")

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
  // One paragraph: the alert's description is a grid, which would put each loose piece of the sentence on a line.
  assert.match(home.text, /data-slot="alert-description"[^>]*><p>Insulin Apps has suspended <strong>Watched Org<\/strong>, so nobody can use it for now\./)
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
  // Disabling an organization keeps its members' sessions (they may belong to others); the form says what it ends.
  assert.match(page.text, /<strong>Disable:<\/strong> End access for abuse or fraud\. Also ends its AI agents, API clients, invitations and SCIM tokens for good\./)
  assert.doesNotMatch(page.text.match(/<strong>Disable:<\/strong>[^<]*/)[0], /session/)
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
  assert.match((await admin.get(h.url('apex', `/super/users/${member.id}`))).text, /<strong>Disable:<\/strong> End access for abuse or fraud\. Also ends its sessions and AI agents for good\./)
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
  const org_id = new RegExp(`name="org_id" value="(${UUID})"`).exec(form.text)[1]
  assert.equal((await admin.post(h.url('apex', '/super/orgs'), { org_id, email: uniqueEmail('nobody'), name: 'X', reason: 'Support request' })).status, 404)
  assert.equal((await admin.post(h.url('apex', '/super/orgs'), { org_id, email, name: 'Third', reason: '' })).status, 400)
  assert.equal((await admin.post(h.url('apex', '/super/orgs'), { email, name: 'Third', reason: 'No form id' })).status, 400, 'a form without its id')
  const created = await admin.post(h.url('apex', '/super/orgs'), { org_id, email, name: 'Third', reason: 'Support request about a third team' })
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

// The synthetic databases' uuids, as the Workers' bindings and the analytics name them.
const GATEWAY_DB = '00000000-0000-4000-8000-0000000000d1'
const CAPTABLE_DB = '00000000-0000-4000-8000-0000000000d2'

/**
 * Answers Cloudflare's API like the account would, counting the calls; `fail` makes one part answer 500, and `sized`
 * lists the databases the storage analytics know.
 */
function cloudflareApi({ fail = null, sized = [GATEWAY_DB, CAPTABLE_DB] } = {}) {
  const calls = []
  const answer = (part, body) => (fail === part ? new Response('{}', { status: 500 }) : body)
  const settings = { 'insulin-apps-gateway': GATEWAY_DB, 'insulin-apps-captable': CAPTABLE_DB }
  const stop = h.outbound.on('https://api.cloudflare.com/client/v4/', (request, url, params, body) => {
    calls.push({ path: url.pathname, auth: request.headers.get('authorization'), body })
    if (url.pathname.endsWith('/workers/scripts')) {
      return answer('workers', { success: true, result: [{ id: 'insulin-apps-gateway' }, { id: 'insulin-apps-captable' }, { id: 'someone-elses-worker' }] })
    }
    const script = /\/workers\/scripts\/([^/]+)\/settings$/.exec(url.pathname)?.[1]
    if (script) {
      return answer('settings', { success: true, result: { bindings: [
        { type: 'd1', name: 'DB', id: settings[script] },
        { type: 'service', name: 'SUGER_GATEWAY', service: 'insulin-apps-gateway' },
      ] } })
    }
    if (url.pathname === '/client/v4/graphql' && body.includes('d1StorageAdaptiveGroups')) {
      return answer('storage', { data: { viewer: { accounts: [{ storage: [
        { dimensions: { databaseId: GATEWAY_DB, date: '2026-01-01' }, max: { databaseSizeBytes: 9 * 1024 ** 3 } },
        { dimensions: { databaseId: CAPTABLE_DB, date: '2026-01-01' }, max: { databaseSizeBytes: 1024 ** 2 } },
      ].filter((group) => sized.includes(group.dimensions.databaseId)) }] } } })
    }
    if (url.pathname === '/client/v4/graphql') {
      return answer('analytics', { data: { viewer: { accounts: [{
        day: [
          { dimensions: { scriptName: 'insulin-apps-gateway' }, sum: { requests: 1500, errors: 3 }, quantiles: { cpuTimeP50: 1500, cpuTimeP99: 9000 } },
          { dimensions: { scriptName: 'insulin-apps-captable' }, sum: { requests: 1200, errors: 12 }, quantiles: { cpuTimeP50: 2500, cpuTimeP99: 40_000 } },
        ],
        month: [
          { dimensions: { scriptName: 'insulin-apps-gateway' }, sum: { requests: 9_000_000, errors: 30 } },
          { dimensions: { scriptName: 'insulin-apps-captable' }, sum: { requests: 5_000_000, errors: 100 } },
        ],
        d1Yesterday: [{ dimensions: { databaseId: CAPTABLE_DB }, sum: { rowsRead: 5000, rowsWritten: 50 } }],
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
    assert.deepEqual(api.calls.map((call) => call.path).sort(), [
      '/client/v4/graphql',
      '/client/v4/graphql',
      `/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/workers/scripts`,
      `/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/workers/scripts/insulin-apps-captable/settings`,
      `/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/workers/scripts/insulin-apps-gateway/settings`,
    ].sort(), "no D1 endpoint: a D1 token could read the apps' databases")
    assert.ok(api.calls.every((call) => call.auth === `Bearer ${CLOUDFLARE_TOKEN}`))
    const [{ data }] = await h.sql('SELECT data FROM super_cloudflare_snapshots')
    const snapshot = JSON.parse(data)
    assert.deepEqual(snapshot.workers.map((worker) => worker.name), ['insulin-apps-captable', 'insulin-apps-gateway'])
    assert.deepEqual(snapshot.databases.map((db) => [db.name, db.sizeBytes, db.rowsReadYesterday]), [
      ['insulin-apps-captable', 1024 ** 2, 5000], ['insulin-apps-gateway', 9 * 1024 ** 3, 0],
    ], "each database named after the Worker that binds it, its size from the analytics")
    assert.deepEqual(snapshot.problems, [])

    await tick()
    await new Promise((accept) => setTimeout(accept, 300))
    assert.equal(api.calls.length, 5, 'the hour is taken: no second read')
    assert.doesNotMatch(h.logText(), new RegExp(CLOUDFLARE_TOKEN), 'the token is never logged')

    const reader = await operator()
    const page = await reader.get(h.url('apex', '/super/cloudflare'))
    assert.equal(page.status, 200)
    assert.match(page.text, /insulin-apps-captable/)
    assert.doesNotMatch(page.text, /someone-elses-worker/)
    assert.match(page.text, /Gateway requests this month/)
    assert.match(page.text, /9,000,000 of 10,000,000 \(90%\)/, "the gateway's requests alone: the apps' come through bindings, which aren't billed")
    assert.doesNotMatch(page.text, /14,000,000/)
    assert.match(page.text, /Rows read yesterday/)
    assert.doesNotMatch(page.text, /Rows read, 24 h/)
    assert.match(page.text, /Largest database \(insulin-apps-gateway\)/)
    assert.match(page.text, /Above 80%/)
    for (const resource of ['Email Service', 'RL_AUTH', 'RL_APP', 'RL_PUBLIC', 'DOCS_ASSETS', '\\*/5 \\* \\* \\* \\*', '17 3 \\* \\* \\*', 'captable\\.insulinapps\\.localhost']) {
      assert.match(page.text, new RegExp(resource), `the inventory names ${resource}`)
    }
    const overview = await reader.get(h.url('apex', '/super'))
    assert.match(overview.text, /Gateway requests this month<\/a>: 9,000,000 of 10,000,000/, 'on the watch list')
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
    assert.equal(snapshot.databases.find((db) => db.name === 'insulin-apps-captable').sizeBytes, 1024 ** 2, 'and the sizes')
    assert.equal(snapshot.workers[0].requestsMonth, null, 'figures that weren\'t read are unknown, not zero')
    assert.equal(snapshot.databases[0].rowsReadMonth, null)
    const reader = await operator()
    const page = await reader.get(h.url('apex', '/super/cloudflare'))
    assert.match(page.text, /couldn(?:&#x27;|')t be read: analytics:http_500/)
    assert.doesNotMatch(page.text, /Gateway requests this month/, 'no meter from unknown figures')
    const overview = await reader.get(h.url('apex', '/super'))
    assert.match(overview.text, /Part of the last Cloudflare read failed \(analytics:http_500\)/)
    assert.doesNotMatch(overview.text, /0 of 10,000,000/)
  } finally {
    api.stop()
  }
  // The next tick tries the hour again, and the hour keeps one snapshot.
  const healthy = cloudflareApi()
  try {
    await tick()
    await waitFor(async () => (await h.sql("SELECT 1 FROM super_jobs WHERE name = 'cloudflare' AND outcome = 'ok'")).length)
    assert.ok(healthy.calls.length > 0)
    const rows = await h.sql('SELECT data FROM super_cloudflare_snapshots')
    assert.equal(rows.length, 1, 'one snapshot an hour')
    assert.equal(JSON.parse(rows[0].data).workers.find((worker) => worker.name === 'insulin-apps-gateway').requestsMonth, 9_000_000)
  } finally {
    healthy.stop()
  }
})

test('a consent decided after its person or organization stopped being active grants nothing', async () => {
  const { member, orgId } = await orgWithMember()
  const client = await registerClient(h)
  const now = Date.now()
  const grant = () => insertGrantWithCode(h.db, {
    id: randomUUID(), clientId: client.client_id, userId: member.id, orgId, app: 'captable', now, expiresAt: now + 3_600_000,
    codeHash: randomUUID().replaceAll('-', '').repeat(2), redirectUri: LOOPBACK, codeChallenge: 'c'.repeat(43), codeExpiresAt: now + 60_000,
  })
  await h.sql("UPDATE users SET status = 'disabled' WHERE id = ?1", member.id)
  assert.equal(await grant(), false, 'a disabled account')
  await h.sql("UPDATE users SET status = 'active' WHERE id = ?1", member.id)
  await h.sql("UPDATE orgs SET status = 'suspended' WHERE id = ?1", orgId)
  assert.equal(await grant(), false, 'a suspended organization')
  await h.sql("UPDATE orgs SET status = 'active' WHERE id = ?1", orgId)
  assert.equal(await grant(), true, 'active again')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?1 AND org_id = ?2', member.id, orgId))[0].n, 1)
})

test('a standing change asked for twice at the same moment is recorded once', async () => {
  const { member, orgId } = await orgWithMember()
  const operator = { id: randomUUID(), email: ADMIN, name: 'Ada Admin' }
  const now = Date.now()
  const change = { orgId, status: 'disabled', reason: 'Twice at once', operator, label: 'Watched Org', now }
  assert.equal(await setOrgStatus(h.db, change), true)
  assert.equal(await setOrgStatus(h.db, change), false)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM super_audit WHERE target_id = ?1 AND action = 'org.disable'", orgId))[0].n, 1)
  const user = { userId: member.id, status: 'suspended', reason: 'Twice at once', operator, label: member.email, now }
  assert.equal(await setUserStatus(h.db, user), true)
  assert.equal(await setUserStatus(h.db, user), false)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM super_audit WHERE target_id = ?1 AND action = 'user.suspend'", member.id))[0].n, 1)
})

test("deleting the account of a suspended organization's only member leaves the organization, still counted for its domain", async () => {
  const owner = await h.user({ name: 'Sole Owner' })
  const orgId = await h.org(owner.client, 'Solo Suspect')
  const admin = await operator(ADMIN)
  assert.equal((await admin.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'suspended', reason: 'Under review' })).status, 303)
  const deleted = await owner.client.post(h.url('apex', '/account/delete'), { confirm: owner.email })
  assert.equal(deleted.status, 200, deleted.text.slice(0, 300))
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM users WHERE id = ?1', owner.id))[0].n, 0, 'the account is gone')
  const [org] = await h.sql('SELECT status, owner_domain FROM orgs WHERE id = ?1', orgId)
  assert.deepEqual(org, { status: 'suspended', owner_domain: 'example.test' }, 'the organization stays')
})

test("an organization's last activity: switching to it, and never a suspended one or one the person left", async () => {
  const person = await h.user()
  const first = await h.org(person.client, 'First Active')
  const second = await h.org(person.client, 'Second Active')
  await h.sql('UPDATE orgs SET last_active_at = 0 WHERE id IN (?1, ?2)', first, second)
  assert.equal((await person.client.post(h.url('apex', '/orgs/switch'), { org_id: second })).status, 303)
  assert.ok((await h.sql('SELECT last_active_at FROM orgs WHERE id = ?1', second))[0].last_active_at > 0, 'switching counts')

  await h.sql("UPDATE orgs SET status = 'suspended', last_active_at = 0 WHERE id = ?1", second)
  await h.sql('UPDATE sessions SET last_seen_at = 0, active_org_id = ?2 WHERE user_id = ?1', person.id, second)
  await person.client.get(h.url('apex', '/'))
  assert.equal((await h.sql('SELECT last_active_at FROM orgs WHERE id = ?1', second))[0].last_active_at, 0, 'not a suspended one')

  const stranger = await h.user()
  const left = await h.org(stranger.client, 'Left Behind')
  await h.sql('UPDATE orgs SET last_active_at = 0 WHERE id = ?1', left)
  await h.sql('UPDATE sessions SET last_seen_at = 0, active_org_id = ?2 WHERE user_id = ?1', person.id, left)
  await person.client.get(h.url('apex', '/'))
  assert.equal((await h.sql('SELECT last_active_at FROM orgs WHERE id = ?1', left))[0].last_active_at, 0, 'not one the person is no member of')
})

test("an app's organizations page through every organization it reported, a hundred at a time", async () => {
  const hour = topOfHour()
  const ids = Array.from({ length: 150 }, (_, index) => `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`)
  for (const [index, id] of ids.entries()) {
    await h.sql('INSERT INTO orgs (id, name, created_at, updated_at) VALUES (?1, ?2, 0, 0)', id, `Paged Org ${String(index).padStart(3, '0')}`)
  }
  const sent = await report({ hour, organizations: ids.map((id, index) => ({ id, metrics: { records: 1000 - index } })) }, { app: 'ledger' })
  assert.equal(JSON.parse(sent.text).organizations, 150)
  const reader = await operator()
  const first = await reader.get(h.url('apex', '/super/apps/ledger'))
  assert.match(first.text, /Paged Org 000/)
  assert.match(first.text, /Paged Org 099/)
  assert.doesNotMatch(first.text, /Paged Org 100/)
  assert.match(first.text, /href="\/super\/apps\/ledger\?sort=records&amp;page=2"/)
  const second = await reader.get(h.url('apex', '/super/apps/ledger?sort=records&page=2'))
  assert.match(second.text, /Paged Org 149/)
  assert.doesNotMatch(second.text, /Paged Org 099/)
})


test("an organization's own writes refuse it once it is suspended, even a request that passed its checks before", async () => {
  const { owner, member, orgId } = await orgWithMember()
  const invited = await owner.client.post(h.url('apex', `/orgs/${orgId}/invitations`), { email: uniqueEmail('pending'), role: 'VIEWER' })
  assert.equal(invited.status, 303)
  const [invitation] = await h.sql("SELECT id FROM invitations WHERE org_id = ?1 AND status = 'pending'", orgId)
  await h.sql("UPDATE orgs SET status = 'suspended' WHERE id = ?1", orgId)
  const now = Date.now()
  assert.equal(await renameOrg(h.db, orgId, owner.id, 'Renamed', now), false, 'rename')
  assert.equal(await changeRole(h.db, { orgId, userId: member.id, current: 'EDITOR', next: 'VIEWER', actorId: owner.id, now }), false, 'a role')
  assert.equal(await revokeInvitation(h.db, invitation.id, owner.id, now), false, 'an invitation')
  assert.equal(await removeMember(h.db, orgId, member.id, 'EDITOR', owner.id), false, 'a removal')
  assert.equal(await leaveOrg(h.db, orgId, member.id, 'EDITOR'), false, 'leaving')
  assert.equal(await deleteOrg(h.db, orgId, owner.id), false, 'deleting it')
  const [org] = await h.sql('SELECT name, status FROM orgs WHERE id = ?1', orgId)
  assert.deepEqual(org, { name: 'Watched Org', status: 'suspended' })
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1', orgId))[0].n, 2)
})

test('an agent or API client used as its account or organization is suspended leaves no sign of activity', async () => {
  const { owner, member, orgId } = await orgWithMember()
  const agent = await connect(h, member, orgId)
  const [grant] = await h.sql('SELECT id FROM oauth_grants WHERE user_id = ?1 AND org_id = ?2', member.id, orgId)
  void agent
  const created = await owner.client.post(h.url('apex', '/apps/captable/settings/api/clients'), { org_id: orgId, name: 'Exporter', role: 'VIEWER' })
  assert.equal(created.status, 200)
  const [account] = await h.sql('SELECT id FROM service_accounts WHERE org_id = ?1', orgId)
  await h.sql("UPDATE users SET status = 'suspended', last_active_at = 0 WHERE id = ?1", member.id)
  await h.sql("UPDATE orgs SET status = 'suspended', last_active_at = 0 WHERE id = ?1", orgId)
  await touchGrant(h.db, grant.id, Date.now())
  await touchServiceAccount(h.db, account.id, Date.now())
  assert.equal((await h.sql('SELECT last_active_at FROM users WHERE id = ?1', member.id))[0].last_active_at, 0)
  assert.equal((await h.sql('SELECT last_active_at FROM orgs WHERE id = ?1', orgId))[0].last_active_at, 0)
})

test('a report for an hour that exists only after normalizing (yesterday at 24:00) is refused', async () => {
  const yesterday = new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10)
  const refused = await report({ hour: `${yesterday}T24:00:00Z`, app: { database_bytes: 1 } })
  assert.equal(refused.status, 400)
  assert.match(JSON.parse(refused.text).detail, /not a valid time/)
})

test('creating an organization for someone twice from one form creates it once', async () => {
  const email = `twice.${Date.now()}@twice-over.test`
  await h.user({ name: 'Twice Person', email })
  const admin = await operator(ADMIN)
  const form = await admin.get(h.url('apex', '/super/orgs/new'))
  const orgId = new RegExp(`name="org_id" value="(${UUID})"`).exec(form.text)?.[1]
  assert.ok(orgId, 'the form carries the id of the organization it will create')
  const fields = { org_id: orgId, email, name: 'Only Once', reason: 'Support request, double-clicked' }
  const first = await admin.post(h.url('apex', '/super/orgs'), fields)
  const second = await admin.post(h.url('apex', '/super/orgs'), fields)
  assert.equal(first.status, 303)
  assert.equal(second.status, 303)
  assert.equal(second.location, first.location, 'the second lands on the same organization')
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM orgs WHERE name = 'Only Once'"))[0].n, 1)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM super_audit WHERE action = 'org.create' AND target_id = ?1", orgId))[0].n, 1)
  // An id that is another organization's takes nothing over.
  const { orgId: taken } = await orgWithMember()
  const hijack = await admin.post(h.url('apex', '/super/orgs'), { ...fields, org_id: taken, name: 'Hijack' })
  assert.equal(hijack.status, 409)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 AND u.email = ?2", taken, email))[0].n, 0)
  assert.equal((await h.sql('SELECT name FROM orgs WHERE id = ?1', taken))[0].name, 'Watched Org')
})

test('a failed hourly snapshot is tried again at the next tick', async () => {
  await h.sql('DELETE FROM super_jobs')
  await h.sql('DELETE FROM super_cloudflare_snapshots')
  const hour = Math.floor(Date.now() / HOUR) * HOUR
  await h.sql("INSERT INTO super_jobs (name, hour, started_at, finished_at, outcome) VALUES ('cloudflare', ?1, ?2, ?2, 'failed')", hour, Date.now() - 60_000)
  const api = cloudflareApi()
  try {
    await tick()
    await waitFor(async () => (await h.sql("SELECT 1 FROM super_jobs WHERE name = 'cloudflare' AND outcome = 'ok'")).length)
    assert.ok(api.calls.length > 0)
  } finally {
    api.stop()
  }
})

test('each report clears the app\'s hourly numbers past three days, however many there are', async () => {
  const { orgId } = await orgWithMember()
  const old = Math.floor(Date.now() / HOUR) * HOUR - 4 * 24 * HOUR
  for (let batch = 0; batch < 6; batch += 1) {
    await h.db.batch(Array.from({ length: 100 }, (_, index) => h.db.prepare(
      "INSERT INTO app_metrics_hourly (app, org_id, hour, metrics, received_at) VALUES ('ledger', ?1, ?2, '{}', 0)",
    ).bind(`00000000-0000-4000-a000-${String(batch * 100 + index).padStart(12, '0')}`, old)))
  }
  assert.equal((await report({ hour: topOfHour(), organizations: [{ id: orgId, metrics: { records: 1 } }] }, { app: 'ledger' })).status, 202)
  assert.equal((await h.sql("SELECT COUNT(*) AS n FROM app_metrics_hourly WHERE app = 'ledger' AND hour < ?1", old + HOUR))[0].n, 0)
})


test("a suspended organization's SCIM token, integration proxy, API client and its pending ways in are all refused", async () => {
  const { owner, member, orgId } = await orgWithMember()
  // SCIM, with a token from the settings page and a verified domain.
  await h.sql("INSERT INTO sso_domains (org_id, domain, token, created_at, verified_at) VALUES (?1, 'suspended-scim.test', 'synthetic-token', ?2, ?2)", orgId, Date.now())
  const scimCreated = await owner.client.post(h.url('apex', `/orgs/${orgId}/sso/scim-tokens`), { name: 'Test IdP' })
  assert.equal(scimCreated.status, 201)
  const scimToken = /<code[^>]*>([A-Za-z0-9_-]{43})<\/code>/.exec(scimCreated.text)[1]
  const scim = (method, path, body) => h.client().request(h.url('apex', `/scim/v2${path}`), {
    method, headers: { Authorization: `Bearer ${scimToken}`, ...(body ? { 'Content-Type': 'application/scim+json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  })
  assert.equal((await scim('GET', '/Users')).status, 200)
  // A stored credential, an API client and a pending invitation.
  const saved = await owner.client.post(h.url('apex', '/apps/captable/settings/integrations/credentials'), {
    org_id: orgId, key: 'upstream', name: 'Upstream', base_url: 'https://api.example.test/v1', allowed_hosts: '', auth_scheme: 'bearer', secret: 'bearer-synthetic',
  })
  assert.ok([200, 303].includes(saved.status), saved.text.slice(0, 200))
  const created = await owner.client.post(h.url('apex', '/apps/captable/settings/api/clients'), { org_id: orgId, name: 'Nightly', role: 'VIEWER' })
  const clientId = /(ia_sa_[A-Za-z0-9_-]{22})/.exec(created.text)[1]
  const secret = /(ia_sk_[A-Za-z0-9_-]{43})/.exec(created.text)[1]
  const credentials = () => form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'client_credentials' }, { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` })
  const issued = await credentials()
  assert.equal(issued.status, 200)
  const apiToken = issued.json.access_token
  const invitee = await h.user({ name: 'Later Invitee' })
  assert.equal((await owner.client.post(h.url('apex', `/orgs/${orgId}/invitations`), { email: invitee.email, role: 'VIEWER' })).status, 303)
  const link = await h.link(invitee.email, '/invitations/')
  const outbound = []
  const stop = h.outbound.on('https://api.example.test/', (request, url) => { outbound.push(url.href); return { ok: true } })
  try {
    const admin = await operator(ADMIN)
    assert.equal((await admin.post(h.url('apex', `/super/orgs/${orgId}/status`), { status: 'suspended', reason: 'Checking everything' })).status, 303)
    const [before] = await h.sql('SELECT last_used_at FROM scim_tokens WHERE org_id = ?1', orgId)
    assert.equal((await scim('GET', '/Users')).status, 401, 'SCIM')
    assert.equal((await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'new@suspended-scim.test' })).status, 401)
    assert.deepEqual(await h.sql('SELECT last_used_at FROM scim_tokens WHERE org_id = ?1', orgId), [before], 'a refused token is not marked used')
    const proxied = await h.client().request(h.url('apex', '/__insulin/integrations/upstream/proxy/_/items'), {
      headers: { Authorization: `Bearer ${appToken(SECRET_KEY, 'captable')}`, 'x-suger-organization-id': orgId },
    })
    assert.equal(proxied.status, 404, 'the integration proxy')
    assert.deepEqual(outbound, [], 'and nothing went out')
    assert.equal((await credentials()).status, 401, 'client credentials')
    assert.equal((await h.client().request(h.url('captable', '/api/echo'), { headers: { Authorization: `Bearer ${apiToken}` } })).status, 401, 'an API client\'s token')
    assert.notEqual((await invitee.client.post(`${link}/accept`, {})).status, 303, 'accepting an invitation')
    assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, invitee.id))[0].n, 0)
    assert.equal(await joinOrg(h.db, orgId, invitee.id, 'VIEWER', Date.now(), 1000), false, 'single sign-on joining')
    await h.sql("INSERT INTO users (id, email, name, email_verified_at, created_at, updated_at) VALUES ('00000000-0000-4000-8000-00000000510e', 'scim@suspended-scim.test', 'Scim Person', 0, 0, 0)")
    assert.equal(await joinOrgByScim(h.db, orgId, '00000000-0000-4000-8000-00000000510e', 'VIEWER', Date.now(), 1000), false, 'SCIM joining')
    assert.equal((await member.client.post(h.url('apex', '/orgs/switch'), { org_id: orgId })).status, 404, 'switching to it')
    assert.equal(await setAppAccess(h.db, { orgId, userId: member.id, current: 'EDITOR', grants: [{ app: 'captable', role: 'VIEWER', customRoleId: null }], actorId: owner.id, now: Date.now() }), false, 'app access')
    assert.equal(await insertInvitation(h.db, {
      id: randomUUID(), orgId, email: uniqueEmail('blocked'), role: 'VIEWER', grants: [], invitedBy: owner.id, now: Date.now(), expiresAt: Date.now() + 86_400_000, pendingLimit: 50, app: null,
    }), false, 'a new invitation')
  } finally {
    stop()
  }
})

test("a suspended account's agent can't refresh or redeem a code, and the code step refuses it", async () => {
  const { member, orgId } = await orgWithMember()
  const agent = await connect(h, member, orgId)
  // A code allowed just before the suspension, not yet exchanged.
  const client = await registerClient(h)
  const { challenge } = pkce()
  const now = Date.now()
  const codeHash = randomUUID().replaceAll('-', '').repeat(2)
  assert.equal(await insertGrantWithCode(h.db, {
    id: randomUUID(), clientId: client.client_id, userId: member.id, orgId, app: 'captable', now, expiresAt: now + 3_600_000,
    codeHash, redirectUri: LOOPBACK, codeChallenge: challenge, codeExpiresAt: now + 60_000,
  }), true)
  const admin = await operator(ADMIN)
  assert.equal((await admin.post(h.url('apex', `/super/users/${member.id}/status`), { status: 'suspended', reason: 'Agents too' })).status, 303)
  const refresh = await form(h.client(), h.url('apex', '/oauth/token'), { grant_type: 'refresh_token', refresh_token: agent.refresh_token, client_id: agent.client.client_id })
  assert.equal(refresh.status, 400, 'refresh')
  assert.equal(await redeemCode(h.db, codeHash, client.client_id, Date.now()), null, 'a code allowed before')

  // Two-step sign-in: the suspension lands between the password and the code.
  const person = await h.user({ name: 'Two Step' })
  assert.equal((await person.client.post(h.url('apex', '/account/security/setup'), { password: PASSWORD })).status, 303)
  const setup = await person.client.get(h.url('apex', '/account/security'))
  const totp = base32Decode(/<code[^>]*>([A-Z2-7 ]+)<\/code>/.exec(setup.text)[1].replaceAll(' ', ''))
  assert.equal((await person.client.post(h.url('apex', '/account/security/enable'), { code: await hotp(totp, timeStep(Date.now()) - 1), password: PASSWORD })).status, 200)
  const browser = h.client()
  const first = await h.signIn(browser, { email: person.email })
  assert.equal(first.location, h.url('apex', '/login/mfa'))
  assert.equal((await admin.post(h.url('apex', `/super/users/${person.id}/status`), { status: 'suspended', reason: 'Mid sign-in' })).status, 303)
  const code = await browser.post(h.url('apex', '/login/mfa'), { code: await hotp(totp, timeStep(Date.now()) + 1) })
  assert.equal(code.status, 403)
  assert.match(code.text, /This account is suspended/)
  assert.ok(!code.cookies.some((line) => /^insulin_session=[^;]+;/.test(line) && !/Max-Age=0/.test(line)), 'no session')
})

test("the consent page doesn't offer a suspended organization", async () => {
  const person = await h.user()
  const kept = await h.org(person.client, 'Offered Org')
  const suspended = await h.org(person.client, 'Hidden Org')
  await h.sql("UPDATE orgs SET status = 'suspended' WHERE id = ?1", suspended)
  const client = await registerClient(h)
  const { challenge } = pkce()
  const { page } = await openConsent(person, authorizeUrl(h, { client, challenge }))
  assert.match(page.text, new RegExp(kept))
  assert.doesNotMatch(page.text, new RegExp(suspended))
  assert.doesNotMatch(page.text, /Hidden Org/)
})


test("a database the storage analytics don't know leaves the storage meters out rather than understating them", async () => {
  await h.sql('DELETE FROM super_jobs')
  await h.sql('DELETE FROM super_cloudflare_snapshots')
  const api = cloudflareApi({ sized: [CAPTABLE_DB] })
  try {
    await tick()
    await waitFor(async () => (await h.sql("SELECT 1 FROM super_jobs WHERE name = 'cloudflare' AND finished_at IS NOT NULL")).length)
    const snapshot = JSON.parse((await h.sql('SELECT data FROM super_cloudflare_snapshots'))[0].data)
    assert.equal(snapshot.databases.find((db) => db.name === 'insulin-apps-gateway').sizeBytes, null)
    const reader = await operator()
    const page = await reader.get(h.url('apex', '/super/cloudflare'))
    assert.doesNotMatch(page.text, /D1 storage, all databases/, "a total that leaves a database out isn't the total")
    assert.doesNotMatch(page.text, /Largest database/, 'nor is the largest known database the largest')
    assert.match(page.text, /Gateway requests this month/, 'the other meters stay')
  } finally {
    api.stop()
  }
})


test('the meters against the plan: right, or left out, whatever the snapshot could read', () => {
  const day = 24 * HOUR
  const may = Date.UTC(2026, 4, 1)
  const gateway = (requestsMonth) => ({ name: 'insulin-apps-gateway', requests24h: 1, errors24h: 0, requestsMonth, errorsMonth: 0, cpuP50: null, cpuP99: null })
  const db = (name, sizeBytes, rows) => ({ name, id: name, sizeBytes, rowsReadYesterday: rows, rowsWrittenYesterday: rows, rowsReadMonth: rows, rowsWrittenMonth: rows })
  const snapshot = (takenAt, workers, databases) => ({ takenAt, monthStart: Date.UTC(new Date(takenAt).getUTCFullYear(), new Date(takenAt).getUTCMonth(), 1), workers, databases, problems: [] })
  const keys = (rows) => rows.map((row) => row.key)

  // Ten days into a 31-day month, at half the allowance: heading for 155%, a warning from the projection alone.
  const mid = headroom(snapshot(may + 10 * day, [gateway(PLAN.workerRequestsPerMonth / 2)], [db('insulin-apps-gateway', 1024, 100)]))
  assert.deepEqual(keys(mid), ['requests', 'rows_read', 'rows_written', 'storage', 'largest_db'])
  assert.equal(mid[0].projected, Math.round((PLAN.workerRequestsPerMonth / 2) * 3.1))
  assert.equal(isWarning(mid[0]), true)

  // Five minutes into a month there is too little of it to project from: no projection, not a twelfth of one.
  const early = headroom(snapshot(may + 5 * 60_000, [gateway(13_000)], []))
  assert.equal(early[0].projected, null)
  assert.equal(isWarning(early[0]), false)
  // December runs to the first of January.
  const december = headroom(snapshot(Date.UTC(2026, 11, 16), [gateway(1500)], []))
  assert.equal(december[0].projected, 3100)

  assert.deepEqual(keys(headroom(snapshot(may + day, null, null))), [], 'nothing read')
  assert.deepEqual(keys(headroom(snapshot(may + day, [], []))), [], 'no Worker, no database: no meter at all, never zeros')
  assert.deepEqual(keys(headroom(snapshot(may + day, [gateway(null)], [db('a', 1, null)]))), ['storage', 'largest_db'], 'rows unknown')
  assert.deepEqual(keys(headroom(snapshot(may + day, [{ ...gateway(5), name: 'insulin-apps-captable' }], [db('a', null, 5), db('b', 2, 5)]))), ['rows_read', 'rows_written'], 'a size unknown, and no gateway')
})

// Last in the file: the gateway stops reading a body past its limit, and the connection it came on may not be usable
// again, so nothing may follow it on Miniflare's pooled connections.
test('a report over 512 KB is refused before it is read', async () => {
  assert.equal((await report('x'.repeat(512 * 1024 + 1))).status, 413)
})
