// The two-level navigation of the gateway's signed-in pages (DESIGN.md §3.2): level 1 for the organization's pages as
// each role sees it, an app's own level 1 (from its manifest) on its settings pages, level 2, the breadcrumb, the
// collapse toggles and the `insulin_nav` cookie they set (same host only), and the narrow-screen drawer. The account
// bar's side (it stays away from a page with the navigation) is in bar.test.mjs.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { APPS, startGateway } from './helpers/harness.mjs'
import { parseNavCookie } from '../src/navigation.ts'

/** Cap Table with a navigation manifest: an item for every role, one for editors, one for admins and one for viewers only, in groups. */
const NAVIGATION = [
  { key: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', path: '/' },
  { key: 'stakeholders', label: 'Stakeholders', icon: 'users', path: '/stakeholders', group: 'Equity', children: [
    { key: 'founders', label: 'Founders', icon: 'user', path: '/stakeholders?type=founder' },
  ] },
  { key: 'grants', label: 'Grants', icon: 'award', path: '/grants?status=active', group: 'Equity', role: 'EDITOR' },
  { key: 'audit', label: 'Audit log', icon: 'history', path: '/audit', group: 'Admin', role: 'ADMIN' },
  { key: 'mine', label: 'My holdings', icon: 'chart-pie', path: '/portfolio', group: 'Mine', maxRole: 'VIEWER' },
]

let h
let owner
let orgId
const people = {}
before(async () => {
  h = await startGateway({ apps: [{ ...APPS[0], navigation: NAVIGATION }, APPS[1]] })
  owner = await h.user({ name: 'Nadia Owner' })
  orgId = await h.org(owner.client, 'Navigation Org')
  people.admin = await member('Ari Admin', 'ADMIN')
  people.editor = await member('Eve Editor', 'EDITOR')
  people.viewer = await member('Val Viewer', 'VIEWER')
  people.appViewer = await member('Pia App-Viewer', 'APPS', { captable: 'VIEWER' })
  people.appEditor = await member('Ed App-Editor', 'APPS', { captable: 'EDITOR' })
  people.ledgerOnly = await member('Lou Ledger-Only', 'APPS', { ledger: 'ADMIN' })
})
after(async () => { await h?.close() })

/** Adds a signed-up user to the organization directly (the invitation flow has its own tests). */
async function member(name, role, grants = {}) {
  const person = await h.user({ name })
  const now = Date.now()
  await h.sql('INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)', orgId, person.id, role, now)
  for (const [app, grant] of Object.entries(grants)) {
    await h.sql('INSERT INTO app_grants (org_id, user_id, app, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)', orgId, person.id, app, grant, now)
  }
  return person
}

/** The desktop level 1, level 2 and breadcrumb of a page. */
function shell(text) {
  const primary = /<nav aria-label="Primary" id="insulin-nav-primary"[\s\S]*?<\/nav>/.exec(text)?.[0] ?? null
  const section = /<nav aria-label="Section" id="insulin-nav-section"[\s\S]*?<\/nav>/.exec(text)?.[0] ?? null
  const breadcrumb = /<nav aria-label="Breadcrumb"[\s\S]*?<\/nav>/.exec(text)?.[0] ?? null
  return { primary, section, breadcrumb }
}

/** The labels of the links in a piece of navigation (not its toggle), in order, with the group headings as `# Heading`. */
function entries(html) {
  return [...html.matchAll(/<div id="[a-z-]+-group-\d+" class="[^"]*">([^<]+)<\/div>|<a href="(?!\/__insulin\/nav)[^"]*"[^>]*>(?:<svg[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg>)?<span>([^<]+)<\/span><\/a>/g)]
    .map((match) => (match[1] ? `# ${match[1]}` : match[2]))
}

/** The href of the link labelled `label`. */
function hrefOf(html, label) {
  const match = new RegExp(`<a href="([^"]*)"[^>]*>(?:<svg[^>]*>(?:(?!</svg>)[\\s\\S])*</svg>)?<span>${label}</span></a>`).exec(html)
  assert.ok(match, `a link labelled ${label}`)
  return match[1].replaceAll('&amp;', '&')
}

test("level 1 of the organization's pages: Home, the apps the person can use, and the settings their role opens", async () => {
  const expected = {
    owner: ['Home', '# Apps', 'Cap Table', '# Settings', 'People', 'Roles', 'Organization', 'OAuth clients', 'Single sign-on', 'Docs'],
    admin: ['Home', '# Apps', 'Cap Table', '# Settings', 'People', 'Roles', 'Organization', 'OAuth clients', 'Docs'],
    editor: ['Home', '# Apps', 'Cap Table', '# Settings', 'People', 'Roles', 'Organization', 'Docs'],
    viewer: ['Home', '# Apps', 'Cap Table', '# Settings', 'People', 'Roles', 'Organization', 'Docs'],
    appViewer: ['Home', '# Apps', 'Cap Table', '# Settings', 'People', 'Organization', 'Docs'],
    // Ledger isn't deployed here, so someone with only Ledger has no app to open.
    ledgerOnly: ['Home', '# Settings', 'People', 'Organization', 'Docs'],
  }
  for (const [who, labels] of Object.entries(expected)) {
    const person = who === 'owner' ? owner : people[who]
    const page = await person.client.get(h.url('apex', '/'))
    assert.equal(page.status, 200, who)
    const { primary, section, breadcrumb } = shell(page.text)
    assert.deepEqual(entries(primary), labels, who)
    assert.equal(section, null, `${who}: the home page has no level 2`)
    assert.match(primary, /aria-current="page" data-active="true"[^>]*><svg[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg><span>Home<\/span>/, `${who}: Home is open`)
    assert.match(breadcrumb, /<span aria-current="page" class="[^"]*">Home<\/span>/, who)
    assert.ok(primary.includes(`Navigation Org</span>`), `${who}: the switcher names the organization`)
    assert.ok(primary.includes(`Account menu for ${person.name}`), `${who}: the person at the bottom`)
  }
  const page = await owner.client.get(h.url('apex', '/'))
  const { primary } = shell(page.text)
  assert.equal(hrefOf(primary, 'Cap Table'), 'http://captable.insulinapps.localhost/', 'an app opens on its own host')
  assert.equal(hrefOf(primary, 'People'), `http://insulinapps.localhost/settings/users?org=${orgId}`)
  assert.equal(hrefOf(primary, 'Docs'), 'http://insulinapps.localhost/docs/')
  assert.match(primary, /<details data-slot="org-switcher"[^>]*>[\s\S]*href="http:\/\/insulinapps\.localhost\/orgs\/new"/, 'the switcher creates an organization')
  assert.match(primary, /<form action="\/logout" method="post">/, 'the person signs out')

  // A settings page: its item is open, and the breadcrumb is Settings › the page.
  const roles = await people.admin.client.get(h.url('apex', `/settings/roles?org=${orgId}`))
  const opened = shell(roles.text)
  assert.match(opened.primary, /aria-current="page" data-active="true"[^>]*><svg[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg><span>Roles<\/span>/)
  assert.equal(opened.primary.match(/<a [^>]*aria-current=/g).length, 1, 'one open item')
  assert.deepEqual([...opened.breadcrumb.matchAll(/>([^<>]+)<\/(?:a|span)>/g)].map((match) => match[1]), ['Settings', 'Roles'])
  assert.doesNotMatch(roles.text, /aria-label="Organization settings"/, 'the old tabs are gone: level 1 has the pages')
})

test("the account pages: the organization's level 1, and Account's pages in level 2", async () => {
  for (const [path, label] of [['/account', 'Profile'], ['/account/security', 'Security'], ['/account/agents', 'AI agents']]) {
    const page = await people.viewer.client.get(h.url('apex', path))
    const { primary, section, breadcrumb } = shell(page.text)
    assert.deepEqual(entries(primary), ['Home', '# Apps', 'Cap Table', '# Settings', 'People', 'Roles', 'Organization', 'Docs'], path)
    assert.doesNotMatch(primary, /<a [^>]*aria-current=/, `${path}: nothing open in level 1`)
    assert.match(section, /<div data-slot="nav-section-title" class="[^"]*">Account<\/div>/, path)
    assert.deepEqual(entries(section), ['Profile', 'Security', 'AI agents'], path)
    assert.match(section, new RegExp(`aria-current="page"[^>]*><svg[^>]*>(?:(?!</svg>)[\\s\\S])*</svg><span>${label}</span>`), path)
    assert.deepEqual([...breadcrumb.matchAll(/>([^<>]+)<\/(?:a|span)>/g)].map((match) => match[1]), ['Account', label], path)
  }
})

test("an app's settings pages show the app's own level 1, as the person's role in it allows, with Settings open", async () => {
  const expected = {
    VIEWER: ['Dashboard', '# Equity', 'Stakeholders', '# Mine', 'My holdings', 'Docs', 'Settings'],
    EDITOR: ['Dashboard', '# Equity', 'Stakeholders', 'Grants', 'Docs', 'Settings'],
    ADMIN: ['Dashboard', '# Equity', 'Stakeholders', 'Grants', '# Admin', 'Audit log', 'Docs', 'Settings'],
  }
  for (const [person, role] of [[people.viewer, 'VIEWER'], [people.appViewer, 'VIEWER'], [people.editor, 'EDITOR'], [people.appEditor, 'EDITOR'], [people.admin, 'ADMIN'], [owner, 'ADMIN']]) {
    for (const [tab, label] of [['users', 'People'], ['integrations', 'Integrations'], ['api', 'API access'], ['connect-ai', 'Connect AI']]) {
      const page = await person.client.get(h.url('apex', `/apps/captable/settings/${tab}`))
      assert.equal(page.status, 200, `${person.name} ${tab}`)
      const { primary, section, breadcrumb } = shell(page.text)
      assert.deepEqual(entries(primary), expected[role], `${person.name} (${role}) on ${tab}`)
      assert.match(primary, /aria-current="true" data-active="true"[^>]*><svg[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg><span>Settings<\/span>/, 'Settings is the open section')
      assert.deepEqual(entries(section), ['People', 'Integrations', 'API access', 'Connect AI'])
      assert.match(section, new RegExp(`aria-current="page" data-active="true"[^>]*><svg[^>]*>(?:(?!</svg>)[\\s\\S])*</svg><span>${label}</span>`), `${tab} is open`)
      assert.equal(section.match(/aria-current=/g).length, 1)
      assert.deepEqual([...breadcrumb.matchAll(/>([^<>]+)<\/(?:a|span)>/g)].map((match) => match[1]), ['Cap Table', 'Settings', label])
      assert.doesNotMatch(page.text, /aria-label="Cap Table settings"/, 'the old tabs are gone: level 2 has the pages')
    }
  }
  const page = await owner.client.get(h.url('apex', '/apps/captable/settings/users'))
  const { primary, section } = shell(page.text)
  assert.equal(hrefOf(primary, 'Dashboard'), 'http://captable.insulinapps.localhost/', "the manifest's paths, on the app's host")
  assert.equal(hrefOf(primary, 'Grants'), 'http://captable.insulinapps.localhost/grants?status=active', 'with their query')
  assert.equal(hrefOf(primary, 'Docs'), 'http://captable.insulinapps.localhost/docs', "the app's in-app Docs")
  assert.equal(hrefOf(primary, 'Settings'), 'http://insulinapps.localhost/apps/captable/settings/users')
  assert.equal(hrefOf(section, 'API access'), 'http://insulinapps.localhost/apps/captable/settings/api', 'the settings stay on the apex')
  assert.doesNotMatch(primary, /Founders/, "an item's children aren't level 1")
  assert.doesNotMatch(primary, /# Apps|>Home</, "the organization's items give way to the app's")
  assert.match(primary, /<svg[^>]*lucide-layout-dashboard[^>]*>/, "the manifest's icon")

  // An app without a manifest: just Docs and Settings.
  await h.sql("INSERT INTO app_grants (org_id, user_id, app, role, created_at, updated_at) VALUES (?1, ?2, 'ledger', 'VIEWER', 0, 0)", orgId, people.appViewer.id)
  const ledger = await people.appViewer.client.get(h.url('apex', '/apps/ledger/settings/users'))
  assert.deepEqual(entries(shell(ledger.text).primary), ['Docs', 'Settings'])
})

test("an app's settings pages stack below xl, so a long organization name or the invite form can't widen the page", async () => {
  // Next to both levels (240px and 224px) the content is 256px wide at 768px, while the sm: rows assume more; from xl
  // (1280px) it is 768px, room for the rows again.
  const has = (classes, name) => classes.split(' ').includes(name)
  const person = await h.user({ name: 'Nell Owner' })
  const name = 'Northwind Traders Limited Partnership for Regional Distribution and Logistics'
  await h.org(person.client, name)
  for (const tab of ['users', 'integrations', 'api', 'connect-ai']) {
    const page = await person.client.get(h.url('apex', `/apps/captable/settings/${tab}`))
    assert.equal(page.status, 200, tab)
    const header = /<div class="([^"]*)"><div class="flex min-w-0 flex-col gap-1.5"><div data-slot="page-title"/.exec(page.text)?.[1]
    assert.ok(header, `${tab}: the page header`)
    assert.ok(has(header, 'sm:flex-col'), `${tab}: the header stacks`)
    assert.doesNotMatch(header, /(?:sm|md|lg):flex-row/, tab)
    assert.ok(has(header, 'xl:flex-row'), `${tab}: a row again from xl`)
    const link = new RegExp(`<a class="([^"]*)" href="[^"]*/settings/users\\?org=[^"]*">Everyone in ${name}`).exec(page.text)?.[1]
    assert.ok(link, `${tab}: the link to everyone in the organization`)
    // It wraps, keeps a button's height on one line, and from xl leaves the title room beside it.
    for (const wanted of ['whitespace-normal', 'max-w-full', 'h-auto', 'min-h-9', 'xl:max-w-sm']) assert.ok(has(link, wanted), `${tab}: ${wanted}`)
    assert.doesNotMatch(link, /whitespace-nowrap|(?:^| )h-9(?: |$)/, tab)
  }
  const people = await person.client.get(h.url('apex', '/apps/captable/settings/users'))
  const invite = /<form class="([^"]*)" action="\/apps\/captable\/settings\/users\/invite"/.exec(people.text)?.[1]
  assert.ok(invite, 'the invite form')
  assert.ok(has(invite, 'grid-cols-1') && has(invite, 'xl:grid-cols-[1fr_13rem_auto]'), `the invite form's columns: ${invite}`)
  assert.doesNotMatch(invite, /(?:sm|md|lg):grid-cols-/)
})

test('collapsed and expanded: each level shows its icons with title and aria-label, and its toggle flips it', async () => {
  const person = people.editor
  const path = '/apps/captable/settings/api'
  const expanded = shell((await person.client.get(h.url('apex', path))).text)
  assert.match(expanded.primary, /data-state="expanded" class="[^"]*w-60/, 'level 1 is 240px')
  assert.match(expanded.section, /data-state="expanded" class="[^"]*w-56/, 'level 2 is 224px')
  assert.doesNotMatch(expanded.primary, /<a href="http:\/\/captable[^"]*"[^>]* title=/, 'expanded items have their labels, no tooltip')
  const toggle1 = /<a href="(\/__insulin\/nav\?l1=collapsed&amp;return=[^"]+)" data-slot="nav-toggle" aria-expanded="true" aria-controls="insulin-nav-primary" aria-label="Collapse navigation" title="Collapse navigation"/.exec(expanded.primary)
  assert.ok(toggle1, "level 1's toggle")
  assert.equal(new URL(toggle1[1].replaceAll('&amp;', '&'), 'http://x.test').searchParams.get('return'), path, 'it comes back to this page')
  assert.match(expanded.section, /<a href="\/__insulin\/nav\?l2=collapsed&amp;return=%2Fapps%2Fcaptable%2Fsettings%2Fapi" data-slot="nav-toggle" aria-expanded="true" aria-controls="insulin-nav-section" aria-label="Collapse section"/)

  const flipped = await person.client.get(h.url('apex', toggle1[1].replaceAll('&amp;', '&')))
  assert.equal(flipped.status, 303)
  assert.equal(flipped.location, path)
  const half = shell((await person.client.get(h.url('apex', path))).text)
  assert.match(half.primary, /data-state="collapsed" class="[^"]*w-14/, 'level 1 is 56px')
  assert.match(half.section, /data-state="expanded"/, 'level 2 keeps its own state')
  assert.match(half.primary, /<a href="http:\/\/captable\.insulinapps\.localhost\/grants\?status=active" title="Grants" aria-label="Grants" class="[^"]*"><svg[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg><\/a>/, 'an icon with its label as the tooltip')
  assert.doesNotMatch(half.primary, /<span>Grants<\/span>/)
  assert.match(half.primary, /<div id="nav-primary-group-1" class="sr-only">Equity<\/div>/, 'headings stay for screen readers')
  assert.match(half.primary, /<summary data-slot="menu-trigger" class="[^"]*" title="Navigation Org" aria-label="Organization: Navigation Org"><span aria-hidden="true" class="[^"]*">N<\/span><\/summary>/, "the switcher shows the organization's initial")
  assert.match(half.primary, /<summary data-slot="menu-trigger" class="[^"]*" title="Eve Editor">/, 'the person shows their initials')
  assert.match(half.primary, /<a href="\/__insulin\/nav\?l1=expanded&amp;return=[^"]+" data-slot="nav-toggle" aria-expanded="false" aria-controls="insulin-nav-primary" aria-label="Expand navigation"/)

  assert.equal((await person.client.get(h.url('apex', `/__insulin/nav?l2=collapsed&return=${encodeURIComponent(path)}`))).status, 303)
  const both = shell((await person.client.get(h.url('apex', path))).text)
  assert.match(both.section, /data-state="collapsed" class="[^"]*w-14/)
  assert.match(both.section, /<div data-slot="nav-section-title" class="sr-only">Settings<\/div>/)
  assert.match(both.section, /<a href="http:\/\/insulinapps\.localhost\/apps\/captable\/settings\/api" aria-current="page" data-active="true" title="API access" aria-label="API access"/)
  assert.match(both.section, /aria-expanded="false" aria-controls="insulin-nav-section" aria-label="Expand section"/)
  // The same choice on every page of the apex, and the organization's pages too.
  assert.match(shell((await person.client.get(h.url('apex', '/'))).text).primary, /data-state="collapsed"/)

  assert.equal((await person.client.get(h.url('apex', '/__insulin/nav?l1=expanded&l2=expanded&return=%2F'))).status, 303)
  const back = shell((await person.client.get(h.url('apex', path))).text)
  assert.match(back.primary, /data-state="expanded"/)
  assert.match(back.section, /data-state="expanded"/)
})

test('the toggle endpoint: a host-only cookie of valid states, and a 303 back to a path on the same host only', async () => {
  const client = h.client()
  const set = await client.get(h.url('apex', '/__insulin/nav?l1=collapsed&return=%2Fsettings%2Fusers%3Forg%3Dabc'))
  assert.equal(set.status, 303)
  assert.equal(set.location, '/settings/users?org=abc', 'the path and its query, on this host')
  assert.deepEqual(set.cookies, ['insulin_nav=collapsed.expanded; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax'], 'host-only (no Domain), so no app host sees it')
  assert.equal(set.headers.get('cache-control'), 'no-store')
  const next = await client.get(h.url('apex', '/__insulin/nav?l2=collapsed&return=/'))
  assert.deepEqual(next.cookies, ['insulin_nav=collapsed.collapsed; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax'], 'the other level keeps its state')
  assert.equal(next.location, '/')
  assert.equal((await client.get(h.url('apex', '/__insulin/nav?l1=expanded'))).location, '/', 'no return: the home page')

  for (const query of [
    'return=%2F', 'l1=open&return=%2F', 'l1=COLLAPSED', 'l2=', 'l1=collapsed&l1=expanded', 'l1=collapsed&x=1',
    'l1=collapsed&return=http%3A%2F%2Fevil.example%2F', 'l1=collapsed&return=%2F%2Fevil.example%2F', 'l1=collapsed&return=%2F%5Cevil.example',
    'l1=collapsed&return=https%3A%2F%2Finsulinapps.localhost%2F', 'l1=collapsed&return=http%3A%2F%2Fcaptable.insulinapps.localhost%2F',
    'l1=collapsed&return=javascript%3Aalert(1)', 'l1=collapsed&return=settings', 'l1=collapsed&return=%2Fa%0D%0ASet-Cookie%3A%20x%3D1',
    'l1=collapsed&return=', 'l1=collapsed&return=%2F&return=%2Fsettings',
    // Paths that only become `//host` once the dot segments are resolved.
    'l1=collapsed&return=%2F.%2F%2Fevil.example%2F', 'l1=collapsed&return=%2Fa%2F..%2F%2Fevil.example', 'l1=collapsed&return=%2F%252e%2F%2Fevil.example',
  ]) {
    const refused = await client.get(h.url('apex', `/__insulin/nav?${query}`))
    assert.equal(refused.status, 400, query)
    assert.deepEqual(refused.cookies, [], `${query}: nothing remembered`)
    assert.equal(refused.location, null, query)
  }
  assert.equal((await client.post(h.url('apex', '/__insulin/nav?l1=collapsed'), {})).status, 405, 'GET only')
  assert.equal((await client.get(h.url('captable', '/__insulin/nav?l1=collapsed&return=%2F'))).status, 404, 'on the apex only')
  assert.equal((await client.get(h.url('old-auth', '/__insulin/nav?l1=collapsed&return=%2F'))).status, 308, 'the old host only redirects')

  // The app never receives the cookie: it is host-only, and it is one of the gateway's cookies.
  const echoed = await owner.client.get(h.url('captable', '/api/echo'), { headers: { Cookie: `${owner.client.jar.header(new URL(h.url('captable', '/')))}; insulin_nav=collapsed.collapsed` } })
  assert.equal(echoed.status, 200)
  assert.doesNotMatch(echoed.text, /insulin_nav/)
  // An unknown or damaged cookie is the default.
  assert.deepEqual(parseNavCookie('collapsed.collapsed'), { l1: 'collapsed', l2: 'collapsed' })
  for (const value of [undefined, '', 'collapsed', 'collapsed.open', 'collapsed.expanded.x', 'COLLAPSED.expanded']) {
    assert.deepEqual(parseNavCookie(value), { l1: 'expanded', l2: 'expanded' }, String(value))
  }
})

test('in production the toggle keeps the cookie Secure', async () => {
  const production = await startGateway({ mode: 'production' })
  try {
    const set = await production.client().get(production.url('apex', '/__insulin/nav?l2=collapsed&return=%2Faccount'))
    assert.equal(set.status, 303)
    assert.equal(set.location, '/account')
    assert.deepEqual(set.cookies, ['insulin_nav=expanded.collapsed; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax'])
  } finally {
    await production.close()
  }
})

test('narrow screens: a top bar with the organization switcher and a menu whose drawer holds both levels and the person', async () => {
  const page = await people.editor.client.get(h.url('apex', '/apps/captable/settings/integrations'))
  const bar = /<div data-slot="nav-mobile" class="([^"]*)">([\s\S]*?)<nav aria-label="Primary" id="insulin-nav-primary"/.exec(page.text)
  assert.ok(bar, 'the top bar comes first')
  assert.match(bar[1], /md:hidden/, 'only below 768px')
  assert.match(bar[2], /<details data-slot="org-switcher"/)
  const drawer = /<details data-slot="nav-drawer" class="[^"]*">([\s\S]*)$/.exec(bar[2])[1]
  assert.match(drawer, /<summary class="[^"]*">[\s\S]*?<span class="sr-only">Menu<\/span><\/summary>/, 'a labelled menu button')
  assert.deepEqual(entries(/<nav aria-label="Primary" class="[^"]*">[\s\S]*?<\/nav>/.exec(drawer)[0]), ['Dashboard', '# Equity', 'Stakeholders', 'Grants', 'Docs', 'Settings'])
  assert.deepEqual(entries(/<nav aria-label="Section" class="[^"]*">[\s\S]*?<\/nav>/.exec(drawer)[0]), ['People', 'Integrations', 'API access', 'Connect AI'])
  assert.match(drawer, /<form action="\/logout" method="post">/)
  assert.match(page.text, /<nav aria-label="Primary" id="insulin-nav-primary" data-slot="nav-primary" data-state="expanded" class="[^"]*hidden[^"]*md:flex/, 'the columns from 768px')
  // Ids stay unique although the drawer repeats the navigation.
  const ids = [...page.text.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length, `unique ids: ${ids.join(' ')}`)
})

test('the signed-out pages keep the top bar, and every shell page marks itself for the account bar', async () => {
  const anonymous = h.client()
  for (const path of ['/', '/login', '/signup', '/docs/', '/privacy']) {
    const page = await anonymous.get(h.url('apex', path))
    assert.equal(page.status, 200, path)
    assert.doesNotMatch(page.text, /data-insulin-shell/, path)
    assert.match(page.text, /<header class="sticky top-0/, `${path}: the top bar`)
  }
  const home = await owner.client.get(h.url('apex', '/'))
  assert.match(home.text, /<body class="[^"]*"><a class="skip" href="#main">Skip to content<\/a><div data-insulin-shell="" class="[^"]*">/)
})
