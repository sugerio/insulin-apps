// The header a signing page or an embedded editor sends its page session in: `x-esign-session: <64 hex>`. Not
// Authorization, because the platform's gateway forwards public paths without it (an identity never travels there),
// and not an x-suger-* name, because the gateway strips those.
export const SESSION_HEADER = 'x-esign-session';

/** The page session a request carries, or '' when it carries none (or something that isn't one). */
export function sessionToken(headers: { get(name: string): string | null } | ((name: string) => string | undefined)): string {
  const value = typeof headers === 'function' ? headers(SESSION_HEADER) : headers.get(SESSION_HEADER);
  return /^[a-f0-9]{64}$/.test(value ?? '') ? value! : '';
}
