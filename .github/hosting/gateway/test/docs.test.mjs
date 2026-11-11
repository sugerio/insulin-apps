// The public docs at /docs/ on the apex: every page generated from the repository's Markdown renders for anyone, with
// one <h1>, the gateway's CSP and no inline script or style; the navigation lists every app; unknown pages are 404;
// images come only from the DOCS_ASSETS binding, at /docs/assets/*; llms.txt lists every page; and check:docs fails
// while the generated module is stale.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listApps } from '../../../scripts/list-apps.mjs'
import { DOCS_MODULE, PLATFORM_DOCS, docsAreCurrent, repositoryDir } from '../scripts/build-docs.mjs'
import { gatewayDir } from './helpers/bundle.mjs'
import { DOCS_ASSETS_DIR, startGateway } from './helpers/harness.mjs'

let h
let bare
/** Every docs page, from the Markdown on disk: { path, title, section }. */
let pages
let apps
before(async () => {
  ;[h, bare] = await Promise.all([startGateway(), startGateway({ omit: ['DOCS_ASSETS'] })])
  apps = await listApps(repositoryDir)
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

test('the navigation lists Platform and every app with all its pages, and the top bar shows the visitor', async () => {
  const index = await h.client().get(h.url('apex', '/docs/'))
  const nav = /<nav aria-label="Documentation"[\s\S]*?<\/nav>/.exec(index.text)?.[0]
  assert.ok(nav, 'a navigation')
  for (const title of ['Platform', ...apps.map((app) => app.title)]) assert.ok(nav.includes(`>${title}</p>`), `the ${title} section`)
  for (const { path } of pages) assert.ok(nav.includes(`href="${path}"`), `${path} in the navigation`)
  assert.ok(nav.indexOf('>Platform</p>') < nav.indexOf(`>${apps[0].title}</p>`), 'Platform comes first')

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
    for (const [svg] of page.text.matchAll(/<svg viewBox[\s\S]*?<\/svg>/g)) {
      assert.match(svg, /role="img" aria-labelledby="[^"]+-title [^"]+-desc"/, `${path}: an accessible diagram`)
      assert.match(svg, /<title id="[^"]+">[^<]+<\/title><desc id="[^"]+">[^<]+<\/desc>/, `${path}: title and description`)
      assert.doesNotMatch(svg, /\s(?:fill|stroke|color|stop-color)="(?!none")[^"]*"/, `${path}: colours come from classes only`)
    }
  }
  assert.ok(seen.size >= 10, 'the pages show screenshots')
  const diagrams = await Promise.all(['/docs/platform/how-it-works', '/docs/platform/organizations-and-roles', '/docs/captable/how-it-works', '/docs/esign/how-it-works']
    .map(async (path) => ((await h.client().get(h.url('apex', path))).text.match(/<svg viewBox/g) ?? []).length))
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
