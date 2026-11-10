import { Hono } from 'hono'
import { apiCatalog, catalogLevel } from '../lib/catalog.ts'
import type { AppEnv } from '../types.ts'

export function catalogRoutes() {
  const routes = new Hono<AppEnv>()
  routes.get('/', async (c) => {
    const auth = c.get('auth')
    const exists = auth.orgAccess.size > 0 || (await c.env.DB.prepare(
      `SELECT 1 AS found FROM orgs WHERE console_organization_id = ? AND status = 'active' LIMIT 1`,
    ).bind(auth.consoleOrganizationId).first<{ found: number }>()) !== null
    return c.json(apiCatalog(catalogLevel(auth, exists)))
  })
  return routes
}
