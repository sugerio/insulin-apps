// Google sign-in: authorization code + PKCE (S256) + state + nonce, with the token endpoint answered by the outbound
// fetch hook.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, startGateway, uniqueEmail } from './helpers/harness.mjs'

let h
let production
let noGoogle
before(async () => {
  ;[h, production, noGoogle] = await Promise.all([
    startGateway(),
    startGateway({ mode: 'production' }),
    startGateway({ vars: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: undefined } }),
  ])
})
after(async () => { await Promise.all([h?.close(), production?.close(), noGoogle?.close()]) })

const b64url = (value) => Buffer.from(value).toString('base64url')
const idToken = (claims) => `${b64url(JSON.stringify({ alg: 'RS256', kid: 'test' }))}.${b64url(JSON.stringify(claims))}.c2lnbmF0dXJl`
const sessionCookie = (response) => response.cookies.find((cookie) => cookie.startsWith('insulin_session='))

/** Runs start → (Google) → callback, with the ID token's claims built from the request's nonce. */
async function googleFlow(harness, client, claims = {}, { returnTo, tamper } = {}) {
  const start = await client.get(harness.url('auth', `/auth/google/start${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`))
  assert.equal(start.status, 302)
  const authorize = new URL(start.location)
  const nonce = authorize.searchParams.get('nonce')
  harness.outbound.google = () => ({
    access_token: 'test-access-token',
    token_type: 'Bearer',
    id_token: idToken({
      iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000),
      nonce, email_verified: true, sub: 'sub-default', email: uniqueEmail('google'), name: 'Grace Google', ...claims,
    }),
  })
  const params = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'test-authorization-code', scope: 'openid email profile' })
  tamper?.(params)
  const callback = await client.get(harness.url('auth', `/auth/google/callback?${params}`))
  return { start, authorize, callback }
}

test('start sets a short-lived flow cookie and sends the browser to Google with PKCE, state and nonce', async () => {
  const client = h.client()
  const start = await client.get(h.url('auth', `/auth/google/start?return_to=${encodeURIComponent(h.url('captable', '/x'))}`))
  assert.equal(start.status, 302)
  const url = new URL(start.location)
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('client_id'), GOOGLE_CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), 'http://auth.insulinapps.localhost/auth/google/callback')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  assert.equal(url.searchParams.get('prompt'), 'select_account')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  const cookie = start.cookies.find((line) => line.startsWith('insulin_oauth='))
  assert.match(cookie, /; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/, 'SITE_ENV=test on http://*.localhost: no Secure, no __Host-')
  const [state, verifier, nonce] = cookie.split(';')[0].split('=')[1].split('.')
  assert.equal(url.searchParams.get('state'), state)
  assert.equal(url.searchParams.get('nonce'), nonce)
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'))
})

test('in production the flow cookie is __Host- and Secure, and the redirect URI is the registered https one', async () => {
  const start = await production.client().get(production.url('auth', '/auth/google/start'))
  const cookie = start.cookies.find((line) => line.startsWith('__Host-insulin_oauth='))
  assert.match(cookie, /^__Host-insulin_oauth=[^;]+; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/)
  assert.doesNotMatch(cookie, /Domain=/)
  assert.equal(new URL(start.location).searchParams.get('redirect_uri'), 'https://auth.example.test/auth/google/callback')
})

test('a first Google sign-in creates a confirmed account, signs in and returns where it started', async () => {
  const client = h.client()
  const email = uniqueEmail('first-google')
  const { callback, start } = await googleFlow(h, client, { sub: 'sub-first', email: email.toUpperCase(), name: 'Grace ‮Google' }, { returnTo: h.url('captable', '/companies') })
  assert.equal(callback.status, 302)
  assert.equal(callback.location, h.url('captable', '/companies'))
  assert.ok(sessionCookie(callback))
  assert.ok(callback.cookies.some((line) => /^insulin_oauth=; .*Max-Age=0/.test(line)), 'the flow cookie is cleared')
  const [user] = await h.sql('SELECT * FROM users WHERE email = ?1', email)
  assert.equal(user.google_sub, 'sub-first')
  assert.equal(user.password_hash, null)
  assert.ok(user.email_verified_at > 0)
  assert.equal(user.name, 'Grace Google')
  const exchange = h.outbound.to('https://oauth2.googleapis.com/token').at(-1)
  assert.equal(exchange.method, 'POST')
  assert.equal(exchange.params.get('code'), 'test-authorization-code')
  assert.equal(exchange.params.get('client_id'), GOOGLE_CLIENT_ID)
  assert.equal(exchange.params.get('client_secret'), GOOGLE_CLIENT_SECRET)
  assert.equal(exchange.params.get('redirect_uri'), 'http://auth.insulinapps.localhost/auth/google/callback')
  assert.equal(exchange.params.get('grant_type'), 'authorization_code')
  const verifier = start.cookies.find((line) => line.startsWith('insulin_oauth=')).split(';')[0].split('=')[1].split('.')[1]
  assert.equal(exchange.params.get('code_verifier'), verifier)
  assert.equal((await client.get(h.url('auth', '/'))).status, 200)
})

test('a callback whose state does not match the cookie is refused before talking to Google', async () => {
  const client = h.client()
  const calls = h.outbound.to('https://oauth2.googleapis.com/token').length
  const { callback } = await googleFlow(h, client, { sub: 'sub-state' }, { tamper: (params) => params.set('state', 'x'.repeat(43)) })
  assert.equal(callback.status, 400)
  assert.equal(sessionCookie(callback), undefined)
  assert.equal(callback.cookies.length, 0, 'a mismatched state does not even clear the flow')
  assert.equal(h.outbound.to('https://oauth2.googleapis.com/token').length, calls)
  const noCookie = await h.client().get(h.url('auth', `/auth/google/callback?state=${'s'.repeat(43)}&code=c`))
  assert.equal(noCookie.status, 400)
})

test('a flow cookie works once: replaying the callback fails', async () => {
  const client = h.client()
  const { callback, authorize } = await googleFlow(h, client, { sub: 'sub-replay' })
  assert.equal(callback.status, 302)
  const replay = await client.get(h.url('auth', `/auth/google/callback?state=${authorize.searchParams.get('state')}&code=again`))
  assert.equal(replay.status, 400)
})

test('cancelling at Google, with this flow\'s state, shows a message, clears the flow and signs nobody in', async () => {
  const client = h.client()
  const start = await client.get(h.url('auth', '/auth/google/start'))
  const state = new URL(start.location).searchParams.get('state')
  const cancelled = await client.get(h.url('auth', `/auth/google/callback?error=access_denied&state=${state}`))
  assert.equal(cancelled.status, 400)
  assert.match(cancelled.text, /cancelled/)
  assert.equal(sessionCookie(cancelled), undefined)
  assert.ok(cancelled.cookies.some((line) => /^insulin_oauth=; .*Max-Age=0/.test(line)), 'the flow is over')
})

test('an error callback without this flow\'s state changes nothing: the pending flow still completes', async () => {
  const client = h.client()
  const start = await client.get(h.url('auth', '/auth/google/start'))
  const authorize = new URL(start.location)
  for (const query of ['error=access_denied', `error=access_denied&state=${'x'.repeat(43)}`]) {
    const forged = await client.get(h.url('auth', `/auth/google/callback?${query}`))
    assert.equal(forged.status, 400)
    assert.equal(forged.cookies.length, 0, 'the flow cookie is left alone')
  }
  h.outbound.google = () => ({
    id_token: idToken({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, nonce: authorize.searchParams.get('nonce'), email_verified: true, sub: 'sub-after-forged-error', email: uniqueEmail('after-error'), name: 'After Error' }),
  })
  const callback = await client.get(h.url('auth', `/auth/google/callback?state=${authorize.searchParams.get('state')}&code=c`))
  assert.equal(callback.status, 302)
  assert.ok(sessionCookie(callback))
})

test('an ID token with email_verified false, a wrong nonce or audience, or a failed exchange signs nobody in', async () => {
  const email = uniqueEmail('rejected')
  for (const claims of [{ email_verified: false }, { nonce: 'n'.repeat(43) }, { aud: 'someone-else' }, { iss: 'https://evil.example' }, { exp: 1 }]) {
    const { callback } = await googleFlow(h, h.client(), { sub: 'sub-rejected', email, ...claims })
    assert.equal(callback.status, 400, JSON.stringify(claims))
    assert.equal(sessionCookie(callback), undefined)
  }
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM users WHERE email = ?1', email))[0].n, 0)
  const client = h.client()
  const start = await client.get(h.url('auth', '/auth/google/start'))
  h.outbound.google = () => new Response('{"error":"invalid_grant"}', { status: 400 })
  const failed = await client.get(h.url('auth', `/auth/google/callback?state=${new URL(start.location).searchParams.get('state')}&code=bad`))
  assert.equal(failed.status, 400)
  assert.equal(sessionCookie(failed), undefined)
})

test('pre-hijacking: Google sign-in confirms an unconfirmed account and throws away the password someone else chose', async () => {
  const victim = uniqueEmail('victim')
  await h.signUp(h.client(), { email: victim, password: 'attacker chosen password' })
  const attackerLink = await h.link(victim, '/verify-email')
  const { callback } = await googleFlow(h, h.client(), { sub: 'sub-victim', email: victim })
  assert.equal(callback.status, 302)
  const [user] = await h.sql('SELECT * FROM users WHERE email = ?1', victim)
  assert.equal(user.google_sub, 'sub-victim')
  assert.equal(user.password_hash, null)
  assert.ok(user.email_verified_at > 0)
  assert.equal((await h.signIn(h.client(), { email: victim, password: 'attacker chosen password' })).status, 401)
  const token = new URL(attackerLink).searchParams.get('token')
  assert.equal((await h.client().post(h.url('auth', '/verify-email'), { token })).status, 400, 'outstanding links died too')
})

test('Google links to a confirmed password account and keeps its password; later sign-ins find it by subject', async () => {
  const { email, id } = await h.user()
  const linked = await googleFlow(h, h.client(), { sub: 'sub-linked', email })
  assert.equal(linked.callback.status, 302)
  const [user] = await h.sql('SELECT google_sub, password_hash FROM users WHERE id = ?1', id)
  assert.equal(user.google_sub, 'sub-linked')
  assert.ok(user.password_hash, 'a confirmed account keeps its password')
  assert.equal((await h.signIn(h.client(), { email })).status, 303)
  const again = await googleFlow(h, h.client(), { sub: 'sub-linked', email: uniqueEmail('renamed-at-google') })
  assert.equal(again.callback.status, 302)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM users WHERE google_sub = ?1', 'sub-linked'))[0].n, 1, 'same account, no duplicate')
})

test('an address linked to a different Google account is refused', async () => {
  const email = uniqueEmail('linked-elsewhere')
  await googleFlow(h, h.client(), { sub: 'sub-original', email })
  const other = await googleFlow(h, h.client(), { sub: 'sub-impostor', email })
  assert.equal(other.callback.status, 409)
  assert.equal(sessionCookie(other.callback), undefined)
})

test('a return_to on another host is ignored', async () => {
  const { callback } = await googleFlow(h, h.client(), { sub: 'sub-return' }, { returnTo: 'https://evil.example/' })
  assert.equal(callback.location, h.url('auth', '/'))
})

test('without GOOGLE_CLIENT_ID, Google sign-in is hidden and its endpoints are 404', async () => {
  const login = await noGoogle.client().get(noGoogle.url('auth', '/login'))
  assert.equal(login.status, 200)
  assert.doesNotMatch(login.text, /Continue with Google/)
  assert.doesNotMatch((await noGoogle.client().get(noGoogle.url('auth', '/signup'))).text, /Continue with Google/)
  assert.match((await h.client().get(h.url('auth', '/login'))).text, /Continue with Google/)
  assert.equal((await noGoogle.client().get(noGoogle.url('auth', '/auth/google/start'))).status, 404)
  assert.equal((await noGoogle.client().get(noGoogle.url('auth', '/auth/google/callback?state=x&code=y'))).status, 404)
})
