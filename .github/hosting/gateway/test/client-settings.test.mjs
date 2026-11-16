// An app's own page of settings for each OAuth client (`insulin.clientSettings`, DESIGN.md §5.3.1): the API access page
// links each live client there, for the organization's owners and admins; the app keeps the page and the settings.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, startGateway } from './helpers/harness.mjs'
import { clientSettingsProblem } from '../src/config.ts'
import { clientSettingsProblem as listAppsClientSettingsProblem } from '../../../scripts/list-apps.mjs'

const CAPTABLE = APPS.find((app) => app.name === 'captable')
const SETTINGS_APPS = [
  { ...CAPTABLE, clientSettings: '/client-settings', publicPaths: ['/sign', '/api/public/'] },
  { name: 'ledger', title: 'Ledger', summary: 'Keeps no settings per client.', binding: 'APP_LEDGER' },
]

let h
before(async () => { h = await startGateway({ apps: SETTINGS_APPS, stubBindings: ['APP_LEDGER'] }) })
after(async () => { await h?.close() })

const CLIENT_ID = /(ia_sa_[A-Za-z0-9_-]{22})/
const apiPage = (person, app = 'captable') => person.client.get(h.url('apex', `/apps/${app}/settings/api`))
const post = (person, path, fields, app = 'captable') => person.client.post(h.url('apex', `/apps/${app}/settings/api${path}`), fields)

async function member(orgId, name, role) {
  const person = await h.user({ name })
  const now = Date.now()
  await h.sql('INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, person.id, role, now)
  return person
}

async function createClient(person, orgId, name, app = 'captable') {
  const created = await post(person, '/clients', { org_id: orgId, name, role: 'EDITOR' }, app)
  assert.equal(created.status, 200, created.text.slice(0, 400))
  const [row] = await h.sql('SELECT id FROM service_accounts WHERE client_id = ?1', CLIENT_ID.exec(created.text)[1])
  return row.id
}

test('the path: a signed-in page of the app, outside /api/, never public, without a query; both checks agree', () => {
  const publicPaths = ['/sign', '/api/public/', '/copy']
  for (const check of [clientSettingsProblem, listAppsClientSettingsProblem]) {
    for (const good of ['/client-settings', '/settings-for/clients', '/signing']) assert.equal(check(good, publicPaths), null, good)
    for (const bad of [
      'client-settings', '//elsewhere', '/client-settings/', '/client-settings?x=1', '/api/client-settings', '/API', '/sign', '/sign/clients',
      '/copy/x', '/settings', '/__insulin/x', '/a/../b', '/a%2fb', '/a b', 42, null, ['/x'],
    ]) assert.notEqual(check(bad, publicPaths), null, String(bad))
  }
})

test("owners and admins get a link to the app's settings page under each live client; nobody else does", async () => {
  const owner = await h.user({ name: 'Olive Owner' })
  const orgId = await h.org(owner.client, 'Client Settings Org')
  const admin = await member(orgId, 'Ada Admin', 'ADMIN')
  const editor = await member(orgId, 'Eddie Editor', 'EDITOR')
  const nightly = await createClient(owner, orgId, 'Nightly & export')
  const revoked = await createClient(owner, orgId, 'Old sync')
  await h.sql('UPDATE service_accounts SET revoked_at = ?1 WHERE id = ?2', Date.now(), revoked)

  const href = `http://captable.insulinapps.localhost/client-settings/${nightly}?name=Nightly%20%26%20export`
  for (const person of [owner, admin]) {
    const page = await apiPage(person)
    assert.equal(page.status, 200)
    assert.ok(page.text.includes(`href="${href}"`), `${person.name}: the link`)
    assert.match(page.text, />Cap Table settings<span class="sr-only"> for Nightly &amp; export<\/span>/)
    assert.ok(!page.text.includes(`/client-settings/${revoked}`), `${person.name}: none for a revoked client`)
  }
  const editorPage = await apiPage(editor)
  assert.equal(editorPage.status, 200)
  assert.ok(!editorPage.text.includes('/client-settings/'), 'someone who only sees the clients gets no link')

  // An app without the page: no link.
  await createClient(owner, orgId, 'Ledger sync', 'ledger')
  const ledger = await apiPage(owner, 'ledger')
  assert.equal(ledger.status, 200)
  assert.doesNotMatch(ledger.text, />Ledger settings<span class="sr-only">/)
})
