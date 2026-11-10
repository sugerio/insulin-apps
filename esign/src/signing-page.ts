/**
 * The recipient signing page, served by the Worker itself so that it can be embedded in an
 * <iframe> by the host application (for example a product's console), with the API on the page's own origin.
 * The host builds `<origin>/sign#code=<code>&host=<its own origin>` from a recipient-view code
 * issued for this origin, the Worker's own (the default when the request names none). `host` is
 * where the page reports that the signer closed it, signed or declined; it must be an origin
 * allowed to frame the page.
 */

const MAX_ANCESTORS = 10;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The origins allowed to frame the page, from a space-separated list. Anything that is not a
 * bare https origin, or http on a loopback host, is dropped; with `httpsOnly` (prod), http on a
 * loopback host is dropped too.
 */
export function frameAncestors(raw: string | undefined, httpsOnly = false): string[] {
  const out: string[] = [];
  for (const value of (raw ?? '').split(/\s+/)) {
    if (!value) continue;
    let url: URL;
    try { url = new URL(value); } catch { continue; }
    const secure = url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:' && LOOPBACK.has(url.hostname));
    if (!secure || url.origin !== value || out.includes(value)) continue;
    out.push(value);
    if (out.length === MAX_ANCESTORS) break;
  }
  return out;
}

/**
 * Headers that let a cross-origin-isolated host (COEP require-corp) embed this page, and
 * load its assets. Harmless for hosts that are not isolated.
 */
export const EMBEDDABLE_HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
} as const;

/** Builds the page from the built recipient UI (index.html). Null when it is unavailable. */
export async function signingPage(request: Request, assets: Fetcher | undefined, rawAncestors: string | undefined, httpsOnly = false): Promise<Response | null> {
  if (!assets) return null;
  const source = await assets.fetch(new Request(new URL('/index.html', request.url)));
  if (!source.ok) return null;
  const html = await source.text();
  if (!html.includes('<head>')) return null;
  const origin = new URL(request.url).origin;
  const allowed = frameAncestors(rawAncestors, httpsOnly);
  // Declares that this page's own origin serves the signing API, and which hosts may frame it: the
  // page tells only one of those that the signer closed, signed or declined (see ui/RecipientPage.ts).
  const page = html.replace('<head>', `<head><meta name="esign-api" content="${origin}"><meta name="esign-hosts" content="${[origin, ...allowed].join(' ')}">`);
  const ancestors = ["'self'", ...allowed].join(' ');
  return new Response(page, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${ancestors}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...EMBEDDABLE_HEADERS,
    },
  });
}

/**
 * The demo page (ui/DemoPage.ts): drives the API with a pasted tenant key, so it is never
 * framed by another site; it embeds this origin's own signing page, editor and PDFs.
 */
export async function demoPage(request: Request, assets: Fetcher | undefined): Promise<Response | null> {
  if (!assets) return null;
  const source = await assets.fetch(new Request(new URL('/demo.html', request.url)));
  if (!source.ok) return null;
  return new Response(source.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
