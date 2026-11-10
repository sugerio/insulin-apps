// SCIM 2.0 provisioning (DESIGN.md §7): an owner's token, the discovery documents, Users with the filters and patch
// shapes Okta and Entra send, verified domains only, and the last owner kept. All data is synthetic.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { UUID_RE, startGateway } from './helpers/harness.mjs'
import { joinOrgByScim } from '../src/db/sso.ts'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User'
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

/** An owner, an organization with `domain` verified, and a SCIM token created on the settings page. */
async function provisioned(domain, ownerEmail) {
  const owner = await h.user(ownerEmail ? { email: ownerEmail } : {})
  const orgId = await h.org(owner.client, 'SCIM Org')
  await h.sql('INSERT INTO sso_domains (org_id, domain, token, created_at, verified_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, domain, 'synthetic-token', Date.now())
  const created = await owner.client.post(h.url('auth', `/orgs/${orgId}/sso/scim-tokens`), { name: 'Test IdP' })
  assert.equal(created.status, 201, created.text.slice(0, 300))
  const token = /<code[^>]*>([A-Za-z0-9_-]{43})<\/code>/.exec(created.text)[1]
  return { owner, orgId, token }
}

function scim(token, method, path, body) {
  return h.client().request(h.url('apex', `/scim/v2${path}`), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/scim+json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
}
const json = (response) => JSON.parse(response.text)

test('the token: shown once, required, revocable; the discovery documents', async () => {
  const { owner, orgId, token } = await provisioned('scim-token.test')
  const [row] = await h.sql('SELECT token_hash, last_used_at FROM scim_tokens WHERE org_id = ?1', orgId)
  assert.notEqual(row.token_hash, token, 'only its hash is stored')
  assert.equal(row.last_used_at, null)
  assert.doesNotMatch((await owner.client.get(h.url('auth', `/settings/sso?org=${orgId}`))).text, new RegExp(token), 'never shown again')

  const anonymous = await h.client().get(h.url('apex', '/scim/v2/Users'))
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer realm="scim"')
  assert.match(anonymous.headers.get('content-type'), /^application\/scim\+json/)
  assert.deepEqual(json(anonymous).schemas, ['urn:ietf:params:scim:api:messages:2.0:Error'])
  assert.equal((await scim('A'.repeat(43), 'GET', '/Users')).status, 401)

  const config = await scim(token, 'GET', '/ServiceProviderConfig')
  assert.equal(config.status, 200)
  assert.equal(json(config).patch.supported, true)
  assert.equal(json(config).bulk.supported, false)
  assert.equal(json(await scim(token, 'GET', '/ResourceTypes')).Resources[0].endpoint, '/Users')
  assert.equal(json(await scim(token, 'GET', `/Schemas/${USER}`)).id, USER)
  assert.ok((await h.sql('SELECT last_used_at FROM scim_tokens WHERE org_id = ?1', orgId))[0].last_used_at > 0)

  const [{ id }] = await h.sql('SELECT id FROM scim_tokens WHERE org_id = ?1', orgId)
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/sso/scim-tokens/${id}/revoke`), {})).status, 303)
  assert.equal((await scim(token, 'GET', '/Users')).status, 401, 'revoked')
})

test('Users: create, find by userName, read, replace, patch (Okta and Entra shapes) and delete', async () => {
  const domain = 'scim-users.test'
  const { orgId, token } = await provisioned(domain)
  const email = `new.person@${domain}`
  const created = await scim(token, 'POST', '/Users', {
    schemas: [USER], userName: email.toUpperCase(), name: { givenName: 'Nina', familyName: 'New' }, emails: [{ value: email, primary: true }], active: true, externalId: 'ext-1',
  })
  assert.equal(created.status, 201, created.text)
  const user = json(created)
  assert.match(user.id, UUID_RE)
  assert.equal(user.userName, email)
  assert.equal(user.displayName, 'Nina New')
  assert.equal(user.active, true)
  assert.equal(user.externalId, 'ext-1')
  assert.equal(created.headers.get('location'), h.url('apex', `/scim/v2/Users/${user.id}`))
  const [account] = await h.sql('SELECT password_hash, email_verified_at FROM users WHERE id = ?1', user.id)
  assert.equal(account.password_hash, null)
  assert.ok(account.email_verified_at > 0, 'confirmed: the organization vouches for its domain')
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, user.id))[0].role, 'VIEWER')

  assert.equal((await scim(token, 'POST', '/Users', { schemas: [USER], userName: email })).status, 409, 'uniqueness')
  const outside = await scim(token, 'POST', '/Users', { schemas: [USER], userName: 'someone@elsewhere.test' })
  assert.equal(outside.status, 400)
  assert.equal(json(outside).scimType, 'invalidValue')

  const found = json(await scim(token, 'GET', `/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`))
  assert.equal(found.totalResults, 1)
  assert.equal(found.Resources[0].id, user.id)
  assert.equal(json(await scim(token, 'GET', `/Users?filter=${encodeURIComponent('userName eq "nobody@scim-users.test"')}`)).totalResults, 0)
  assert.equal(json(await scim(token, 'GET', `/Users?filter=${encodeURIComponent('displayName co "N"')}`)).scimType, 'invalidFilter')

  // Okta deactivates with a value object; the person leaves the organization but stays visible as inactive.
  const deactivated = await scim(token, 'PATCH', `/Users/${user.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: false } }] })
  assert.equal(deactivated.status, 200, deactivated.text)
  assert.equal(json(deactivated).active, false)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, user.id))[0].n, 0)
  assert.equal(json(await scim(token, 'GET', `/Users/${user.id}`)).active, false)
  // Entra reactivates with a path and a string boolean, and renames.
  const reactivated = await scim(token, 'PATCH', `/Users/${user.id}`, {
    schemas: [PATCH], Operations: [{ op: 'Replace', path: 'active', value: 'True' }, { op: 'Replace', path: 'displayName', value: 'Nina Renamed' }, { op: 'Add', path: 'title', value: 'Ignored' }],
  })
  assert.equal(reactivated.status, 200, reactivated.text)
  assert.equal(json(reactivated).active, true)
  assert.equal(json(reactivated).displayName, 'Nina Renamed')

  const replaced = await scim(token, 'PUT', `/Users/${user.id}`, { schemas: [USER], userName: email, name: { formatted: 'Nina Put' }, active: true })
  assert.equal(json(replaced).displayName, 'Nina Put')
  const renamed = await scim(token, 'PUT', `/Users/${user.id}`, { schemas: [USER], userName: `other@${domain}` })
  assert.equal(renamed.status, 400)
  assert.equal(json(renamed).scimType, 'mutability')

  assert.equal((await scim(token, 'DELETE', `/Users/${user.id}`)).status, 204)
  assert.equal((await scim(token, 'GET', `/Users/${user.id}`)).status, 404)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, user.id))[0].n, 0)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM users WHERE id = ?1', user.id))[0].n, 1, 'the account itself stays: it may belong to other organizations')
})

test('only the organization\'s own people in verified domains; paging; the last owner is kept', async () => {
  const domain = 'scim-owner.test'
  const { owner, orgId, token } = await provisioned(domain, `boss@${domain}`)
  const outsider = await h.user()
  await h.join(owner, orgId, outsider, 'EDITOR')
  const list = json(await scim(token, 'GET', '/Users'))
  assert.deepEqual(list.Resources.map((resource) => resource.userName), [owner.email], 'members outside the verified domains are not SCIM\'s')
  assert.equal((await scim(token, 'GET', `/Users/${outsider.id}`)).status, 404)
  assert.equal((await scim(token, 'DELETE', `/Users/${outsider.id}`)).status, 404)

  for (const name of ['a', 'b']) assert.equal((await scim(token, 'POST', '/Users', { schemas: [USER], userName: `${name}@${domain}` })).status, 201)
  const page = json(await scim(token, 'GET', '/Users?startIndex=2&count=1'))
  assert.equal(page.totalResults, 3)
  assert.equal(page.itemsPerPage, 1)
  assert.equal(page.startIndex, 2)

  const lastOwner = await scim(token, 'PATCH', `/Users/${owner.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] })
  assert.equal(lastOwner.status, 409)
  assert.equal((await scim(token, 'DELETE', `/Users/${owner.id}`)).status, 409)
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, owner.id))[0].role, 'OWNER')

  const other = await provisioned('scim-other.test')
  assert.equal((await scim(other.token, 'GET', `/Users/${owner.id}`)).status, 404, 'another organization\'s token sees nothing here')
  assert.equal((await scim(token, 'PATCH', `/Users/${owner.id}`, { Operations: [] })).status, 400, 'a PatchOp needs its schema')
  const unsupported = await h.client().request(h.url('apex', '/scim/v2/Users'), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'x' })
  assert.equal(unsupported.status, 415)
  assert.equal((await scim(token, 'GET', '/Groups')).status, 404)
})

test('review: removing a domain removes the people SCIM provisioned on it, and SCIM can no longer reach or reactivate them', async () => {
  const domain = 'scim-removed.test'
  const { owner, orgId, token } = await provisioned(domain)
  const created = await scim(token, 'POST', '/Users', { schemas: [USER], userName: `gone@${domain}`, active: true })
  assert.equal(created.status, 201, created.text)
  const id = json(created).id
  const kept = await h.user({ email: `kept@${domain}` })
  await h.join(owner, orgId, kept, 'EDITOR')
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/sso/domains/remove`), { domain })).status, 303)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, id))[0].n, 0, 'the provisioned person left')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM scim_users WHERE org_id = ?1 AND user_id = ?2', orgId, id))[0].n, 0, 'and their link')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, kept.id))[0].n, 1, 'people SCIM never touched stay')
  assert.equal((await h.sql("SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2", orgId, owner.id))[0].role, 'OWNER')
  assert.equal((await scim(token, 'GET', `/Users/${id}`)).status, 404)
  const reactivate = await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: true }] })
  assert.equal(reactivate.status, 404)
  assert.equal(json(await scim(token, 'GET', `/Users?filter=${encodeURIComponent(`userName eq "gone@${domain}"`)}`)).totalResults, 0)
  assert.equal((await scim(token, 'POST', '/Users', { schemas: [USER], userName: `again@${domain}` })).status, 400, 'no longer a verified domain')
})

test('review: a domain that loses its verification hides its people from SCIM, and joining re-checks it in the same statement', async () => {
  const domain = 'scim-unverified.test'
  const { orgId, token } = await provisioned(domain)
  const created = await scim(token, 'POST', '/Users', { schemas: [USER], userName: `paused@${domain}`, active: false })
  assert.equal(created.status, 201, created.text)
  const id = json(created).id
  await h.sql('UPDATE sso_domains SET verified_at = NULL WHERE org_id = ?1 AND domain = ?2', orgId, domain)
  const reactivate = await scim(token, 'PATCH', `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: true }] })
  assert.equal(reactivate.status, 404)
  assert.equal(await joinOrgByScim(h.db, orgId, id, 'VIEWER', Date.now(), 100), false, 'the join itself refuses an address outside a verified domain')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, id))[0].n, 0)
  assert.equal((await scim(token, 'POST', '/Users', { schemas: [USER], userName: 'anna@bücher.test' })).status, 400, 'a domain in its Unicode form')
})
