// The public docs at /docs/ on the apex: every page generated from the repository's Markdown renders for anyone, with
// one <h1>, the gateway's CSP and no inline script or style; the two-level navigation lists every section in level 1
// and the open section's pages in level 2, in a menu on narrow screens too, and is all the layout adds around the
// breadcrumb, article, previous and next and table of contents; unknown pages are 404; images come only from the
// DOCS_ASSETS binding, at /docs/assets/*; llms.txt lists every page; and check:docs fails while the generated module
// is stale.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { listApps } from '../../../scripts/list-apps.mjs'
import { DOCS_MODULE, PLATFORM_DOCS, docsAreCurrent, loadDocs, repositoryDir } from '../scripts/build-docs.mjs'
import { navIcon } from '../scripts/docs/layout.mjs'
import { decodeEntities, renderTokens } from '../scripts/docs/markdown.mjs'
import { NAV_ICON_NAMES, appIconName } from '../src/nav-icons.ts'
import { gatewayDir } from './helpers/bundle.mjs'
import { DOCS_ASSETS_DIR, startGateway } from './helpers/harness.mjs'

let h
let bare
/** Every docs page, from the Markdown on disk: { path, title, section }. */
let pages
let apps
/** The sections and pages in reading order, as the build reads them (scripts/build-docs.mjs). */
let docs
before(async () => {
  ;[h, bare] = await Promise.all([startGateway(), startGateway({ omit: ['DOCS_ASSETS'] })])
  apps = await listApps(repositoryDir)
  docs = await loadDocs()
  const sections = [{ slug: 'platform', title: 'Platform', dir: PLATFORM_DOCS }, ...apps.map((app) => ({ slug: app.name, title: app.title, dir: join(repositoryDir, app.name, 'docs', 'public') }))]
  pages = []
  for (const section of sections) {
    for (const name of (await readdir(section.dir)).filter((file) => file.endsWith('.md')).sort()) {
      const source = await readFile(join(section.dir, name), 'utf8')
      pages.push({ path: `/docs/${section.slug}/${name.slice(0, -3)}`, title: /^title: (.+)$/m.exec(source)[1], section })
    }
  }
})
after(async () => { await Promise.all([h?.close(), bare?.close()]) })

const INLINE = /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=|javascript:/i

async function cspOfPages() {
  return (await h.client().get(h.url('apex', '/privacy'))).headers.get('content-security-policy')
}

function assertDocsPage(page, where, csp) {
  assert.equal(page.status, 200, where)
  assert.match(page.headers.get('content-type'), /^text\/html; charset=utf-8$/, where)
  assert.equal(page.headers.get('content-security-policy'), csp, `${where}: the gateway's page CSP, unchanged`)
  assert.equal(page.headers.get('x-robots-tag'), null, `${where}: indexable`)
  assert.ok(page.text.startsWith('<!doctype html>\n<html lang="en">'), where)
  assert.equal(page.text.match(/<h1[\s>]/g)?.length, 1, `${where}: one h1`)
  assert.doesNotMatch(page.text, INLINE, `${where}: no inline script, style or handler`)
  assert.ok(page.text.includes('<link rel="stylesheet" href="/__insulin/gateway.css"/>'), where)
  assert.match(page.text, /<meta name="description" content="[^"]+"\/>/, `${where}: a description`)
  assert.ok(page.text.includes('<main id="main"'), where)
  assert.ok(!page.text.includes('data-docs-slot'), `${where}: the placeholder is replaced`)
}

test('/docs/ and every page render publicly, with one h1, the CSP and no inline script or style', async () => {
  const csp = await cspOfPages()
  const anonymous = h.client()
  for (const path of ['/docs', '/docs/']) {
    const index = await anonymous.get(h.url('apex', path))
    assertDocsPage(index, path, csp)
    assert.ok(index.text.includes('<title>Documentation · Insulin Apps</title>'), path)
    assert.ok(index.text.includes(`<link rel="canonical" href="${h.url('apex', '/docs/')}"/>`), `${path}: one canonical address`)
  }
  assert.ok(pages.length >= 20, 'the platform and both apps have pages')
  for (const { path, title, section } of pages) {
    const page = await anonymous.get(h.url('apex', path))
    assertDocsPage(page, path, csp)
    assert.ok(page.text.includes(`<title>${title.replaceAll("'", '&#x27;')} · ${section.title} docs · Insulin Apps</title>`), `${path}: title`)
    assert.ok(page.text.includes(`<link rel="canonical" href="${h.url('apex', path)}"/>`), `${path}: canonical`)
    assert.ok(page.text.includes(`aria-current="page"`), `${path}: the navigation marks the page`)
    assert.match(page.text, /<nav aria-label="On this page"|<aside class="hidden xl:block"><\/aside>/, `${path}: a table of contents`)
    assert.match(page.text, /<nav aria-label="Previous and next"/, `${path}: previous and next`)
  }
})

/** A page's HTML, fetched once per test file run. */
const fetched = new Map()
async function pageHtml(path) {
  if (!fetched.has(path)) {
    const page = await h.client().get(h.url('apex', path))
    assert.equal(page.status, 200, path)
    fetched.set(path, page.text)
  }
  return fetched.get(path)
}

/** The only match of `pattern` in `html`, or null; more than one fails. */
function only(html, pattern, what) {
  const all = html.match(new RegExp(pattern.source, 'g')) ?? []
  assert.ok(all.length <= 1, `one ${what} at most`)
  return all[0] ?? null
}

/**
 * The docs' navigation in a page: level 1, level 2, the narrow screens' menu and the search box above it (null where
 * there is none).
 */
function navigationOf(html) {
  return {
    primary: only(html, /<nav aria-label="Documentation"[\s\S]*?<\/nav>/, 'level 1'),
    section: only(html, /<nav aria-label="Section"[\s\S]*?<\/nav>/, 'level 2'),
    menu: only(html, /<details class="group mb-8 rounded-lg border lg:hidden">[\s\S]*?<\/details>/, 'menu'),
    search: only(html, /<form (?=[^>]*\saction="\/docs\/search")(?=[^>]*\sclass="[^"]*\blg:hidden\b)[^>]*>[\s\S]*?<\/form>/, 'search box above the menu'),
  }
}

/** The links in some HTML, in order: { href, text, current } (`current`: the aria-current value, or null). */
function linksOf(html) {
  return [...html.matchAll(/<a href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g)].map(([, href, attributes, inner]) => ({
    href: decodeEntities(href),
    text: decodeEntities(inner.replace(/<[^>]+>/g, '')).trim(),
    current: /\saria-current="([^"]+)"/.exec(attributes)?.[1] ?? null,
  }))
}

/** Level 1 as it should read with `open` the open section (null on /docs/, where Overview is the page). */
function levelOne(open) {
  return [
    { href: '/docs/', text: 'Overview', current: open ? null : 'page' },
    ...docs.sections.map((section) => ({ href: section.pages[0].path, text: section.title, current: section === open ? 'true' : null })),
    { href: '/docs/llms.txt', text: 'llms.txt', current: null },
    { href: '/docs/llms-full.txt', text: 'llms-full.txt', current: null },
  ]
}

/** Level 2 for `page`: its section's pages in reading order, `page` marked. */
function levelTwo(page) {
  return page.section.pages.map((other) => ({ href: other.path, text: other.title, current: other === page ? 'page' : null }))
}

test('level 1 lists Overview, Platform, every app with its icon and the files for AI agents; /docs/ has no level 2', async () => {
  assert.deepEqual(docs.sections.map((section) => section.slug), ['platform', ...apps.map((app) => app.name)], 'Platform, then every app')
  const html = await pageHtml('/docs/')
  const { primary, section, menu } = navigationOf(html)
  assert.ok(primary, 'level 1')
  assert.deepEqual(linksOf(primary), levelOne(null), 'Overview (the page), Platform, each app, llms.txt and llms-full.txt')
  assert.equal(section, null, 'no level 2 on /docs/: Overview has no pages of its own')
  assert.ok(menu, 'the menu for narrow screens')
  assert.deepEqual(linksOf(menu), levelOne(null), 'the menu: level 1 only')
  assert.ok(!menu.includes('data-slot="docs-menu-section"'), 'no level 2 in the menu either')

  const icons = [['Overview', 'book-open'], ['Platform', 'layers'], ...apps.map((app) => [app.title, appIconName(app.name)]), ['llms.txt', 'file-text'], ['llms-full.txt', 'files']]
  for (const [label, icon] of icons) {
    assert.match(primary, new RegExp(`<svg [^>]*class="lucide lucide-${icon}[ "][^>]*aria-hidden="true"[^>]*>(?:(?!</svg>)[\\s\\S])*</svg><span>${label.replace('.', '\\.')}</span></a>`), `${label}: the ${icon} icon`)
  }
  for (const name of NAV_ICON_NAMES) assert.ok(navIcon(name), `the docs can draw the ${name} icon an app may have`)
  // The apps under their heading, and the files for agents apart, pinned to the bottom of the column.
  const appsAt = primary.indexOf('>Apps</div>')
  assert.ok(appsAt > primary.indexOf('<span>Platform</span>') && appsAt < primary.indexOf(`<span>${apps[0].title}</span>`), 'the apps under "Apps"')
  assert.match(primary, /<div class="mt-auto flex flex-col"><div class="flex flex-col"><div id="docs-nav-agents"[^>]*>For AI agents<\/div>/, 'For AI agents at the bottom')
  // Each column shows on wide screens only, the menu on narrow ones.
  assert.match(primary, /^<nav aria-label="Documentation" [^>]*class="[^"]*\bhidden\b[^"]*\blg:flex\b[^"]*\bw-60\b/, 'level 1: 240px, from 1024px')
})

test('level 2 lists only the open section\'s pages, marks the page, and level 1 the section', async () => {
  for (const page of docs.pages) {
    const html = await pageHtml(page.path)
    const { primary, section } = navigationOf(html)
    assert.deepEqual(linksOf(primary), levelOne(page.section), `${page.path}: level 1, its section open (aria-current="true")`)
    assert.ok(section, `${page.path}: level 2`)
    assert.match(section, /^<nav aria-label="Section" [^>]*class="[^"]*\bhidden\b[^"]*\blg:flex\b[^"]*\bw-56\b/, `${page.path}: level 2, 224px, from 1024px`)
    assert.ok(section.includes(`<div id="docs-nav-section-title" class="min-w-0 flex-1 truncate text-sm font-semibold">${page.section.title}</div>`), `${page.path}: headed by its section`)
    assert.ok(section.includes('<ul aria-labelledby="docs-nav-section-title"'), `${page.path}: the list is named by the header`)
    assert.deepEqual(linksOf(section), levelTwo(page), `${page.path}: its section's pages, and no other section's`)
    assert.equal(html.match(/aria-current="page"/g).length, 2, `${page.path}: the page is marked in level 2 and in the menu, nowhere else`)
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
    assert.equal(new Set(ids).size, ids.length, `${page.path}: every id once`)
  }
})

test('on narrow screens the <details> menu holds both levels: level 1, the open section\'s pages, the files for agents', async () => {
  for (const page of docs.pages) {
    const { menu } = navigationOf(await pageHtml(page.path))
    assert.ok(menu, `${page.path}: a menu`)
    assert.match(menu, /^<details class="group mb-8 rounded-lg border lg:hidden"><summary [^>]*>[\s\S]*?Documentation menu[\s\S]*?<\/summary><nav aria-label="Documentation menu"/, `${page.path}: closed, below 1024px only`)
    const one = levelOne(page.section)
    assert.deepEqual(linksOf(menu), [...one.slice(0, -2), ...levelTwo(page), ...one.slice(-2)], `${page.path}: both levels, in order`)
    const level2 = /<div data-slot="docs-menu-section"[\s\S]*?<\/ul><\/div>/.exec(menu)?.[0]
    assert.ok(level2?.includes(`<div id="docs-menu-section-title" class="px-2 text-sm font-semibold">${page.section.title}</div>`), `${page.path}: level 2 headed by its section`)
    assert.deepEqual(linksOf(level2), levelTwo(page), `${page.path}: level 2 in the menu`)
  }
})

const TOP_BAR_WIDE = '<div class="flex h-14 w-full items-center gap-2 px-4">'
const TOP_BAR = '<div class="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4 sm:px-6">'

test('apart from the navigation, a page is its breadcrumb, article, previous and next and table of contents, as before', async () => {
  for (const page of docs.pages) {
    const html = await pageHtml(page.path)
    let rest = /<main id="main"[^>]*>([\s\S]*)<\/main>/.exec(html)[1]
    const take = (pattern, what) => {
      const found = only(rest, pattern, what)
      assert.ok(found, `${page.path}: ${what}`)
      rest = rest.replace(found, '')
      return found
    }
    for (const part of Object.values(navigationOf(rest))) rest = rest.replace(part, '')

    const breadcrumb = take(/<nav aria-label="Breadcrumb"[\s\S]*?<\/nav>/, 'a breadcrumb')
    assert.deepEqual(linksOf(breadcrumb), [{ href: '/docs/', text: 'Docs', current: null }, { href: page.section.pages[0].path, text: page.section.title, current: null }], `${page.path}: Docs › section`)

    const article = take(/<article\b[\s\S]*?<\/article>/, 'an article')
    const body = renderToStaticMarkup(createElement(Fragment, null, renderTokens(page.tokens, { file: page.file, path: page.path, headings: page.headings, site: docs.site })))
    assert.ok(article.endsWith(`</header>${body}</article>`), `${page.path}: the article's body is the Markdown's, untouched`)
    const title = renderToStaticMarkup(createElement('h1', null, page.title))
    const description = renderToStaticMarkup(createElement(Fragment, null, page.description))
    assert.match(article, new RegExp(`^<article [^>]*><header [^>]*><div [^>]*>${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</div><p [^>]*>`), `${page.path}: the title`)
    assert.ok(article.includes(`>${description}</p></header>`), `${page.path}: the description`)

    const toc = take(/<aside class="hidden xl:block">(?:<nav aria-label="On this page"[\s\S]*?<\/nav>)?<\/aside>/, 'a table of contents')
    const entries = page.headings.filter((heading) => heading.depth <= 3)
    assert.deepEqual(linksOf(toc).map((link) => [link.href, link.text]), entries.map((heading) => [`#${heading.id}`, heading.text]), `${page.path}: On this page`)
    for (const heading of entries) assert.ok(article.includes(` id="${heading.id}"`), `${page.path}: #${heading.id} is in the article`)

    const neighbours = take(/<nav aria-label="Previous and next"[\s\S]*?<\/nav>/, 'previous and next')
    assert.deepEqual(linksOf(neighbours).map((link) => link.href), [page.previous, page.next].filter(Boolean).map((other) => other.path), `${page.path}: previous and next`)

    assert.equal(rest.replace(/<[^>]+>/g, '').trim(), '', `${page.path}: nothing else to read`)
    assert.deepEqual([...rest.matchAll(/<([a-z0-9]+)[\s>]/g)].map((match) => match[1]).filter((tag) => tag !== 'div'), [], `${page.path}: only the layout's boxes are left`)
    assert.ok(html.includes(TOP_BAR_WIDE) && !html.includes(TOP_BAR), `${page.path}: the top bar spans the window, over the navigation`)
  }
  const index = await pageHtml('/docs/')
  assert.ok(index.includes(TOP_BAR_WIDE), '/docs/: the wide top bar')
  for (const section of docs.sections) {
    for (const page of section.pages) assert.ok(index.includes(`<a href="${page.path}" class="flex flex-col gap-1.5 rounded-xl border`), `/docs/: the card for ${page.path}`)
  }
  assert.ok((await h.client().get(h.url('apex', '/privacy'))).text.includes(TOP_BAR), 'other pages keep their top bar')
})

test('the top bar shows the visitor', async () => {
  const index = await h.client().get(h.url('apex', '/docs/'))
  const top = /<header\b[\s\S]*?<\/header>/.exec(index.text)[0]
  assert.ok(top.includes('>Sign in</a>') && top.includes('>Create account</a>'), 'signed out: sign-in links')
  assert.ok(top.includes(`href="${h.url('apex', '/docs/')}">Docs</a>`), 'the top bar links the docs')
  const person = await h.user({ name: 'Docs Reader' })
  await h.org(person.client, 'Docs Org')
  const signedIn = await person.client.get(h.url('apex', pages[0].path))
  assertDocsPage(signedIn, 'signed in', await cspOfPages())
  assert.ok(/<header\b[\s\S]*?<\/header>/.exec(signedIn.text)[0].includes('Account menu for Docs Reader'), 'signed in: the account')
  const landing = await h.client().get(h.url('apex', '/'))
  assert.ok(landing.text.includes(`href="${h.url('apex', '/docs/')}">Read the docs</a>`), 'the landing page links the docs')
})

test('unknown docs pages are 404; sections lead to their first page; only GET and HEAD', async () => {
  const client = h.client()
  for (const path of ['/docs/nope', '/docs/platform/nope', '/docs/captable/no-such-page', '/docs/platform/getting-started/extra', '/docs/nope.md',
    '/docs/platform/nope.md', '/docs/index.md', '/docs/assets', '/docs/llms.txt/', '/docs//platform/getting-started', '/docsx', '/docs/Platform/getting-started']) {
    const page = await client.get(h.url('apex', path))
    assert.equal(page.status, 404, path)
    assert.match(page.text, /<title>Page not found · Insulin Apps<\/title>/, path)
  }
  const first = pages.find((page) => page.section.slug === 'platform' && page.path.endsWith('/getting-started'))
  for (const path of ['/docs/platform', '/docs/platform/']) {
    const section = await client.get(h.url('apex', path))
    assert.equal(section.status, 302, path)
    assert.equal(section.location, h.url('apex', first.path))
  }
  const slash = await client.get(h.url('apex', `${first.path}/`))
  assert.equal(slash.status, 301)
  assert.equal(slash.location, h.url('apex', first.path))
  const post = await client.post(h.url('apex', '/docs/'), {})
  assert.equal(post.status, 405)
  const head = await client.request(h.url('apex', first.path), { method: 'HEAD' })
  assert.equal(head.status, 200)
  // On an app's host, /docs belongs to the app (Cap Table has its own in-app Docs).
  const onApp = await client.get(h.url('captable', '/docs/'))
  assert.equal(onApp.status, 401, 'the app proxy answered: not signed in')
})

/** The first file under the assets directory's screenshots, with its bytes. */
async function someScreenshot() {
  const name = (await readdir(join(DOCS_ASSETS_DIR, 'screenshots'))).filter((file) => file.endsWith('.png')).sort()[0]
  assert.ok(name, 'a screenshot to serve')
  return { path: `/docs/assets/screenshots/${name}`, bytes: await readFile(join(DOCS_ASSETS_DIR, 'screenshots', name)) }
}

async function fetchBytes(harness, href, init = {}) {
  const response = await harness.mf.dispatchFetch(href, { redirect: 'manual', ...init })
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) }
}

test('/docs/assets/* comes from the DOCS_ASSETS binding with long caching, and nothing else does', async () => {
  const { path, bytes } = await someScreenshot()
  const image = await fetchBytes(h, h.url('apex', `${path}?v=0123456789`))
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(image.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff')
  assert.ok(image.bytes.equals(bytes), 'the file itself')
  const etag = image.headers.get('etag')
  assert.ok(etag, 'an ETag')
  const again = await fetchBytes(h, h.url('apex', path), { headers: { 'If-None-Match': etag } })
  assert.equal(again.status, 304)
  assert.equal(again.bytes.length, 0)
  const head = await fetchBytes(h, h.url('apex', path), { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.bytes.length, 0)

  const name = path.slice('/docs/assets/'.length)
  for (const other of [`/${name}`, `/assets/${name}`, `/docs/${name}`, '/docs/assets/', '/docs/assets/screenshots/missing.png',
    `/docs/assets/${name.toUpperCase()}`, `/docs/assets/${name}.txt`, '/docs/assets/%2e%2e/package.json', '/docs/assets/screenshots/%2e%2e/%2e%2e/package.json',
    '/docs/assets/..%2fpackage.json', '/package.json', '/docs/assets/screenshots']) {
    const response = await fetchBytes(h, h.url('apex', other))
    assert.equal(response.status, 404, other)
    assert.match(response.headers.get('content-type'), /^text\/html/, `${other}: the gateway's 404, not an asset`)
  }
  const post = await h.client().post(h.url('apex', path), {})
  assert.equal(post.status, 405)
  const onApp = await fetchBytes(h, h.url('captable', path))
  assert.notEqual(onApp.headers.get('content-type'), 'image/png', 'app hosts never serve the docs assets')
  const withoutBinding = await fetchBytes(bare, bare.url('apex', path))
  assert.equal(withoutBinding.status, 404, 'no binding, no images')
  assert.equal((await bare.client().get(bare.url('apex', '/docs/'))).status, 200, 'the pages still render')
})

/** A diagram: an SVG in a figure of the article (the top bar's mark is an SVG too, with its own colours). */
const DIAGRAM = /<figure class="mt-8 first:mt-0"><div[^>]*><svg[\s\S]*?<\/svg>/g

test('every image a page shows is served, and every diagram is themed SVG without colours of its own', async () => {
  const seen = new Set()
  for (const { path } of pages) {
    const page = await h.client().get(h.url('apex', path))
    for (const [, src] of page.text.matchAll(/<img src="([^"]+)"/g)) {
      assert.match(src, /^\/docs\/assets\/[a-z0-9/_.-]+\.png\?v=[0-9a-f]{10}$/, `${path}: ${src}`)
      if (seen.has(src)) continue
      seen.add(src)
      const image = await fetchBytes(h, h.url('apex', src))
      assert.equal(image.status, 200, `${path}: ${src}`)
    }
    for (const [svg] of page.text.matchAll(DIAGRAM)) {
      assert.match(svg, /role="img" aria-labelledby="[^"]+-title [^"]+-desc"/, `${path}: an accessible diagram`)
      assert.match(svg, /<title id="[^"]+">[^<]+<\/title><desc id="[^"]+">[^<]+<\/desc>/, `${path}: title and description`)
      assert.doesNotMatch(svg, /\s(?:fill|stroke|color|stop-color)="(?!none")[^"]*"/, `${path}: colours come from classes only`)
    }
  }
  assert.ok(seen.size >= 10, 'the pages show screenshots')
  const diagrams = await Promise.all(['/docs/platform/how-it-works', '/docs/platform/organizations-and-roles', '/docs/captable/how-it-works', '/docs/esign/how-it-works']
    .map(async (path) => ((await h.client().get(h.url('apex', path))).text.match(DIAGRAM) ?? []).length))
  assert.deepEqual(diagrams, [2, 1, 1, 1], 'the architecture diagrams')
})

test('llms.txt lists every page, llms-full.txt and the .md addresses carry their Markdown', async () => {
  const client = h.client()
  const llms = await client.get(h.url('apex', '/docs/llms.txt'))
  assert.equal(llms.status, 200)
  assert.equal(llms.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.ok(llms.text.startsWith('# Insulin Apps\n\n> '), 'the llms.txt format')
  assert.ok(!llms.text.includes('@@ORIGIN@@'), 'the origin is filled in')
  for (const { path, title } of pages) assert.ok(llms.text.includes(`- [${title}](${h.url('apex', `${path}.md`)}): `), `${path} in llms.txt`)
  for (const title of ['Platform', ...apps.map((app) => app.title)]) assert.ok(llms.text.includes(`\n## ${title}\n`), title)

  const full = await client.get(h.url('apex', '/docs/llms-full.txt'))
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'text/plain; charset=utf-8')
  for (const { path, title } of pages) {
    assert.ok(full.text.includes(`Source: ${h.url('apex', path)}\n\n# ${title}\n`), `${path} in llms-full.txt`)
    const markdown = await client.get(h.url('apex', `${path}.md`))
    assert.equal(markdown.status, 200, `${path}.md`)
    assert.ok(markdown.text.startsWith(`# ${title}\n\n> `), `${path}.md`)
    assert.doesNotMatch(markdown.text, /```diagram/, `${path}.md: diagrams become their description`)
  }
})

function runCheck(args) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(gatewayDir, 'scripts', 'build-docs.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('exit', (code) => accept({ code, output }))
  })
}

test('the committed docs module matches a fresh build (npm run check:docs), and the check fails while it is stale', async () => {
  assert.ok(await docsAreCurrent(), 'src/assets/docs-content.ts is stale: run `npm run build:docs`')
  const dir = await mkdtemp(join(tmpdir(), 'docs-check-'))
  try {
    const stale = join(dir, 'docs-content.ts')
    await writeFile(stale, (await readFile(DOCS_MODULE, 'utf8')).replace('Insulin Apps documentation', 'Insulin Apps documentation, edited'))
    const failed = await runCheck(['--check', '--out', stale])
    assert.equal(failed.code, 1)
    assert.match(failed.output, /is stale: run `npm run build:docs`/)
    await writeFile(stale, await readFile(DOCS_MODULE, 'utf8'))
    assert.equal((await runCheck(['--check', '--out', stale])).code, 0, 'a current copy passes')
    assert.equal((await runCheck(['--check', '--allow-todo'])).code, 1, '--check takes no --allow-* option')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const module = await readFile(DOCS_MODULE, 'utf8')
  assert.doesNotMatch(module, /<script|<style|\\u003cscript|\sstyle=\\"/i, 'no script or style in the generated pages')
})
