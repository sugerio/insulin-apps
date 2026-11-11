// /docs/ on the apex: the public documentation, open to everyone and indexable. The pages are generated from the
// repository's Markdown at build time (scripts/build-docs.mjs → src/assets/docs-content.ts); the top bar shows the
// visitor's sign-in links or account. Images come from the Worker's static-assets binding (DOCS_ASSETS, the directory
// .github/hosting/docs/assets/), and /docs/assets/* is the only way anything in that binding is served.
import { DOCS_LLMS_TXT, DOCS_ORIGIN_TOKEN as ORIGIN_TOKEN, DOCS_PAGES, DOCS_SECTIONS } from './assets/docs-content.ts'
import { loadSession } from './auth/session.ts'
import type { Context } from './context.ts'
import { apexUrl } from './context.ts'
import { assetHeaders } from './http/headers.ts'
import { htmlResponse, redirect } from './http/response.ts'
import { accountOf } from './pages/document.tsx'
import { docsDocument } from './pages/docs.tsx'
import { notFoundPage } from './pages/status.tsx'

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

export async function docs(ctx: Context): Promise<Response> {
  const path = ctx.url.pathname
  if (path.startsWith('/docs/assets/')) return docsAsset(ctx)
  if (path === '/docs/llms.txt') return text(DOCS_LLMS_TXT.replaceAll(ORIGIN_TOKEN, apexUrl(ctx, '')))
  if (path === '/docs/llms-full.txt') return text(llmsFull(ctx))
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
