// An app's section for each OAuth client on its API access page (DESIGN.md §5.3.1): read from and saved to the app as
// the signed-in organization admin, only the fields and types the contract allows, members chosen among the
// organization's own, and the app told when the client is deleted. The stub app keeps the section in memory.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, startGateway } from './helpers/harness.mjs'
import { formValues, parseClientSettings } from '../src/integrations/client-settings.ts'

const CAPTABLE = APPS.find((app) => app.name === 'captable')
const SETTINGS_APPS = [
  { ...CAPTABLE, clientSettings: '/api/client-settings' },
  { name: 'ledger', title: 'Ledger', summary: 'Answers its section in a shape the contract does not allow.', binding: 'APP_LEDGER', clientSettings: '/api/client-settings-broken' },
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

/** What the stub app received for its client settings since `start`. */
async function received(start = 0) {
  const stub = await h.mf.getWorker('stub-app')
  return (await (await stub.fetch('http://stub-app/__stub/client-settings')).json()).slice(start)
}

/** A form body with a field repeated, as checkboxes post it. */
function checked(fields, name, values) {
  const body = new URLSearchParams(fields)
  for (const value of values) body.append(name, value)
  return body
}

test('the contract: a section of 1 to 5 members fields, plain text of bounded length, anything else refused', () => {
  const good = { title: 'Who sees what it creates', description: 'They see everything.', status: 'Seen by 1 people', fields: [{ name: 'people', type: 'members', label: 'Share with', value: ['a@example.test'] }] }
  assert.deepEqual(parseClientSettings(good), { ...good, fields: [{ ...good.fields[0], hint: null }] })
  assert.deepEqual(parseClientSettings({ title: 'T', fields: [{ name: 'people', type: 'members', label: 'L', value: [] }] })?.description, null)
  const field = good.fields[0]
  for (const [why, bad] of [
    ['no fields', { ...good, fields: [] }],
    ['six fields', { ...good, fields: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ ...field, name })) }],
    ['a type other than members', { ...good, fields: [{ ...field, type: 'html' }] }],
    ['a field named twice', { ...good, fields: [field, field] }],
    ['a field name that is not an identifier', { ...good, fields: [{ ...field, name: 'Bad-Name' }] }],
    ['a value that is not an email', { ...good, fields: [{ ...field, value: ['not an email'] }] }],
    ['51 people', { ...good, fields: [{ ...field, value: Array.from({ length: 51 }, (_, i) => `p${i}@example.test`) }] }],
    ['a long title', { ...good, title: 'x'.repeat(81) }],
    ['a title that is not text', { ...good, title: 42 }],
    ['not an object', [good]],
  ]) assert.equal(parseClientSettings(bad), null, why)
  assert.equal(parseClientSettings({ ...good, title: 'Line\u0007 one' }).title, 'Line  one', 'control characters become spaces')
})

test("a submitted form sends only the organization's members, spelled as theirs, once each", () => {
  const section = parseClientSettings({ title: 'T', fields: [{ name: 'people', type: 'members', label: 'L', value: [] }] })
  const form = new URLSearchParams([['people', 'ADA@example.test'], ['people', 'ada@example.test'], ['people', 'outsider@example.test'], ['other', 'bo@example.test']])
  assert.deepEqual(formValues(section, form, ['ada@example.test', 'bo@example.test']), { people: ['ada@example.test'] })
})

test("owners and admins see and save the app's section under each client, as themselves; the app's refusal is shown; others see none", async () => {
  const owner = await h.user({ name: 'Olive Owner' })
  const orgId = await h.org(owner.client, 'Client Settings Org')
  const admin = await member(orgId, 'Ada Admin', 'ADMIN')
  const editor = await member(orgId, 'Eddie Editor', 'EDITOR')
  const outsider = await h.user({ name: 'Otto Outsider' })
  const id = await createClient(owner, orgId, 'Nightly export')
  const start = (await received()).length

  const page = await apiPage(admin)
  assert.equal(page.status, 200)
  assert.match(page.text, /Cap Table settings<span class="sr-only"> for Nightly export<\/span>/)
  assert.match(page.text, /Who sees what it creates/)
  assert.match(page.text, /Seen by the client only/)
  for (const person of [owner, admin, editor]) assert.ok(page.text.includes(`value="${person.email}"`), `${person.name} can be picked`)
  assert.ok(!page.text.includes(outsider.email), 'never someone outside the organization')
  const [read] = await received(start)
  assert.equal(read.method, 'GET')
  assert.equal(read.url, `https://captable.insulinapps.localhost/api/client-settings/${id}?name=Nightly%20export`)
  assert.equal(read.headers['x-suger-user-id'], admin.id, 'as the admin who opened the page')
  assert.equal(read.headers['x-suger-organization-id'], orgId)
  assert.equal(read.headers['x-suger-access-via'], 'browser')

  const editorPage = await apiPage(editor)
  assert.doesNotMatch(editorPage.text, /Who sees what it creates/, 'someone who only sees the clients sees no section')
  assert.equal((await post(editor, `/clients/${id}/app-settings`, checked({ org_id: orgId }, 'people', [editor.email]))).status, 403)

  // Saved: the outsider's address is dropped before the app sees the values.
  const before = (await received()).length
  const saved = await post(admin, `/clients/${id}/app-settings`, checked({ org_id: orgId }, 'people', [owner.email, outsider.email]))
  assert.equal(saved.status, 200, saved.text.slice(0, 400))
  assert.match(saved.text, /Saved: 1 people see what it creates\./, "the app's notice")
  assert.match(saved.text, /Seen by 1 people/)
  const post1 = (await received(before)).find((request) => request.method === 'POST')
  assert.deepEqual(post1.body, { values: { people: [owner.email] } })
  assert.equal(post1.headers['x-suger-user-id'], admin.id)
  assert.equal(post1.headers['content-type'], 'application/json')

  // Refused: the app's message and the field's error, under the client's section, opened.
  const refused = await post(owner, `/clients/${id}/app-settings`, checked({ org_id: orgId }, 'people', [owner.email, admin.email, editor.email]))
  assert.equal(refused.status, 200)
  assert.match(refused.text, /<details class="group mt-2" open="">/)
  assert.match(refused.text, /role="alert"[^>]*>Nothing was saved\.</)
  assert.match(refused.text, /role="alert"[^>]*>Pick at most two people\.</)
  assert.match(refused.text, /Seen by 1 people/, 'what was saved before stands')

  // Another organization's client is not this admin's to change.
  const otherOwner = await h.user({ name: 'Other Owner' })
  const otherOrg = await h.org(otherOwner.client, 'Other Org')
  const otherId = await createClient(otherOwner, otherOrg, 'Theirs')
  assert.equal((await post(admin, `/clients/${otherId}/app-settings`, checked({ org_id: orgId }, 'people', [admin.email]))).status, 404)

  // Deleting the client tells the app to forget it.
  const beforeDelete = (await received()).length
  assert.equal((await post(owner, `/clients/${id}/delete`, { org_id: orgId })).status, 303)
  const forgot = (await received(beforeDelete)).find((request) => request.method === 'DELETE')
  assert.equal(forgot?.path, `/api/client-settings/${id}`)
  assert.equal((await post(owner, `/clients/${id}/app-settings`, checked({ org_id: orgId }, 'people', [owner.email]))).status, 404, 'a deleted client has no settings')
})

test("an app that answers outside the contract: the page says its settings couldn't be loaded, and the rest of it works", async () => {
  const owner = await h.user({ name: 'Lena Ledger-Owner' })
  const orgId = await h.org(owner.client, 'Ledger Org')
  const id = await createClient(owner, orgId, 'Ledger sync', 'ledger')
  const page = await apiPage(owner, 'ledger')
  assert.equal(page.status, 200)
  assert.match(page.text, /Ledger&#x27;s settings for this client couldn&#x27;t be loaded\. Reload the page to try again\./)
  assert.doesNotMatch(page.text, /&lt;b&gt;|<b>x<\/b>/, "never the app's markup")
  assert.match(page.text, />Rotate secret<span class="sr-only"> for Ledger sync</)
  const save = await post(owner, `/clients/${id}/app-settings`, { org_id: orgId, people: owner.email }, 'ledger')
  assert.equal(save.status, 502)
  assert.match(save.text, /Ledger couldn&#x27;t be reached to save its settings for Ledger sync\. Try again\./)
})
