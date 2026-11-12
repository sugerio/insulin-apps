// The docs' MCP server, https://<domain>/docs/mcp (DESIGN.md §1; .github/hosting/docs/searching-the-docs.md): public,
// read only and without sign-in, for any agent. Stateless Streamable HTTP, JSON-RPC answered with JSON, as the apps'
// servers (server.ts), with three tools over the public docs: `search_docs`, `read_doc` and `list_docs`. It reaches no
// organization and no app; requests are limited per IP, and every tool call in a batch counts again.
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { resultForAgents } from '../docs.ts'
import { QUERY_LIMIT, docsSections, findDocsPage, searchDocs } from '../docs-search.ts'
import { jsonResponse } from '../http/response.ts'
import { CORS, readJson } from '../oauth/http.ts'
import { allowPublic } from '../ratelimit.ts'
import { PROTOCOL_VERSIONS, isId, rpcError, rpcResult, toolProblem, type ToolResult } from './server.ts'

const BODY_LIMIT_BYTES = 64 * 1024
const BATCH_LIMIT = 10
const SEARCH_RESULTS = 8
const SEARCH_RESULTS_MAX = 20

const TOOLS = [
  {
    name: 'search_docs',
    title: 'Search the docs',
    description: 'Search the Insulin Apps documentation: the platform (accounts, organizations and roles, sign-in and security, AI agents over MCP, the API with OAuth clients, integrations) and each app. Returns the best pages, each with its section, the heading where the words are, its address and a passage. Read a result with read_doc.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A few words to search for.', minLength: 1, maxLength: QUERY_LIMIT },
        limit: { type: 'integer', description: `How many results, 1 to ${SEARCH_RESULTS_MAX}; ${SEARCH_RESULTS} if left out.`, minimum: 1, maximum: SEARCH_RESULTS_MAX },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_doc',
    title: 'Read a docs page',
    description: 'One page of the Insulin Apps documentation, as Markdown. Give its address, such as /docs/platform/ai-agents or the full URL from search_docs or list_docs.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'The page\'s address: /docs/<section>/<page>, or its full URL.', minLength: 1, maxLength: 2048 },
      },
      required: ['page'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_docs',
    title: 'List the docs',
    description: 'Every page of the Insulin Apps documentation, by section, with its address and description.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return jsonResponse(data, status, { ...CORS, ...extra })
}

/** A tool's answer: readable text for the model, and the same data as structuredContent. */
function answer(text: string, data?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}) }
}

export async function docsMcpEndpoint(ctx: Context): Promise<Response> {
  if (!(await allowPublic(ctx))) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' })
  const body = await readJson(ctx, BODY_LIMIT_BYTES)
  if (body instanceof Response) return body
  if (body === undefined) return json(rpcError(null, { code: -32700, message: 'Send a JSON-RPC message as application/json.' }), 400)
  if (Array.isArray(body)) {
    if (!body.length) return json(rpcError(null, { code: -32600, message: 'Empty batch.' }), 400)
    if (body.length > BATCH_LIMIT) return json(rpcError(null, { code: -32600, message: `Send at most ${BATCH_LIMIT} messages in a batch.` }), 400)
    const answers = (await Promise.all(body.map((message) => handleMessage(ctx, message, true)))).filter((answer) => answer !== null)
    return answers.length ? json(answers) : new Response(null, { status: 202, headers: CORS })
  }
  const reply = await handleMessage(ctx, body, false)
  return reply === null ? new Response(null, { status: 202, headers: CORS }) : json(reply)
}

async function handleMessage(ctx: Context, message: unknown, charge: boolean): Promise<object | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, { code: -32600, message: 'Not a JSON-RPC message.' })
  const { jsonrpc, method, id, params } = message as Record<string, unknown>
  if (jsonrpc !== '2.0' || typeof method !== 'string') return isId(id) || id === undefined ? rpcError(isId(id) ? id : null, { code: -32600, message: 'Not a JSON-RPC 2.0 request.' }) : null
  // A notification (no id): nothing to answer.
  if (id === undefined) return null
  if (!isId(id)) return rpcError(null, { code: -32600, message: 'The id must be a string or a number.' })
  const args = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>
  switch (method) {
    case 'initialize': {
      const asked = typeof args.protocolVersion === 'string' ? args.protocolVersion : ''
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'insulin-apps-docs', title: 'Insulin Apps docs', version: '1.0.0' },
        instructions: 'The public documentation of Insulin Apps, read only and without sign-in. Call "search_docs" with a few words from the question, then "read_doc" on the best result; "list_docs" lists every page. It reaches no organization or app data.',
      })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS })
    case 'tools/call': {
      if (charge && !(await allowPublic(ctx))) return rpcError(id, { code: -32000, message: 'Too many requests. Try again in a minute.' })
      const name = args.name
      const input = (args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {}) as Record<string, unknown>
      if (typeof name !== 'string' || !TOOLS.some((tool) => tool.name === name)) return rpcError(id, { code: -32602, message: `Unknown tool: ${String(name).slice(0, 40)}` })
      return rpcResult(id, callTool(ctx, name, input))
    }
    default:
      return rpcError(id, { code: -32601, message: `Method not found: ${method.slice(0, 60)}` })
  }
}

function callTool(ctx: Context, name: string, input: Record<string, unknown>): ToolResult {
  if (name === 'search_docs') return search(ctx, input)
  if (name === 'read_doc') {
    if (typeof input.page !== 'string' || !input.page.trim()) return toolProblem('Give the page\'s address, such as /docs/platform/ai-agents.')
    const found = findDocsPage(input.page.slice(0, 2048), apexUrl(ctx, ''))
    if (!found) return toolProblem(`There is no docs page at ${input.page.slice(0, 200)}. Find one with search_docs or list_docs.`)
    return answer(`Source: ${apexUrl(ctx, found.page.path)}\n\n${found.markdown}`)
  }
  const sections = docsSections().map((section) => ({
    title: section.title,
    pages: section.pages.map((page) => ({ title: page.title, url: apexUrl(ctx, page.path), description: page.description })),
  }))
  const text = sections.map((section) => `## ${section.title}\n\n${section.pages.map((page) => `- [${page.title}](${page.url}): ${page.description}`).join('\n')}`).join('\n\n')
  return answer(text, { sections })
}

function search(ctx: Context, input: Record<string, unknown>): ToolResult {
  const query = typeof input.query === 'string' ? input.query.trim().slice(0, QUERY_LIMIT).trim() : ''
  if (!query) return toolProblem('Give a few words to search for, as "query".')
  if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > SEARCH_RESULTS_MAX)) {
    return toolProblem(`The limit must be a whole number from 1 to ${SEARCH_RESULTS_MAX}.`)
  }
  const results = searchDocs(query, (input.limit as number | undefined) ?? SEARCH_RESULTS).map((result) => resultForAgents(ctx, result))
  if (!results.length) return answer(`Nothing in the docs matches "${query}". Try other words, or list_docs.`, { query, results })
  const lines = results.map((result, index) => [
    `${index + 1}. ${result.title}${result.heading ? ` › ${result.heading}` : ''} (${result.section})`,
    `   ${result.url}`,
    `   ${result.snippet}`,
  ].join('\n'))
  return answer(`${results.length === 1 ? '1 page' : `${results.length} pages`} for "${query}":\n\n${lines.join('\n\n')}`, { query, results })
}
