// Enterprise single sign-on (DESIGN.md §7): owners' settings, domain verification over DNS-over-HTTPS, SAML responses
// signed by a stand-in identity provider (and every way of getting one wrong), OpenID Connect against stubbed
// endpoints, joining the organization, and "require SSO" closing the other ways in. All data is synthetic.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { GOOGLE_CLIENT_ID, PASSWORD, TOKENS, UUID, startGateway, uniqueEmail } from './helpers/harness.mjs'
import { encode, makeIdentityProviderKey, requestIdFrom, samlResponse, signResponse } from './helpers/saml-idp.mjs'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

const IDP_KEY = makeIdentityProviderKey('Test IdP')
const OTHER_KEY = makeIdentityProviderKey('Somebody Else')
const SAML_ISSUER = 'https://idp.example.test/saml'
const IDP_ORIGIN = 'https://idp.example.test'
const b64url = (value) => Buffer.from(value).toString('base64url')
const jwt = (claims) => `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.c2lnbmF0dXJl`

const post = (person, path, fields = {}) => person.client.post(h.url('auth', path), fields)

/** An owner with an organization and a verified domain (inserted directly; the UI path has its own test). */
async function orgWithDomain(domain, name = 'SSO Org') {
  const owner = await h.user({ name: 'Olive Owner' })
  const orgId = await h.org(owner.client, name)
  await h.sql('INSERT INTO sso_domains (org_id, domain, token, created_at, verified_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, domain, 'synthetic-token', Date.now())
  return { owner, orgId }
}

async function samlConnection(owner, orgId, extra = {}) {
  const saved = await post(owner, `/orgs/${orgId}/sso/connection`, {
    protocol: 'saml', default_role: 'VIEWER', saml_entity_id: SAML_ISSUER, saml_sso_url: `${IDP_ORIGIN}/sso`,
    saml_certificate: IDP_KEY.certificate, enabled: 'on', ...extra,
  })
  assert.equal(saved.status, 303, saved.text.slice(0, 500))
  const [connection] = await h.sql('SELECT id FROM sso_connections WHERE org_id = ?1', orgId)
  return { id: connection.id, acs: h.url('apex', `/sso/saml/${connection.id}/acs`), entityId: h.url('apex', `/sso/saml/${connection.id}`) }
}

/** "Sign in with SSO" for `email`: the continue page, and the identity provider's address it leads to. */
async function startSso(client, email, returnTo) {
  const page = await client.post(h.url('apex', '/sso'), returnTo ? { email, return_to: returnTo } : { email })
  assert.equal(page.status, 200, page.text.slice(0, 500))
  const target = /<meta http-equiv="refresh" content="0; url=([^"]+)"/.exec(page.text)[1].replaceAll('&amp;', '&')
  return { page, target }
}

const acsPost = (client, acs, xml, origin = IDP_ORIGIN) => client.post(acs, { SAMLResponse: encode(xml) }, { origin })

test('single sign-on settings are for owners only', async () => {
  const { owner, orgId } = await orgWithDomain('owners-only.test')
  const admin = await h.user()
  const viewer = await h.user()
  await h.join(owner, orgId, admin, 'ADMIN')
  await h.join(owner, orgId, viewer, 'VIEWER')
  const page = await owner.client.get(h.url('auth', `/settings/sso?org=${orgId}`))
  assert.equal(page.status, 200)
  assert.match(page.text, /<h2>Domains<\/h2>/)
  assert.match(page.text, /href="http:\/\/insulinapps\.localhost\/settings\/sso\?org=[^"]+" aria-current="page"/, 'the tab')
  for (const person of [admin, viewer]) {
    assert.equal((await person.client.get(h.url('auth', `/settings/sso?org=${orgId}`))).status, 403)
    assert.doesNotMatch((await person.client.get(h.url('auth', `/settings/users?org=${orgId}`))).text, /Single sign-on/, 'no tab')
    assert.equal((await post(person, `/orgs/${orgId}/sso/domains`, { domain: 'sneaky.test' })).status, 403)
    assert.equal((await post(person, `/orgs/${orgId}/sso/scim-tokens`, { name: 'Sneaky' })).status, 403)
  }
  const stranger = await h.user()
  assert.equal((await stranger.client.get(h.url('auth', `/settings/sso?org=${orgId}`))).status, 404)
})

test('domains: claimed, proven with a DNS TXT record, held by one organization at a time', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Domain Org')
  assert.equal((await post(owner, `/orgs/${orgId}/sso/domains`, { domain: 'gmail.com' })).status, 400, 'a shared provider')
  assert.equal((await post(owner, `/orgs/${orgId}/sso/domains`, { domain: 'not a domain' })).status, 400)
  assert.equal((await post(owner, `/orgs/${orgId}/sso/domains`, { domain: 'insulinapps.localhost' })).status, 400, 'the site itself')
  assert.equal((await post(owner, `/orgs/${orgId}/sso/domains`, { domain: ' Verify-Me.TEST. ' })).status, 303)
  const [claim] = await h.sql('SELECT domain, token, verified_at FROM sso_domains WHERE org_id = ?1', orgId)
  assert.equal(claim.domain, 'verify-me.test')
  assert.equal(claim.verified_at, null)
  const page = await owner.client.get(h.url('auth', `/settings/sso?org=${orgId}`))
  assert.ok(page.text.includes('_insulin-apps.verify-me.test'))
  assert.ok(page.text.includes(`insulin-apps-verification=${claim.token}`))

  let published = ['"insulin-apps-verification=something-else"']
  h.outbound.on('https://cloudflare-dns.com/', (_request, url) => {
    assert.equal(url.searchParams.get('name'), '_insulin-apps.verify-me.test')
    assert.equal(url.searchParams.get('type'), 'TXT')
    return { Status: 0, Answer: published.map((data) => ({ name: url.searchParams.get('name'), type: 16, data })) }
  })
  assert.equal((await post(owner, `/orgs/${orgId}/sso/domains/verify`, { domain: 'verify-me.test' })).status, 409, 'not published yet')
  // Long values come split into character strings, which count as one.
  published = [`"insulin-apps-verif" "ication=${claim.token}"`]
  assert.equal((await post(owner, `/orgs/${orgId}/sso/domains/verify`, { domain: 'verify-me.test' })).status, 303)
  assert.ok((await h.sql('SELECT verified_at FROM sso_domains WHERE org_id = ?1', orgId))[0].verified_at > 0)
  assert.equal(h.outbound.to('https://cloudflare-dns.com/').at(-1).headers.accept, 'application/dns-json')

  const rival = await h.user()
  const rivalOrg = await h.org(rival.client, 'Rival Org')
  assert.equal((await post(rival, `/orgs/${rivalOrg}/sso/domains`, { domain: 'verify-me.test' })).status, 409, 'verified elsewhere')
  assert.equal((await post(owner, `/orgs/${orgId}/sso/domains/remove`, { domain: 'verify-me.test' })).status, 303)
  assert.equal((await post(rival, `/orgs/${rivalOrg}/sso/domains`, { domain: 'verify-me.test' })).status, 303, 'free again once removed')
})

test('SAML: a signed response signs a new person in to the organization with the default role, once', async () => {
  const domain = 'saml-corp.test'
  const { owner, orgId } = await orgWithDomain(domain, 'SAML Org')
  const sp = await samlConnection(owner, orgId)
  const metadata = await h.client().get(h.url('apex', `/sso/saml/${sp.id}/metadata`))
  assert.equal(metadata.status, 200)
  assert.match(metadata.headers.get('content-type'), /^application\/samlmetadata\+xml/)
  assert.ok(metadata.text.includes(`entityID="${sp.entityId}"`))
  assert.ok(metadata.text.includes(`Location="${sp.acs}"`))

  const client = h.client()
  const email = `sam.${Date.now()}@${domain}`
  const { target } = await startSso(client, email.toUpperCase(), h.url('captable', '/companies'))
  assert.ok(target.startsWith(`${IDP_ORIGIN}/sso?SAMLRequest=`))
  const { id, xml } = requestIdFrom(target)
  assert.match(xml, new RegExp(`AssertionConsumerServiceURL="${sp.acs.replaceAll('.', '\\.')}"`))
  assert.match(id, /^_[0-9a-f]{40}$/)

  const response = signResponse(samlResponse({ acs: sp.acs, entityId: sp.entityId, requestId: id, email, displayName: 'Sam Saml' }), IDP_KEY)
  const signedIn = await acsPost(client, sp.acs, response)
  assert.equal(signedIn.status, 200, signedIn.text.slice(0, 300))
  assert.match(signedIn.text, /url=http:\/\/captable\.insulinapps\.localhost\/companies/, 'continues to where it started')
  assert.ok(signedIn.cookies.some((cookie) => cookie.startsWith('insulin_session=')))
  const [user] = await h.sql('SELECT id, name, password_hash, email_verified_at FROM users WHERE email = ?1', email)
  assert.equal(user.name, 'Sam Saml')
  assert.equal(user.password_hash, null)
  assert.ok(user.email_verified_at > 0)
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, user.id))[0].role, 'VIEWER')
  const echo = JSON.parse((await client.get(h.url('captable', '/api/echo'))).text)
  assert.equal(echo.headers['x-suger-organization-id'], orgId, 'signed in to the organization')
  assert.equal(echo.headers['x-suger-app-role'], 'VIEWER')

  const replay = await acsPost(h.client(), sp.acs, response)
  assert.equal(replay.status, 400, 'the same response again (another browser)')
  const replaySame = await acsPost(client, sp.acs, response)
  assert.equal(replaySame.status, 400, 'the same response again (same browser)')
  assert.match(replaySame.text, /already used/)
})

test('SAML: unsigned, wrongly signed, tampered, wrapped, misaddressed, expired or unrequested responses sign nobody in', async () => {
  const domain = 'saml-refuse.test'
  const { owner, orgId } = await orgWithDomain(domain, 'Refusing Org')
  const sp = await samlConnection(owner, orgId)
  const email = `refused@${domain}`
  const attempt = async (build) => {
    const client = h.client()
    const { target } = await startSso(client, email)
    const { id } = requestIdFrom(target)
    const response = await acsPost(client, sp.acs, build(id))
    assert.equal(response.cookies.filter((cookie) => cookie.startsWith('insulin_session=')).length, 0)
    return response
  }
  const base = (id, extra = {}) => samlResponse({ acs: sp.acs, entityId: sp.entityId, requestId: id, email, ...extra })
  const cases = [
    ['unsigned', (id) => base(id), /isn&#x27;t signed/],
    ['another key', (id) => signResponse(base(id), OTHER_KEY), /not signed with the identity provider/],
    ['tampered after signing', (id) => signResponse(base(id), IDP_KEY).replace(email, `boss@${domain}`), /not signed with the identity provider/],
    ['a second, unsigned assertion', (id) => {
      const signed = signResponse(base(id), IDP_KEY)
      const evil = base(id, { assertionId: '_evil', email: `boss@${domain}` }).match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)[0]
      return signed.replace('</samlp:Response>', `${evil}</samlp:Response>`)
    }, /exactly one Assertion/],
    ['the signed assertion moved, another in its place', (id) => {
      const signed = signResponse(base(id), IDP_KEY)
      const original = signed.match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)[0]
      const evil = base(id, { email: `boss@${domain}` }).match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)[0]
      return signed.replace(original, `${evil}<samlp:Extensions>${original}</samlp:Extensions>`)
    }, /Two elements share an ID|exactly one Assertion/],
    ['another audience', (id) => signResponse(base(id, { audience: 'https://other.example.test/sp' }), IDP_KEY), /another service/],
    ['another recipient', (id) => signResponse(base(id, { recipient: 'https://other.example.test/acs' }), IDP_KEY), /another service/],
    ['another issuer', (id) => signResponse(base(id, { issuer: 'https://evil.example.test' }), IDP_KEY), /another identity provider/],
    ['expired', (id) => signResponse(base(id, { notBefore: Date.now() - 3_600_000, notOnOrAfter: Date.now() - 600_000 }), IDP_KEY), /expired/],
    ['an unknown request', () => signResponse(base('_0000000000000000000000000000000000000000'), IDP_KEY), /expired, was already used/],
    ['assertion and response for different requests', (id) => signResponse(base(id, { assertionInResponseTo: '_other' }), IDP_KEY), /different requests/],
    ['a failure status', (id) => signResponse(base(id, { status: 'urn:oasis:names:tc:SAML:2.0:status:Responder' }), IDP_KEY), /didn&#x27;t sign you in/],
    ['a DTD', (id) => `<!DOCTYPE x [<!ENTITY a "b">]>${signResponse(base(id), IDP_KEY)}`, /DTDs/],
  ]
  for (const [why, build, message] of cases) {
    const response = await attempt(build)
    assert.equal(response.status, 400, why)
    assert.match(response.text, message, why)
  }
  // Without the flow cookie (a response replayed into another browser), even a valid one is refused.
  const client = h.client()
  const { target } = await startSso(client, email)
  const { id } = requestIdFrom(target)
  assert.equal((await acsPost(h.client(), sp.acs, signResponse(base(id), IDP_KEY))).status, 400)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM users WHERE email = ?1', email))[0].n, 0, 'nobody was created')
  // The right one still works: none of the attempts used up this browser's pending sign-in.
  assert.equal((await acsPost(client, sp.acs, signResponse(base(id), IDP_KEY))).status, 303)
})

test('SAML: a whole-response signature works too, and an address outside the verified domains is refused', async () => {
  const domain = 'saml-whole.test'
  const { owner, orgId } = await orgWithDomain(domain, 'Whole Org')
  const sp = await samlConnection(owner, orgId, { default_role: 'EDITOR' })
  const client = h.client()
  const { target } = await startSso(client, `whole@${domain}`)
  const { id } = requestIdFrom(target)
  const outside = signResponse(samlResponse({ acs: sp.acs, entityId: sp.entityId, requestId: id, email: 'whole@elsewhere.test' }), IDP_KEY, { element: 'Response' })
  const refused = await acsPost(client, sp.acs, outside)
  assert.equal(refused.status, 403)
  assert.match(refused.text, /verified domains/)
  const second = h.client()
  const { target: next } = await startSso(second, `whole@${domain}`)
  const signed = signResponse(samlResponse({ acs: sp.acs, entityId: sp.entityId, requestId: requestIdFrom(next).id, email: `whole@${domain}` }), IDP_KEY, { element: 'Response' })
  assert.equal((await acsPost(second, sp.acs, signed)).status, 303)
  const [user] = await h.sql('SELECT id FROM users WHERE email = ?1', `whole@${domain}`)
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, user.id))[0].role, 'EDITOR')
})

test('SAML: an unconfirmed account loses the password someone else may have chosen; an existing member keeps their role', async () => {
  const domain = 'saml-existing.test'
  const { owner, orgId } = await orgWithDomain(domain, 'Existing Org')
  const sp = await samlConnection(owner, orgId)
  const squatted = `squat@${domain}`
  assert.equal((await h.signUp(h.client(), { email: squatted })).status, 200)
  const member = await h.user({ email: `member@${domain}` })
  await h.join(owner, orgId, member, 'ADMIN')
  for (const email of [squatted, member.email]) {
    const client = h.client()
    const { target } = await startSso(client, email)
    assert.equal((await acsPost(client, sp.acs, signResponse(samlResponse({ acs: sp.acs, entityId: sp.entityId, requestId: requestIdFrom(target).id, email }), IDP_KEY))).status, 303)
  }
  const [user] = await h.sql('SELECT password_hash, email_verified_at, credential_version FROM users WHERE email = ?1', squatted)
  assert.equal(user.password_hash, null)
  assert.ok(user.email_verified_at > 0)
  assert.equal(user.credential_version, 1)
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, member.id))[0].role, 'ADMIN')
})

test('an address without single sign-on gets a plain answer; a connection that is off or incomplete is never used', async () => {
  const none = await h.client().post(h.url('apex', '/sso'), { email: 'nobody@no-sso.test' })
  assert.equal(none.status, 404)
  assert.match(none.text, /no single sign-on for that address/)
  const domain = 'saml-off.test'
  const { owner, orgId } = await orgWithDomain(domain, 'Off Org')
  const sp = await samlConnection(owner, orgId, { enabled: undefined })
  assert.equal((await h.client().post(h.url('apex', '/sso'), { email: `x@${domain}` })).status, 404)
  assert.equal((await h.client().post(sp.acs, { SAMLResponse: 'x' }, { origin: IDP_ORIGIN })).status, 404, 'a disabled connection has no ACS')
  const incomplete = await post(owner, `/orgs/${orgId}/sso/connection`, { protocol: 'saml', default_role: 'VIEWER', enabled: 'on' })
  assert.equal(incomplete.status, 400, 'turning on needs every SAML field')
  const badCertificate = await post(owner, `/orgs/${orgId}/sso/connection`, { protocol: 'saml', default_role: 'VIEWER', saml_certificate: '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----' })
  assert.equal(badCertificate.status, 400)
  assert.equal((await post(owner, `/orgs/${orgId}/sso/connection`, { protocol: 'saml', default_role: 'OWNER' })).status, 400, 'never owner by default')
})

async function oidcSetup(domain, issuer) {
  const { owner, orgId } = await orgWithDomain(domain, 'OIDC Org')
  h.outbound.on(`${issuer}/.well-known/openid-configuration`, () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` }))
  const saved = await post(owner, `/orgs/${orgId}/sso/connection`, {
    protocol: 'oidc', default_role: 'VIEWER', oidc_issuer: `${issuer}/`, oidc_client_id: 'insulin-client', oidc_client_secret: 'synthetic-client-secret', enabled: 'on',
  })
  assert.equal(saved.status, 303, saved.text.slice(0, 400))
  const [connection] = await h.sql('SELECT id, oidc_issuer, oidc_client_secret FROM sso_connections WHERE org_id = ?1', orgId)
  return { owner, orgId, connection }
}

/** Starts an OIDC sign-in, answers the token endpoint with `claims` (nonce from the request), calls back. */
async function oidcFlow(issuer, client, email, claims = {}) {
  const { target } = await startSso(client, email)
  const authorize = new URL(target)
  const nonce = authorize.searchParams.get('nonce')
  const now = Math.floor(Date.now() / 1000)
  h.outbound.on(`${issuer}/token`, () => ({
    token_type: 'Bearer',
    access_token: 'synthetic-access-token',
    id_token: jwt({ iss: issuer, aud: 'insulin-client', exp: now + 300, iat: now, nonce, email, email_verified: true, name: 'Olga Oidc', ...claims }),
  }))
  const callback = await client.get(`${authorize.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'synthetic-code' })}`)
  return { authorize, callback }
}

test('OpenID Connect: PKCE, state and nonce; the client secret is sealed; a good ID token signs in', async () => {
  const issuer = 'https://oidc-good.example.test'
  const domain = 'oidc-good.test'
  const { orgId, connection } = await oidcSetup(domain, issuer)
  assert.equal(connection.oidc_issuer, issuer)
  assert.match(connection.oidc_client_secret, /^v1\./, 'sealed, never stored as typed')
  const client = h.client()
  const email = `olga@${domain}`
  const { authorize, callback } = await oidcFlow(issuer, client, email)
  assert.equal(authorize.origin + authorize.pathname, `${issuer}/authorize`)
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorize.searchParams.get('scope'), 'openid email profile')
  assert.equal(callback.status, 302, callback.text.slice(0, 300))
  assert.equal(callback.location, h.url('apex', '/'))
  const exchange = h.outbound.to(`${issuer}/token`).at(-1)
  assert.equal(exchange.params.get('client_secret'), 'synthetic-client-secret')
  assert.equal(exchange.params.get('client_id'), 'insulin-client')
  assert.equal(exchange.params.get('redirect_uri'), h.url('apex', `/sso/oidc/${connection.id}/callback`))
  const verifier = exchange.params.get('code_verifier')
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'))
  const [user] = await h.sql('SELECT id, name FROM users WHERE email = ?1', email)
  assert.equal(user.name, 'Olga Oidc')
  assert.equal((await h.sql('SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2', orgId, user.id))[0].role, 'VIEWER')
  const replay = await client.get(`${authorize.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'synthetic-code' })}`)
  assert.equal(replay.status, 400, 'a callback works once')
})

test('OpenID Connect: a wrong nonce, audience or issuer, an unverified address, an expired token or a cancel sign nobody in', async () => {
  const issuer = 'https://oidc-refuse.example.test'
  const domain = 'oidc-refuse.test'
  await oidcSetup(domain, issuer)
  const email = `refused@${domain}`
  for (const [why, claims] of [
    ['wrong nonce', { nonce: 'not-the-nonce' }],
    ['wrong audience', { aud: 'someone-else' }],
    ['several audiences without azp', { aud: ['insulin-client', 'someone-else'] }],
    ['wrong issuer', { iss: 'https://evil.example.test' }],
    ['unverified address', { email_verified: false }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 600 }],
  ]) {
    const { callback } = await oidcFlow(issuer, h.client(), email, claims)
    assert.equal(callback.status, 400, why)
    assert.equal(callback.cookies.filter((cookie) => cookie.startsWith('insulin_session=')).length, 0, why)
  }
  const client = h.client()
  const { target } = await startSso(client, email)
  const authorize = new URL(target)
  const cancelled = await client.get(`${authorize.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: authorize.searchParams.get('state'), error: 'access_denied' })}`)
  assert.equal(cancelled.status, 400)
  const forged = await h.client().get(`${authorize.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: 'forged', code: 'x' })}`)
  assert.equal(forged.status, 400)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM users WHERE email = ?1', email))[0].n, 0)
})

test('"require SSO" turns away password, sign-up, reset, confirmation and Google for those addresses', async () => {
  const domain = 'required.test'
  const { owner, orgId } = await orgWithDomain(domain, 'Required Org')
  const existing = await h.user({ email: `existing@${domain}` })
  const unconfirmed = `unconfirmed@${domain}`
  await h.signUp(h.client(), { email: unconfirmed })
  await h.client().post(h.url('auth', '/forgot-password'), { email: existing.email, 'cf-turnstile-response': TOKENS.forgot })
  const resetLink = await h.link(existing.email, '/reset-password')
  const confirmLink = await h.link(unconfirmed, '/verify-email')
  await samlConnection(owner, orgId, { require_sso: 'on' })

  const login = await h.signIn(h.client(), { email: existing.email })
  assert.equal(login.status, 403)
  assert.match(login.text, /requires its own sign-in/)
  assert.ok(login.text.includes(`href="/sso?email=${encodeURIComponent(existing.email)}"`))
  assert.equal(login.cookies.filter((cookie) => cookie.startsWith('insulin_session=')).length, 0)
  const wrongPassword = await h.signIn(h.client(), { email: `nobody@${domain}`, password: 'wrong password!' })
  assert.equal(wrongPassword.status, 403, 'the same answer for an address without an account')
  assert.equal((await h.signUp(h.client(), { email: `new@${domain}` })).status, 403)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM users WHERE email = ?1', `new@${domain}`))[0].n, 0)
  assert.equal((await h.client().post(h.url('auth', '/forgot-password'), { email: existing.email, 'cf-turnstile-response': TOKENS.forgot })).status, 403)
  assert.equal((await h.client().get(resetLink)).status, 403)
  const token = new URL(resetLink).searchParams.get('token')
  assert.equal((await h.client().post(h.url('auth', '/reset-password'), { token, password: 'a brand new password' })).status, 403)
  assert.equal((await h.client().post(h.url('auth', '/verify-email'), { token: new URL(confirmLink).searchParams.get('token') })).status, 403)

  const google = h.client()
  const start = await google.get(h.url('auth', '/auth/google/start'))
  const authorize = new URL(start.location)
  const now = Math.floor(Date.now() / 1000)
  h.outbound.google = () => ({
    id_token: jwt({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, exp: now + 300, iat: now, nonce: authorize.searchParams.get('nonce'), email_verified: true, sub: 'sub-required', email: existing.email, name: 'Existing' }),
  })
  const callback = await google.get(h.url('auth', `/auth/google/callback?${new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'c' })}`))
  assert.equal(callback.status, 403)
  assert.equal((await h.sql('SELECT google_sub FROM users WHERE id = ?1', existing.id))[0].google_sub, null, 'nothing was linked')

  // Other domains are untouched, and so is everyone once the requirement is off.
  assert.equal((await h.signIn(h.client(), { email: owner.email })).status, 303)
  await samlConnection(owner, orgId, { require_sso: undefined })
  assert.equal((await h.signIn(h.client(), { email: existing.email, password: PASSWORD })).status, 303)
})

test('the login page offers single sign-on, and the settings page shows what the identity provider needs', async () => {
  const login = await h.client().get(h.url('auth', '/login'))
  assert.match(login.text, /href="\/sso">Sign in with SSO<\/a>/)
  const { owner, orgId } = await orgWithDomain('details.test', 'Details Org')
  const before = await owner.client.get(h.url('auth', `/settings/sso?org=${orgId}`))
  assert.match(before.text, /Save the connection \(it can stay off\)/)
  const sp = await samlConnection(owner, orgId, { enabled: undefined })
  const after = await owner.client.get(h.url('auth', `/settings/sso?org=${orgId}`))
  assert.ok(after.text.includes(sp.acs))
  assert.ok(after.text.includes(sp.entityId))
  assert.match(after.text, /One certificate is saved/)
  assert.match(after.text, new RegExp(`/sso/saml/${UUID}/metadata`))
  // Saving again without pasting the certificate keeps it.
  await samlConnection(owner, orgId, { saml_certificate: '', enabled: 'on' })
  assert.equal(JSON.parse((await h.sql('SELECT saml_certificates FROM sso_connections WHERE org_id = ?1', orgId))[0].saml_certificates).length, 1)
  assert.equal((await post(owner, `/orgs/${orgId}/sso/connection/delete`)).status, 303)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM sso_connections WHERE org_id = ?1', orgId))[0].n, 0)
  assert.equal(uniqueEmail('x').endsWith('@example.test'), true)
})
