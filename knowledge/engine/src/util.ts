// Small helpers: the clock (replaceable in tests), hashes, ids and time.

export const clock = {
  now: (): number => Date.now(),
  wait: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
}

export const iso = (ms: number = clock.now()): string => new Date(ms).toISOString()

export const utcDay = (ms: number = clock.now()): string => new Date(ms).toISOString().slice(0, 10)

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A document id that is the same on every try of an import, so a retry never adds a second copy. */
export async function documentIdFor(kind: 'file' | 'note', importId: string, itemId: string): Promise<string> {
  return `${kind === 'file' ? 'd' : 'n'}_${(await sha256Hex(`${importId}\0${itemId}`)).slice(0, 24)}`
}

export const randomId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`

export const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
