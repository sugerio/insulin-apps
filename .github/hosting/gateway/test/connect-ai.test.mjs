// An app's Connect AI page (DESIGN.md §5.2): the MCP server, the role an agent gets and each client's setup, open to
// everyone who can use the app; the person's own agents to disconnect; and, for the organization's owners and admins,
// everyone's, re-checked in SQL.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from './helpers/harness.mjs'
import { connect, rpc } from './helpers/oauth.mjs'
import { deleteAppGrant, listAppGrantsAsAdmin } from '../src/db/oauth.ts'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

const MCP = 'http://captable.insulinapps.localhost/mcp'
const page = (person) => person.client.get(h.url('apex', '/apps/captable/settings/connect-ai'))
const disconnect = (person, orgId, grantId) => person.client.post(h.url('apex', `/apps/captable/settings/connect-ai/agents/${grantId}/disconnect`), { org_id: orgId })

/** Adds a signed-up user to the organization directly (the invitation flow has its own tests). */
async function member(orgId, name, role, grants = {}) {
  const person = await h.user({ name })
  const now = Date.now()
  await h.sql('INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, person.id, role, now)
  for (const [app, grant] of Object.entries(grants)) {
    await h.sql('INSERT INTO app_grants (org_id, user_id, app, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)', orgId, person.id, app, grant, now)
  }
  return person
}

async function grantOf(person, orgId) {
  const [grant] = await h.sql('SELECT id FROM oauth_grants WHERE user_id = ?1 AND org_id = ?2', person.id, orgId)
  return grant.id
}

test('Connect AI opens for an organization Viewer and a specific-apps Viewer, with the server, their role and every client\'s setup', async () => {
  const owner = await h.user({ name: 'Cora Owner' })
  const orgId = await h.org(owner.client, 'Connect Org')
  const viewer = await member(orgId, 'Vic Viewer', 'VIEWER')
  const appViewer = await member(orgId, 'Ava App-Viewer', 'APPS', { captable: 'VIEWER' })
  const ledgerOnly = await member(orgId, 'Lou Ledger-Only', 'APPS', { ledger: 'EDITOR' })

  for (const [person, role] of [[viewer, 'Viewer'], [appViewer, 'Viewer'], [owner, 'Admin']]) {
    const response = await page(person)
    assert.equal(response.status, 200, person.name)
    const text = response.text
    assert.match(text, /aria-current="page"[^>]*>Connect AI<\/a>/, `${person.name}: the Connect AI tab`)
    assert.ok(text.includes(`<code>${MCP}</code>`), `${person.name}: the server's address`)
    assert.match(text, new RegExp(`In Connect Org your role is <span[^>]*>${role}</span>`), `${person.name}: the role the agent gets`)
    assert.match(text, /choose the organization, and allow it/)
    assert.match(text, /for 30 days/)
    for (const command of [
      `claude mcp add --transport http captable ${MCP}`,
      `codex mcp add captable --url ${MCP}\ncodex mcp login captable`,
      `gemini mcp add --transport http captable ${MCP}`,
      `opencode mcp add captable --url ${MCP}\nopencode mcp auth captable`,
    ]) {
      assert.ok(text.includes(`<code>${command}</code>`), `${person.name}: ${command}`)
    }
    assert.match(text, /<code class="font-mono">\/mcp<\/code> in Claude Code/)
    assert.match(text, /\/mcp auth captable<\/code> in Gemini CLI/)
    assert.match(text, /Add custom connector/)
    assert.match(text, /Add custom MCP server/)
    assert.match(text, /<pre class="[^"]*select-all[^"]*"/, 'the blocks are selectable')
    assert.match(text, /You haven&#x27;t connected an agent to Cap Table in Connect Org yet/)
    assert.equal(/Everyone&#x27;s agents/.test(text), person === owner, `${person.name}: everyone's agents only for owners and admins`)
    assert.equal(text.match(/<h1[\s>]/g)?.length, 1)
    assert.doesNotMatch(text, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/)
  }
  assert.equal((await page(ledgerOnly)).status, 403, 'someone without the app')
  const signedOut = await h.client().get(h.url('apex', '/apps/captable/settings/connect-ai'))
  assert.equal(signedOut.status, 302)
  assert.match(signedOut.location, /\/login\?/)
  assert.equal((await h.client().get(h.url('apex', '/apps/no-such-app/settings/connect-ai'))).status, 404)
})

test('own agents are listed and disconnectable; owners and admins see and disconnect everyone\'s; an Editor sees only their own', async () => {
  const owner = await h.user({ name: 'Opal Owner' })
  const orgId = await h.org(owner.client, 'Agents Here Org')
  const admin = await member(orgId, 'Adam Admin', 'ADMIN')
  const editor = await member(orgId, 'Edna Editor', 'EDITOR')
  const viewer = await member(orgId, 'Vince Viewer', 'VIEWER')
  const appAdmin = await member(orgId, 'Alma App-Admin', 'APPS', { captable: 'ADMIN' })
  const editorTokens = await connect(h, editor, orgId, { name: 'Editor Agent' })
  const viewerTokens = await connect(h, viewer, orgId, { name: 'Viewer Agent' })
  const ownerTokens = await connect(h, owner, orgId, { name: 'Owner Agent' })
  const otherOrg = await h.org(owner.client, 'Elsewhere Org')
  await owner.client.post(h.url('apex', '/orgs/switch'), { org_id: orgId })
  await connect(h, owner, otherOrg, { name: 'Elsewhere Agent' })

  const asEditor = (await page(editor)).text
  assert.match(asEditor, /<h2>Your agents<\/h2>/)
  assert.match(asEditor, /Editor Agent/)
  assert.match(asEditor, /Disconnect ends the agent&#x27;s access at once/)
  assert.match(asEditor, /Not yet/, 'never used yet')
  assert.ok(asEditor.includes(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)), 'when it expires')
  assert.doesNotMatch(asEditor, /Viewer Agent|Owner Agent|Everyone&#x27;s agents/, "an Editor sees only their own")
  assert.doesNotMatch((await page(appAdmin)).text, /Everyone&#x27;s agents|Editor Agent/, 'an app admin by grant is no organization admin')

  const asAdmin = (await page(admin)).text
  assert.match(asAdmin, /<h2>Everyone&#x27;s agents<\/h2>/)
  for (const shown of ['Editor Agent', 'Viewer Agent', 'Owner Agent', 'Edna Editor', editor.email, 'Vince Viewer', 'Opal Owner']) assert.ok(asAdmin.includes(shown), shown)
  assert.doesNotMatch(asAdmin, /Elsewhere Agent/, "another organization's agents stay out")
  assert.match(asAdmin, /Disconnect ends the agent&#x27;s access at once/)

  // Someone else's agent: not for an Editor (404), and it keeps working.
  const viewerGrant = await grantOf(viewer, orgId)
  assert.equal((await disconnect(editor, orgId, viewerGrant)).status, 404)
  assert.equal((await rpc(h, viewerTokens.access_token, 'ping')).status, 200)
  // One's own: disconnected at once, back on this page.
  const own = await disconnect(editor, orgId, await grantOf(editor, orgId))
  assert.equal(own.status, 303)
  assert.equal(own.location, '/apps/captable/settings/connect-ai?notice=disconnected')
  assert.equal((await rpc(h, editorTokens.access_token, 'ping')).status, 401)
  // An admin disconnects anyone's.
  assert.equal((await disconnect(admin, orgId, viewerGrant)).status, 303)
  assert.equal((await rpc(h, viewerTokens.access_token, 'ping')).status, 401)
  assert.match((await page(viewer)).text, /You haven&#x27;t connected an agent/)

  // A demoted admin: the statement re-checks the role, so nothing is listed or disconnected.
  await h.sql("UPDATE memberships SET role = 'EDITOR' WHERE org_id = ?1 AND user_id = ?2", orgId, admin.id)
  const ownerGrant = await grantOf(owner, orgId)
  assert.deepEqual(await listAppGrantsAsAdmin(h.db, { orgId, app: 'captable', actorId: admin.id, now: Date.now() }), [])
  assert.equal(await deleteAppGrant(h.db, { id: ownerGrant, orgId, app: 'captable', actorId: admin.id }), false)
  assert.doesNotMatch((await page(admin)).text, /Everyone&#x27;s agents/)
  assert.equal((await disconnect(admin, orgId, ownerGrant)).status, 404)
  assert.equal((await rpc(h, ownerTokens.access_token, 'ping')).status, 200, "the owner's agent still works")
  // An agent of another organization is not this page's to end.
  const elsewhere = await grantOf(owner, otherOrg)
  assert.equal((await disconnect(owner, orgId, elsewhere)).status, 404)
})
