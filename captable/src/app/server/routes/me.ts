import { api } from '#shared'
import { Hono } from 'hono'
import type { AppDeps, AppEnv } from '../types.ts'

interface CompanyRow {
  id: string
  display_name: string
  legal_name: string
  timezone: string
  currency: string
  import_source: api.ImportSource | null
}

export function meRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>()
  routes.get('/', async (c) => {
    const auth = c.get('auth')
    const adminOrg = [...auth.orgAccess.values()][0]
    const holderOrgId = auth.portalMatches[0]?.orgId
    const orgId = adminOrg?.id ?? holderOrgId
    const company = orgId
      ? await c.env.DB.prepare(
        `SELECT o.id, o.display_name, o.legal_name, o.timezone, o.currency,
           (SELECT source_system FROM import_runs r WHERE r.org_id = o.id AND r.status = 'committed'
            ORDER BY r.updated_at DESC LIMIT 1) AS import_source
         FROM orgs o WHERE o.id = ? AND o.status = 'active'`,
      ).bind(orgId).first<CompanyRow>()
      : null
    const access = adminOrg?.access ?? (auth.portalMatches.length > 0 ? 'holder' : 'none')
    return c.json(api.meResponseSchema.parse({
      user: auth.user,
      consoleRole: auth.consoleRole,
      preview: auth.preview,
      company: company && {
        id: company.id,
        displayName: company.display_name,
        legalName: company.legal_name,
        timezone: company.timezone,
        currency: company.currency,
        importSource: company.import_source,
      },
      access,
      pii: adminOrg?.pii ?? false,
      portal: { matches: auth.portalMatches },
      serverTime: deps.now(),
    }))
  })
  return routes
}
