/**
 * Who may embed the signing page (/sign) and the editor (/editor/page/:id). The host that asks for a page's one-time
 * code (through the management API, as its organization) names the origin of the page that will frame it, and the
 * code is bound to it: the signing page's `allowedParentOrigin` on recipient-view, the editor's on its editing session.
 * There is no deployment-wide list. Then:
 *
 * - the page's CSP `frame-ancestors` names that origin (page-policy.ts: the signing link carries it as `?host=`, the
 *   editor's comes from its session);
 * - the page reports who embeds it (the browser's `location.ancestorOrigins`, else the referrer's origin, else nobody)
 *   when it exchanges its code, and the exchange refuses a page framed by any other origin. A framing page can't
 *   change what the browser reports to the framed page, so a page loaded by another site gets no session and shows
 *   nothing;
 * - the signing page tells only that origin that the signer closed, signed or declined (the exchange returns it).
 */
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
