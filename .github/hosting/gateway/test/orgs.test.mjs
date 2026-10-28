// Organizations, roles and members, the active organization, and access across organizations.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { NAVIGATE, UUID, startGateway } from './helpers/harness.mjs'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

async function forwarded(client) {
  const response = await client.get(h.url('captable', '/api/echo'))
  assert.equal(response.status, 200, response.text.slice(0, 300))
  return JSON.parse(response.text).headers
}

/** An organization with one member per role; returns everyone. */
async function team(name = 'Team Org') {
  const owner = await h.user({ name: 'Olive Owner' })
  const orgId = await h.org(owner.client, name)
  const people = { owner }
  for (const role of ['ADMIN', 'EDITOR', 'USER', 'VIEWER']) {
    people[role.toLowerCase()] = await h.user({ name: `${role[0]}${role.slice(1).toLowerCase()} Person` })
    await h.join(owner, orgId, people[role.toLowerCase()], role)
  }
  return { orgId, ...people }
}

const post = (person, path, fields = {}) => person.client.post(h.url('auth', path), fields)

test('creating an organization makes you its owner and your active organization', async () => {
  const { client, id } = await h.user()
  const created = await client.post(h.url('auth', '/orgs/new'), { name: '  Example   Holdings  ' })
  assert.equal(created.status, 303)
  const orgId = new RegExp(`/orgs/(${UUID})\\?notice=created$`).exec(created.location)[1]
  const [membership] = await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, id)
  assert.equal(membership.role, 'OWNER')
  assert.equal((await h.sql('SELECT name FROM orgs WHERE id = ?1', orgId))[0].name, 'Example Holdings')
  const page = await client.get(h.url('auth', `/orgs/${orgId}?notice=created`))
  assert.match(page.text, /<h1>Example Holdings<\/h1>/)
  assert.match(page.text, /Your role: <strong>Owner<\/strong>/)
  assert.match(page.text, /Active organization/)
  assert.equal((await forwarded(client))['x-suger-organization-id'], orgId)
  for (const name of ['', '   ', 'x'.repeat(81)]) {
    assert.equal((await client.post(h.url('auth', '/orgs/new'), { name })).status, 400, `name ${JSON.stringify(name)}`)
  }
})

test('a user can create 10 organizations in total; deleting one does not give the slot back', async () => {
  const { client } = await h.user()
  const ids = []
  for (let i = 1; i <= 10; i += 1) ids.push(await h.org(client, `Org ${i}`))
  const eleventh = await client.post(h.url('auth', '/orgs/new'), { name: 'One too many' })
  assert.equal(eleventh.status, 409)
  assert.match(eleventh.text, /limit of 10 organizations/)
  await client.post(h.url('auth', `/orgs/${ids[0]}/delete`), { confirm: 'Org 1' })
  assert.equal((await client.post(h.url('auth', '/orgs/new'), { name: 'Still too many' })).status, 409)
})

test('each role sees what the console role allows', async () => {
  const people = await team('Visibility Org')
  const page = async (person) => (await person.client.get(h.url('auth', `/orgs/${people.orgId}`))).text
  const owner = await page(people.owner)
  assert.match(owner, /<h2>Members<\/h2>/)
  assert.ok(owner.includes(people.viewer.email), 'owners see addresses')
  assert.match(owner, /Invite people/)
  assert.match(owner, /Delete this organization/)
  assert.match(owner, new RegExp(`action="/orgs/${UUID}/rename"`))
  const admin = await page(people.admin)
  assert.match(admin, /Invite people/)
  assert.doesNotMatch(admin, /Delete this organization/)
  assert.doesNotMatch(admin, /<option value="OWNER">/, 'ADMIN cannot offer OWNER')
  const editor = await page(people.editor)
  assert.ok(editor.includes(people.viewer.email), 'editors see the member list')
  assert.doesNotMatch(editor, /Invite people/)
  for (const person of [people.user, people.viewer]) {
    const text = await page(person)
    assert.match(text, /Only editors, admins and owners can see the member list/)
    assert.ok(!text.includes(people.owner.email), 'no member addresses')
    assert.doesNotMatch(text, /Invite people/)
  }
  assert.match(await page(people.viewer), /Your role: <strong>Viewer<\/strong>/)
})

test('the server enforces roles: ADMIN cannot grant, change or remove OWNER, and lower roles manage nothing', async () => {
  const people = await team('Rules Org')
  const { orgId, owner, admin, editor, user, viewer } = people
  assert.equal((await post(admin, `/orgs/${orgId}/rename`, { name: 'Renamed' })).status, 403)
  assert.equal((await post(admin, `/orgs/${orgId}/delete`, { confirm: 'Rules Org' })).status, 403)
  assert.equal((await post(admin, `/orgs/${orgId}/members/${editor.id}/role`, { role: 'OWNER' })).status, 403, 'ADMIN granting OWNER')
  assert.equal((await post(admin, `/orgs/${orgId}/members/${owner.id}/role`, { role: 'VIEWER' })).status, 403, 'ADMIN changing an OWNER')
  assert.equal((await post(admin, `/orgs/${orgId}/members/${owner.id}/remove`)).status, 403, 'ADMIN removing an OWNER')
  assert.equal((await post(editor, `/orgs/${orgId}/members/${viewer.id}/role`, { role: 'USER' })).status, 403)
  assert.equal((await post(user, `/orgs/${orgId}/members/${viewer.id}/remove`)).status, 403)
  assert.equal((await post(editor, `/orgs/${orgId}/invitations`, { email: 'new.person@example.test', role: 'VIEWER' })).status, 403)

  assert.equal((await post(admin, `/orgs/${orgId}/members/${editor.id}/role`, { role: 'ADMIN' })).status, 303)
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, editor.id))[0].role, 'ADMIN')
  assert.equal((await post(admin, `/orgs/${orgId}/members/${viewer.id}/remove`)).status, 303)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, viewer.id))[0].n, 0)
  assert.equal((await post(owner, `/orgs/${orgId}/members/${admin.id}/role`, { role: 'OWNER' })).status, 303, 'OWNER can grant OWNER')
  assert.equal((await post(owner, `/orgs/${orgId}/members/${user.id}/role`, { role: 'SUPERUSER' })).status, 400)
  assert.equal((await forwarded(admin.client))['x-suger-app-role'], 'OWNER', 'the new role reaches the apps at once')
})

test('the last owner can neither leave, nor lose the owner role, nor be removed; with two owners one may leave', async () => {
  const owner = await h.user()
  const second = await h.user()
  const orgId = await h.org(owner.client, 'Owners Org')
  const leave = await post(owner, `/orgs/${orgId}/leave`)
  assert.equal(leave.status, 409)
  assert.match(leave.text, /only owner/)
  assert.equal((await post(owner, `/orgs/${orgId}/members/${owner.id}/role`, { role: 'ADMIN' })).status, 409)
  assert.equal((await post(owner, `/orgs/${orgId}/members/${owner.id}/remove`)).status, 409)
  assert.equal((await h.sql("SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2", orgId, owner.id))[0].role, 'OWNER')
  await h.join(owner, orgId, second, 'OWNER')
  assert.equal((await post(owner, `/orgs/${orgId}/members/${owner.id}/role`, { role: 'ADMIN' })).status, 303, 'another owner remains')
  assert.equal((await post(second, `/orgs/${orgId}/leave`)).status, 409, 'now second is the last owner')
  assert.equal((await post(owner, `/orgs/${orgId}/leave`)).status, 303, 'an admin may leave')
})

test('deleting an organization needs its name typed exactly and moves members to their next organization', async () => {
  const owner = await h.user()
  const member = await h.user()
  const older = await h.org(member.client, 'Member Own Org')
  const orgId = await h.org(owner.client, 'Doomed Org')
  await h.join(owner, orgId, member, 'EDITOR')
  assert.equal((await forwarded(member.client))['x-suger-organization-id'], orgId, 'joining made it active')
  const page = await owner.client.get(h.url('auth', `/orgs/${orgId}`))
  assert.match(page.text, /Apps keep the data they stored for it, but nobody can reach that data again/)
  assert.equal((await post(owner, `/orgs/${orgId}/delete`, { confirm: 'doomed org' })).status, 400)
  const deleted = await post(owner, `/orgs/${orgId}/delete`, { confirm: ' Doomed Org ' })
  assert.equal(deleted.status, 303)
  assert.equal(deleted.location, h.url('auth', '/?notice=org-deleted'))
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1', orgId))[0].n, 0)
  assert.equal((await forwarded(member.client))['x-suger-organization-id'], older)
  const ownerApp = await owner.client.raw(h.url('captable', '/dashboard?tab=1'), { headers: NAVIGATE })
  assert.equal(ownerApp.status, 302, 'no organization left')
  assert.equal(ownerApp.location, h.url('auth', `/orgs/new?return_to=${encodeURIComponent(h.url('captable', '/dashboard?tab=1'))}`))
})

test('switching organization changes what the apps receive; a removed member falls back to the oldest membership', async () => {
  const owner = await h.user()
  const member = await h.user()
  const first = await h.org(member.client, 'First Own Org')
  const shared = await h.org(owner.client, 'Shared Switch Org')
  await h.join(owner, shared, member, 'VIEWER')
  assert.equal((await forwarded(member.client))['x-suger-app-role'], 'VIEWER')
  const switched = await member.client.post(h.url('auth', '/orgs/switch'), { org_id: first })
  assert.equal(switched.status, 303)
  let headers = await forwarded(member.client)
  assert.equal(headers['x-suger-organization-id'], first)
  assert.equal(headers['x-suger-app-role'], 'OWNER')
  await member.client.post(h.url('auth', '/orgs/switch'), { org_id: shared })
  assert.equal((await forwarded(member.client))['x-suger-organization-id'], shared)
  await post(owner, `/orgs/${shared}/members/${member.id}/remove`)
  headers = await forwarded(member.client)
  assert.equal(headers['x-suger-organization-id'], first, 'oldest remaining membership')
  assert.equal(headers['x-suger-app-role'], 'OWNER')
})

test('nobody reaches another organization: pages, actions and switching all answer 404', async () => {
  const alice = await h.user()
  const bob = await h.user()
  const aliceOrg = await h.org(alice.client, 'Alice Org')
  const bobOrg = await h.org(bob.client, 'Bob Org')
  assert.equal((await bob.client.get(h.url('auth', `/orgs/${aliceOrg}`))).status, 404)
  for (const [path, fields] of [
    [`/orgs/${aliceOrg}/rename`, { name: 'Taken' }],
    [`/orgs/${aliceOrg}/delete`, { confirm: 'Alice Org' }],
    [`/orgs/${aliceOrg}/leave`, {}],
    [`/orgs/${aliceOrg}/invitations`, { email: bob.email, role: 'OWNER' }],
    [`/orgs/${aliceOrg}/members/${alice.id}/role`, { role: 'VIEWER' }],
    [`/orgs/${aliceOrg}/members/${alice.id}/remove`, {}],
    ['/orgs/switch', { org_id: aliceOrg }],
  ]) {
    assert.equal((await post(bob, path, fields)).status, 404, path)
  }
  const api = await bob.client.post(h.url('captable', '/__insulin/switch-org'), {}, {
    contentType: 'application/json', body: JSON.stringify({ orgId: aliceOrg }), headers: { Accept: 'application/json' },
  })
  assert.equal(api.status, 404)
  assert.equal((await forwarded(bob.client))['x-suger-organization-id'], bobOrg)
  assert.equal((await h.sql('SELECT name FROM orgs WHERE id = ?1', aliceOrg))[0].name, 'Alice Org')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1', aliceOrg))[0].n, 1)
  assert.equal((await bob.client.get(h.url('auth', '/orgs/not-an-id'))).status, 404)
})
