// Two-step sign-in (DESIGN.md §5.1): enrolment with a QR code and recovery codes, the code prompt after a password,
// Google or reset sign-in, single-use codes and recovery codes, the attempt cap, the challenge cookie, turning it off,
// and failing closed without GATEWAY_SECRET_KEY. Codes are computed from the key the setup page shows.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { GOOGLE_CLIENT_ID, NAVIGATE, PASSWORD, TOKENS, startGateway } from './helpers/harness.mjs'
import { createHash } from 'node:crypto'
import { base32Decode, hotp, timeStep } from '../src/auth/totp.ts'
import { consumeRecoveryCode, consumeStep, takeChallenge } from '../src/db/mfa.ts'

let h
let production
let keyless
before(async () => {
  ;[h, production, keyless] = await Promise.all([
    startGateway(),
    startGateway({ mode: 'production' }),
    startGateway({ vars: { GATEWAY_SECRET_KEY: undefined } }),
  ])
})
after(async () => { await Promise.all([h?.close(), production?.close(), keyless?.close()]) })

const RECOVERY = /<li>([a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4})<\/li>/g

/**
 * A code for the next step the gateway will accept: after the last one used, and within a step of now. When that would
 * be more than a step ahead, the test moves the user's last step back instead of waiting 30 seconds.
 */
async function freshCode(harness, person, secret) {
  const now = timeStep(Date.now())
  const [{ totp_last_step: last }] = await harness.sql('SELECT totp_last_step FROM users WHERE id = ?1', person.id)
  let step = Math.max(now - 1, last + 1)
  if (step > now + 1) {
    await harness.sql('UPDATE users SET totp_last_step = ?2 WHERE id = ?1', person.id, now - 2)
    step = now - 1
  }
  return hotp(base32Decode(secret), step)
}

/** Turns two-step sign-in on for `person`; returns the key and the recovery codes the page showed once. */
async function enable(harness, person) {
  assert.equal((await person.client.post(harness.url('auth', '/account/security/setup'), { password: PASSWORD })).status, 303)
  const page = await person.client.get(harness.url('auth', '/account/security'))
  const secret = /<code[^>]*>([A-Z2-7 ]+)<\/code>/.exec(page.text)[1].replaceAll(' ', '')
  const enabled = await person.client.post(harness.url('auth', '/account/security/enable'), { code: await hotp(base32Decode(secret), timeStep(Date.now()) - 1), password: PASSWORD })
  assert.equal(enabled.status, 200, enabled.text.slice(0, 300))
  const codes = [...enabled.text.matchAll(RECOVERY)].map((match) => match[1])
  return { secret, codes, page: enabled }
}

const mfaCookie = (response) => response.cookies.find((line) => /^(__Host-)?insulin_mfa=[^;]+;/.test(line) && !/Max-Age=0/.test(line))
const sessionCookie = (response) => response.cookies.find((line) => /^insulin_session=[^;]+;/.test(line) && !/Max-Age=0/.test(line))

test('TOTP follows RFC 6238 (SHA-1 test vectors) and the setup key round-trips through base32', async () => {
  const secret = new TextEncoder().encode('12345678901234567890')
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(await hotp(secret, timeStep(seconds * 1000), 8), expected, String(seconds))
  }
})

test('turning it on: a QR code and key, a code from the app, ten recovery codes once, other sessions signed out, an e-mail', async () => {
  const person = await h.user({ name: 'Mfa Enroller' })
  const elsewhere = h.client()
  assert.equal((await h.signIn(elsewhere, { email: person.email })).status, 303)

  const off = await person.client.get(h.url('auth', '/account/security'))
  assert.match(off.text, /Set up two-step sign-in/)
  assert.match((await person.client.get(h.url('auth', '/account'))).text, /<h2>Two-step sign-in<\/h2>[\s\S]*?>Off</)
  const unproven = await person.client.post(h.url('auth', '/account/security/setup'), { password: 'not the password' })
  assert.equal(unproven.status, 403, 'a session alone, without the password, sets nothing up')
  assert.match(unproven.text, /That password isn&#x27;t right/)
  assert.equal((await h.sql('SELECT totp_pending FROM users WHERE id = ?1', person.id))[0].totp_pending, null)
  assert.equal((await person.client.post(h.url('auth', '/account/security/setup'), { password: PASSWORD })).status, 303)
  const setup = await person.client.get(h.url('auth', '/account/security'))
  assert.match(setup.text, /<svg[^>]*role="img"[^>]*aria-label="QR code for your authenticator app"/)
  assert.doesNotMatch(setup.text, /\sstyle=/, 'no inline styles, the QR code included')
  const secret = /<code[^>]*>([A-Z2-7 ]+)<\/code>/.exec(setup.text)[1].replaceAll(' ', '')
  assert.equal(secret.length, 32, '20 random bytes')
  const [pending] = await h.sql('SELECT totp_pending, totp_secret FROM users WHERE id = ?1', person.id)
  assert.match(pending.totp_pending, /^v1\./, 'sealed, never in the clear')
  assert.ok(!pending.totp_pending.includes(secret))
  assert.equal(pending.totp_secret, null, 'not on until a code confirms it')

  const wrong = await person.client.post(h.url('auth', '/account/security/enable'), { code: '000000', password: PASSWORD })
  assert.equal(wrong.status, 400)
  assert.match(wrong.text, /That code didn&#x27;t work/)
  const noPassword = await person.client.post(h.url('auth', '/account/security/enable'), { code: await hotp(base32Decode(secret), timeStep(Date.now())) })
  assert.equal(noPassword.status, 403, 'confirming needs the password too')
  const enabled = await person.client.post(h.url('auth', '/account/security/enable'), { code: await hotp(base32Decode(secret), timeStep(Date.now())), password: PASSWORD })
  assert.equal(enabled.status, 200)
  const codes = [...enabled.text.matchAll(RECOVERY)].map((match) => match[1])
  assert.equal(codes.length, 10)
  assert.equal(new Set(codes).size, 10)
  assert.ok(sessionCookie(enabled), 'this browser continues with a fresh session')
  const [user] = await h.sql('SELECT totp_secret, totp_pending, totp_enabled_at FROM users WHERE id = ?1', person.id)
  assert.match(user.totp_secret, /^v1\./)
  assert.equal(user.totp_pending, null)
  assert.ok(user.totp_enabled_at > 0)
  const stored = await h.sql('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = ?1', person.id)
  assert.equal(stored.length, 10)
  assert.ok(stored.every((row) => /^[0-9a-f]{64}$/.test(row.code_hash)), 'recovery codes are stored as SHA-256 only')

  assert.equal((await person.client.get(h.url('auth', '/account'))).status, 200, 'still signed in here')
  assert.equal((await elsewhere.get(h.url('auth', '/account'))).status, 302, 'every other session ended')
  const mails = await h.waitForMail(person.email, 2)
  assert.match(mails.at(-1).subject, /Two-step sign-in was turned on/)
  const page = await person.client.get(h.url('auth', '/account/security'))
  assert.match(page.text, /You have 10 recovery codes left/)
  assert.doesNotMatch(page.text, RECOVERY, 'the codes are never shown again')
})

test('a password sign-in asks for a code before any session exists, and the code works once', async () => {
  const person = await h.user({ name: 'Mfa Signer' })
  const { secret } = await enable(h, person)
  const client = h.client()
  const signedIn = await h.signIn(client, { email: person.email, returnTo: h.url('captable', '/x') })
  assert.equal(signedIn.status, 303)
  assert.equal(signedIn.location, h.url('auth', '/login/mfa'))
  assert.equal(sessionCookie(signedIn), undefined, 'no session yet')
  const cookie = mfaCookie(signedIn)
  assert.match(cookie, /^insulin_mfa=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/, 'host-only: no Domain')
  assert.equal((await client.get(h.url('auth', '/account'))).status, 302, 'not signed in')
  assert.equal((await client.raw(h.url('captable', '/x'), { headers: NAVIGATE })).status, 302, 'nor in an app')

  const prompt = await client.get(h.url('auth', '/login/mfa'))
  assert.equal(prompt.status, 200)
  assert.match(prompt.text, /autoComplete="one-time-code"|autocomplete="one-time-code"/)
  assert.match(prompt.text, /inputMode="numeric"|inputmode="numeric"/)
  const wrong = await client.post(h.url('auth', '/login/mfa'), { code: '123456' })
  assert.equal(wrong.status, 400)
  assert.match(wrong.text, /4 more tries/)

  const code = await freshCode(h, person, secret)
  const done = await client.post(h.url('auth', '/login/mfa'), { code })
  assert.equal(done.status, 200, 'continues to the app with a page')
  assert.match(done.text, /url=http:\/\/captable\.insulinapps\.localhost\/x/)
  assert.ok(sessionCookie(done))
  assert.ok(done.cookies.some((line) => /^insulin_mfa=; .*Max-Age=0/.test(line)), 'the challenge cookie is cleared')
  assert.equal((await client.get(h.url('auth', '/account'))).status, 200)
  assert.equal((await client.get(h.url('auth', '/login/mfa'))).status, 410, 'the challenge is gone')

  const again = h.client()
  await h.signIn(again, { email: person.email })
  const replay = await again.post(h.url('auth', '/login/mfa'), { code })
  assert.equal(replay.status, 400, 'the same code never works twice')
  assert.equal(sessionCookie(replay), undefined)
})

test('five wrong codes end the challenge; signing in again starts afresh', async () => {
  const person = await h.user()
  const { secret } = await enable(h, person)
  const client = h.client()
  await h.signIn(client, { email: person.email })
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal((await client.post(h.url('auth', '/login/mfa'), { code: '000000' })).status, 400, `attempt ${attempt}`)
  }
  const capped = await client.post(h.url('auth', '/login/mfa'), { code: await freshCode(h, person, secret) })
  assert.equal(capped.status, 429, 'even a right code, after five wrong ones')
  assert.equal(sessionCookie(capped), undefined)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM mfa_challenges WHERE user_id = ?1', person.id))[0].n, 0)
  await h.signIn(client, { email: person.email })
  assert.equal((await client.post(h.url('auth', '/login/mfa'), { code: await freshCode(h, person, secret) })).status, 303)
})

test('a recovery code signs in once; new codes replace the old ones and need an app code', async () => {
  const person = await h.user()
  const { secret, codes } = await enable(h, person)
  const client = h.client()
  await h.signIn(client, { email: person.email })
  const [first] = codes
  assert.equal((await client.post(h.url('auth', '/login/mfa'), { code: first.toUpperCase().replaceAll('-', ' ') })).status, 303, 'case, spaces and dashes don\'t matter')
  const other = h.client()
  await h.signIn(other, { email: person.email })
  assert.equal((await other.post(h.url('auth', '/login/mfa'), { code: first })).status, 400, 'used up')
  assert.match((await person.client.get(h.url('auth', '/account/security'))).text, /You have 9 recovery codes left/)

  assert.equal((await person.client.post(h.url('auth', '/account/security/recovery-codes'), { code: codes[1] })).status, 400, 'an app code, not a recovery code')
  const renewed = await person.client.post(h.url('auth', '/account/security/recovery-codes'), { code: await freshCode(h, person, secret) })
  assert.equal(renewed.status, 200)
  const fresh = [...renewed.text.matchAll(RECOVERY)].map((match) => match[1])
  assert.equal(fresh.length, 10)
  assert.equal((await other.post(h.url('auth', '/login/mfa'), { code: codes[2] })).status, 400, 'the old codes stopped working')
  assert.equal((await other.post(h.url('auth', '/login/mfa'), { code: fresh[0] })).status, 303)
})

test('Google sign-in and a password reset ask for the code too', async () => {
  const person = await h.user({ name: 'Mfa Google' })
  const { secret } = await enable(h, person)
  const client = h.client()
  const start = await client.get(h.url('auth', '/auth/google/start'))
  const authorize = new URL(start.location)
  const b64url = (value) => Buffer.from(value).toString('base64url')
  h.outbound.google = () => ({
    access_token: 'test-access-token',
    token_type: 'Bearer',
    id_token: `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({
      iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000),
      nonce: authorize.searchParams.get('nonce'), email_verified: true, sub: `sub-${person.id}`, email: person.email, name: 'Mfa Google',
    }))}.c2ln`,
  })
  const callback = await client.get(h.url('auth', `/auth/google/callback?${new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'test-code' })}`))
  assert.equal(callback.status, 302)
  assert.equal(callback.location, h.url('auth', '/login/mfa'))
  assert.equal(sessionCookie(callback), undefined)
  assert.ok(mfaCookie(callback))
  assert.equal((await client.post(h.url('auth', '/login/mfa'), { code: await freshCode(h, person, secret) })).status, 303)

  const resetter = h.client()
  await resetter.post(h.url('auth', '/forgot-password'), { email: person.email, 'cf-turnstile-response': TOKENS.forgot })
  const link = await h.link(person.email, '/reset-password')
  const reset = await resetter.post(h.url('auth', '/reset-password'), { token: new URL(link).searchParams.get('token'), password: 'a brand new password' })
  assert.equal(reset.status, 303)
  assert.equal(reset.location, h.url('auth', '/login/mfa'), 'a reset link proves the inbox, not the second factor')
  assert.equal(sessionCookie(reset), undefined)
  const done = await resetter.post(h.url('auth', '/login/mfa'), { code: await freshCode(h, person, secret) })
  assert.equal(done.status, 303)
  assert.equal(done.location, h.url('auth', '/?notice=password-set'))
})

test('two answers at the same moment: one step, one recovery code and one challenge are each used by exactly one', async () => {
  const person = await h.user()
  const { codes } = await enable(h, person)
  const [{ totp_secret: sealed, totp_last_step: last }] = await h.sql('SELECT totp_secret, totp_last_step FROM users WHERE id = ?1', person.id)
  const steps = await Promise.all(Array.from({ length: 4 }, () => consumeStep(h.db, person.id, sealed, last + 1)))
  assert.deepEqual(steps.filter(Boolean).length, 1)
  const hash = createHash('sha256').update(codes[0].replaceAll('-', '')).digest('hex')
  const used = await Promise.all(Array.from({ length: 4 }, () => consumeRecoveryCode(h.db, person.id, hash, Date.now())))
  assert.equal(used.filter(Boolean).length, 1)
  const client = h.client()
  await h.signIn(client, { email: person.email })
  const [challenge] = await h.sql('SELECT id_hash FROM mfa_challenges WHERE user_id = ?1', person.id)
  const taken = await Promise.all(Array.from({ length: 4 }, () => takeChallenge(h.db, challenge.id_hash)))
  assert.equal(taken.filter(Boolean).length, 1)
})

test('a credential change while the challenge waits means no session', async () => {
  const person = await h.user()
  const { secret } = await enable(h, person)
  const client = h.client()
  await h.signIn(client, { email: person.email })
  // Elsewhere, the password changes: the version the first factor verified is no longer the user's.
  await h.sql('UPDATE users SET credential_version = credential_version + 1 WHERE id = ?1', person.id)
  const answer = await client.post(h.url('auth', '/login/mfa'), { code: await freshCode(h, person, secret) })
  assert.equal(answer.status, 409)
  assert.match(answer.text, /Please sign in again/)
  assert.equal(sessionCookie(answer), undefined)
})

test('the challenge cookie is host-only and __Host- in production, and never reaches an app', async () => {
  const person = await production.user()
  const { secret } = await enable(production, person)
  const client = production.client()
  const signedIn = await production.signIn(client, { email: person.email })
  assert.match(mfaCookie(signedIn), /^__Host-insulin_mfa=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/)
  assert.equal((await client.post(production.url('auth', '/login/mfa'), { code: await freshCode(production, person, secret) })).status, 303)

  const member = await h.user()
  await h.org(member.client, 'Cookie Org')
  const url = h.url('captable', '/api/echo')
  const cookie = `${member.client.jar.header(new URL(url))}; insulin_mfa=${'a'.repeat(43)}; __Host-insulin_mfa=${'b'.repeat(43)}; kept=1`
  const echo = JSON.parse((await member.client.get(url, { headers: { Cookie: cookie } })).text)
  assert.equal(echo.cookie, 'kept=1', 'gateway cookies are removed before the app sees the request')
})

test('turning it off needs a code or a recovery code, signs other sessions out, and sign-in no longer asks', async () => {
  const person = await h.user()
  const { codes } = await enable(h, person)
  const elsewhere = h.client()
  await h.signIn(elsewhere, { email: person.email })
  assert.equal((await person.client.post(h.url('auth', '/account/security/disable'), { code: '000000' })).status, 400)
  const off = await person.client.post(h.url('auth', '/account/security/disable'), { code: codes[0] })
  assert.equal(off.status, 303)
  assert.equal(off.location, '/account/security?notice=disabled')
  assert.ok(sessionCookie(off), 'this browser stays signed in')
  const [user] = await h.sql('SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?1', person.id)
  assert.deepEqual(user, { totp_secret: null, totp_enabled_at: null })
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ?1', person.id))[0].n, 0)
  assert.equal((await person.client.get(h.url('auth', '/account'))).status, 200)
  assert.match((await h.waitForMail(person.email, 3)).at(-1).subject, /Two-step sign-in was turned off/)
  const plain = await h.signIn(h.client(), { email: person.email })
  assert.equal(plain.location, h.url('auth', '/'), 'a password alone signs in again')
})

test('without GATEWAY_SECRET_KEY nothing can be turned on, and app codes are refused while recovery codes still work', async () => {
  const person = await keyless.user()
  const page = await keyless.client().get(keyless.url('auth', '/account/security'))
  assert.equal(page.status, 302, 'signed out')
  const security = await person.client.get(keyless.url('auth', '/account/security'))
  assert.match(security.text, /Two-step sign-in isn&#x27;t available on this site right now/)
  assert.doesNotMatch(security.text, /Set up two-step sign-in<\/button>/)
  assert.equal((await person.client.post(keyless.url('auth', '/account/security/setup'), {})).status, 503)

  // An account that turned it on while the site had a key keeps needing it.
  const recovery = 'abcd-efgh-ijkl-mnop'
  await keyless.sql("UPDATE users SET totp_secret = 'v1.AAAAAAAAAAAAAAAA.AAAA', totp_enabled_at = 1 WHERE id = ?1", person.id)
  await keyless.sql('INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (?1, ?2, 1)', person.id, createHash('sha256').update('abcdefghijklmnop').digest('hex'))
  const client = keyless.client()
  const signedIn = await keyless.signIn(client, { email: person.email })
  assert.equal(signedIn.location, keyless.url('auth', '/login/mfa'), 'fail closed: still asked for a code')
  const refused = await client.post(keyless.url('auth', '/login/mfa'), { code: '123456' })
  assert.equal(refused.status, 503)
  assert.match(refused.text, /Codes can&#x27;t be checked right now/)
  assert.equal(sessionCookie(refused), undefined)
  assert.equal((await client.post(keyless.url('auth', '/login/mfa'), { code: recovery })).status, 303)
})

test('deleting the account takes its two-step sign-in rows along', async () => {
  const person = await h.user()
  await enable(h, person)
  const client = h.client()
  await h.signIn(client, { email: person.email })
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM mfa_challenges WHERE user_id = ?1', person.id))[0].n, 1)
  assert.equal((await person.client.post(h.url('auth', '/account/delete'), { confirm: person.email })).status, 200)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ?1', person.id))[0].n, 0)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM mfa_challenges WHERE user_id = ?1', person.id))[0].n, 0)
})

test('the code prompt and the security page are ordinary pages: one h1, labelled fields, no inline script or style', async () => {
  const person = await h.user({ name: 'Mfa Renderer' })
  await enable(h, person)
  const client = h.client()
  await h.signIn(client, { email: person.email, password: PASSWORD })
  for (const page of [await client.get(h.url('auth', '/login/mfa')), await person.client.get(h.url('auth', '/account/security'))]) {
    assert.equal(page.status, 200)
    assert.equal(page.text.match(/<h1[\s>]/g)?.length, 1)
    assert.match(page.text, /<label[^>]*for="field-[a-z-]*code"/)
    assert.doesNotMatch(page.text, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/)
  }
  const menu = await person.client.get(h.url('auth', '/account'))
  assert.match(menu.text, /href="http:\/\/insulinapps\.localhost\/account\/security"/, 'the account menu links Security')
  assert.equal((await h.client().get(h.url('auth', '/login/mfa'))).status, 410, 'no challenge, nothing to answer')
})

test('review: an account without a password turns it on only within ten minutes of signing in', async () => {
  const person = await h.user({ name: 'No Password' })
  await h.sql('UPDATE users SET password_hash = NULL WHERE id = ?1', person.id)
  const page = await person.client.get(h.url('auth', '/account/security'))
  assert.match(page.text, /within ten minutes of signing in/)
  await h.sql('UPDATE sessions SET created_at = ?2 WHERE user_id = ?1', person.id, Date.now() - 11 * 60 * 1000)
  const stale = await person.client.post(h.url('auth', '/account/security/setup'), {})
  assert.equal(stale.status, 403, 'an old session alone sets nothing up')
  assert.match(stale.text, /sign in again/)
  await h.sql('UPDATE sessions SET created_at = ?2 WHERE user_id = ?1', person.id, Date.now())
  assert.equal((await person.client.post(h.url('auth', '/account/security/setup'), {})).status, 303, 'a fresh sign-in is enough')
})

test('review: ten wrong app codes in a row, across sign-ins, pause app codes for an hour; a recovery code still works', async () => {
  const person = await h.user({ name: 'Mfa Guessed' })
  const { secret, codes } = await enable(h, person)
  let client = h.client()
  for (let wrong = 0; wrong < 10; wrong += 1) {
    if (wrong % 5 === 0) {
      client = h.client()
      assert.equal((await h.signIn(client, { email: person.email })).status, 303)
    }
    const answer = await client.post(h.url('auth', '/login/mfa'), { code: '000000' })
    assert.ok([400, 429].includes(answer.status), String(answer.status))
  }
  const [user] = await h.sql('SELECT totp_failures, totp_locked_until FROM users WHERE id = ?1', person.id)
  assert.ok(user.totp_locked_until > Date.now(), 'locked')
  assert.equal(user.totp_failures, 0, 'the count starts again after the lock')
  assert.equal((await h.mails(person.email)).filter((mail) => /Too many wrong sign-in codes/.test(mail.subject)).length, 1, 'told once')
  const next = h.client()
  assert.equal((await h.signIn(next, { email: person.email })).status, 303)
  const refused = await next.post(h.url('auth', '/login/mfa'), { code: await freshCode(h, person, secret) })
  assert.equal(refused.status, 429, 'even a right app code waits out the hour')
  assert.match(refused.text, /paused for an hour/)
  const recovered = await next.post(h.url('auth', '/login/mfa'), { code: codes[0] })
  assert.equal(recovered.status, 303, 'a recovery code still signs in')
  assert.deepEqual((await h.sql('SELECT totp_failures, totp_locked_until FROM users WHERE id = ?1', person.id))[0], { totp_failures: 0, totp_locked_until: null })
})
