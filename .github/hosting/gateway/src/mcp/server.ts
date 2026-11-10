// Each app's MCP server, at https://<app>.<domain>/mcp (DESIGN.md §5.2): stateless Streamable HTTP, JSON-RPC answered
// with JSON. Four tools reach the app's own API as the person who connected the client, with their role at the time of
// each call: `whoami`, `endpoints` (the app's GET /api/catalog), `read` (GET) and `change` (POST, PUT, PATCH, DELETE).
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { originOf } from '../context.ts'
import { jsonResponse } from '../http/response.ts'
import { log, logError } from '../log.ts'
import { allowApp } from '../ratelimit.ts'
import { bearerHeaders, isAppApiPath, unauthorized } from '../oauth/app-api.ts'
import { CORS, preflight, readJson } from '../oauth/http.ts'
import { bearerToken, resolveBearer, type BearerIdentity } from '../oauth/tokens.ts'

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const BODY_LIMIT_BYTES = 1024 * 1024
export const RESULT_LIMIT_BYTES = 200 * 1024
const CHANGE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const
const METADATA_PATH = '/.well-known/oauth-protected-resource/mcp'

type JsonRpcId = string | number
interface JsonRpcError { code: number; message: string }

const TOOLS = [
  {
    name: 'whoami',
    title: 'Who am I',
    description: 'Who this connection acts as: the person, the organization, the app, and their role and permissions in it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'endpoints',
    title: 'List the API',
    description: 'The app\'s API: each endpoint\'s method, path, summary, and query or body schema, as far as your role may use it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read',
    title: 'Read',
    description: 'GET an endpoint of the app\'s API (a path under /api/), with optional query parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path, starting with /api/.' },
        query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Query parameters.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'change',
    title: 'Change',
    description: 'POST, PUT, PATCH or DELETE an endpoint of the app\'s API (a path under /api/), with an optional JSON body. Changes are real and made as you.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: [...CHANGE_METHODS] },
        path: { type: 'string', description: 'The path, starting with /api/.' },
        query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        body: { description: 'The JSON body, if the endpoint takes one.' },
        idempotencyKey: { type: 'string', description: 'Sent as Idempotency-Key, for endpoints that ask for one.', maxLength: 200 },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
]

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: JsonRpcId | null, error: JsonRpcError) {
  return { jsonrpc: '2.0', id, error }
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return jsonResponse(data, status, { ...CORS, ...extra })
}

/** RFC 9728 metadata for the app's MCP resource (`/mcp`) or, at the root, its API (service accounts' tokens). */
export function protectedResourceMetadata(ctx: Context, app: HostedApp, mcp: boolean): Response {
  const origin = originOf(ctx, app.host)
  return json({
    resource: mcp ? `${origin}/mcp` : origin,
    authorization_servers: [originOf(ctx, ctx.config.domain)],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_name: app.title,
  }, 200, { 'Cache-Control': 'public, max-age=300' })
}

export async function mcpEndpoint(ctx: Context, app: HostedApp): Promise<Response> {
  const method = ctx.request.method
  if (method === 'OPTIONS') return preflight('POST, OPTIONS')
  if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST, OPTIONS' })
  if (!app.service) return json({ error: 'unavailable' }, 503)
  const token = bearerToken(ctx.request)
  if (!token) return unauthorized(ctx, app, METADATA_PATH, null)
  const identity = await resolveBearer(ctx, app, token)
  if ('refused' in identity) {
    return identity.refused === 'no_access' ? json({ error: 'no_app_access' }, 403) : unauthorized(ctx, app, METADATA_PATH, 'invalid_token')
  }
  if (identity.kind !== 'person') return unauthorized(ctx, app, METADATA_PATH, 'invalid_token')
  if (!(await allowApp(ctx, identity.actor.id))) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' })

  const body = await readJson(ctx, BODY_LIMIT_BYTES)
  if (body instanceof Response) return body
  if (body === undefined) return json(rpcError(null, { code: -32700, message: 'Send a JSON-RPC message as application/json.' }), 400)
  if (Array.isArray(body)) {
    if (!body.length) return json(rpcError(null, { code: -32600, message: 'Empty batch.' }), 400)
    const answers = (await Promise.all(body.map((message) => handleMessage(ctx, app, identity, message)))).filter((answer) => answer !== null)
    return answers.length ? json(answers) : new Response(null, { status: 202, headers: CORS })
  }
  const answer = await handleMessage(ctx, app, identity, body)
  return answer === null ? new Response(null, { status: 202, headers: CORS }) : json(answer)
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

async function handleMessage(ctx: Context, app: HostedApp, identity: Extract<BearerIdentity, { kind: 'person' }>, message: unknown): Promise<object | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, { code: -32600, message: 'Not a JSON-RPC message.' })
  const { jsonrpc, method, id, params } = message as Record<string, unknown>
  if (jsonrpc !== '2.0' || typeof method !== 'string') return isId(id) || id === undefined ? rpcError(isId(id) ? id : null, { code: -32600, message: 'Not a JSON-RPC 2.0 request.' }) : null
  // A notification (no id), or a response to something we never asked: nothing to answer.
  if (id === undefined) return null
  if (!isId(id)) return rpcError(null, { code: -32600, message: 'The id must be a string or a number.' })
  const args = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>
  switch (method) {
    case 'initialize': {
      const asked = typeof args.protocolVersion === 'string' ? args.protocolVersion : ''
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `insulin-apps-${app.name}`, title: `${app.title} on Insulin Apps`, version: '1.0.0' },
        instructions: `This connection uses ${app.title}'s API as ${identity.actor.name}, with their role there. Call "endpoints" first to see what the API offers, then "read" and "change". Changes are real.`,
      })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS })
    case 'tools/call': {
      const name = args.name
      const input = (args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {}) as Record<string, unknown>
      if (typeof name !== 'string' || !TOOLS.some((tool) => tool.name === name)) return rpcError(id, { code: -32602, message: `Unknown tool: ${String(name).slice(0, 40)}` })
      return rpcResult(id, await callTool(ctx, app, identity, name, input))
    }
    default:
      return rpcError(id, { code: -32601, message: `Method not found: ${method.slice(0, 60)}` })
  }
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function toolResult(data: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, ...(isError ? { isError: true } : {}) }
}

function toolProblem(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

async function callTool(ctx: Context, app: HostedApp, identity: Extract<BearerIdentity, { kind: 'person' }>, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (name === 'whoami') {
    const org = await ctx.config.db.prepare('SELECT name FROM orgs WHERE id = ?1').bind(identity.orgId).first<{ name: string }>()
    return toolResult({
      user: { id: identity.actor.id, name: identity.actor.name, email: identity.actor.email },
      organization: { id: identity.orgId, name: org?.name ?? null },
      app: { name: app.name, title: app.title },
      role: identity.access.role,
      roleLabel: identity.access.label,
      permissions: identity.access.permissions,
      client: identity.clientName,
    })
  }
  if (name === 'endpoints') {
    const answer = await callApp(ctx, app, identity, 'GET', '/api/catalog', undefined, undefined, undefined, 'endpoints')
    if ('problem' in answer) return toolProblem(answer.problem)
    if (answer.status === 404) return toolProblem(`${app.title} doesn't publish an API catalog. Its API is under /api/; use "read" and "change" with the paths you know.`)
    return toolResult(answer, answer.status >= 400)
  }
  const method = name === 'read' ? 'GET' : typeof input.method === 'string' ? input.method.toUpperCase() : ''
  if (name === 'change' && !(CHANGE_METHODS as readonly string[]).includes(method)) return toolProblem('Choose the method: POST, PUT, PATCH or DELETE.')
  if (typeof input.path !== 'string') return toolProblem('Give the path, starting with /api/.')
  if (input.query !== undefined && (typeof input.query !== 'object' || input.query === null || Array.isArray(input.query))) return toolProblem('The query must be an object of names and values.')
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(input.idempotencyKey))) {
    return toolProblem('The idempotency key must be 1-200 visible ASCII characters.')
  }
  const answer = await callApp(ctx, app, identity, method, input.path, input.query as Record<string, unknown> | undefined,
    name === 'change' ? input.body : undefined, input.idempotencyKey as string | undefined, name)
  if ('problem' in answer) return toolProblem(answer.problem)
  return toolResult(answer, answer.status >= 400)
}

type AppAnswer = { status: number; contentType: string | null; body: unknown; truncated?: true } | { problem: string }

/** One request to the app as the person; the answer's body is parsed when it is JSON and cut after 200 KB. */
async function callApp(ctx: Context, app: HostedApp, identity: Extract<BearerIdentity, { kind: 'person' }>, method: string, path: string,
  query: Record<string, unknown> | undefined, body: unknown, idempotencyKey: string | undefined, tool: string): Promise<AppAnswer> {
  const origin = originOf(ctx, app.host)
  if (path.length > 2048 || !path.startsWith('/api/') || /[\\#]/.test(path) || path.startsWith('//')) return { problem: 'The path must start with /api/.' }
  let url: URL
  try {
    url = new URL(path, origin)
  } catch {
    return { problem: 'That path isn\'t valid.' }
  }
  if (url.origin !== origin || !isAppApiPath(url.pathname)) return { problem: 'Only the app\'s own API is reachable: paths under /api/, except /api/__suger/.' }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) return { problem: `The query parameter "${key.slice(0, 40)}" must be a string, number or boolean.` }
    url.searchParams.set(key, String(value))
  }
  const headers = new Headers(bearerHeaders(ctx, app, identity, 'mcp'))
  headers.set('Accept', 'application/json')
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
  let payload: string | undefined
  if (body !== undefined && method !== 'GET') {
    payload = JSON.stringify(body)
    headers.set('Content-Type', 'application/json')
  }
  let upstream: Response
  try {
    upstream = await app.service!.fetch(new Request(url.href, { method, headers, body: payload, redirect: 'manual' }))
  } catch (error) {
    logError('app_unreachable', error, { app: app.name })
    return { problem: `${app.title} isn't reachable right now. Try again in a minute.` }
  }
  log('mcp_call', { grant: identity.grantId, app: app.name, tool, method, status: upstream.status })
  const { text, truncated } = await readLimited(upstream, RESULT_LIMIT_BYTES)
  const contentType = upstream.headers.get('Content-Type')
  let parsed: unknown = text
  if (!truncated && /\bjson\b/i.test(contentType ?? '')) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  return { status: upstream.status, contentType, body: parsed, ...(truncated ? { truncated: true as const } : {}) }
}

/** The body as text, at most `limit` bytes; the rest is left unread. */
export async function readLimited(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total))
      total = limit
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), truncated }
}
