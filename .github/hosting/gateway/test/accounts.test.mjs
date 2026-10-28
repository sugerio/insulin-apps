// E-mail and password accounts (SITE_ENV=test: the capture transport stores mail in D1).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { PASSWORD, TOKENS, UUID, startGateway, uniqueEmail } from './helpers/harness.mjs'

let h
before(async () => { h = await startGateway() })
after(async () => { await h?.close() })

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const h1 = (page) => page.text.match(/<h1>([\s\S]*?)<\/h1>/)?.[1]
const sessionCookie = (response) => response.cookies.find((cookie) => cookie.startsWith('insulin_session='))

async function userRow(email) {
  const [row] = await h.sql('SELECT * FROM users WHERE email = ?1', email)
  return row
}

test('sign-up creates an unconfirmed account, emails a confirmation link, and never signs in', async () => {
  const client = h.client()
  const email = uniqueEmail('new')
  const page = await h.signUp(client, { name: 'Ada Example', email: email.toUpperCase() })
  assert.equal(page.status, 200)
  assert.equal(h1(page), 'Check your inbox')
  assert.equal(sessionCookie(page), undefined, 'no session')
  const user = await userRow(email)
  assert.equal(user.name, 'Ada Example')
  assert.equal(user.email_verified_at, null)
  assert.match(user.password_hash, /^pbkdf2_sha256\$100000\$/)
  const [mail] = await h.waitForMail(email)
  assert.match(mail.subject, /Confirm your email/)
  const link = await h.link(email, '/verify-email')
  const token = new URL(link).searchParams.get('token')
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  const [stored] = await h.sql('SELECT token_hash, purpose, expires_at - created_at AS ttl FROM email_tokens WHERE user_id = ?1', user.id)
  assert.equal(stored.token_hash, sha256(token), 'only the SHA-256 is stored')
  assert.equal(stored.purpose, 'verify_email')
  assert.equal(stored.ttl, 24 * 60 * 60 * 1000)
  assert.match(mail.html, /Confirm my email/)
})

test('sign-up with an existing address answers the same, emails the owner, and changes nothing', async () => {
  const email = uniqueEmail('taken')
  const first = await h.signUp(h.client(), { email })
  const before = await userRow(email)
  const second = await h.signUp(h.client(), { email, password: 'a different password' })
  assert.equal(second.status, first.status)
  assert.equal(h1(second), h1(first))
  assert.equal(second.text.replaceAll(email, ''), first.text.replaceAll(email, ''), 'identical page')
  assert.equal(sessionCookie(second), undefined)
  const after = await userRow(email)
  assert.equal(after.password_hash, before.password_hash, 'password unchanged')
  const mails = await h.waitForMail(email, 2)
  assert.match(mails[1].subject, /Someone tried to sign up/)
  assert.match(mails[1].text, /\/login/)
  assert.match(mails[1].text, /\/forgot-password/)
  assert.doesNotMatch(mails[1].text, /verify-email/, 'no confirmation link for an account someone else may have created')
})

test('sign-up checks its fields before anything else happens', async () => {
  const email = uniqueEmail('invalid')
  const page = await h.client().post(h.url('auth', '/signup'), { name: ' ', email, password: 'short', 'cf-turnstile-response': TOKENS.signup })
  assert.equal(page.status, 400)
  assert.match(page.text, /role="alert"/)
  assert.match(page.text, /Enter your name/)
  assert.match(page.text, /at least 10 characters/)
  assert.match(page.text, /id="field-password"[^>]*aria-invalid="true"/)
  assert.equal(await userRow(email), undefined)
  const bad = await h.client().post(h.url('auth', '/signup'), { name: 'X', email: 'not-an-email', password: PASSWORD, 'cf-turnstile-response': TOKENS.signup })
  assert.equal(bad.status, 400)
  assert.match(bad.text, /Enter a valid email address/)
})

test('sign-up needs a valid Turnstile token', async () => {
  const email = uniqueEmail('bot')
  const before = h.outbound.to('https://challenges.cloudflare.com').length
  const rejected = await h.signUp(h.client(), { email, turnstile: 'wrong-token' })
  assert.equal(rejected.status, 400)
  assert.match(rejected.text, /security check/)
  assert.equal(await userRow(email), undefined)
  assert.equal(h.outbound.to('https://challenges.cloudflare.com').length, before + 1)
  const missing = await h.client().post(h.url('auth', '/signup'), { name: 'X', email, password: PASSWORD })
  assert.equal(missing.status, 400)
  assert.equal(h.outbound.to('https://challenges.cloudflare.com').length, before + 1, 'no siteverify call without a token')
  const call = h.outbound.to('https://challenges.cloudflare.com').at(-1)
  assert.equal(call.params.get('secret'), 'test-turnstile-secret')
  assert.ok(call.params.get('remoteip'), 'the client IP is sent')
})

test('a confirmation link: GET never consumes it, POST confirms and signs in, a second use fails', async () => {
  const client = h.client()
  const email = uniqueEmail('confirm')
  await h.signUp(client, { email })
  const link = await h.link(email, '/verify-email')
  for (let i = 0; i < 2; i += 1) {
    const page = await client.get(link)
    assert.equal(page.status, 200)
    assert.match(page.text, /Confirm my email/)
    assert.equal(sessionCookie(page), undefined)
  }
  assert.equal((await userRow(email)).email_verified_at, null, 'GET changed nothing')
  const token = new URL(link).searchParams.get('token')
  const confirmed = await client.post(h.url('auth', '/verify-email'), { token })
  assert.equal(confirmed.status, 303)
  assert.equal(confirmed.location, h.url('auth', '/?notice=verified'))
  const cookie = sessionCookie(confirmed)
  assert.match(cookie, /^insulin_session=[A-Za-z0-9_-]{43}; Domain=insulinapps\.localhost; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/)
  assert.ok((await userRow(email)).email_verified_at > 0)
  const [session] = await h.sql('SELECT id_hash FROM sessions WHERE user_id = ?1', (await userRow(email)).id)
  assert.equal(session.id_hash, sha256(client.jar.get('insulin_session').value), 'only the SHA-256 of the session is stored')

  const again = await h.client().post(h.url('auth', '/verify-email'), { token })
  assert.equal(again.status, 400)
  assert.match(again.text, /expired or was already used/)
  assert.equal((await h.client().get(link)).status, 400)
})

test('an expired confirmation link fails, and a new link replaces the old one', async () => {
  const client = h.client()
  const email = uniqueEmail('expired')
  await h.signUp(client, { email })
  const firstLink = await h.link(email, '/verify-email')
  await h.sql('UPDATE email_tokens SET expires_at = ?1 WHERE email = ?2', Date.now() - 1, email)
  assert.equal((await client.get(firstLink)).status, 400)
  await h.sql('UPDATE email_tokens SET expires_at = ?1 WHERE email = ?2', Date.now() + 60_000, email)
  await client.post(h.url('auth', '/resend-verification'), { email, 'cf-turnstile-response': TOKENS.resend })
  const secondLink = await h.link(email, '/verify-email', 2)
  assert.notEqual(secondLink, firstLink)
  const old = await client.post(h.url('auth', '/verify-email'), { token: new URL(firstLink).searchParams.get('token') })
  assert.equal(old.status, 400, 'the older link stopped working')
  const fresh = await client.post(h.url('auth', '/verify-email'), { token: new URL(secondLink).searchParams.get('token') })
  assert.equal(fresh.status, 303)
})

test('sign-in errors are generic, and an unconfirmed account is told to confirm only with the right password', async () => {
  const { email } = await h.user()
  const wrong = await h.signIn(h.client(), { email, password: 'not the password' })
  const unknown = await h.signIn(h.client(), { email: uniqueEmail('nobody'), password: 'not the password' })
  for (const page of [wrong, unknown]) {
    assert.equal(page.status, 401)
    assert.match(page.text, /Email or password is incorrect/)
    assert.equal(sessionCookie(page), undefined)
  }
  const pending = uniqueEmail('pending')
  await h.signUp(h.client(), { email: pending })
  const unconfirmedWrong = await h.signIn(h.client(), { email: pending, password: 'not the password' })
  assert.equal(unconfirmedWrong.status, 401, 'nothing about the account without its password')
  const unconfirmed = await h.signIn(h.client(), { email: pending })
  assert.equal(unconfirmed.status, 403)
  assert.equal(h1(unconfirmed), 'Confirm your email first')
  assert.match(unconfirmed.text, /action="\/resend-verification"/)
  assert.equal(sessionCookie(unconfirmed), undefined)
})

test('signing in creates a new session and never adopts the one the browser brought', async () => {
  const { email, client: first } = await h.user()
  const client = h.client()
  const planted = 'p'.repeat(43)
  client.jar.store(new URL(h.url('auth')), [`insulin_session=${planted}; Domain=${h.domain}; Path=/`])
  const page = await h.signIn(client, { email, returnTo: h.url('captable', '/companies') })
  assert.equal(page.status, 200, 'a cross-origin destination continues through a page')
  assert.match(page.text, /http-equiv="refresh" content="0; url=http:\/\/captable\.insulinapps\.localhost\/companies"/)
  const value = client.jar.get('insulin_session').value
  assert.notEqual(value, planted)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?1', sha256(planted)))[0].n, 0)
  assert.equal((await first.get(h.url('auth', '/'))).status, 200, 'other sessions are unaffected')
  const same = await h.signIn(h.client(), { email, returnTo: h.url('auth', '/account') })
  assert.equal(same.status, 303, 'a same-origin destination is a plain redirect')
  assert.equal(same.location, h.url('auth', '/account'))
})

test('signing out deletes the session and clears the cookie with the same Domain and Path', async () => {
  const { client, id } = await h.user()
  const before = (await h.sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1', id))[0].n
  const out = await client.post(h.url('auth', '/logout'), {})
  assert.equal(out.status, 303)
  assert.equal(out.location, '/login?signed_out=1')
  assert.equal(sessionCookie(out), 'insulin_session=; Domain=insulinapps.localhost; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1', id))[0].n, before - 1)
  const home = await client.get(h.url('auth', '/'))
  assert.equal(home.status, 302)
  assert.match(home.location, /\/login\?return_to=/)
})

test('resend gives the same answer for every address and only emails accounts that need it', async () => {
  const pending = uniqueEmail('resend-pending')
  await h.signUp(h.client(), { email: pending })
  const { email: confirmed } = await h.user()
  const nobody = uniqueEmail('resend-nobody')
  const pages = []
  for (const email of [pending, confirmed, nobody]) {
    pages.push(await h.client().post(h.url('auth', '/resend-verification'), { email, 'cf-turnstile-response': TOKENS.resend }))
  }
  for (const page of pages) {
    assert.equal(page.status, 200)
    assert.equal(page.text, pages[0].text)
  }
  await h.waitForMail(pending, 2)
  await new Promise((accept) => setTimeout(accept, 200))
  assert.equal((await h.mails(confirmed)).length, 1, 'only the original confirmation')
  assert.equal((await h.mails(nobody)).length, 0)
})

test('forgot password answers the same and resets: confirms the address, signs out everywhere, signs in afresh', async () => {
  const { email, client: elsewhere, id } = await h.user()
  const nobody = uniqueEmail('forgot-nobody')
  const known = await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot })
  const unknown = await h.client().post(h.url('auth', '/forgot-password'), { email: nobody, 'cf-turnstile-response': TOKENS.forgot })
  assert.equal(known.status, 200)
  assert.equal(known.text, unknown.text)
  const link = await h.link(email, '/reset-password')
  await new Promise((accept) => setTimeout(accept, 200))
  assert.equal((await h.mails(nobody)).length, 0)
  const [token] = await h.sql("SELECT expires_at - created_at AS ttl FROM email_tokens WHERE user_id = ?1 AND purpose = 'reset_password'", id)
  assert.equal(token.ttl, 60 * 60 * 1000, 'reset links last one hour')

  const client = h.client()
  const form = await client.get(link)
  assert.equal(form.status, 200)
  assert.match(form.text, /Choose a new password/)
  const tokenValue = new URL(link).searchParams.get('token')
  const short = await client.post(h.url('auth', '/reset-password'), { token: tokenValue, password: 'short' })
  assert.equal(short.status, 400)
  assert.match(short.text, /at least 10 characters/)
  const reset = await client.post(h.url('auth', '/reset-password'), { token: tokenValue, password: 'a brand new password' })
  assert.equal(reset.status, 303)
  assert.equal(reset.location, h.url('auth', '/?notice=password-set'))
  assert.ok(sessionCookie(reset))
  const home = await elsewhere.get(h.url('auth', '/'))
  assert.equal(home.status, 302, 'every older session was revoked')
  assert.equal((await client.get(h.url('auth', '/'))).status, 200)
  assert.equal((await h.signIn(h.client(), { email })).status, 401, 'the old password stopped working')
  assert.equal((await h.signIn(h.client(), { email, password: 'a brand new password' })).status, 303)
  assert.equal((await h.client().post(h.url('auth', '/reset-password'), { token: tokenValue, password: 'yet another password' })).status, 400, 'single use')
})

test('a reset link expires after its hour, and a reset confirms an unconfirmed address', async () => {
  const email = uniqueEmail('reset-unconfirmed')
  await h.signUp(h.client(), { email })
  await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot })
  const expired = new URL(await h.link(email, '/reset-password')).searchParams.get('token')
  await h.sql("UPDATE email_tokens SET expires_at = ?1 WHERE email = ?2 AND purpose = 'reset_password'", Date.now() - 1, email)
  assert.equal((await h.client().post(h.url('auth', '/reset-password'), { token: expired, password: 'a brand new password' })).status, 400)
  await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot })
  const fresh = new URL(await h.link(email, '/reset-password', 3)).searchParams.get('token')
  const reset = await h.client().post(h.url('auth', '/reset-password'), { token: fresh, password: 'a brand new password' })
  assert.equal(reset.status, 303)
  assert.ok((await userRow(email)).email_verified_at > 0, 'the inbox is proven')
})

test('a Google-only account can set a first password, by reset or on the account page', async () => {
  const email = uniqueEmail('google-only')
  const now = Date.now()
  await h.sql("INSERT INTO users (id, email, name, password_hash, email_verified_at, google_sub, created_at, updated_at) VALUES (?1, ?2, 'Gee', NULL, ?3, 'google-sub-1', ?3, ?3)", randomUUID(), email, now)
  assert.equal((await h.signIn(h.client(), { email, password: 'whatever password' })).status, 401)
  await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot })
  const link = await h.link(email, '/reset-password')
  const client = h.client()
  await client.post(h.url('auth', '/reset-password'), { token: new URL(link).searchParams.get('token'), password: 'first password ever' })
  assert.equal((await h.signIn(h.client(), { email, password: 'first password ever' })).status, 303)
  await h.sql("UPDATE users SET password_hash = NULL WHERE email = ?1", email)
  const account = await client.get(h.url('auth', '/account'))
  assert.match(account.text, /Set a password/)
  assert.doesNotMatch(account.text, /current_password/)
  const set = await client.post(h.url('auth', '/account/password'), { password: 'second first password' })
  assert.equal(set.status, 303)
  assert.equal((await h.signIn(h.client(), { email, password: 'second first password' })).status, 303)
})

test('the account page renames, and changing the password needs the current one and signs out other sessions', async () => {
  const { client, email } = await h.user({ name: 'Old Name' })
  const other = h.client()
  await h.signIn(other, { email })
  const renamed = await client.post(h.url('auth', '/account/name'), { name: '  New\u0007 Name  ' })
  assert.equal(renamed.status, 303)
  assert.equal((await userRow(email)).name, 'New Name')
  const wrong = await client.post(h.url('auth', '/account/password'), { current_password: 'not it at all', password: 'another password' })
  assert.equal(wrong.status, 400)
  assert.match(wrong.text, /current password is incorrect/)
  const changed = await client.post(h.url('auth', '/account/password'), { current_password: PASSWORD, password: 'another password' })
  assert.equal(changed.status, 303)
  assert.equal((await client.get(h.url('auth', '/account'))).status, 200, 'this session stays')
  assert.equal((await other.get(h.url('auth', '/account'))).status, 302, 'the other session ended')
})

test('deleting an account needs the address typed, is blocked for a last owner with members, and takes solo organizations along', async () => {
  const owner = await h.user()
  const member = await h.user()
  const shared = await h.org(owner.client, 'Shared Org')
  const solo = await h.org(owner.client, 'Solo Org')
  await h.join(owner, shared, member, 'EDITOR')

  const mistyped = await owner.client.post(h.url('auth', '/account/delete'), { confirm: 'someone@example.test' })
  assert.equal(mistyped.status, 400)
  const blocked = await owner.client.post(h.url('auth', '/account/delete'), { confirm: owner.email })
  assert.equal(blocked.status, 409)
  assert.match(blocked.text, new RegExp(`only owner of <a href="/orgs/${UUID}">Shared Org</a>`))
  assert.ok(await userRow(owner.email))

  await owner.client.post(h.url('auth', `/orgs/${shared}/members/${member.id}/role`), { role: 'OWNER' })
  const deleted = await owner.client.post(h.url('auth', '/account/delete'), { confirm: owner.email.toUpperCase() })
  assert.equal(deleted.status, 200)
  assert.match(deleted.text, /Your account was deleted/)
  assert.ok(sessionCookie(deleted).includes('Max-Age=0'))
  assert.equal(await userRow(owner.email), undefined)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM orgs WHERE id = ?1', solo))[0].n, 0, 'the solo organization went too')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM orgs WHERE id = ?1', shared))[0].n, 1, 'the shared one stays with its new owner')
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1', owner.id))[0].n, 0)
})

test('sessions slide: at most one write an hour, and an expired session counts as signed out', async () => {
  const { client, id } = await h.user()
  const [fresh] = await h.sql('SELECT last_seen_at, expires_at FROM sessions WHERE user_id = ?1', id)
  const quiet = await client.get(h.url('auth', '/'))
  assert.equal(sessionCookie(quiet), undefined, 'no refresh within the hour')
  assert.deepEqual((await h.sql('SELECT last_seen_at, expires_at FROM sessions WHERE user_id = ?1', id))[0], fresh)

  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  await h.sql('UPDATE sessions SET last_seen_at = ?1, expires_at = ?2 WHERE user_id = ?3', twoHoursAgo, Date.now() + 60_000, id)
  const touched = await client.get(h.url('auth', '/'))
  assert.match(sessionCookie(touched), /Max-Age=2592000/)
  const [slid] = await h.sql('SELECT last_seen_at, expires_at FROM sessions WHERE user_id = ?1', id)
  assert.ok(slid.last_seen_at > twoHoursAgo)
  assert.ok(slid.expires_at > Date.now() + 29 * 24 * 60 * 60 * 1000)

  await h.sql('UPDATE sessions SET expires_at = ?1 WHERE user_id = ?2', Date.now() - 1, id)
  assert.equal((await client.get(h.url('auth', '/'))).status, 302)
})

test('review 3: flooding resend requests past the email cap never invalidates the link already delivered', async () => {
  const email = uniqueEmail('flood-verify')
  await h.signUp(h.client(), { email })
  const resend = () => h.client().post(h.url('auth', '/resend-verification'), { email, 'cf-turnstile-response': TOKENS.resend })
  for (let i = 0; i < 4; i += 1) {
    await resend()
    await h.waitForMail(email, i + 2)
  }
  const delivered = new URL(await h.link(email, '/verify-email', 5)).searchParams.get('token')
  // The recipient cap (5 an hour) is reached: these requests get no e-mail, and must not replace the delivered link.
  for (let i = 0; i < 3; i += 1) await resend()
  await new Promise((accept) => setTimeout(accept, 300))
  assert.equal((await h.mails(email)).length, 5)
  const unused = await h.sql("SELECT token_hash FROM email_tokens WHERE email = ?1 AND purpose = 'verify_email' AND used_at IS NULL", email)
  assert.deepEqual(unused.map((row) => row.token_hash), [sha256(delivered)], 'the staged tokens of capped requests were dropped')
  const confirmed = await h.client().post(h.url('auth', '/verify-email'), { token: delivered })
  assert.equal(confirmed.status, 303, 'the delivered link still works')
})

test('review 3: flooding reset requests past the email cap never invalidates the reset link already delivered', async () => {
  const { email } = await h.user()
  const forgot = () => h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot })
  for (let i = 0; i < 4; i += 1) {
    await forgot()
    await h.waitForMail(email, i + 2)
  }
  const delivered = new URL(await h.link(email, '/reset-password', 5)).searchParams.get('token')
  for (let i = 0; i < 3; i += 1) await forgot()
  await new Promise((accept) => setTimeout(accept, 300))
  assert.equal((await h.mails(email)).length, 5)
  const reset = await h.client().post(h.url('auth', '/reset-password'), { token: delivered, password: 'recovered at last' })
  assert.equal(reset.status, 303, 'the delivered reset link still works')
  assert.equal((await h.signIn(h.client(), { email, password: 'recovered at last' })).status, 303)
})
