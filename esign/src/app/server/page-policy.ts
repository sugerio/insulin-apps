// What each page's HTML is sent with (page-headers.ts applies it). Every page: a Content-Security-Policy that loads
// scripts, styles, workers and data only from this origin (images and frames also from blob: and data:, for the PDF
// previews and downloads); React's style attributes need 'unsafe-inline' for styles, and nothing needs eval.
//
// Who may frame a page depends on its audience:
// - the signing page (/sign): this origin and the hosts in ESIGN_FRAME_ANCESTORS;
// - the embedded editor (/editor/page/<id>): this origin and the session's parent (or ESIGN_FRAME_ANCESTORS);
// - the signed-copy page (/copy) and the members' pages: nobody, so a page elsewhere can't frame them and trick a
//   signed-in member into sending or voiding (clickjacking).
// frame-ancestors is sent only when the request came through insulinapps.com's gateway (it sets x-suger-access-via):
// the Insulin console frames the app in its own preview, and decides that itself.

export type PageKind = 'signing' | 'editor' | 'copy' | 'member'

const EDITOR_PAGE = /^\/editor\/page\/([a-f0-9]{64})\/?$/
const ORIGIN = /^https?:\/\/[^/?#\s'";]+$/

/** The page a path shows, or null for what isn't a page (the API and the built assets). */
export function pageKind(pathname: string): PageKind | null {
  if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/assets/')) return null
  if (pathname === '/sign' || pathname === '/sign/') return 'signing'
  if (EDITOR_PAGE.test(pathname)) return 'editor'
  if (pathname === '/copy' || pathname === '/copy/') return 'copy'
  return 'member'
}

/** The origins in a space-separated list that are origins (anything else is dropped, never passed into the policy). */
export function originsIn(list: string): string[] {
  return list.split(/\s+/).filter((origin) => ORIGIN.test(origin))
}

const BASE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
]

export type PageContext = {
  /** ESIGN_FRAME_ANCESTORS: the hosts allowed to frame the signing page and, by default, the editor. */
  frameAncestors: string
  /** The parent origin an editor session was opened for, or null. */
  editorParent: (pageId: string) => Promise<string | null>
  /** Whether the request came through insulinapps.com's gateway (x-suger-access-via is set). */
  viaGateway: boolean
}

/** The headers for a page's HTML response, or null when the response isn't a page. */
export async function pageHeaders(pathname: string, contentType: string | null, context: PageContext): Promise<Record<string, string> | null> {
  const kind = pageKind(pathname)
  if (!kind || !/^text\/html\b/i.test(contentType ?? '')) return null
  let ancestors: string | null = null
  if (kind === 'signing') ancestors = ["'self'", ...originsIn(context.frameAncestors)].join(' ')
  else if (kind === 'editor') {
    const parent = await context.editorParent(EDITOR_PAGE.exec(pathname)![1]!)
    ancestors = ["'self'", ...(parent && ORIGIN.test(parent) ? [parent] : originsIn(context.frameAncestors))].join(' ')
  } else ancestors = "'none'"
  const policy = [...BASE, kind === 'member' ? "frame-src 'self' blob:" : "frame-src 'none'", ...(context.viaGateway ? [`frame-ancestors ${ancestors}`] : [])]
  const headers: Record<string, string> = {
    'Content-Security-Policy': policy.join('; '),
    'X-Content-Type-Options': 'nosniff',
  }
  if (kind === 'member') headers['Referrer-Policy'] = 'same-origin'
  else {
    // Codes and tokens travel in the fragment, which browsers never send; no-referrer and no-store keep the rest private.
    headers['Cache-Control'] = 'no-store'
    headers['Referrer-Policy'] = 'no-referrer'
  }
  return headers
}
