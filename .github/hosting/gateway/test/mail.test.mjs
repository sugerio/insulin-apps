// The production mail transport: the Email Service binding (a stub here), its failures, and the capture table kept
// for SITE_ENV=test only.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { TOKENS, startGateway, uniqueEmail } from './helpers/harness.mjs'

let h
before(async () => { h = await startGateway({ mode: 'production' }) })
after(async () => { await h?.close() })

test('production sends through the EMAIL binding with the configured sender, and captures nothing', async () => {
  const email = uniqueEmail('sent')
  const page = await h.signUp(h.client(), { name: 'Mail Person', email })
  assert.equal(page.status, 200)
  const [mail] = await h.waitForMail(email)
  assert.deepEqual(mail.from, { email: 'no-reply@example.test', name: 'Insulin Apps' })
  assert.equal(mail.to, email)
  assert.match(mail.subject, /^Confirm your email for Insulin Apps$/)
  assert.match(mail.text, /https:\/\/auth\.example\.test\/verify-email\?token=[A-Za-z0-9_-]{43}/)
  assert.match(mail.html, /<a href="https:\/\/auth\.example\.test\/verify-email\?token=/)
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM mail_capture'))[0].n, 0)
})

test('a failed send shows "couldn\'t send the email right now", logs only the code, and lets the person try again', async () => {
  const email = uniqueEmail('failing')
  await h.failMail('E_SENDER_NOT_VERIFIED')
  try {
    const page = await h.signUp(h.client(), { email })
    assert.equal(page.status, 503)
    assert.match(page.text, /couldn(?:&#x27;|&#39;|')t send the email right now/)
    assert.equal((await h.sql('SELECT COUNT(*) AS n FROM users WHERE email = ?1', email))[0].n, 0, 'the half-made account is gone')
    assert.match(h.logText(), /"event":"mail_failed","kind":"verify_email","code":"E_SENDER_NOT_VERIFIED"/)
    assert.ok(!h.logText().includes(email))

    const forgot = await h.client().post(h.url('auth', '/forgot-password'), { email: uniqueEmail('nobody'), 'cf-turnstile-response': TOKENS.forgot })
    const forgotKnown = await h.client().post(h.url('auth', '/forgot-password'), { email: (await h.sql('SELECT email FROM users LIMIT 1'))[0].email, 'cf-turnstile-response': TOKENS.forgot })
    assert.equal(forgotKnown.status, 200)
    assert.equal(forgotKnown.text, forgot.text, 'a failure never reveals which addresses have accounts')
  } finally {
    await h.failMail(null)
  }
  assert.equal((await h.signUp(h.client(), { email })).status, 200, 'trying again works')
  await h.waitForMail(email)
})

test('a failed invitation email is reported and leaves no pending invitation', async () => {
  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Mail Fail Org')
  const email = uniqueEmail('invite-fail')
  await h.failMail('E_RATE_LIMIT_EXCEEDED')
  try {
    const response = await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations`), { email, role: 'USER' })
    assert.equal(response.status, 503)
    assert.match(response.text, /couldn(?:&#x27;|&#39;|')t send the email right now/)
  } finally {
    await h.failMail(null)
  }
  assert.equal((await h.sql('SELECT COUNT(*) AS n FROM invitations WHERE email = ?1', email))[0].n, 0)
  assert.match(h.logText(), /"code":"E_RATE_LIMIT_EXCEEDED"/)
})

test('review 3: a reset request whose email fails leaves the earlier reset link working', async () => {
  const { email } = await h.user()
  await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot })
  const first = new URL(await h.link(email, '/reset-password')).searchParams.get('token')
  await h.failMail('E_RATE_LIMIT_EXCEEDED')
  try {
    await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot })
    await new Promise((accept) => setTimeout(accept, 300))
  } finally {
    await h.failMail(null)
  }
  const unused = await h.sql("SELECT COUNT(*) AS n FROM email_tokens WHERE email = ?1 AND purpose = 'reset_password' AND used_at IS NULL", email)
  assert.equal(unused[0].n, 1, 'the failed request\'s staged token is gone')
  const reset = await h.client().post(h.url('auth', '/reset-password'), { token: first, password: 'still recoverable' })
  assert.equal(reset.status, 303)
})
