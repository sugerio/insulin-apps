// Every page the gateway renders, signed out and signed in: the server-rendered React document (no inline script or
// style, one <h1>, the favicon links), the top bar for the visitor (sign-in links, the account controls, or neither on
// pages that must not depend on the session), the link to Insulin, the footer, and escaping of user input.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gatewayDir } from './helpers/bundle.mjs'
import { NAVIGATE, TOKENS, startGateway, uniqueEmail } from './helpers/harness.mjs'

let h
let owner
let orgId
before(async () => {
  h = await startGateway()
  owner = await h.user({ name: 'Rendering Owner' })
  orgId = await h.org(owner.client, 'Rendering Org')
})
after(async () => { await h?.close() })

const INSULIN = 'href="https://www.insulin.dev"'

function header(page) {
  const match = /<header\b[\s\S]*?<\/header>/.exec(page.text)
  assert.ok(match, 'a top bar')
  return match[0]
}

/**
 * The shared document. `state` is the top bar's account part: 'in' (organization switcher and account menu), 'out'
 * (Sign in and Create account), or 'none' (pages that must not depend on the session).
 */
function assertPage(page, { status = 200, title, site = 'auth', state, name = 'Rendering Owner' }) {
  const where = `${title} (${state})`
  assert.equal(page.status, status, where)
  // client.raw() answers with Node's plain header object, client.get() with Headers.
  const type = typeof page.headers.get === 'function' ? page.headers.get('content-type') : page.headers['content-type']
  assert.match(type, /^text\/html/, where)
  assert.ok(page.text.startsWith('<!doctype html>\n<html lang="en">'), where)
  assert.ok(page.text.includes(`<title>${title} · Insulin Apps</title>`), `${where}: title`)
  assert.equal(page.text.match(/<h1[\s>]/g)?.length, 1, `${where}: one h1`)
  assert.ok(page.text.includes('<link rel="stylesheet" href="/__insulin/gateway.css"/>'), where)
  assert.ok(page.text.includes('<link rel="icon" href="/__insulin/icon.svg" type="image/svg+xml"/>'), `${where}: SVG favicon`)
  const own = site === 'apex' || site === 'auth'
  assert.equal(page.text.includes('<link rel="icon" href="/favicon.ico" sizes="32x32"/>'), own, `${where}: favicon.ico`)
  assert.equal(page.text.includes('<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>'), own, `${where}: touch icon`)
  assert.doesNotMatch(page.text, /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/, `${where}: no inline script, style or handler`)
  assert.ok(page.text.includes('<a class="skip" href="#main">Skip to content</a>'), where)
  assert.ok(page.text.includes('<main id="main"'), where)

  const top = header(page)
  assert.match(top, /aria-hidden="true" data-slot="insulin-mark"/, `${where}: the mark`)
  assert.match(top, /Built with <\/span>Insulin<\/span>/, `${where}: the Insulin link`)
  assert.ok(top.includes(INSULIN), `${where}: links to Insulin`)
  const signedIn = top.includes(`Account menu for ${name}`)
  const signedOut = top.includes('>Sign in</a>') && top.includes('>Create account</a>')
  assert.deepEqual({ signedIn, signedOut }, { signedIn: state === 'in', signedOut: state === 'out' }, `${where}: top bar`)

  const footer = /<footer\b[\s\S]*?<\/footer>/.exec(page.text)?.[0] ?? ''
  assert.match(footer, /<a href="[^"]+\/privacy">Privacy notice<\/a>/, `${where}: footer`)
  assert.match(footer, /<a href="[^"]+\/terms">Terms of use<\/a>/, `${where}: footer`)
  assert.ok(footer.includes(`<a ${INSULIN}>`), `${where}: footer links to Insulin`)
}

test('the apex pages, signed out and signed in', async () => {
  const anonymous = h.client()
  assertPage(await anonymous.get(h.url('apex', '/')), { site: 'apex', title: 'Open-source apps, hosted', state: 'out' })
  const landing = await owner.client.get(h.url('apex', '/'))
  assertPage(landing, { site: 'apex', title: 'Open-source apps, hosted', state: 'in' })
  assert.match(header(landing), /Rendering Org[\s\S]*?>Owner<\/span>/, 'the switcher shows the active organization and role')
  for (const [path, title] of [['/privacy', 'Privacy notice'], ['/terms', 'Terms of use']]) {
    assertPage(await anonymous.get(h.url('apex', path)), { site: 'apex', title, state: 'none' })
    assertPage(await owner.client.get(h.url('apex', path)), { site: 'apex', title, state: 'none' })
  }
  for (const client of [anonymous, owner.client]) {
    assertPage(await client.get(h.url('apex', '/no-such-page')), { site: 'apex', status: 404, title: 'Page not found', state: 'none' })
  }
})

test('the auth forms render signed out; signed in, sign-in and sign-up send the person home', async () => {
  const anonymous = h.client()
  for (const [path, title] of [['/login', 'Sign in'], ['/signup', 'Create an account'], ['/forgot-password', 'Forgot your password'], ['/resend-verification', 'Resend confirmation']]) {
    const page = await anonymous.get(h.url('auth', path))
    assertPage(page, { title, state: 'none' })
    assert.match(page.text, /<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async="" defer=""><\/script>/, path)
    assert.match(page.text, /<button data-slot="button" data-variant="default" data-size="default" class="[^"]*w-full[^"]*" type="submit">/, `${path}: a full-width primary button`)
  }
  for (const path of ['/login', '/signup']) {
    const page = await owner.client.get(h.url('auth', path))
    assert.equal(page.status, 302, path)
    assert.equal(page.location, h.url('auth', '/'))
  }
  for (const [path, title] of [['/forgot-password', 'Forgot your password'], ['/resend-verification', 'Resend confirmation']]) {
    assertPage(await owner.client.get(h.url('auth', path)), { title, state: 'none' })
  }
})

test('the signed-in pages render with the account controls, and send the signed-out to sign in', async () => {
  const pages = [['/', 'Your organizations'], ['/account', 'Account'], ['/orgs/new', 'Create an organization'], [`/orgs/${orgId}`, 'Rendering Org']]
  for (const [path, title] of pages) {
    const page = await owner.client.get(h.url('auth', path))
    assertPage(page, { title, state: 'in' })
    assert.match(page.text, /<form action="\/logout" method="post">/, `${path}: sign-out posts to the auth host's own route`)
    const away = await h.client().get(h.url('auth', path))
    assert.equal(away.status, 302, path)
    assert.equal(away.location, h.url('auth', `/login?return_to=${encodeURIComponent(h.url('auth', path))}`))
  }
  const home = await owner.client.get(h.url('auth', '/'))
  assert.match(header(home), new RegExp(`<a class="[^"]*" href="http://auth\\.insulinapps\\.localhost/orgs/${orgId}">`), 'Manage members')
  assert.equal(header(home).match(/<details data-slot="menu" class="[^"]*" name="top-bar">/g)?.length, 2, 'two exclusive <details> menus')
})

test('the invitation page in each state', async () => {
  const invitee = await h.user({ name: 'Rendering Invitee' })
  const invited = await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations`), { email: invitee.email, role: 'EDITOR' })
  assert.equal(invited.status, 303)
  const link = await h.link(invitee.email, '/invitations/')
  assertPage(await h.client().get(link), { title: 'Invitation', state: 'out' })
  assertPage(await invitee.client.get(link), { title: 'Invitation', state: 'in', name: 'Rendering Invitee' })
  const stranger = await h.user({ name: 'Rendering Stranger' })
  assertPage(await stranger.client.get(link), { status: 403, title: 'Invitation', state: 'in', name: 'Rendering Stranger' })
  const id = new URL(link).pathname.split('/').pop()
  assert.equal((await owner.client.post(h.url('auth', `/orgs/${orgId}/invitations/${id}/revoke`), {})).status, 303)
  assertPage(await invitee.client.get(link), { status: 410, title: 'Invitation', state: 'in', name: 'Rendering Invitee' })
  assertPage(await h.client().get(link), { status: 410, title: 'Invitation', state: 'out' })
})

test('the e-mail link pages, the form results and the error pages', async () => {
  const email = uniqueEmail('rendering')
  const client = h.client()
  assertPage(await h.signUp(client, { email }), { title: 'Check your inbox', state: 'none' })
  assertPage(await h.signIn(h.client(), { email }), { status: 403, title: 'Confirm your email first', state: 'none' })
  const verify = await h.link(email, '/verify-email')
  assertPage(await client.get(verify), { title: 'Confirm your email', state: 'none' })
  assertPage(await client.get(h.url('auth', '/verify-email?token=nope')), { status: 400, title: 'Link expired', state: 'none' })
  assertPage(await client.get(h.url('auth', '/reset-password?token=nope')), { status: 400, title: 'Link expired', state: 'none' })
  await h.confirm(client, email)

  const forgot = await h.client().post(h.url('auth', '/forgot-password'), { email, 'cf-turnstile-response': TOKENS.forgot })
  assertPage(forgot, { title: 'Check your inbox', state: 'none' })
  const reset = await h.link(email, '/reset-password')
  assertPage(await h.client().get(reset), { title: 'Choose a new password', state: 'none' })
  const resend = await h.client().post(h.url('auth', '/resend-verification'), { email, 'cf-turnstile-response': TOKENS.resend })
  assertPage(resend, { title: 'Check your inbox', state: 'none' })

  // A sign-in that returns to another host continues with a page; its link and meta refresh carry the destination.
  const back = await h.signIn(h.client(), { email, returnTo: h.url('apex', '/') })
  assertPage(back, { title: 'Continue', state: 'none' })
  assert.match(back.text, /<meta http-equiv="refresh" content="0; url=http:\/\/insulinapps\.localhost\/"\/>/)

  assertPage(await h.client().get(h.url('auth', '/logout')), { status: 405, title: 'Not allowed', state: 'none' })
  assertPage(await h.client().post(h.url('auth', '/login'), {}, { origin: 'http://evil.example' }), { status: 403, title: 'Request blocked', state: 'none' })
  assertPage(await h.client().post(h.url('auth', '/login'), {}, { contentType: 'application/json', body: '{}' }), {
    status: 415, title: 'Something is wrong with that request', state: 'none',
  })
  assertPage(await h.client().get(h.url('auth', '/__insulin/dev/mail')), { title: 'Captured mail', state: 'none' })
  assertPage(await owner.client.raw(h.url('ledger', '/'), { headers: NAVIGATE }), {
    site: 'app', status: 503, title: 'This app is not available right now', state: 'none',
  })

  const leaving = await h.user({ name: 'Rendering Leaver' })
  const deleted = await leaving.client.post(h.url('auth', '/account/delete'), { confirm: leaving.email })
  assertPage(deleted, { title: 'Account deleted', state: 'out', name: 'Rendering Leaver' })
})

test('a message page for a signed-in person keeps the account controls', async () => {
  const viewer = await h.user({ name: 'Rendering Viewer' })
  await h.join(owner, orgId, viewer, 'VIEWER')
  const refused = await viewer.client.post(h.url('auth', `/orgs/${orgId}/rename`), { name: 'Nope' })
  assertPage(refused, { status: 403, title: 'Not allowed', state: 'in', name: 'Rendering Viewer' })
  assert.match(refused.text, /Your role in this organization doesn&#x27;t allow that\./)
})

test('names and organization names are escaped wherever they appear', async () => {
  const name = `<img src=x onerror="alert('n')"> & Co`
  const person = await h.user({ name })
  const evilOrg = `"><script>alert(1)</script>`
  const id = await h.org(person.client, evilOrg)
  for (const href of [h.url('apex', '/'), h.url('auth', '/'), h.url('auth', `/orgs/${id}`), h.url('auth', '/account')]) {
    const page = await person.client.get(href)
    assert.equal(page.status, 200, href)
    assert.ok(!page.text.includes('<img src=x'), `${href}: the name is escaped`)
    assert.ok(!page.text.includes('<script>alert(1)'), `${href}: the organization name is escaped`)
    assert.ok(page.text.includes('&lt;img src=x onerror=&quot;alert(&#x27;n&#x27;)&quot;&gt; &amp; Co'), href)
    assert.ok(page.text.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'), href)
  }
})

test('the page code never writes raw HTML', async () => {
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path)
    }
  }
  await walk(join(gatewayDir, 'src'))
  assert.ok(files.length > 20)
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(source, /dangerouslySetInnerHTML\s*[=:]|\b__html\b/, file)
  }
})

test('the landing page lays out the apps as cards and the steps as three feature cards', async () => {
  const page = await h.client().get(h.url('apex', '/'))
  assert.match(page.text, /<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">/, 'a responsive grid of app cards')
  assert.equal(page.text.match(/data-slot="card"/g)?.length, 2 + 3, 'two app cards and three feature cards')
  for (const feature of ['One organization for every app', 'Roles from Owner to Viewer', 'Open source on Cloudflare']) {
    assert.ok(page.text.includes(`<h3>${feature}</h3>`), feature)
  }
})
