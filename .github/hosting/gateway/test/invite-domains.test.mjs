// "Invite only people in our verified domains" (DESIGN.md §3): off by default, an owner's setting once a domain is
// verified, and checked inside the statements that invite and accept, for the organization and for each app.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startGateway, uniqueEmail } from './helpers/harness.mjs'
import { acceptInvitation, findInvitation, insertInvitation } from '../src/db/invitations.ts'
import { invitePolicy, setInviteVerifiedDomainsOnly } from '../src/db/orgs.ts'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

const DAY = 24 * 60 * 60 * 1000
const post = (person, path, fields = {}) => person.client.post(h.url('auth', path), fields)
const invite = (person, orgId, email, role = 'VIEWER') => post(person, `/orgs/${orgId}/invitations`, { email, role })
const appPost = (person, path, fields = {}) => person.client.post(h.url('apex', `/apps/captable${path}`), fields)
const settings = async (person, orgId) => (await person.client.get(h.url('auth', `/settings/organization?org=${orgId}`))).text
const flag = async (orgId) => (await h.sql('SELECT invite_verified_domains_only AS only FROM orgs WHERE id = ?1', orgId))[0].only

let counter = 0
/** A fresh address in `domain`. */
function address(domain, prefix = 'person') {
  counter += 1
  return `${prefix}.${counter}@${domain}`
}

/** An owner (at example.test) with an organization and, unless `domain` is null, that domain verified (inserted directly). */
async function orgWith(domain, name = 'Domains Org') {
  const owner = await h.user({ name: 'Olive Owner' })
  const orgId = await h.org(owner.client, name)
  if (domain) await verify(orgId, domain)
  return { owner, orgId }
}

async function verify(orgId, domain) {
  await h.sql('INSERT INTO sso_domains (org_id, domain, token, created_at, verified_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, domain, 'synthetic-token', Date.now())
}

async function turnOn(owner, orgId) {
  const on = await post(owner, `/orgs/${orgId}/invite-domains`, { only: 'on' })
  assert.equal(on.status, 303, on.text.slice(0, 300))
  assert.equal(on.location, h.url('auth', `/settings/organization?org=${orgId}&notice=invite-domains-on`))
}

const MESSAGE = (domains) => `This organization only invites people with an address in its verified domains: ${domains}.`

test('the setting is off by default, owner-only, and offered once a domain is verified', async () => {
  const { owner, orgId } = await orgWith(null, 'Setting Org')
  assert.equal(await flag(orgId), 0, 'off by default')
  let page = await settings(owner, orgId)
  assert.match(page, /<h2>Invitations<\/h2>/)
  assert.match(page, /Verify a domain under <a href="http:\/\/insulinapps\.localhost\/settings\/sso\?org=[^"]+">Single sign-on<\/a> first/)
  assert.doesNotMatch(page, /action="\/orgs\/[^"]+\/invite-domains"/, 'no switch without a verified domain')
  const early = await post(owner, `/orgs/${orgId}/invite-domains`, { only: 'on' })
  assert.equal(early.status, 409)
  assert.match(early.text, /Verify a domain under Single sign-on first/)
  assert.equal(await flag(orgId), 0)

  // A domain that is claimed but not verified yet doesn't count.
  await h.sql("INSERT INTO sso_domains (org_id, domain, token, created_at) VALUES (?1, 'setting-pending.test', 't', 1)", orgId)
  assert.equal((await post(owner, `/orgs/${orgId}/invite-domains`, { only: 'on' })).status, 409)
  await verify(orgId, 'setting-org.test')
  page = await settings(owner, orgId)
  assert.match(page, /Anyone can be invited now\. You can allow only people with an address in your verified domains \(setting-org\.test\)/)
  assert.match(page, new RegExp(`action="/orgs/${orgId}/invite-domains"[^>]*><input type="hidden" name="only" value="on"/>`))

  const admin = await h.user()
  const viewer = await h.user()
  await h.join(owner, orgId, admin, 'ADMIN')
  await h.join(owner, orgId, viewer, 'VIEWER')
  for (const person of [admin, viewer]) {
    assert.doesNotMatch(await settings(person, orgId), /<h2>Invitations<\/h2>/, 'only owners see it')
    assert.equal((await post(person, `/orgs/${orgId}/invite-domains`, { only: 'on' })).status, 403)
  }
  const stranger = await h.user()
  assert.equal((await post(stranger, `/orgs/${orgId}/invite-domains`, { only: 'on' })).status, 404)
  assert.equal(await flag(orgId), 0)

  await turnOn(owner, orgId)
  assert.equal(await flag(orgId), 1)
  page = (await owner.client.get(h.url('auth', `/settings/organization?org=${orgId}&notice=invite-domains-on`))).text
  assert.match(page, /Only people with an address in your verified domains can be invited now\./)
  assert.match(page, /Only people with an address in your verified domains \(setting-org\.test\) can be invited or accept an invitation/)
  assert.match(page, /Allow any address/)

  // Its last verified domain gone, nobody can be invited, and the card stays so an owner can turn it off.
  await h.sql("DELETE FROM sso_domains WHERE org_id = ?1 AND domain = 'setting-org.test'", orgId)
  page = await settings(owner, orgId)
  assert.match(page, /none is verified right now, so nobody can be invited/)
  const nobody = await invite(owner, orgId, address('setting-org.test'))
  assert.equal(nobody.status, 403)
  assert.match(nobody.text, /only invites people with an address in its verified domains, and none is verified right now\./)
  const off = await post(owner, `/orgs/${orgId}/invite-domains`, { only: 'off' })
  assert.equal(off.status, 303)
  assert.equal(off.location, h.url('auth', `/settings/organization?org=${orgId}&notice=invite-domains-off`))
  assert.equal(await flag(orgId), 0)
})

test('while it is on, organization invitations go only to addresses in a verified domain, in any case or form', async () => {
  const { owner, orgId } = await orgWith('acme-invites.test', 'Acme Invites')
  await verify(orgId, 'xn--bcher-kva.test')
  const admin = await h.user()
  await h.join(owner, orgId, admin, 'ADMIN')
  const outsider = uniqueEmail('outsider')
  assert.equal((await invite(owner, orgId, outsider)).status, 303, 'off: anyone can be invited')
  await turnOn(owner, orgId)

  for (const [person, email] of [[owner, uniqueEmail('outside')], [admin, address('sub.acme-invites.test')], [admin, address('acme-invites.test.example')]]) {
    const refused = await invite(person, orgId, email)
    assert.equal(refused.status, 403, email)
    assert.ok(refused.text.includes(MESSAGE('acme-invites.test, xn--bcher-kva.test')), email)
    assert.equal((await h.sql('SELECT COUNT(*) AS n FROM invitations WHERE org_id = ?1 AND email = ?2', orgId, email))[0].n, 0, email)
  }
  assert.equal((await invite(admin, orgId, address('ACME-Invites.TEST', 'Upper'))).status, 303, 'compared case-insensitively')
  assert.equal((await invite(owner, orgId, address('bücher.test', 'anna'))).status, 303, 'and in punycode')
  assert.equal((await invite(owner, orgId, address('acme-invites.test'), 'OWNER')).status, 303)
})

test('an invitation made before the setting, or before its domain went, can no longer be accepted by someone new', async () => {
  const { owner, orgId } = await orgWith('accept-corp.test', 'Accept Corp')
  const outsider = await h.user({ name: 'Outside Person' })
  const insider = await h.user({ name: 'Inside Person', email: address('accept-corp.test') })
  assert.equal((await invite(owner, orgId, outsider.email)).status, 303)
  assert.equal((await invite(owner, orgId, insider.email)).status, 303)
  await turnOn(owner, orgId)

  const link = await h.link(outsider.email, '/invitations/')
  const refused = await outsider.client.post(`${link}/accept`, {})
  assert.equal(refused.status, 403)
  assert.ok(refused.text.includes(MESSAGE('accept-corp.test')))
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, outsider.id))[0].n, 0)
  assert.equal((await h.sql('SELECT status FROM invitations WHERE org_id = ?1 AND email = ?2', orgId, outsider.email))[0].status, 'pending')

  // The domain is removed: an invitation to it stops working too.
  await h.sql("DELETE FROM sso_domains WHERE org_id = ?1 AND domain = 'accept-corp.test'", orgId)
  const lost = await insider.client.post(`${await h.link(insider.email, '/invitations/')}/accept`, {})
  assert.equal(lost.status, 403)
  assert.match(lost.text, /none is verified right now/)
  await verify(orgId, 'accept-corp.test')
  assert.equal((await insider.client.post(`${await h.link(insider.email, '/invitations/')}/accept`, {})).status, 303, 'verified again')

  // Turned off, the outsider's invitation works again.
  assert.equal((await post(owner, `/orgs/${orgId}/invite-domains`, { only: 'off' })).status, 303)
  assert.equal((await outsider.client.post(`${link}/accept`, {})).status, 303)
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, outsider.id))[0].role, 'VIEWER')
})

test('an app\'s people page follows it for someone new, while an existing specific-apps member can still be given the app', async () => {
  const { owner, orgId } = await orgWith('app-corp.test', 'App Corp')
  // A specific-apps member from outside the domain, who joined before the setting.
  const member = await h.user()
  assert.equal((await post(owner, `/orgs/${orgId}/invitations`, { email: member.email, role: 'APPS', 'app:ledger': 'VIEWER' })).status, 303)
  assert.equal((await member.client.post(`${await h.link(member.email, '/invitations/')}/accept`, {})).status, 303)
  const pending = await h.user()
  assert.equal((await appPost(owner, '/settings/users/invite', { org_id: orgId, email: pending.email, role: 'VIEWER' })).status, 303)
  await turnOn(owner, orgId)

  const refused = await appPost(owner, '/settings/users/invite', { org_id: orgId, email: uniqueEmail('app-outsider'), role: 'VIEWER' })
  assert.equal(refused.status, 403)
  assert.ok(refused.text.includes(MESSAGE('app-corp.test')))
  const inside = address('app-corp.test')
  assert.equal((await appPost(owner, '/settings/users/invite', { org_id: orgId, email: inside, role: 'EDITOR' })).status, 303)
  assert.equal((await h.sql("SELECT role FROM invitations WHERE org_id = ?1 AND email = ?2 AND status = 'pending'", orgId, inside))[0].role, 'APPS')

  const added = await appPost(owner, '/settings/users/invite', { org_id: orgId, email: member.email, role: 'EDITOR' })
  assert.equal(added.status, 303, 'already in the organization')
  assert.match(added.location, /notice=access-added$/)
  assert.equal((await h.sql("SELECT role FROM app_grants WHERE org_id = ?1 AND user_id = ?2 AND app = 'captable'", orgId, member.id))[0].role, 'EDITOR')

  // The app invitation sent before the setting can't be accepted now.
  const late = await pending.client.post(`${await h.link(pending.email, '/invitations/')}/accept`, {})
  assert.equal(late.status, 403)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM app_grants WHERE org_id = ?1 AND user_id = ?2', orgId, pending.id))[0].n, 0)
})

test('the domain check is inside the insert and the acceptance: a setting turned on mid-request still holds', async () => {
  const { owner, orgId } = await orgWith('race-corp.test', 'Race Corp')
  const email = uniqueEmail('raced')
  // The invite form read the policy while it was off...
  assert.equal((await invitePolicy(h.db, orgId)).verifiedOnly, false)
  // ...an owner turns it on meanwhile...
  assert.equal(await setInviteVerifiedDomainsOnly(h.db, orgId, owner.id, true, Date.now()), true)
  // ...and the insert, which checks the domains itself, writes nothing.
  const now = Date.now()
  const fields = { orgId, role: 'VIEWER', grants: [], app: null, invitedBy: owner.id, now, expiresAt: now + DAY, pendingLimit: 50 }
  assert.equal(await insertInvitation(h.db, { id: randomUUID(), email, ...fields }), false)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM invitations WHERE org_id = ?1 AND email = ?2', orgId, email))[0].n, 0)
  assert.equal(await insertInvitation(h.db, { id: randomUUID(), email: address('race-corp.test'), ...fields }), true, 'an address in the domain')
  const app = { role: 'APPS', app: 'captable', grants: [{ app: 'captable', role: 'VIEWER', customRoleId: null }] }
  assert.equal(await insertInvitation(h.db, { ...fields, ...app, id: randomUUID(), email: uniqueEmail('raced-app') }), false, 'from an app page too')
  assert.equal(await insertInvitation(h.db, { ...fields, ...app, id: randomUUID(), email: address('RACE-corp.test') }), true, 'its domain in any case')

  // An acceptance that found the invitation open, after which the domain is removed, adds nobody.
  const insider = await h.user({ email: address('race-corp.test') })
  const id = randomUUID()
  assert.equal(await insertInvitation(h.db, { id, email: insider.email, ...fields }), true)
  assert.equal((await findInvitation(h.db, id)).status, 'pending')
  await h.sql("DELETE FROM sso_domains WHERE org_id = ?1 AND domain = 'race-corp.test'", orgId)
  assert.equal(await acceptInvitation(h.db, id, insider.id, insider.email, Date.now(), 100), false)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, insider.id))[0].n, 0)
  assert.equal((await findInvitation(h.db, id)).status, 'pending')

  // An owner demoted meanwhile changes nothing.
  const other = await h.user()
  await h.sql("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', ?3, ?3)", orgId, other.id, Date.now())
  assert.equal(await setInviteVerifiedDomainsOnly(h.db, orgId, other.id, false, Date.now()), false)
  assert.equal(await flag(orgId), 1)
  assert.equal(await setInviteVerifiedDomainsOnly(h.db, orgId, owner.id, false, Date.now()), true)
  assert.equal(await setInviteVerifiedDomainsOnly(h.db, orgId, owner.id, true, Date.now()), false, 'and turning it on needs a verified domain')
})
