// Where an authorization may send the browser back to (DESIGN.md §5.2): a program on the same computer, listening on a
// loopback address (RFC 8252 §7.3, any port and path), or one of the hosted connectors listed here.

/** Hosted MCP connectors' registered callbacks, compared exactly. */
export const HOSTED_CALLBACKS: ReadonlySet<string> = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
])

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parse(uri: string): URL | null {
  if (uri.length > 2048) return null
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

/** http on localhost, 127.0.0.1 or [::1], without credentials or a fragment. */
export function isLoopback(uri: string): boolean {
  const url = parse(uri)
  return url !== null && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password && !url.hash
    && !uri.includes('#')
}

export function isAllowedRedirect(uri: string): boolean {
  return isLoopback(uri) || HOSTED_CALLBACKS.has(uri)
}
