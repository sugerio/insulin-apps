import { api } from '#shared'
import { z } from 'zod'
import type { AuthContext } from '../types.ts'

/**
 * `GET /api/catalog`: the route table as data for AI agents and API clients (the hosting platform's MCP `endpoints`
 * tool shows it), limited to what the caller can use right now. Built once per level and isolate.
 */

/** `setup`: someone who records changes, before the organization has a company (setup or an import comes first). */
export type CatalogLevel = 'admin_rw' | 'admin_ro' | 'holder' | 'setup' | 'none'

/** The level the caller has now: their access to the company, a holder match, or the right to set one up. */
export function catalogLevel(auth: Pick<AuthContext, 'orgAccess' | 'portalMatches' | 'permissions'>, companyExists: boolean): CatalogLevel {
  const company = [...auth.orgAccess.values()][0]
  if (company) return company.access
  if (auth.portalMatches.length > 0) return 'holder'
  return !companyExists && auth.permissions.has('captable.manage') ? 'setup' : 'none'
}

const isCreateCompany = (route: api.AnyRoute) => route.method === 'POST' && route.path === '/api/orgs'
const isImport = (route: api.AnyRoute) => route.path.startsWith('/api/import/')

function callable(route: api.AnyRoute, level: CatalogLevel): boolean {
  if (route.auth === 'identity') return true
  if (route.auth === 'holder') return level === 'holder'
  if (level === 'setup') return isCreateCompany(route) || isImport(route)
  return (level === 'admin_rw' || level === 'admin_ro') && route.access.includes(level) && !isCreateCompany(route)
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...document } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  return document
}

function bodyOf(body: api.BodySpec): Record<string, unknown> | null {
  switch (body.kind) {
    case 'none': return null
    case 'json': return jsonSchemaOf(body.schema)
    case 'form': return { ...jsonSchemaOf(body.schema), description: 'Sent as multipart/form-data fields' }
    case 'raw': return { type: 'string', description: "The file's bytes, sent with these headers", 'x-headers': jsonSchemaOf(body.headers) }
  }
}

function endpointOf(route: api.AnyRoute): api.ApiCatalogEndpoint {
  return {
    method: route.method,
    path: route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}'),
    summary: route.summary,
    query: route.query ? jsonSchemaOf(route.query) : null,
    body: bodyOf(route.body),
    idempotencyKey: route.idempotency !== 'none',
  }
}

const built = new Map<CatalogLevel, api.ApiCatalog>()

export function apiCatalog(level: CatalogLevel): api.ApiCatalog {
  let catalog = built.get(level)
  if (!catalog) {
    catalog = api.apiCatalogSchema.parse({
      endpoints: api.ROUTE_TABLE.filter((route) => callable(route, level)).map(endpointOf),
    })
    built.set(level, catalog)
  }
  return catalog
}
