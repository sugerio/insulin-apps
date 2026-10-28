// Structured log lines. Fields carry event names, ids, counts and error codes only: never passwords, tokens, cookies,
// e-mail addresses, request bodies or exception messages (a message can quote a URL, a key or an address).

type Field = string | number | boolean | null | undefined

export function log(event: string, fields: Record<string, Field> = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}

// Error names that say what failed without saying anything about the data involved.
const KNOWN_ERRORS = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError', 'TimeoutError', 'BodyTooLarge',
])

/**
 * Logs a failure by its class only: a known error name, an identifier-like code (`E_RATE_LIMIT_EXCEEDED`) and the
 * identifier a message starts with (`D1_ERROR:` gives `D1_ERROR`). The message itself is never written.
 */
export function logError(event: string, error: unknown, fields: Record<string, Field> = {}): void {
  const name = error instanceof Error && KNOWN_ERRORS.has(error.name) ? error.name : 'unknown'
  const kind = error instanceof Error ? /^([A-Z][A-Z0-9_]{1,40}):/.exec(error.message)?.[1] ?? null : null
  const code = errorCode(error)
  console.error(JSON.stringify({ event, ...fields, error: name, ...(kind ? { kind } : {}), ...(code === 'unknown' ? {} : { code }) }))
}

/** A short identifier-like code from a thrown error (`E_RATE_LIMIT_EXCEEDED`), or `unknown`. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'unknown'
}
