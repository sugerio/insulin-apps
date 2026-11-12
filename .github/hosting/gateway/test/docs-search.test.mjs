// The public docs, open to search engines, AI assistants and agents (DESIGN.md §1; searching-the-docs.md): robots.txt
// lets every crawler in and names sitemap.xml, which lists every indexable page; llms.txt is at the root too; every docs
// page has a search box, link previews (Open Graph) and schema.org microdata; /docs/search finds the passage that
// matches and isn't indexed; /docs/search.json answers any origin; and the docs' MCP server at /docs/mcp searches and
// reads the docs with no sign-in. Each is limited per IP.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDocs } from '../scripts/build-docs.mjs'
import { decodeEntities } from '../scripts/docs/markdown.mjs'
import { startGateway } from './helpers/harness.mjs'
import { json } from './helpers/oauth.mjs'

let h
let docs
before(async () => {
  h = await startGateway()
  docs = await loadDocs()
})
after(async () => { await h?.close() })

const INLINE = /<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=|javascript:/i
const ROTATE = '/docs/platform/api-and-service-accounts#rotate-the-secret-without-downtime'

const mcp = (body, { client = h.client(), headers = {} } = {}) => json(client, h.url('apex', '/docs/mcp'), body, { Accept: 'application/json, text/event-stream', ...headers })
const call = async (name, args = {}, id = 1) => {
  const response = await mcp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  assert.equal(response.status, 200, response.text)
  return response.json.result
}
const searchJson = (query, client = h.client()) => client.get(h.url('apex', `/docs/search.json${query}`))

test('robots.txt lets every crawler read the site but the search results, and names the sitemap', async () => {
  const robots = await h.client().get(h.url('apex', '/robots.txt'))
  assert.equal(robots.status, 200)
  assert.match(robots.headers.get('content-type'), /^text\/plain; charset=utf-8$/)
  assert.equal(robots.headers.get('x-robots-tag'), null)
  const rules = robots.text.split('\n').filter((line) => line && !line.startsWith('#'))
  assert.deepEqual(rules, ['User-agent: *', 'Allow: /', 'Disallow: /docs/search?', `Sitemap: ${h.url('apex', '/sitemap.xml')}`])
})

test('sitemap.xml lists the landing page, privacy, terms and every docs page, each indexable', async () => {
  const sitemap = await h.client().get(h.url('apex', '/sitemap.xml'))
  assert.equal(sitemap.status, 200)
  assert.match(sitemap.headers.get('content-type'), /^application\/xml; charset=utf-8$/)
  assert.ok(sitemap.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'))
  const listed = [...sitemap.text.matchAll(/<url><loc>([^<]+)<\/loc><\/url>/g)].map((match) => match[1])
  const expected = ['/', '/privacy', '/terms', '/docs/', ...docs.pages.map((page) => page.path)].map((path) => h.url('apex', path))
  assert.deepEqual([...listed].sort(), [...expected].sort(), 'every page once, nothing else')
  for (const url of listed) {
    const page = await h.client().get(url)
    assert.equal(page.status, 200, url)
    assert.equal(page.headers.get('x-robots-tag'), null, `${url}: indexable`)
    assert.ok(page.text.includes(`<link rel="canonical" href="${url}"/>`), `${url}: its canonical address is the one listed`)
  }
})

test('llms.txt and llms-full.txt are at the root too, and llms.txt says how to search the docs', async () => {
  for (const name of ['llms.txt', 'llms-full.txt']) {
    const [root, docsCopy] = await Promise.all([h.client().get(h.url('apex', `/${name}`)), h.client().get(h.url('apex', `/docs/${name}`))])
    assert.equal(root.status, 200, name)
    assert.match(root.headers.get('content-type'), /^text\/plain/, name)
    assert.equal(root.text, docsCopy.text, `/${name} is /docs/${name}`)
  }
  const llms = (await h.client().get(h.url('apex', '/llms.txt'))).text
  assert.ok(llms.includes(`GET ${h.url('apex', '/docs/search.json')}?q=<words>`), 'the search JSON')
  assert.ok(llms.includes(`MCP server at ${h.url('apex', '/docs/mcp')}`), 'the MCP server')
  assert.ok(llms.includes(`[Searching the docs](${h.url('apex', '/docs/platform/searching-the-docs.md')})`), 'and the page about both')
})

test('every docs page has the search box, link previews and schema.org microdata', async () => {
  const docsIndex = await h.client().get(h.url('apex', '/docs/'))
  assert.equal(docsIndex.text.match(/<form [^>]*action="\/docs\/search"/g)?.length, 3, '/docs/: in level 1, above the menu and under the title')
  assert.ok(docsIndex.text.includes('<meta property="og:type" content="website"/>'), '/docs/: a website')
  for (const page of docs.pages) {
    const html = (await h.client().get(h.url('apex', page.path))).text
    const forms = [...html.matchAll(/<form [^>]*>[\s\S]*?<\/form>/g)].map((match) => match[0]).filter((form) => form.includes('action="/docs/search"'))
    assert.equal(forms.length, 2, `${page.path}: in level 1, and above the menu on narrow screens`)
    for (const form of forms) {
      assert.match(form, /\smethod="get"/, page.path)
      assert.match(form, /<input type="search" [^>]*aria-label="Search the docs"[^>]*name="q"\/>/, `${page.path}: a named search box`)
      assert.match(form, /<button type="submit"[^>]*>[\s\S]*<span class="sr-only">Search<\/span><\/button>/, `${page.path}: and its button`)
    }
    const canonical = h.url('apex', page.path)
    const meta = (property) => decodeEntities(new RegExp(`<meta property="${property}" content="([^"]*)"/>`).exec(html)?.[1] ?? '')
    assert.equal(meta('og:type'), 'article', page.path)
    assert.equal(meta('og:title'), `${page.title} · ${page.section.title} docs`, page.path)
    assert.equal(meta('og:description'), page.description, page.path)
    assert.equal(meta('og:url'), canonical, page.path)
    assert.equal(meta('og:image'), h.url('apex', '/apple-touch-icon.png'), page.path)
    assert.equal(meta('og:site_name'), 'Insulin Apps', page.path)
    assert.ok(html.includes('<meta name="twitter:card" content="summary"/>'), page.path)
    assert.match(html, /<article [^>]*itemScope="" itemType="https:\/\/schema\.org\/TechArticle">/, `${page.path}: a TechArticle`)
    assert.match(html, /<div [^>]*itemProp="headline"><h1>/, `${page.path}: its headline is the title`)
    assert.match(html, /<p [^>]*itemProp="description">/, `${page.path}: and its description`)
    const crumbs = /<ol [^>]*itemScope="" itemType="https:\/\/schema\.org\/BreadcrumbList">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? ''
    const items = [...crumbs.matchAll(/<li itemProp="itemListElement" itemScope="" itemType="https:\/\/schema\.org\/ListItem"><a href="([^"]+)" itemProp="item"[^>]*><span itemProp="name">([^<]+)<\/span><\/a><meta itemProp="position" content="(\d)"\/><\/li>/g)]
    assert.deepEqual(items.map((match) => [match[1], decodeEntities(match[2]), match[3]]), [['/docs/', 'Docs', '1'], [page.section.pages[0].path, page.section.title, '2']], `${page.path}: Docs › section`)
  }
})

test('the landing page, privacy and terms have descriptions and previews; signed-in and sign-in pages have none', async () => {
  for (const path of ['/', '/privacy', '/terms']) {
    const html = (await h.client().get(h.url('apex', path))).text
    assert.match(html, /<meta name="description" content="[^"]{40,}"\/>/, `${path}: a description`)
    assert.ok(html.includes(`<link rel="canonical" href="${h.url('apex', path)}"/>`), `${path}: canonical`)
    assert.ok(html.includes('<meta property="og:type" content="website"/>'), `${path}: a preview`)
  }
  const login = await h.client().get(h.url('apex', '/login'))
  assert.equal(login.headers.get('x-robots-tag'), 'noindex')
  assert.doesNotMatch(login.text, /og:|name="description"/, 'no preview for a page that isn\'t indexed')
})

test('/docs/search lists the best passages with the words marked, escapes the query, and isn\'t indexed', async () => {
  const csp = (await h.client().get(h.url('apex', '/privacy'))).headers.get('content-security-policy')
  const found = await h.client().get(h.url('apex', '/docs/search?q=rotate+secret'))
  assert.equal(found.status, 200)
  assert.equal(found.headers.get('x-robots-tag'), 'noindex', 'search pages aren\'t indexed')
  assert.equal(found.headers.get('content-security-policy'), csp)
  assert.doesNotMatch(found.text, INLINE)
  assert.equal(found.text.match(/<h1[\s>]/g)?.length, 1)
  assert.ok(found.text.includes('<title>rotate secret · Search the docs · Insulin Apps</title>'))
  assert.match(found.text, /<input type="search" [^>]*value="rotate secret"/, 'the box keeps the query')
  assert.match(found.text, /<nav aria-label="Documentation"/, 'inside the docs\' navigation')
  assert.equal(found.text.match(/aria-current="(?:page|true)"/g), null, 'no page or section is open')
  const results = [...found.text.matchAll(/<li class="flex flex-col gap-1 rounded-xl[^"]*"><a href="([^"]+)"/g)].map((match) => decodeEntities(match[1]))
  assert.equal(results[0], ROTATE, 'the section about rotating comes first, linked at its heading')
  assert.equal(new Set(results.map((href) => href.split('#')[0])).size, results.length, 'each page once')
  assert.ok(results.length <= 20)
  assert.match(found.text, /<mark [^>]*>Rotate<\/mark> <mark [^>]*>secret<\/mark>/, 'the words are marked')

  const hostile = await h.client().get(h.url('apex', `/docs/search?q=${encodeURIComponent('<script>alert(1)</script> "x')}`))
  assert.equal(hostile.status, 200)
  assert.doesNotMatch(hostile.text, INLINE, 'the query never becomes markup')
  assert.ok(hostile.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;x'), 'it is shown as text')

  const empty = await h.client().get(h.url('apex', '/docs/search'))
  assert.equal(empty.status, 200)
  assert.ok(empty.text.includes('Type a few words'))
  const none = await h.client().get(h.url('apex', '/docs/search?q=zzqqxv'))
  assert.ok(none.text.includes('Nothing in the docs matches &ldquo;zzqqxv&rdquo;') || none.text.includes('Nothing in the docs matches “zzqqxv”'))
  assert.equal((await h.client().request(h.url('apex', '/docs/search?q=x'), { method: 'POST' })).status, 405)
})

test('/docs/search.json answers any origin with each result\'s page, heading, passage and Markdown', async () => {
  const found = await searchJson('?q=rotate%20secret&limit=3')
  assert.equal(found.status, 200)
  assert.equal(found.headers.get('access-control-allow-origin'), '*')
  assert.match(found.headers.get('content-type'), /^application\/json/)
  assert.equal(found.headers.get('cache-control'), 'public, max-age=300')
  const body = JSON.parse(found.text)
  assert.equal(body.query, 'rotate secret')
  assert.ok(body.results.length >= 1 && body.results.length <= 3, 'the limit holds')
  assert.deepEqual(body.results[0], {
    title: 'API access with OAuth clients',
    section: 'Platform',
    heading: 'Rotate the secret without downtime',
    url: h.url('apex', ROTATE),
    markdown: h.url('apex', '/docs/platform/api-and-service-accounts.md'),
    snippet: body.results[0].snippet,
  })
  assert.match(body.results[0].snippet, /Rotate secret makes a new secret/)
  assert.equal((await h.client().get(body.results[0].markdown)).status, 200, 'the Markdown is there')

  assert.equal(JSON.parse((await searchJson('?q=roles&limit=1')).text).results.length, 1)
  assert.ok(JSON.parse((await searchJson('?q=the&limit=999')).text).results.length <= 25, 'at most 25')
  assert.ok(JSON.parse((await searchJson('?q=the')).text).results.length <= 10, '10 by default')
  const missing = await searchJson('?q=%20')
  assert.equal(missing.status, 400)
  assert.equal(JSON.parse(missing.text).error, 'missing_query')
  assert.equal(missing.headers.get('access-control-allow-origin'), '*')
  const preflight = await h.client().request(h.url('apex', '/docs/search.json'), { method: 'OPTIONS', headers: { Origin: 'https://agent.example.com', 'Access-Control-Request-Method': 'GET' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS')
  assert.equal((await h.client().request(h.url('apex', '/docs/search.json?q=x'), { method: 'POST' })).status, 405)
})

test('the docs\' MCP server needs no sign-in: initialize, the three read-only tools, and the protocol\'s edges', async () => {
  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  assert.equal(init.status, 200, init.text)
  assert.equal(init.headers.get('www-authenticate'), null, 'no OAuth challenge')
  assert.equal(init.headers.get('access-control-allow-origin'), '*')
  assert.equal(init.json.result.protocolVersion, '2025-06-18')
  assert.equal(init.json.result.serverInfo.name, 'insulin-apps-docs')
  assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } })
  const newest = await mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal(newest.json.result.protocolVersion, '2025-11-25', 'an unknown version gets the newest')

  const listed = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  assert.deepEqual(listed.json.result.tools.map((tool) => tool.name), ['search_docs', 'read_doc', 'list_docs'])
  for (const tool of listed.json.result.tools) assert.equal(tool.annotations.readOnlyHint, true, tool.name)

  const searched = await call('search_docs', { query: 'rotate secret', limit: 2 })
  assert.equal(searched.isError, undefined)
  assert.ok(searched.structuredContent.results.length <= 2)
  assert.equal(searched.structuredContent.results[0].url, h.url('apex', ROTATE))
  assert.ok(searched.content[0].text.startsWith('2 pages for "rotate secret":\n\n1. API access with OAuth clients › Rotate the secret without downtime (Platform)\n'), searched.content[0].text.slice(0, 200))
  assert.equal((await call('search_docs', { query: 'zzqqxv' })).structuredContent.results.length, 0, 'nothing found is an answer, not an error')
  assert.equal((await call('search_docs', { query: '' })).isError, true)
  assert.equal((await call('search_docs', { query: 'roles', limit: 21 })).isError, true, 'at most 20')
  assert.equal((await call('search_docs', { query: 'roles', limit: 1.5 })).isError, true)

  const markdown = (await h.client().get(h.url('apex', '/docs/platform/ai-agents.md'))).text
  for (const page of ['/docs/platform/ai-agents', 'platform/ai-agents', h.url('apex', '/docs/platform/ai-agents.md#the-tools-an-agent-gets'), `${h.url('apex', '/docs/platform/ai-agents')}/`]) {
    const read = await call('read_doc', { page })
    assert.equal(read.isError, undefined, page)
    assert.equal(read.content[0].text, `Source: ${h.url('apex', '/docs/platform/ai-agents')}\n\n${markdown}`, `${page}: the page's Markdown`)
  }
  for (const page of ['/docs/platform/nothing-here', 'https://elsewhere.example.com/docs/platform/ai-agents', '/docs/', '/docs/search', '']) {
    assert.equal((await call('read_doc', { page })).isError, true, `${page || 'empty'}: not a page`)
  }

  const all = await call('list_docs')
  assert.deepEqual(all.structuredContent.sections.map((section) => section.title), docs.sections.map((section) => section.title))
  assert.deepEqual(all.structuredContent.sections.flatMap((section) => section.pages.map((page) => page.url)), docs.pages.map((page) => h.url('apex', page.path)))
  assert.ok(all.content[0].text.startsWith('## Platform\n\n- [Getting started]('))

  // The protocol's edges, as the apps' servers answer them.
  const note = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(note.status, 202)
  const batch = await mcp([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }])
  assert.deepEqual(batch.json.map((answer) => answer.id), ['a', 'b'])
  assert.equal((await mcp(Array.from({ length: 11 }, (_, index) => ({ jsonrpc: '2.0', id: index, method: 'ping' })))).status, 400, 'at most 10 in a batch')
  assert.equal((await mcp([])).status, 400)
  assert.equal((await mcp({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).json.error.code, -32601)
  assert.equal((await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'change' } })).json.error.code, -32602, 'only its own tools')
  const notJson = await h.client().request(h.url('apex', '/docs/mcp'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })
  assert.equal(notJson.status, 400)
  assert.equal(JSON.parse(notJson.text).error.code, -32700)
  const large = await h.client().request(h.url('apex', '/docs/mcp'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping', params: { pad: 'x'.repeat(70 * 1024) } }) })
  assert.equal(large.status, 413)
  const get = await h.client().get(h.url('apex', '/docs/mcp'))
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST, OPTIONS')
  const preflight = await h.client().request(h.url('apex', '/docs/mcp'), { method: 'OPTIONS', headers: { Origin: 'https://agent.example.com', 'Access-Control-Request-Method': 'POST' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  // A cross-site POST is fine here: no cookie is read, so the apex's form Origin check doesn't apply.
  const crossSite = await mcp({ jsonrpc: '2.0', id: 7, method: 'ping' }, { headers: { Origin: 'https://agent.example.com' } })
  assert.equal(crossSite.status, 200)
})

test('search, its JSON and the MCP server are limited per IP, and every tool call in a batch counts', async () => {
  const limited = await startGateway({ appLimit: 3 })
  try {
    const client = limited.client()
    for (let i = 0; i < 3; i++) assert.equal((await client.get(limited.url('apex', '/docs/search.json?q=roles'))).status, 200, `request ${i + 1}`)
    const json429 = await client.get(limited.url('apex', '/docs/search.json?q=roles'))
    assert.equal(json429.status, 429)
    assert.equal(json429.headers.get('retry-after'), '60')
    assert.equal((await client.get(limited.url('apex', '/docs/search?q=roles'))).status, 429, 'the page too')
    assert.equal((await json(client, limited.url('apex', '/docs/mcp'), { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 429, 'and the MCP server')
    assert.equal((await limited.client().get(limited.url('apex', '/docs/search.json?q=roles'))).status, 200, 'another address isn\'t held up')
    assert.equal((await limited.client().get(limited.url('apex', '/docs/platform/ai-agents'))).status, 200, 'reading the docs isn\'t limited')

    const batcher = limited.client()
    const calls = Array.from({ length: 4 }, (_, index) => ({ jsonrpc: '2.0', id: index, method: 'tools/call', params: { name: 'list_docs', arguments: {} } }))
    const answers = (await json(batcher, limited.url('apex', '/docs/mcp'), calls)).json
    assert.equal(answers.filter((answer) => answer.error?.code === -32000).length, 2, 'the request and two calls fit in 3; two calls more are refused')
  } finally {
    await limited.close()
  }
})
