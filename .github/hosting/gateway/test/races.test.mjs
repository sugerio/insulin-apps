// Interleavings from the security review, replayed against the real database. A request reads and checks something,
// another request changes it, and then the first request writes. The write runs through the gateway's own data
// modules (called with Miniflare's D1 binding), so the guard under test is the one in the SQL, and it must change
// nothing.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { TOKENS, startGateway, uniqueEmail } from './helpers/harness.mjs'
import { hashPassword } from '../src/crypto.ts'
import { changePassword, findUserByEmail, resetPassword } from '../src/db/users.ts'
import { insertSession } from '../src/db/sessions.ts'
import { changeRole, deleteOrg, removeMember, renameOrg } from '../src/db/orgs.ts'
import { claimResend, findInvitation, insertInvitation, revokeInvitation } from '../src/db/invitations.ts'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const DAY = 24 * 60 * 60 * 1000

async function count(query, ...params) {
  return (await h.sql(query, ...params))[0].n
}

test('review 2, first interleaving: a sign-in that verified the old password before a reset gets no session', async () => {
  const { email, id } = await h.user()
  // The sign-in reads the account and verifies the old password...
  const seen = await findUserByEmail(h.db, email)
  // ...the owner resets the password in the meantime...
  const version = await resetPassword(h.db, id, await hashPassword('the reset password'), Date.now())
  assert.equal(version, seen.credential_version + 1)
  // ...and the sign-in's session insert, conditional on the version it verified, creates nothing.
  const created = await insertSession(h.db, {
    idHash: sha256('late sign-in'), userId: id, activeOrgId: null, credentialVersion: seen.credential_version, now: Date.now(), expiresAt: Date.now() + DAY,
  })
  assert.equal(created, false)
  assert.equal(await count('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?1', sha256('late sign-in')), 0)
  // The same insert under the current version works: the guard is the version, nothing else.
  assert.equal(await insertSession(h.db, {
    idHash: sha256('fresh sign-in'), userId: id, activeOrgId: null, credentialVersion: version, now: Date.now(), expiresAt: Date.now() + DAY,
  }), true)
})

test('review 2: a session row from before a credential change no longer authenticates, even if it exists', async () => {
  const { client, email, id } = await h.user()
  const [before] = await h.sql('SELECT * FROM sessions WHERE user_id = ?1', id)
  await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot })
  const link = await h.link(email, '/reset-password')
  await h.client().post(h.url('auth', '/reset-password'), { token: new URL(link).searchParams.get('token'), password: 'a password after reset' })
  // Put the old session row back, as a session created under the old version would be: it must not count.
  await h.sql(
    'INSERT INTO sessions (id_hash, user_id, active_org_id, credential_version, created_at, last_seen_at, expires_at) VALUES (?1, ?2, NULL, ?3, ?4, ?4, ?5)',
    before.id_hash, id, before.credential_version, Date.now(), Date.now() + DAY,
  )
  const home = await client.get(h.url('auth', '/'))
  assert.equal(home.status, 302, 'the old cookie is signed out')
  assert.match(home.location, /\/login/)
})

test('review 2, second interleaving: a password change that verified the old password before a reset cannot overwrite it', async () => {
  const user = await h.user()
  // The change request loads its session (credential version v) and checks the current password...
  const [session] = await h.sql('SELECT id_hash, credential_version FROM sessions WHERE user_id = ?1', user.id)
  // ...a reset lands first...
  await resetPassword(h.db, user.id, await hashPassword('the reset password'), Date.now())
  // ...then the change writes, conditional on v: refused, and the reset's password stands.
  const changed = await changePassword(h.db, {
    userId: user.id, passwordHash: await hashPassword('the late change'), verifiedVersion: session.credential_version, sessionHash: session.id_hash, now: Date.now(),
  })
  assert.equal(changed, false)
  assert.equal((await h.signIn(h.client(), { email: user.email, password: 'the reset password' })).status, 303)
  assert.equal((await h.signIn(h.client(), { email: user.email, password: 'the late change' })).status, 401)
})

test('review 2: a password change raises the version, keeps this session and ends the others, in one transaction', async () => {
  const user = await h.user()
  const other = h.client()
  await h.signIn(other, { email: user.email })
  const [{ credential_version: before }] = await h.sql('SELECT credential_version FROM users WHERE id = ?1', user.id)
  const changed = await user.client.post(h.url('auth', '/account/password'), { current_password: 'correct horse battery staple', password: 'a changed password' })
  assert.equal(changed.status, 303)
  const [{ credential_version: afterward }] = await h.sql('SELECT credential_version FROM users WHERE id = ?1', user.id)
  assert.equal(afterward, before + 1)
  assert.equal((await user.client.get(h.url('auth', '/account'))).status, 200, 'this session moved to the new version')
  assert.equal((await other.get(h.url('auth', '/account'))).status, 302, 'the other one ended')
  assert.deepEqual((await h.sql('SELECT DISTINCT credential_version AS v FROM sessions WHERE user_id = ?1', user.id)).map((row) => row.v), [afterward])
})

/** An organization with an owner, a second owner, an admin and two other members. */
async function team() {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Race Org')
  const people = { owner }
  for (const [key, role] of [['second', 'OWNER'], ['admin', 'ADMIN'], ['editor', 'EDITOR'], ['viewer', 'VIEWER']]) {
    people[key] = await h.user()
    await h.join(owner, orgId, people[key], role)
  }
  return { orgId, ...people }
}

test('review 4: an owner who loses the role or is removed mid-request can neither rename nor delete the organization', async () => {
  const { orgId, owner, second } = await team()
  // `second` passed the OWNER check, then lost the role before the write.
  await h.sql("UPDATE memberships SET role = 'ADMIN' WHERE org_id = ?1 AND user_id = ?2", orgId, second.id)
  assert.equal(await renameOrg(h.db, orgId, second.id, 'Taken over', Date.now()), false)
  assert.equal(await deleteOrg(h.db, orgId, second.id), false)
  await h.sql('DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, second.id)
  assert.equal(await renameOrg(h.db, orgId, second.id, 'Taken over', Date.now()), false)
  assert.equal(await deleteOrg(h.db, orgId, second.id), false)
  assert.equal((await h.sql('SELECT name FROM orgs WHERE id = ?1', orgId))[0].name, 'Race Org')
  assert.equal(await renameOrg(h.db, orgId, owner.id, 'Renamed by an owner', Date.now()), true, 'a current owner still can')
})

test('review 4: an admin whose role is lowered or who is removed mid-request cannot invite, revoke, resend, change roles or remove members', async () => {
  const { orgId, owner, admin, editor, viewer } = await team()
  const pendingEmail = uniqueEmail('pending-before-race')
  await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations`), { email: pendingEmail, role: 'USER' })
  const pending = await findInvitation(h.db, (await h.sql('SELECT id FROM invitations WHERE email = ?1', pendingEmail))[0].id)
  // Old enough to resend, so the resend below is refused only because of the actor's role.
  await h.sql('UPDATE invitations SET last_sent_at = ?1 WHERE id = ?2', Date.now() - 11 * 60 * 1000, pending.id)
  const stale = await findInvitation(h.db, pending.id)

  for (const lower of [
    () => h.sql("UPDATE memberships SET role = 'EDITOR' WHERE org_id = ?1 AND user_id = ?2", orgId, admin.id),
    () => h.sql('DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, admin.id),
  ]) {
    await lower()
    const invited = await insertInvitation(h.db, {
      id: randomUUID(), orgId, email: uniqueEmail('raced-invite'), role: 'USER', invitedBy: admin.id, now: Date.now(), expiresAt: Date.now() + DAY, pendingLimit: 50,
    })
    assert.equal(invited, false, 'invite')
    assert.equal(await revokeInvitation(h.db, pending.id, admin.id, Date.now()), false, 'revoke')
    assert.equal(await claimResend(h.db, stale, admin.id, Date.now(), 10 * 60 * 1000, Date.now() + DAY), false, 'resend')
    assert.equal(await changeRole(h.db, { orgId, userId: editor.id, current: 'EDITOR', next: 'VIEWER', actorId: admin.id, now: Date.now() }), false, 'change a role')
    assert.equal(await removeMember(h.db, orgId, viewer.id, 'VIEWER', admin.id), false, 'remove a member')
  }
  assert.equal(await count("SELECT COUNT(*) AS n FROM invitations WHERE org_id = ?1 AND email LIKE 'raced-invite%'", orgId), 0)
  assert.equal((await findInvitation(h.db, pending.id)).status, 'pending')
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, editor.id))[0].role, 'EDITOR')
  assert.equal(await count('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, viewer.id), 1)
  // An owner, whose role is current, still can.
  assert.equal(await changeRole(h.db, { orgId, userId: editor.id, current: 'EDITOR', next: 'VIEWER', actorId: owner.id, now: Date.now() }), true)
  assert.equal(await revokeInvitation(h.db, pending.id, owner.id, Date.now()), true)
})

test('review 4: an admin keeps the OWNER limits inside the statement', async () => {
  const { orgId, admin, second } = await team()
  assert.equal(await changeRole(h.db, { orgId, userId: second.id, current: 'OWNER', next: 'VIEWER', actorId: admin.id, now: Date.now() }), false, 'cannot change an owner')
  assert.equal(await removeMember(h.db, orgId, second.id, 'OWNER', admin.id), false, 'cannot remove an owner')
  assert.equal(await insertInvitation(h.db, {
    id: randomUUID(), orgId, email: uniqueEmail('owner-invite'), role: 'OWNER', invitedBy: admin.id, now: Date.now(), expiresAt: Date.now() + DAY, pendingLimit: 50,
  }), false, 'cannot invite an owner')
})

test('review 8: concurrent invitations cannot pass the 50-pending cap', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Cap Race Org')
  const now = Date.now()
  for (let i = 0; i < 48; i += 1) {
    await h.sql("INSERT INTO invitations (id, org_id, email, role, invited_by, status, created_at, expires_at, last_sent_at) VALUES (?1, ?2, ?3, 'USER', ?4, 'pending', ?5, ?6, ?5)",
      randomUUID(), orgId, `queued.${i}@example.test`, owner.id, now, now + DAY)
  }
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => owner.client.post(h.url('auth', `/orgs/${orgId}/invitations`), { email: uniqueEmail(`burst-${i}`), role: 'USER' })))
  assert.deepEqual(responses.map((response) => response.status).sort(), [303, 303, 409, 409, 409, 409])
  assert.equal(await count("SELECT COUNT(*) AS n FROM invitations WHERE org_id = ?1 AND status = 'pending'", orgId), 50)
  assert.equal(await insertInvitation(h.db, {
    id: randomUUID(), orgId, email: uniqueEmail('over-cap'), role: 'USER', invitedBy: owner.id, now: Date.now(), expiresAt: Date.now() + DAY, pendingLimit: 50,
  }), false, 'the insert itself enforces the cap')
})
