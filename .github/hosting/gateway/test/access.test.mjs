// Roles for every app (DESIGN.md §2, §3): specific-apps access, custom roles and what the apps receive, the app's own
// people page, the triggers that keep the two kinds of access apart, and the migration that retired USER.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { APPS, NAVIGATE, splitStatements, startGateway, uniqueEmail } from './helpers/harness.mjs'
import { COMPATIBILITY_DATE, gatewayDir } from './helpers/bundle.mjs'
import { removeGrant, upsertGrant, updateCustomRole } from '../src/db/grants.ts'
import { insertInvitation } from '../src/db/invitations.ts'
import { setAppAccess } from '../src/db/orgs.ts'

const CATALOG = [
  { key: 'captable.manage', label: 'Record changes', description: 'Record and reverse equity changes.', role: 'EDITOR' },
  { key: 'captable.view', label: 'View the cap table', description: 'See everything, read only.', role: 'EDITOR' },
  { key: 'portfolio.view', label: 'See own holdings', description: 'Their own holdings.', role: 'VIEWER' },
]

let h
before(async () => {
  h = await startGateway({ apps: APPS.map((app) => (app.name === 'captable' ? { ...app, permissions: CATALOG } : app)) })
})
after(async () => { await h?.close() })

const post = (person, path, fields = {}) => person.client.post(h.url('auth', path), fields)
// An app's settings live on the apex, under /apps/<app> (the app's own host only redirects there).
const appPost = (person, path, fields = {}) => person.client.post(h.url('apex', `/apps/captable${path}`), fields)
const appPage = (person, path) => person.client.get(h.url('apex', `/apps/captable${path}`))

async function forwarded(client) {
  const response = await client.get(h.url('captable', '/api/echo'))
  assert.equal(response.status, 200, response.text.slice(0, 300))
  return JSON.parse(response.text).headers
}

/** Invites `invitee` with specific-apps access (`grants`: { captable: 'EDITOR', ... }) and accepts. */
async function joinApps(owner, orgId, invitee, grants) {
  const fields = { email: invitee.email, role: 'APPS' }
  for (const [app, value] of Object.entries(grants)) fields[`app:${app}`] = value
  const invited = await post(owner, `/orgs/${orgId}/invitations`, fields)
  assert.equal(invited.status, 303, invited.text.slice(0, 400))
  const link = await h.link(invitee.email, '/invitations/')
  const accepted = await invitee.client.post(`${link}/accept`, {})
  assert.equal(accepted.status, 303, accepted.text.slice(0, 300))
}

async function customRole(owner, orgId, name, permissions) {
  const body = new URLSearchParams({ app: 'captable', name, description: '' })
  for (const permission of permissions) body.append('permission', permission)
  const created = await owner.client.post(h.url('auth', `/orgs/${orgId}/roles`), {}, { body: body.toString() })
  assert.equal(created.status, 303, created.text.slice(0, 400))
  return (await h.sql('SELECT id FROM custom_roles WHERE org_id = ?1 AND name = ?2', orgId, name))[0].id
}

async function roleOf(orgId, userId) {
  return (await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, userId))[0]?.role ?? null
}

async function grantsOf(orgId, userId) {
  return h.sql('SELECT app, role, custom_role_id FROM app_grants WHERE org_id = ?1 AND user_id = ?2 ORDER BY app', orgId, userId)
}

test('specific-apps access: the app sees the role given for it; another app is closed; the people list is not shown', async () => {
  const owner = await h.user({ name: 'Apps Owner' })
  const orgId = await h.org(owner.client, 'Apps Org')
  const editor = await h.user({ name: 'Cap Editor' })
  await joinApps(owner, orgId, editor, { captable: 'EDITOR' })
  assert.equal(await roleOf(orgId, editor.id), 'APPS')
  assert.deepEqual(await grantsOf(orgId, editor.id), [{ app: 'captable', role: 'EDITOR', custom_role_id: null }])
  const headers = await forwarded(editor.client)
  assert.equal(headers['x-suger-app-role'], 'EDITOR')
  assert.equal(headers['x-suger-app-permissions'], 'captable.manage captable.view portfolio.view')

  const ledgerOnly = await h.user({ name: 'Ledger Only' })
  await joinApps(owner, orgId, ledgerOnly, { ledger: 'VIEWER' })
  const api = await ledgerOnly.client.get(h.url('captable', '/api/echo'))
  assert.equal(api.status, 403)
  assert.deepEqual(JSON.parse(api.text), { error: 'no_app_access' })
  const page = await ledgerOnly.client.raw(h.url('captable', '/dashboard'), { headers: NAVIGATE })
  assert.equal(page.status, 403)
  assert.match(page.text, /You don&#x27;t have access to Cap Table/)
  const home = await ledgerOnly.client.get(h.url('apex', '/'))
  assert.match(home.text, /<h2>Ledger<\/h2>/)
  assert.doesNotMatch(home.text, /<h2>Cap Table<\/h2>/, 'the home page lists only their apps')

  const people = await ledgerOnly.client.get(h.url('auth', `/settings/users?org=${orgId}`))
  assert.match(people.text, /<h2>Your apps<\/h2>/)
  assert.ok(!people.text.includes(owner.email), "specific-apps members don't see the organization's people")
  const roles = await ledgerOnly.client.get(h.url('auth', `/settings/roles?org=${orgId}`))
  assert.doesNotMatch(roles.text, /<h2>Organization roles<\/h2>/)
  const everyone = await owner.client.get(h.url('auth', `/settings/users?org=${orgId}`))
  assert.match(everyone.text, /Cap Table: Editor/)
  assert.match(everyone.text, /Ledger: Viewer/)
})

test('an organization role and app grants never mix: changing access swaps one for the other, and the triggers refuse a mix', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Exclusive Org')
  const person = await h.user()
  await joinApps(owner, orgId, person, { captable: 'VIEWER', ledger: 'EDITOR' })
  assert.equal((await post(owner, `/orgs/${orgId}/members/${person.id}/role`, { role: 'EDITOR' })).status, 303)
  assert.equal(await roleOf(orgId, person.id), 'EDITOR')
  assert.deepEqual(await grantsOf(orgId, person.id), [], 'the organization role took the place of the grants')
  await assert.rejects(
    h.sql("INSERT INTO app_grants (org_id, user_id, app, role, created_at, updated_at) VALUES (?1, ?2, 'captable', 'ADMIN', 1, 1)", orgId, person.id),
    /specific-apps membership/,
  )
  const change = { role: 'APPS', 'app:captable': 'ADMIN' }
  assert.equal((await post(owner, `/orgs/${orgId}/members/${person.id}/role`, change)).status, 303)
  assert.equal(await roleOf(orgId, person.id), 'APPS')
  assert.deepEqual(await grantsOf(orgId, person.id), [{ app: 'captable', role: 'ADMIN', custom_role_id: null }])
  assert.equal((await post(owner, `/orgs/${orgId}/members/${person.id}/role`, { role: 'APPS' })).status, 400, 'at least one app')
  assert.equal((await post(owner, `/orgs/${orgId}/members/${person.id}/role`, { role: 'VIEWER', 'app:ledger': 'VIEWER' })).status, 400, 'no app fields with an organization role')
  assert.equal((await post(owner, `/orgs/${orgId}/members/${owner.id}/role`, change)).status, 409, 'the last owner keeps the role')
  assert.equal(await roleOf(orgId, owner.id), 'OWNER')
})

test('custom roles: owners make them from the app catalog, the app receives the narrowest role and the chosen permissions', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Custom Org')
  const admin = await h.user()
  await h.join(owner, orgId, admin, 'ADMIN')
  const board = await customRole(owner, orgId, 'Board observer', ['captable.view'])

  const refused = new URLSearchParams({ app: 'captable', name: 'Sneaky' })
  refused.append('permission', 'captable.manage')
  assert.equal((await admin.client.post(h.url('auth', `/orgs/${orgId}/roles`), {}, { body: refused.toString() })).status, 403, 'admins give custom roles but never make them')
  const unknown = new URLSearchParams({ app: 'captable', name: 'Nothing' })
  unknown.append('permission', 'captable.everything')
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/roles`), {}, { body: unknown.toString() })).status, 400, 'only catalog permissions')
  const duplicate = new URLSearchParams({ app: 'captable', name: 'board OBSERVER' })
  duplicate.append('permission', 'portfolio.view')
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/roles`), {}, { body: duplicate.toString() })).status, 409, 'names are unique per app')
  const noCatalog = new URLSearchParams({ app: 'ledger', name: 'Ledger role' })
  noCatalog.append('permission', 'portfolio.view')
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/roles`), {}, { body: noCatalog.toString() })).status, 400, 'an app without a catalog has none')

  const observer = await h.user({ name: 'Board Member' })
  await joinApps(admin, orgId, observer, { captable: `custom:${board}` })
  let headers = await forwarded(observer.client)
  assert.equal(headers['x-suger-app-role'], 'EDITOR', 'the least built-in role that has captable.view')
  assert.equal(headers['x-suger-app-permissions'], 'captable.view')
  const bar = JSON.parse((await observer.client.get(h.url('captable', '/__insulin/me'))).text)
  assert.equal(bar.organization.roleLabel, 'Board observer')

  const narrowed = new URLSearchParams({ name: 'Board observer', description: 'Own holdings only now' })
  narrowed.append('permission', 'portfolio.view')
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/roles/${board}`), {}, { body: narrowed.toString() })).status, 303)
  headers = await forwarded(observer.client)
  assert.equal(headers['x-suger-app-role'], 'VIEWER', 'a change to the role applies at the next request')
  assert.equal(headers['x-suger-app-permissions'], 'portfolio.view')

  const inUse = await post(owner, `/orgs/${orgId}/roles/${board}/delete`)
  assert.equal(inUse.status, 409)
  assert.match(inUse.text, /still given to people/)
  assert.equal((await post(owner, `/orgs/${orgId}/members/${observer.id}/role`, { role: 'APPS', 'app:captable': 'VIEWER' })).status, 303)
  assert.equal((await post(owner, `/orgs/${orgId}/roles/${board}/delete`)).status, 303)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM custom_roles WHERE id = ?1', board))[0].n, 0)

  const page = await admin.client.get(h.url('auth', `/settings/roles?org=${orgId}`))
  assert.match(page.text, /<h2>Cap Table<\/h2>/)
  assert.doesNotMatch(page.text, /New custom role/, 'only owners see the forms')
  assert.match((await owner.client.get(h.url('auth', `/settings/roles?org=${orgId}`))).text, /New custom role for Cap Table/)
})

test("an app's people page: everyone with access sees it; the app's admins invite, change and remove people for that app only", async () => {
  const owner = await h.user({ name: 'Page Owner' })
  const orgId = await h.org(owner.client, 'App People Org')
  const appAdmin = await h.user({ name: 'Cap Admin' })
  await joinApps(owner, orgId, appAdmin, { captable: 'ADMIN' })
  const viewer = await h.user({ name: 'Org Viewer' })
  await h.join(owner, orgId, viewer, 'VIEWER')

  const seen = await appPage(viewer, '/settings/users')
  assert.equal(seen.status, 200)
  assert.match(seen.text, /Cap Admin/)
  assert.match(seen.text, /<h2>From the organization<\/h2>/)
  assert.doesNotMatch(seen.text, /Invite people to Cap Table/, 'only app admins manage')
  const page = await appPage(appAdmin, '/settings/users')
  assert.match(page.text, /Invite people to Cap Table/)
  assert.match(page.text, new RegExp(`name="org_id" value="${orgId}"`))

  // Someone new: an invitation to this app alone.
  const newcomer = await h.user({ name: 'New Holder' })
  const invited = await appPost(appAdmin, '/settings/users/invite', { org_id: orgId, email: newcomer.email, role: 'VIEWER' })
  assert.equal(invited.status, 303, invited.text.slice(0, 300))
  assert.match((await h.waitForMail(newcomer.email, 2)).at(-1).text, /with access to Cap Table as Viewer/)
  const link = await h.link(newcomer.email, '/invitations/')
  assert.equal((await newcomer.client.post(`${link}/accept`, {})).status, 303)
  assert.deepEqual(await grantsOf(orgId, newcomer.id), [{ app: 'captable', role: 'VIEWER', custom_role_id: null }])

  // A specific-apps member of another app gets this one at once; an organization role is refused.
  const ledgerUser = await h.user()
  await joinApps(owner, orgId, ledgerUser, { ledger: 'EDITOR' })
  assert.equal((await appPost(appAdmin, '/settings/users/invite', { org_id: orgId, email: ledgerUser.email, role: 'EDITOR' })).status, 303)
  assert.deepEqual((await grantsOf(orgId, ledgerUser.id)).map((grant) => [grant.app, grant.role]), [['captable', 'EDITOR'], ['ledger', 'EDITOR']])
  assert.equal((await appPost(appAdmin, '/settings/users/invite', { org_id: orgId, email: viewer.email, role: 'ADMIN' })).status, 409)

  // Change and remove, for this app only; the last app takes the person out of the organization.
  assert.equal((await appPost(appAdmin, `/settings/users/${newcomer.id}/role`, { org_id: orgId, role: 'EDITOR' })).status, 303)
  assert.equal((await grantsOf(orgId, newcomer.id))[0].role, 'EDITOR')
  assert.equal((await appPost(appAdmin, `/settings/users/${ledgerUser.id}/remove`, { org_id: orgId })).status, 303)
  assert.deepEqual((await grantsOf(orgId, ledgerUser.id)).map((grant) => grant.app), ['ledger'], 'their other app stays')
  assert.equal((await appPost(appAdmin, `/settings/users/${newcomer.id}/remove`, { org_id: orgId })).status, 303)
  assert.equal(await roleOf(orgId, newcomer.id), null, 'their last app: they left the organization')
  assert.equal((await appPost(appAdmin, `/settings/users/${viewer.id}/role`, { org_id: orgId, role: 'ADMIN' })).status, 404, 'organization roles are managed on the apex')

  // Others can't: a viewer of the app, or someone outside the organization naming it.
  assert.equal((await appPost(viewer, `/settings/users/${appAdmin.id}/remove`, { org_id: orgId })).status, 403)
  const stranger = await h.user()
  await h.org(stranger.client, 'Stranger Org')
  assert.equal((await appPost(stranger, '/settings/users/invite', { org_id: orgId, email: uniqueEmail('x'), role: 'ADMIN' })).status, 404)

  // An organization-level invitation is beyond an app admin; their own is theirs to revoke.
  await post(owner, `/orgs/${orgId}/invitations`, { email: uniqueEmail('org-editor'), role: 'EDITOR' })
  const [orgInvitation] = await h.sql("SELECT id FROM invitations WHERE org_id = ?1 AND role = 'EDITOR' AND status = 'pending'", orgId)
  assert.equal((await appPost(appAdmin, `/settings/users/invitations/${orgInvitation.id}/revoke`, { org_id: orgId })).status, 404)
  await appPost(appAdmin, '/settings/users/invite', { org_id: orgId, email: uniqueEmail('app-invitee'), role: 'VIEWER' })
  const [appInvitation] = await h.sql("SELECT id FROM invitations WHERE org_id = ?1 AND role = 'APPS' AND status = 'pending'", orgId)
  assert.equal((await appPost(appAdmin, `/settings/users/invitations/${appInvitation.id}/revoke`, { org_id: orgId })).status, 303)
})

test("the app's own host never serves its settings: a page view goes to the apex, and a post from the app's origin changes nothing", async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Isolated Settings Org')
  const old = await owner.client.get(h.url('captable', '/settings/users?notice=removed'))
  assert.equal(old.status, 302)
  assert.equal(old.location, h.url('apex', '/apps/captable/settings/users?notice=removed'))
  assert.equal((await owner.client.get(h.url('captable', '/settings/integrations'))).location, h.url('apex', '/apps/captable/settings/integrations'))
  // What code on the app's own pages could send with the visitor's cookie: a same-origin fetch to the old address, and
  // a cross-origin one to the apex.
  const invite = { org_id: orgId, email: uniqueEmail('smuggled'), role: 'ADMIN' }
  const sameOrigin = await owner.client.post(h.url('captable', '/settings/users/invite'), invite, { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' } })
  assert.equal(sameOrigin.status, 405)
  const crossOrigin = await owner.client.post(h.url('apex', '/apps/captable/settings/users/invite'), invite, {
    origin: h.url('captable').replace(/\/$/, ''), headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors' },
  })
  assert.equal(crossOrigin.status, 403, "the apex refuses a post from the app's origin")
  const account = await owner.client.post(h.url('captable', '/settings/integrations/service-accounts'), { org_id: orgId, name: 'Smuggled', role: 'ADMIN' })
  assert.equal(account.status, 405)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM invitations WHERE org_id = ?1', orgId))[0].n, 0)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM service_accounts WHERE org_id = ?1', orgId))[0].n, 0)
  assert.equal((await owner.client.get(h.url('apex', '/apps/no-such-app/settings/users'))).status, 404)
})

test('the app-level writes re-check the actor in SQL: a demoted app admin or owner changes nothing', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Guarded Org')
  const appAdmin = await h.user()
  await joinApps(owner, orgId, appAdmin, { captable: 'ADMIN' })
  const target = await h.user()
  await joinApps(owner, orgId, target, { captable: 'VIEWER' })
  await h.sql("UPDATE app_grants SET role = 'VIEWER' WHERE org_id = ?1 AND user_id = ?2", orgId, appAdmin.id)
  const now = Date.now()
  assert.equal(await upsertGrant(h.db, { orgId, userId: target.id, grant: { app: 'captable', role: 'ADMIN', customRoleId: null }, actorId: appAdmin.id, now }), false)
  assert.equal(await removeGrant(h.db, { orgId, userId: target.id, app: 'captable', actorId: appAdmin.id }), false)
  assert.equal((await grantsOf(orgId, target.id))[0].role, 'VIEWER')
  const roleId = randomUUID()
  await h.sql("INSERT INTO custom_roles (id, org_id, app, name, permissions, created_at, updated_at) VALUES (?1, ?2, 'captable', 'Guarded', '[\"captable.view\"]', 1, 1)", roleId, orgId)
  await h.sql("UPDATE memberships SET role = 'ADMIN' WHERE org_id = ?1 AND user_id = ?2", orgId, owner.id)
  assert.equal(await updateCustomRole(h.db, { id: roleId, orgId, name: 'Renamed', description: '', permissions: ['portfolio.view'], actorId: owner.id, now }), false, 'no longer an owner')
})

test("review: an invitation's grants stay in its organization, a stale access change never overwrites a newer one, and cleanups re-check the actor", async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Integrity Org')
  const otherOrg = await h.org(owner.client, 'Other Integrity Org')
  const invitationId = randomUUID()
  await h.sql("INSERT INTO invitations (id, org_id, email, role, status, created_at, expires_at, last_sent_at) VALUES (?1, ?2, ?3, 'APPS', 'pending', 1, ?4, 1)",
    invitationId, orgId, uniqueEmail('integrity'), Date.now() + 60_000)
  await assert.rejects(
    h.sql("INSERT INTO invitation_grants (invitation_id, org_id, app, role) VALUES (?1, ?2, 'captable', 'VIEWER')", invitationId, otherOrg),
    /FOREIGN KEY/,
    "a grant naming another organization than its invitation's",
  )

  const second = await h.user()
  await h.join(owner, orgId, second, 'OWNER')
  const target = await h.user()
  await h.join(owner, orgId, target, 'EDITOR')
  // The second owner moves the target to Ledger first; the first owner's change was read while they were an Editor.
  assert.equal(await setAppAccess(h.db, { orgId, userId: target.id, current: 'EDITOR', grants: [{ app: 'ledger', role: 'ADMIN', customRoleId: null }], actorId: second.id, now: Date.now() - 5 }), true)
  assert.equal(await setAppAccess(h.db, { orgId, userId: target.id, current: 'EDITOR', grants: [{ app: 'captable', role: 'VIEWER', customRoleId: null }], actorId: owner.id, now: Date.now() }), false)
  assert.deepEqual(await grantsOf(orgId, target.id), [{ app: 'ledger', role: 'ADMIN', custom_role_id: null }], 'the newer decision stands')

  const admin = await h.user()
  await h.join(owner, orgId, admin, 'ADMIN')
  const email = uniqueEmail('expired-invitee')
  await h.sql("INSERT INTO invitations (id, org_id, email, role, status, created_at, expires_at, last_sent_at) VALUES (?1, ?2, ?3, 'VIEWER', 'pending', 1, 2, 1)", randomUUID(), orgId, email)
  await h.sql("UPDATE memberships SET role = 'VIEWER' WHERE org_id = ?1 AND user_id = ?2", orgId, admin.id)
  assert.equal(await insertInvitation(h.db, {
    id: randomUUID(), orgId, email, role: 'VIEWER', grants: [], app: null, invitedBy: admin.id, now: Date.now(), expiresAt: Date.now() + 60_000, pendingLimit: 50,
  }), false)
  assert.equal((await h.sql('SELECT status FROM invitations WHERE org_id = ?1 AND email = ?2', orgId, email))[0].status, 'pending', 'a demoted admin closes nothing either')
})

test('migration 0003 turns USER memberships and invitations into VIEWER and keeps everything else', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.WARN),
    workers: [{
      name: 'migration-check', modules: true, script: 'export default { fetch() { return new Response() } }',
      compatibilityDate: COMPATIBILITY_DATE, d1Databases: { DB: 'migration-check' },
    }],
  }))
  try {
    const db = await mf.getD1Database('DB')
    const run = async (file) => {
      for (const statement of splitStatements(await readFile(join(gatewayDir, 'migrations', file), 'utf8'))) await db.prepare(statement).run()
    }
    await run('0001_init.sql')
    await run('0002_credential_version.sql')
    await db.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('u1', 'u1@example.test', 'One', 1, 1), ('u2', 'u2@example.test', 'Two', 1, 1)").run()
    await db.prepare("INSERT INTO orgs (id, name, created_at, updated_at) VALUES ('o1', 'Org', 1, 1)").run()
    await db.prepare("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES ('o1', 'u1', 'OWNER', 1, 2), ('o1', 'u2', 'USER', 3, 4)").run()
    await db.prepare("INSERT INTO invitations (id, org_id, email, role, status, created_at, expires_at, last_sent_at) VALUES ('i1', 'o1', 'x@example.test', 'USER', 'pending', 1, 9, 1)").run()
    await run('0003_roles.sql')
    const { results: members } = await db.prepare('SELECT user_id, role, created_at, updated_at FROM memberships ORDER BY user_id').all()
    assert.deepEqual(members, [{ user_id: 'u1', role: 'OWNER', created_at: 1, updated_at: 2 }, { user_id: 'u2', role: 'VIEWER', created_at: 3, updated_at: 4 }])
    assert.equal((await db.prepare("SELECT role FROM invitations WHERE id = 'i1'").first()).role, 'VIEWER')
    await assert.rejects(db.prepare("UPDATE memberships SET role = 'USER' WHERE user_id = 'u2'").run(), /CHECK/)
  } finally {
    await mf.dispose()
  }
})
