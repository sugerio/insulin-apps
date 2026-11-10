import { Hono } from 'hono'
import { apiCatalog, catalogLevel } from '../lib/catalog.ts'
import type { AppEnv } from '../types.ts'

export function catalogRoutes() {
  const routes = new Hono<AppEnv>()
  routes.get('/', (c) => c.json(apiCatalog(catalogLevel(c.get('auth').permissions))))
  return routes
}
