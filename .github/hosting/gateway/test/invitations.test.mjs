// Invitations: one pending per organization and address, roles within reach, limits, and acceptance only by a
// signed-in user whose confirmed address is the invited one.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { startGateway, uniqueEmail } from './helpers/harness.mjs'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

const DAY = 24 * 60 * 60 * 1000
const invite = (person, orgId, email, role = 'USER') => person.client.post(h.url('auth', `/orgs/${orgId}/invitations`), { email, role })

async function invitation(orgId, email) {
  const [row] = await h.sql('SELECT * FROM invitations WHERE org_id = ?1 AND email = ?2 ORDER BY created_at DESC', orgId, email)
  return row
}

test('an invitation email names the inviter, organization and role and links to the invitation', async () => {
  const owner = await h.user({ name: 'Iris Inviter' })
  const orgId = await h.org(owner.client, 'Invite & <Co>')
  const email = uniqueEmail('invitee')
  const sent = await invite(owner, orgId, email.toUpperCase(), 'EDITOR')
  assert.equal(sent.status, 303)
  assert.equal(sent.location, h.url('auth', `/orgs/${orgId}?notice=invited`))
  const row = await invitation(orgId, email)
  assert.equal(row.status, 'pending')
  assert.equal(row.role, 'EDITOR')
  assert.equal(row.expires_at - row.created_at, 7 * DAY)
  const [mail] = await h.waitForMail(email)
  assert.equal(mail.subject, 'Iris Inviter invited you to Invite & <Co> on Insulin Apps')
  assert.match(mail.text, /as Editor/)
  assert.ok(mail.text.includes(h.url('auth', `/invitations/${row.id}`)))
  assert.ok(mail.html.includes('Invite &amp; &lt;Co&gt;'), 'the HTML part escapes the organization name')
  assert.ok(!mail.html.includes('<Co>'))
})

test('one pending invitation per organization and address; an expired one makes room', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Single Invite Org')
  const email = uniqueEmail('once')
  assert.equal((await invite(owner, orgId, email)).status, 303)
  const duplicate = await invite(owner, orgId, email, 'VIEWER')
  assert.equal(duplicate.status, 409)
  assert.match(duplicate.text, /already a pending invitation/)
  await h.sql('UPDATE invitations SET expires_at = ?1 WHERE org_id = ?2 AND email = ?3', Date.now() - 1, orgId, email)
  assert.equal((await invite(owner, orgId, email, 'VIEWER')).status, 303)
  const rows = await h.sql('SELECT status, role FROM invitations WHERE org_id = ?1 AND email = ?2 ORDER BY created_at', orgId, email)
  assert.deepEqual(rows.map((r) => r.status), ['expired', 'pending'])
  const member = await h.user()
  await h.join(owner, orgId, member, 'USER')
  assert.equal((await invite(owner, orgId, member.email)).status, 409, 'already a member')
})

test('an admin can invite admins but not owners', async () => {
  const owner = await h.user()
  const admin = await h.user()
  const orgId = await h.org(owner.client, 'Admin Invite Org')
  await h.join(owner, orgId, admin, 'ADMIN')
  const asOwner = await invite(admin, orgId, uniqueEmail('would-be-owner'), 'OWNER')
  assert.equal(asOwner.status, 403)
  assert.match(asOwner.text, /can&#x27;t invite someone as Owner/)
  assert.equal((await invite(admin, orgId, uniqueEmail('new-admin'), 'ADMIN')).status, 303)
  assert.equal((await invite(owner, orgId, uniqueEmail('new-owner'), 'OWNER')).status, 303)
})

test('revoking closes the invitation, and resending is limited to once every 10 minutes', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Revoke Org')
  const email = uniqueEmail('revoked')
  await invite(owner, orgId, email)
  const row = await invitation(orgId, email)
  const early = await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations/${row.id}/resend`), {})
  assert.equal(early.status, 429)
  assert.match(early.text, /once every 10 minutes/)
  await h.sql('UPDATE invitations SET last_sent_at = ?1, expires_at = ?2 WHERE id = ?3', Date.now() - 11 * 60 * 1000, Date.now() + DAY, row.id)
  const resent = await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations/${row.id}/resend`), {})
  assert.equal(resent.status, 303)
  await h.waitForMail(email, 2)
  assert.ok((await invitation(orgId, email)).expires_at > Date.now() + 6 * DAY, 'resending renews the expiry')
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations/${row.id}/resend`), {})).status, 429)

  const revoked = await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations/${row.id}/revoke`), {})
  assert.equal(revoked.status, 303)
  assert.equal((await invitation(orgId, email)).status, 'revoked')
  const invitee = await h.user({ email })
  const page = await invitee.client.get(h.url('auth', `/invitations/${row.id}`))
  assert.equal(page.status, 410)
  assert.match(page.text, /no longer valid/)
  const accept = await invitee.client.post(h.url('auth', `/invitations/${row.id}/accept`), {})
  assert.equal(accept.status, 410)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, invitee.id))[0].n, 0)
})

test('limits: 50 pending invitations, 30 invitation emails a day, 100 members', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Limits Org')
  const now = Date.now()
  for (let i = 0; i < 50; i += 1) {
    await h.sql("INSERT INTO invitations (id, org_id, email, role, invited_by, status, created_at, expires_at, last_sent_at) VALUES (?1, ?2, ?3, 'USER', ?4, 'pending', ?5, ?6, ?5)",
      randomUUID(), orgId, `bulk.${i}@example.test`, owner.id, now, now + DAY)
  }
  const pending = await invite(owner, orgId, uniqueEmail('fifty-first'))
  assert.equal(pending.status, 409)
  assert.match(pending.text, /50 pending invitations/)
  await h.sql("DELETE FROM invitations WHERE org_id = ?1 AND email LIKE 'bulk.%'", orgId)

  for (let i = 0; i < 30; i += 1) await h.sql("INSERT INTO mail_log (recipient_hash, kind, org_id, created_at) VALUES (?1, 'invitation', ?2, ?3)", `hash-${i}`, orgId, now)
  const daily = await invite(owner, orgId, uniqueEmail('thirty-first'))
  assert.equal(daily.status, 429)
  assert.match(daily.text, /30 invitation emails/)
  await h.sql("DELETE FROM mail_log WHERE org_id = ?1", orgId)

  const late = uniqueEmail('late-joiner')
  assert.equal((await invite(owner, orgId, late)).status, 303)
  for (let i = 0; i < 99; i += 1) {
    const id = randomUUID()
    await h.sql("INSERT INTO users (id, email, name, email_verified_at, created_at, updated_at) VALUES (?1, ?2, 'Bulk', ?3, ?3, ?3)", id, `member.${i}.${orgId}@example.test`, now)
    await h.sql("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'VIEWER', ?3, ?3)", orgId, id, now)
  }
  const full = await invite(owner, orgId, uniqueEmail('one-hundred-first'))
  assert.equal(full.status, 409)
  assert.match(full.text, /limit of 100 members/)
  const joiner = await h.user({ email: late })
  const row = await invitation(orgId, late)
  const refused = await joiner.client.post(h.url('auth', `/invitations/${row.id}/accept`), {})
  assert.equal(refused.status, 409)
  assert.match(refused.text, /limit of 100 members/)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1', orgId))[0].n, 100)
})

test('only the invited, confirmed address can accept; the link alone grants nothing', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Match Org')
  const email = uniqueEmail('Mixed.Case')
  await invite(owner, orgId, email, 'ADMIN')
  const link = await h.link(email.toLowerCase(), '/invitations/')
  const id = new URL(link).pathname.split('/').pop()

  const anonymous = await h.client().get(link)
  assert.equal(anonymous.status, 200)
  assert.match(anonymous.text, /<h1>You&#x27;re invited<\/h1>/)
  const signupHref = anonymous.text.match(/href="(\/signup\?[^"]+)"/)[1].replaceAll('&amp;', '&')
  const signupUrl = new URL(signupHref, h.url('auth'))
  assert.equal(signupUrl.searchParams.get('email'), email.toLowerCase())
  assert.equal(signupUrl.searchParams.get('return_to'), link)
  const signedOut = await h.client().post(`${link}/accept`, {})
  assert.equal(signedOut.status, 303, 'signed out: sign in first')
  assert.equal(signedOut.location, h.url('auth', `/login?return_to=${encodeURIComponent(link)}`), 'and come back to the invitation')

  const stranger = await h.user()
  const mismatch = await stranger.client.get(link)
  assert.equal(mismatch.status, 403)
  assert.match(mismatch.text, /for another email address/)
  assert.equal((await stranger.client.post(`${link}/accept`, {})).status, 403)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1', orgId))[0].n, 1, 'nobody joined')

  // The invitee signs up from the invitation page, confirms, comes back, and accepts.
  const invitee = h.client()
  await h.signUp(invitee, { email: email.toLowerCase(), returnTo: link })
  const confirmed = await h.confirm(invitee, email.toLowerCase())
  assert.equal(confirmed.status, 303)
  assert.equal(confirmed.location, link, 'back to the invitation')
  const open = await invitee.get(link)
  assert.equal(open.status, 200)
  assert.match(open.text, /Accept invitation/)
  const accepted = await invitee.post(`${link}/accept`, {})
  assert.equal(accepted.status, 303)
  assert.equal(accepted.location, h.url('auth', `/orgs/${orgId}?notice=joined`))
  const [row] = await h.sql('SELECT status FROM invitations WHERE id = ?1', id)
  assert.equal(row.status, 'accepted')
  const echo = JSON.parse((await invitee.get(h.url('captable', '/api/echo'))).text).headers
  assert.equal(echo['x-suger-organization-id'], orgId)
  assert.equal(echo['x-suger-app-role'], 'ADMIN')
  assert.equal((await invitee.post(`${link}/accept`, {})).status, 410, 'answered once')
})

test('an expired invitation cannot be accepted', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Expiry Org')
  const invitee = await h.user()
  await invite(owner, orgId, invitee.email)
  const row = await invitation(orgId, invitee.email)
  await h.sql('UPDATE invitations SET expires_at = ?1 WHERE id = ?2', Date.now() - 1, row.id)
  assert.equal((await invitee.client.post(h.url('auth', `/invitations/${row.id}/accept`), {})).status, 410)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, invitee.id))[0].n, 0)
})

test('open invitations are listed on the home page and on /orgs/new, where they can be declined or accepted', async () => {
  const owner = await h.user()
  const orgA = await h.org(owner.client, 'Listed Org A')
  const orgB = await h.org(owner.client, 'Listed Org B')
  const invitee = await h.user()
  await invite(owner, orgA, invitee.email, 'VIEWER')
  await invite(owner, orgB, invitee.email, 'EDITOR')
  const home = await invitee.client.get(h.url('auth', '/'))
  assert.match(home.text, /<h2>Invitations<\/h2>/)
  assert.match(home.text, /Listed Org A/)
  assert.match(home.text, /Listed Org B/)
  const appUrl = h.url('captable', '/companies')
  const newOrg = await invitee.client.get(h.url('auth', `/orgs/new?return_to=${encodeURIComponent(appUrl)}`))
  assert.match(newOrg.text, /Listed Org A/)
  assert.ok(newOrg.text.includes(`name="return_to" value="${appUrl}"`), 'accepting from here returns to the app')
  const a = await invitation(orgA, invitee.email)
  const b = await invitation(orgB, invitee.email)
  const declined = await invitee.client.post(h.url('auth', `/invitations/${a.id}/decline`), {})
  assert.equal(declined.status, 303)
  assert.equal((await invitation(orgA, invitee.email)).status, 'declined')
  const accepted = await invitee.client.post(h.url('auth', `/invitations/${b.id}/accept`), { return_to: appUrl })
  assert.equal(accepted.status, 200, 'continues to the app through a page')
  assert.match(accepted.text, /url=http:\/\/captable\.insulinapps\.localhost\/companies/)
  assert.doesNotMatch((await invitee.client.get(h.url('auth', '/'))).text, /<h2>Invitations<\/h2>/)
})
