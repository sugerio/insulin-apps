// The screens' way to Knowledge's API (`/api/**`): JSON in and out, an Idempotency-Key on every change that creates
// something, and the API's errors kept whole (`{ error, message }`, and over a limit `limit` and `resets_at`) so a
// screen can say what happened in the API's own plain words. Nothing is decided here: the server checks every request.

export interface ApiErrorBody {
  error: string
  message: string
  limit?: string
  resets_at?: string | null
  retryAfterSeconds?: number
  [key: string]: unknown
}

export class ApiError extends Error {
  override name = 'ApiError'
  constructor(readonly status: number, readonly body: ApiErrorBody) {
    super(body.message)
  }

  get code(): string {
    return this.body.error
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError

/** What to say about any failure: the API's message, or plain words when the request never got an answer. */
export function describeError(error: unknown): string {
  if (isApiError(error)) return error.message
  return "Knowledge didn't answer. Check your connection and try again."
}

/** Over a limit (429 quota_exceeded): which limit, so a screen can open the awake-hours pop-up. */
export function quotaOf(error: unknown): { limit: string; resetsAt: string | null; message: string } | null {
  if (!isApiError(error) || error.code !== 'quota_exceeded') return null
  return { limit: String(error.body.limit ?? ''), resetsAt: error.body.resets_at ?? null, message: error.message }
}

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = null
  }
  if (!response.ok) {
    const fallback: ApiErrorBody = { error: 'unavailable', message: response.status >= 500 ? 'Knowledge had a problem. Try again in a minute.' : "That didn't work. Reload the page and try again." }
    const known = body && typeof body === 'object' && typeof (body as ApiErrorBody).message === 'string' ? (body as ApiErrorBody) : fallback
    throw new ApiError(response.status, known)
  }
  return body as T
}

async function request<T>(method: string, path: string, body?: unknown, options: { idempotent?: boolean; headers?: Record<string, string>; raw?: BodyInit; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
  let payload: BodyInit | undefined = options.raw
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  if (options.idempotent) headers['idempotency-key'] = newKey()
  let response: Response
  try {
    response = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal: options.signal })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new ApiError(0, { error: 'offline', message: "Knowledge didn't answer. Check your connection and try again." })
  }
  return parse<T>(response)
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, { signal }),
  /** A change that creates something: sent with a fresh Idempotency-Key. */
  create: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}, { idempotent: true }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  upload: <T>(path: string, file: Blob, name: string) =>
    request<T>('PUT', path, undefined, { raw: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(name) } }),
}

export const collectionPath = (id: string, rest = '') => `/api/collections/${encodeURIComponent(id)}${rest}`
