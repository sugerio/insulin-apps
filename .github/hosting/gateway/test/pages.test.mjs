// The apex pages (landing, privacy notice, terms of use), shared page furniture, and accessibility basics.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from './helpers/harness.mjs'

let h
let withSupport
before(async () => {
  ;[h, withSupport] = await Promise.all([startGateway(), startGateway({ vars: { SUPPORT_EMAIL: 'Help@Example.test' } })])
})
after(async () => { await Promise.all([h?.close(), withSupport?.close()]) })

const PRIVACY = 'http://insulinapps.localhost/privacy'
const TERMS = 'http://insulinapps.localhost/terms'

test('the landing page presents the hosted apps, with sign-in links, and links the privacy notice and terms', async () => {
  const page = await h.client().get(h.url('apex', '/'))
  assert.equal(page.status, 200)
  assert.match(page.text, /<title>Open-source apps, hosted · Insulin Apps<\/title>/)
  assert.match(page.text, /<h1>Insulin Apps<\/h1>/)
  assert.match(page.text, /<h3>Cap Table<\/h3>[^<]*<\/div><div data-slot="card-description"[^>]*>Equity management for startups\.<\/div>/)
  assert.ok(page.text.includes('href="http://captable.insulinapps.localhost/">Open Cap Table</a>'))
  assert.match(page.text, /href="https:\/\/github\.com\/example\/insulin-apps\/tree\/main\/captable"><svg[^>]*>[\s\S]*?<\/svg>Source<\/a>/)
  assert.match(page.text, /<h3>Ledger<\/h3>[\s\S]*?Not available right now/, 'an app whose Worker is missing')
  assert.ok(page.text.includes(`href="http://insulinapps.localhost/signup?return_to=${encodeURIComponent('http://insulinapps.localhost/')}"`))
  assert.ok(page.text.includes(`href="${PRIVACY}"`))
  assert.ok(page.text.includes(`href="${TERMS}"`))
  assert.match(page.text, /without an uptime guarantee/)
  assert.ok(page.text.includes('href="https://github.com/example/insulin-apps/issues"'), 'contact falls back to the repository issues')
})

test('signed in, / is the home page with the active organization\'s apps, and signs out on its own host', async () => {
  const person = await h.user({ name: 'Landing Person' })
  await h.org(person.client, 'Landing Org')
  const page = await person.client.get(h.url('apex', '/'))
  assert.match(page.text, /<h1>Apps in Landing Org<\/h1>/, "the apps section's title is the page's heading")
  assert.match(page.text, /<h2>Cap Table<\/h2>/, 'an app card right under it')
  // The navigation's organization switcher lists the organizations and creates one: the page doesn't repeat it.
  assert.doesNotMatch(page.text, /Welcome, Landing Person/)
  assert.doesNotMatch(page.text, /<h2>Your organizations<\/h2>/)
  assert.doesNotMatch(page.text, /Make active/)
  const main = /<main\b[\s\S]*<\/main>/.exec(page.text)[0]
  assert.doesNotMatch(main, /Create an organization/, 'only the organization switcher offers it')
  const primary = /<nav aria-label="Primary" id="insulin-nav-primary"[\s\S]*?<\/nav>/.exec(page.text)[0]
  assert.match(primary, /href="http:\/\/insulinapps\.localhost\/orgs\/new">[\s\S]*?Create an organization/)
  assert.equal(page.headers.get('x-robots-tag'), 'noindex', 'the home page is private')
  assert.match(page.text, /<form action="\/logout" method="post">/)
  const out = await person.client.post(h.url('apex', '/logout'), {})
  assert.equal(out.status, 303)
  const after = await person.client.get(h.url('apex', '/'))
  assert.match(after.text, /<title>Open-source apps, hosted · Insulin Apps<\/title>/, 'the landing page again')
})

test('signed in without an organization, / shows one short card: create one, or the invitations waiting', async () => {
  const person = await h.user({ name: 'Orgless Person' })
  const page = await person.client.get(h.url('apex', '/'))
  assert.equal(page.status, 200)
  assert.equal(page.text.match(/<h1[\s>]/g)?.length, 1)
  assert.match(page.text, /<h1>Your apps<\/h1>/)
  assert.match(page.text, /<h2>You&#x27;re not in an organization yet<\/h2>/)
  assert.ok(page.text.includes(`ask someone to invite ${person.email}`))
  assert.match(page.text, /<a [^>]*href="\/orgs\/new">[\s\S]*?Create an organization<\/a>/)
  assert.doesNotMatch(page.text, /See your invitations/, 'no invitations to point to')

  const owner = await h.user()
  const orgId = await h.org(owner.client, 'Inviting Org')
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations`), { email: person.email, role: 'VIEWER' })).status, 303)
  const invited = await person.client.get(h.url('apex', '/'))
  assert.match(invited.text, /Accept one of your invitations below/)
  assert.match(invited.text, /<a [^>]*href="#invitations">See your invitations<\/a>/)
  assert.match(invited.text, /<div data-slot="card" class="[^"]*" id="invitations">/)
  assert.match(invited.text, /<strong>Inviting Org<\/strong>/)
})

test('the privacy notice covers what is collected, why, processors, retention, deletion, children, changes and contact', async () => {
  const page = await h.client().get(h.url('apex', '/privacy'))
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-robots-tag'), null)
  for (const heading of ['What we collect', 'Why we collect it', 'Who processes it', 'What we don&#x27;t do', 'How long we keep it', 'Deleting your data', 'Children', 'Changes to this notice', 'Contact']) {
    assert.ok(page.text.includes(`>${heading}</h2>`), heading)
  }
  for (const fact of ['insulin_session', '__Host-insulin_oauth', 'PBKDF2', 'Google account id', 'Cloudflare Turnstile', 'Cloudflare D1', 'Cloudflare Email Service',
    'IP address', 'invited email|email addresses people invite', 'No ads', 'not reset', 'under 16', 'Delete my account', 'never issued again',
    '__Host-insulin_mfa', '__Host-insulin_sso', 'recovery codes as hashes only', 'identity provider', 'AI agents', 'Service accounts',
    'encrypted and never shown again', 'lasts 30 days', 'DNS-over-HTTPS', 'records its owner domain', 'Requests for more organizations',
    'your name, your email\\s+address, your owner domain', 'the reason you give', 'Insulin Apps support</strong>, only if you ask for more organizations']) {
    assert.match(page.text, new RegExp(fact), fact)
  }
  assert.ok(page.text.includes('href="http://insulinapps.localhost/account"'))
  assert.ok(page.text.includes('href="https://github.com/example/insulin-apps/issues"'))
  assert.match(page.text, /don(?:&#x27;|&#39;|')t post personal data/)
})

test('the terms cover the as-is service, acceptable use, suspension, the MIT license, liability, changes and contact', async () => {
  const page = await h.client().get(h.url('apex', '/terms'))
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-robots-tag'), null)
  for (const fact of ['&quot;as is&quot;', 'no guarantee of uptime', 'Acceptable use', 'invitations to people who don', 'Suspension and removal', 'MIT License',
    'Limitation of liability', 'Changes to these terms', '>Contact</h2>']) {
    assert.ok(page.text.includes(fact), fact)
  }
  assert.doesNotMatch(page.text, /Apache/)
})

test('SUPPORT_EMAIL, when set, is the contact on the landing, privacy and terms pages', async () => {
  for (const path of ['/', '/privacy', '/terms']) {
    const page = await withSupport.client().get(withSupport.url('apex', path))
    assert.ok(page.text.includes('<a href="mailto:help@example.test">help@example.test</a>'), path)
    assert.ok(!page.text.includes('/issues"'), path)
  }
})

test('every page links the privacy notice and terms in its footer; sign-up states the agreement', async () => {
  for (const path of ['/login', '/signup', '/forgot-password', '/resend-verification', '/no-such-page']) {
    const page = await h.client().get(h.url('auth', path))
    assert.ok(page.text.includes(`<a href="${PRIVACY}">Privacy notice</a>`), path)
    assert.ok(page.text.includes(`<a href="${TERMS}">Terms of use</a>`), path)
  }
  const signup = await h.client().get(h.url('auth', '/signup'))
  assert.ok(signup.text.includes(`By creating an account you agree to the <a href="${TERMS}">Terms of use</a> and acknowledge the <a href="${PRIVACY}">Privacy notice</a>.`))
})

test('pages are accessible basics: language, title, labelled fields, a live region, a skip link, dark mode', async () => {
  for (const path of ['/login', '/signup', '/forgot-password']) {
    const page = await h.client().get(h.url('auth', path))
    assert.match(page.text, /<html lang="en">/)
    assert.match(page.text, /<title>[^<]+ · Insulin Apps<\/title>/)
    assert.match(page.text, /<a class="skip" href="#main">Skip to content<\/a>/)
    assert.match(page.text, /aria-live=/)
    const ids = [...page.text.matchAll(/<input\b[^>]*\sid="([^"]+)"/g)].map(([, id]) => id)
    assert.ok(ids.length, `${path}: has fields`)
    for (const id of ids) assert.match(page.text, new RegExp(`<label\\b[^>]*\\sfor="${id}"`), `${path}: label for ${id}`)
  }
  const css = await h.client().get(h.url('auth', '/__insulin/gateway.css'))
  assert.match(css.headers.get('content-type'), /^text\/css/)
  assert.match(css.text, /@media \(prefers-color-scheme: ?dark\)/)
  assert.match(css.text, /:focus-visible/)
})

// The owner retired an old word for this service; it is assembled here so this file passes the same repository grep.
const RETIRED_WORD = new RegExp(['d', 'e', 'm', 'o'].join(''), 'i')

test('nothing the site serves uses the retired wording', async () => {
  const person = await h.user()
  await h.org(person.client, 'Wording Org')
  const pages = [
    await h.client().get(h.url('apex', '/')), await h.client().get(h.url('apex', '/privacy')), await h.client().get(h.url('apex', '/terms')),
    await h.client().get(h.url('auth', '/signup')), await h.client().get(h.url('auth', '/login')),
    await person.client.get(h.url('auth', '/')), await person.client.get(h.url('auth', '/account')),
    await h.client().get(h.url('captable', '/__insulin/bar.js')), await person.client.get(h.url('captable', '/__insulin/me')),
  ]
  for (const page of pages) assert.doesNotMatch(page.text, RETIRED_WORD)
  for (const mail of await h.mails(person.email)) assert.doesNotMatch(`${mail.subject}\n${mail.text}\n${mail.html}`, RETIRED_WORD)
})
