import type { Html } from '../pages/html.ts'
import { jsonHeaders, pageHeaders } from './headers.ts'

export function htmlResponse(body: Html, options: { status?: number; index?: boolean; headers?: Record<string, string> } = {}): Response {
  const headers = pageHeaders({ index: options.index ?? false })
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)
  return new Response(body.value, { status: options.status ?? 200, headers })
}

export function jsonResponse(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  const headers = jsonHeaders()
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return new Response(JSON.stringify(data), { status, headers })
}

export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin' } })
}
