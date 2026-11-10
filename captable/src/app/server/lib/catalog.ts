import { api } from '#shared'
import { z } from 'zod'

/**
 * `GET /api/catalog`: the route table as data for AI agents and API clients (the hosting platform's MCP `endpoints`
 * tool shows it), limited to what the caller's access level may call. Built once per level and isolate.
 */

export type CatalogLevel = 'admin_rw' | 'admin_ro' | 'holder' | 'none'

/** The level the caller's permissions give, whether or not the company exists yet. */
export function catalogLevel(permissions: ReadonlySet<api.Permission>): CatalogLevel {
  if (permissions.has('captable.manage')) return 'admin_rw'
  if (permissions.has('captable.view')) return 'admin_ro'
  return permissions.has('portfolio.view') ? 'holder' : 'none'
}

function callable(route: api.AnyRoute, level: CatalogLevel): boolean {
  if (route.auth === 'identity') return true
  if (route.auth === 'holder') return level === 'holder'
  return (level === 'admin_rw' || level === 'admin_ro') && route.access.includes(level)
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
