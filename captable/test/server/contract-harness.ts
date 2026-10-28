import { api } from '../../src/app/shared/index.ts'

const API_PREFIX = '/api/'

function routePattern(path: string): RegExp {
  const pattern = path.split('/').map((segment) => segment.startsWith(':')
    ? '([^/]+)'
    : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')
  return new RegExp(`^${pattern}$`)
}

const CONTRACT_ROUTES = api.ROUTE_TABLE.map((route) => ({ route, pattern: routePattern(route.path) }))

export function matchContractRoute(request: Request): { route: api.AnyRoute; paramsValid: boolean } | undefined {
  const path = new URL(request.url).pathname
  const matched = CONTRACT_ROUTES.find(({ route, pattern }) => route.method === request.method && pattern.test(path))
  if (!matched) return undefined
  const values = matched.pattern.exec(path)?.slice(1) ?? []
  const params = Object.fromEntries(api.pathParamNames(matched.route.path).map((name, index) => [name, values[index]]))
  return { route: matched.route, paramsValid: matched.route.params?.safeParse(params).success ?? true }
}

function formatIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`).join('; ')
}

function fail(request: Request, route: api.AnyRoute | undefined, message: string): never {
  const identity = route?.id ?? 'unknown route'
  throw new Error(`Contract response mismatch for ${request.method} ${new URL(request.url).pathname} (${identity}): ${message}`)
}

function headerRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].map(([name, value]) => [name.toLowerCase(), value]))
}

function unknownKeys(raw: unknown, parsed: unknown, path = '<root>'): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    return raw.flatMap((value, index) => unknownKeys(value, parsed[index], `${path}.${index}`))
  }
  if (raw === null || parsed === null || typeof raw !== 'object' || typeof parsed !== 'object'
    || Array.isArray(raw) || Array.isArray(parsed)) return []
  const parsedRecord = parsed as Record<string, unknown>
  return Object.entries(raw as Record<string, unknown>).flatMap(([key, value]) => Object.hasOwn(parsedRecord, key)
    ? unknownKeys(value, parsedRecord[key], path === '<root>' ? key : `${path}.${key}`)
    : [path === '<root>' ? key : `${path}.${key}`])
}

function assertStrict(request: Request, route: api.AnyRoute | undefined, raw: unknown, parsed: unknown, label: string) {
  const extra = unknownKeys(raw, parsed)
  if (extra.length > 0) fail(request, route, `${label}: unknown key(s): ${extra.join(', ')}`)
}

async function jsonBody(request: Request, response: Response, route: api.AnyRoute | undefined): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    fail(request, route, `expected application/json, received ${contentType || 'no Content-Type'}`)
  }
  try { return await response.clone().json() }
  catch { fail(request, route, 'response body is not valid JSON') }
}

async function validateError(
  request: Request,
  response: Response,
  route: api.AnyRoute | undefined,
  allowInternal: boolean,
): Promise<api.ApiErrorCode | 'console_identity_required'> {
  const body = await jsonBody(request, response, route)
  if (response.status === 401 && (body as { error?: unknown }).error === 'Open this app from the Insulin console') {
    return 'console_identity_required'
  }
  const parsed = api.apiErrorBodySchema.safeParse(body)
  if (!parsed.success) fail(request, route, `error body: ${formatIssues(parsed.error)}`)
  assertStrict(request, route, body, parsed.data, 'error body')
  const code = parsed.data.error.code
  if (code === 'internal' && !allowInternal) fail(request, route, '500 internal requires an explicit test opt-in')
  if (api.API_ERROR_STATUS[code] !== response.status) {
    fail(request, route, `${code} must use status ${api.API_ERROR_STATUS[code]}, received ${response.status}`)
  }
  if (route && !route.errors.includes(code)) fail(request, route, `undocumented error code ${code}`)
  if (!route && response.status !== 404 && code !== 'forbidden') {
    fail(request, route, `unknown API route returned ${response.status} ${code}`)
  }
  if (route && code === 'invariant_violation') {
    const undocumented = parsed.data.error.violations!.map(({ code: violation }) => violation)
      .filter((violation) => !route.violations.includes(violation))
    if (undocumented.length) fail(request, route, `undocumented violation code(s): ${undocumented.join(', ')}`)
  }
  if (route && code === 'warnings_unacknowledged') {
    const undocumented = parsed.data.error.warnings!.map(({ code: warning }) => warning)
      .filter((warning) => !route.warnings.includes(warning))
    if (undocumented.length) fail(request, route, `undocumented warning code(s): ${undocumented.join(', ')}`)
  }
  return code
}

export async function validateContractResponse(
  request: Request,
  response: Response,
  options: { allowInternal?: boolean } = {},
): Promise<void> {
  const matched = matchContractRoute(request)
  const route = matched?.route
  const path = new URL(request.url).pathname
  if (matched && !matched.paramsValid) {
    if (![401, 403, 404].includes(response.status)) {
      fail(request, route, `invalid path parameters must answer 404 after authorization, received ${response.status}`)
    }
    await validateError(request, response, route, options.allowInternal === true)
    return
  }
  if (!route) {
    if (path.startsWith(API_PREFIX)) {
      if (request.method === 'HEAD' && [404, 405].includes(response.status)) return
      await validateError(request, response, undefined, options.allowInternal === true)
    }
    return
  }
  if (response.headers.get('Cache-Control') !== 'no-store') {
    fail(request, route, `expected Cache-Control: no-store, received ${response.headers.get('Cache-Control') ?? '<missing>'}`)
  }
  if (response.status !== route.response.status) {
    await validateError(request, response, route, options.allowInternal === true)
    return
  }
  if (response.headers.has('Idempotent-Replay') && response.headers.get('Idempotent-Replay') !== 'true') {
    fail(request, route, 'Idempotent-Replay, when present, must be true')
  }
  switch (route.response.kind) {
    case 'json': {
      const body = await jsonBody(request, response, route)
      const parsed = route.response.schema.safeParse(body)
      if (!parsed.success) fail(request, route, `success body: ${formatIssues(parsed.error)}`)
      assertStrict(request, route, body, parsed.data, 'success body')
      break
    }
    case 'empty': {
      if ((await response.clone().arrayBuffer()).byteLength !== 0) fail(request, route, 'empty response contains body bytes')
      break
    }
    case 'file': {
      const contentType = (response.headers.get('Content-Type') ?? '').split(';', 1)[0]!.trim().toLowerCase()
      if (!route.response.contentTypes.some((declared) => declared.split(';', 1)[0]!.trim().toLowerCase() === contentType)) {
        fail(request, route, `file Content-Type ${contentType || '<missing>'} is not declared`)
      }
      const parsedHeaders = route.response.headers.safeParse(headerRecord(response.headers))
      if (!parsedHeaders.success) fail(request, route, `file headers: ${formatIssues(parsedHeaders.error)}`)
      if (contentType === 'application/json' && route.response.jsonSchema) {
        const body = await jsonBody(request, response, route)
        const parsed = route.response.jsonSchema.safeParse(body)
        if (!parsed.success) fail(request, route, `JSON file body: ${formatIssues(parsed.error)}`)
        assertStrict(request, route, body, parsed.data, 'JSON file body')
      }
      break
    }
    default:
      fail(request, route, 'unexpected retained response kind')
  }
}
