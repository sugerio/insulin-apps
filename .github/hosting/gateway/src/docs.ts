// /docs/ on the apex: the public documentation, open to everyone and indexable. The pages are generated from the
// repository's Markdown at build time (scripts/build-docs.mjs → src/assets/docs-content.ts); the top bar shows the
// visitor's sign-in links or account. Images come from the Worker's static-assets binding (DOCS_ASSETS, the directory
// .github/hosting/docs/assets/), and /docs/assets/* is the only way anything in that binding is served. /docs/search
// and /docs/search.json search the pages (docs-search.ts), for anyone and limited per IP; the search page isn't indexed.
import { DOCS_LLMS_TXT, DOCS_ORIGIN_TOKEN as ORIGIN_TOKEN, DOCS_PAGES, DOCS_SECTIONS } from './assets/docs-content.ts'
import { loadSession } from './auth/session.ts'
import type { Context } from './context.ts'
import { apexUrl } from './context.ts'
import { QUERY_LIMIT, searchDocs, type DocsResult } from './docs-search.ts'
import { assetHeaders } from './http/headers.ts'
import { htmlResponse, jsonResponse, redirect } from './http/response.ts'
import { CORS } from './oauth/http.ts'
import { accountOf } from './pages/document.tsx'
import { docsDocument } from './pages/docs.tsx'
import { docsSearchDocument } from './pages/docs-search.tsx'
import { notFoundPage, rateLimitedPage } from './pages/status.tsx'
import { allowPublic } from './ratelimit.ts'

/** Images only, in lower-case paths: no dot segment, no percent-encoding, nothing but what the docs reference. */
const ASSET = /^\/docs\/assets\/((?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_.-]*\.(png|svg|jpg|jpeg|webp))$/
const ASSET_TYPES: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}
// The pages link each image with ?v=<its content hash>, so a changed image gets a new address and can be cached for good.
const ASSET_CACHE = 'public, max-age=31536000, immutable'
const TEXT_CACHE = 'public, max-age=300'
const PAGE_RESULTS = 20
const JSON_RESULTS = 10
const JSON_RESULTS_MAX = 25

export async function docs(ctx: Context): Promise<Response> {
  const path = ctx.url.pathname
  if (path.startsWith('/docs/assets/')) return docsAsset(ctx)
  if (path === '/docs/llms.txt') return llmsTxt(ctx)
  if (path === '/docs/llms-full.txt') return llmsFullTxt(ctx)
  if (path === '/docs/search') return searchPage(ctx)
  if (path.endsWith('.md')) {
    const page = DOCS_PAGES[path.slice(0, -'.md'.length)]
    return page?.markdown ? text(page.markdown) : notFoundPage(ctx)
  }
  const key = path === '/docs' ? '/docs/' : path
  const page = DOCS_PAGES[key]
  if (page) {
    const session = await loadSession(ctx)
    const user = session?.user.verified ? accountOf(session) : null
    return htmlResponse(docsDocument(ctx, page, apexUrl(ctx, key), user), { index: true })
  }
  // /docs/<section> leads to the section's first page; a page asked for with a trailing slash, to its address.
  const section = /^\/docs\/([a-z0-9-]+)\/?$/.exec(path)
  if (section && DOCS_SECTIONS[section[1]!]) return redirect(apexUrl(ctx, DOCS_SECTIONS[section[1]!]!), 302)
  if (path.endsWith('/') && DOCS_PAGES[path.slice(0, -1)]) return redirect(apexUrl(ctx, path.slice(0, -1)), 301)
  return notFoundPage(ctx)
}

function text(body: string): Response {
  return new Response(body, { headers: assetHeaders('text/plain; charset=utf-8', TEXT_CACHE) })
}

/** llms.txt: every page with its description, and how to search them; at /docs/llms.txt and at the root. */
export function llmsTxt(ctx: Context): Response {
  return text(DOCS_LLMS_TXT.replaceAll(ORIGIN_TOKEN, apexUrl(ctx, '')))
}

/** llms-full.txt: every page's Markdown; at /docs/llms-full.txt and at the root. */
export function llmsFullTxt(ctx: Context): Response {
  return text(llmsFull(ctx))
}

/** The query in `q`, trimmed and cut at QUERY_LIMIT characters ('' when there is none). */
function queryOf(ctx: Context): string {
  return (ctx.url.searchParams.get('q') ?? '').trim().slice(0, QUERY_LIMIT).trim()
}

async function searchPage(ctx: Context): Promise<Response> {
  if (!(await allowPublic(ctx))) return rateLimitedPage(ctx)
  const query = queryOf(ctx)
  const session = await loadSession(ctx)
  const user = session?.user.verified ? accountOf(session) : null
  return htmlResponse(docsSearchDocument(ctx, query, query ? searchDocs(query, PAGE_RESULTS) : [], user))
}

/** A result for programs and agents: the addresses in full, the page's and its Markdown's. */
export function resultForAgents(ctx: Context, result: DocsResult) {
  return {
    title: result.title,
    section: result.section,
    heading: result.heading,
    url: apexUrl(ctx, result.anchor ? `${result.path}#${result.anchor}` : result.path),
    markdown: apexUrl(ctx, `${result.path}.md`),
    snippet: result.snippet,
  }
}

/** GET /docs/search.json?q=&limit=: the search as JSON, for any origin (an APEX_MACHINE endpoint, router.ts). */
export async function docsSearchJson(ctx: Context): Promise<Response> {
  if (!(await allowPublic(ctx))) return jsonResponse({ error: 'rate_limited', error_description: 'Too many requests. Try again in a minute.' }, 429, { ...CORS, 'Retry-After': '60' })
  const query = queryOf(ctx)
  if (!query) return jsonResponse({ error: 'missing_query', error_description: 'Give the words to search for in q.' }, 400, CORS)
  const asked = Number.parseInt(ctx.url.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), JSON_RESULTS_MAX) : JSON_RESULTS
  const results = searchDocs(query, limit).map((result) => resultForAgents(ctx, result))
  return jsonResponse({ query, results }, 200, { ...CORS, 'Cache-Control': 'public, max-age=300' })
}

let full: string | null = null

/** Every page's Markdown in reading order, after a header. */
function llmsFull(ctx: Context): string {
  full ??= [
    '# Insulin Apps documentation, every page',
    '',
    `> The full text of ${ORIGIN_TOKEN}/docs/. ${ORIGIN_TOKEN}/docs/llms.txt lists the pages.`,
    '',
    ...Object.entries(DOCS_PAGES).filter(([, page]) => page.markdown).map(([path, page]) => `---\n\nSource: ${ORIGIN_TOKEN}${path}\n\n${page.markdown}`),
  ].join('\n')
  return full.replaceAll(ORIGIN_TOKEN, apexUrl(ctx, ''))
}

async function docsAsset(ctx: Context): Promise<Response> {
  const match = ASSET.exec(ctx.url.pathname)
  const binding = ctx.env.DOCS_ASSETS
  if (!match || !binding) return notFoundPage(ctx)
  const method = ctx.request.method === 'HEAD' ? 'HEAD' : 'GET'
  const conditional = new Headers()
  const tag = ctx.request.headers.get('If-None-Match')
  if (tag) conditional.set('If-None-Match', tag)
  const found = await binding.fetch(new Request(`https://docs-assets.invalid/${match[1]}`, { method, headers: conditional }))
  if (found.status !== 200 && found.status !== 304) {
    await found.body?.cancel()
    return notFoundPage(ctx)
  }
  const headers = assetHeaders(ASSET_TYPES[match[2]!]!, ASSET_CACHE)
  const etag = found.headers.get('ETag')
  if (etag) headers.set('ETag', etag)
  if (found.status === 304 || method === 'HEAD') {
    await found.body?.cancel()
    return new Response(null, { status: found.status, headers })
  }
  return new Response(found.body, { status: 200, headers })
}
