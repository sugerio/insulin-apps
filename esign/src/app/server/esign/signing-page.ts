/**
 * Who may embed the signing page (/sign) and the editor (/editor/page/:id). Both are pages of the
 * app's single-page build, served as static files, so their response headers can't name the host
 * origins of a deployment. Instead:
 *
 * - the deployment lists the host origins in ESIGN_FRAME_ANCESTORS (space-separated);
 * - the page reports who embeds it (the browser's `location.ancestorOrigins`, else the referrer's
 *   origin, else nobody) when it exchanges its one-time code, and the exchange refuses a page
 *   framed by any other origin. A framing page can't change what the browser reports to the framed
 *   page, so a page loaded by an unlisted site gets no session and shows nothing;
 * - the page tells only a listed host that the signer closed, signed or declined
 *   (`GET /api/public/signing/config`).
 */
const MAX_ANCESTORS = 10;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The origins allowed to frame the pages, from a space-separated list. Anything that is not a bare
 * https origin, or http on a loopback host, is dropped; with `httpsOnly` (prod), http on a loopback
 * host is dropped too.
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
 * Whether a page may open a session, from what it reports: `embedded` (it runs in a frame), `embedder` (the origin of
 * the page framing it, as the browser tells it, or '' when it can't tell) and, where the browser lists them,
 * `embedders` (every ancestor's origin, nearest first: location.ancestorOrigins). A page that isn't framed may; a framed
 * one only when every ancestor it reports is the app itself or one of `allowed`, so neither a frame whose origin the
 * browser hides nor an allowed page that is itself framed by a stranger gets a session.
 */
export function embedderAllowed(report: { embedded?: unknown; embedder?: unknown; embedders?: unknown }, ownOrigin: string, allowed: readonly string[]): boolean {
  if (report.embedded !== true) return true;
  const ok = (origin: unknown) => typeof origin === 'string' && (origin === ownOrigin || allowed.includes(origin));
  if (report.embedders !== undefined) {
    const list = report.embedders;
    if (!Array.isArray(list) || list.length === 0 || list.length > 10 || !list.every(ok)) return false;
    // The nearest ancestor is the embedder the page also names.
    if (report.embedder !== undefined && report.embedder !== list[0]) return false;
    return true;
  }
  return ok(report.embedder);
}
