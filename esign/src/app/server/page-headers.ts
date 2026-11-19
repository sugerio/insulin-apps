// The pages' security headers: Nitro renders the same index.html for every path that isn't /api/** or a built asset, and
// this middleware (registered in nitro.config.ts) gives each page the headers its audience needs. The policy itself is
// in page-policy.ts, which the tests import directly.
import { onResponse } from 'nitro/h3'
import { openAppD1 } from '#platform'
import { pageHeaders } from './page-policy.ts'

export default onResponse(async (response, event) => {
  // A built file that isn't there (a page still running the version before a deploy asks for one of its parts) is not
  // found: never the page's HTML, which the browser would refuse as a script and the page couldn't tell apart.
  if (event.url.pathname.startsWith('/assets/') && /^text\/html\b/i.test(response.headers.get('content-type') ?? '')) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  }
  const headers = await pageHeaders(event.url.pathname, response.headers.get('content-type'), {
    signingHost: event.url.searchParams.get('host'),
    viaGateway: event.req.headers.get('x-suger-access-via') !== null,
    editorParent: async (pageId) => {
      try {
        const db = await openAppD1()
        const row = await db.prepare('SELECT parent_origin FROM editor_sessions WHERE id = ?').bind(pageId).first<{ parent_origin: string }>()
        return row?.parent_origin ?? null
      } catch { return null }
    },
  })
  if (!headers) return
  const out = new Headers(response.headers)
  for (const [name, value] of Object.entries(headers)) out.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out })
})
