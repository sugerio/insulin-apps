/**
 * What the signing page tells the host application that embeds it: the signer closed the page,
 * or signed or declined. The messages carry no token, address or signing data. The page posts
 * them only to the host the signing link names (`#code=…&host=<origin>`), and only when that
 * origin is one the Worker allows to frame the page (`<meta name="esign-hosts">`) and, where the
 * browser reports it, the origin of the page that frames it.
 */
export type SigningHostMessage =
  | { type: 'esign.signing.cancel' }
  | { type: 'esign.signing.finished'; outcome: 'signed' | 'declined' };

const ORIGIN = /^https?:\/\/[^/?#\s]+$/;

/**
 * The host to report to, or '' when the page must not report: not framed, no `host` in the link,
 * `host` not among the allowed origins, or not the origin of the framing page.
 */
export function signingHost(requested: string | null, allowed: string, framed: boolean, ancestor?: string): string {
  if (!framed || !requested || !ORIGIN.test(requested)) return '';
  if (!allowed.split(/\s+/).includes(requested)) return '';
  if (ancestor !== undefined && ancestor !== requested) return '';
  return requested;
}

/** Reads a host's incoming message: the signing page's own message from that frame, or null. */
export function readSigningHostMessage(event: { origin: string; source: unknown; data: unknown }, pageOrigin: string, frame: unknown): SigningHostMessage | null {
  if (!frame || event.source !== frame || event.origin !== pageOrigin) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.type === 'esign.signing.cancel' && Object.keys(value).length === 1) return { type: 'esign.signing.cancel' };
  if (value.type === 'esign.signing.finished' && (value.outcome === 'signed' || value.outcome === 'declined') && Object.keys(value).length === 2) {
    return { type: 'esign.signing.finished', outcome: value.outcome };
  }
  return null;
}
