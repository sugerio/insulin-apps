import type { AppRole } from '@fours/app/server'
import type { api } from '#shared'
import type { AppConfig } from './lib/config.ts'
import type { PortalMatch, ResolvedOrg } from './lib/access/resolve.ts'

export interface AuthContext {
  user: { id: string; email: string | null; displayName: string | null }
  /** The opaque organization id supplied by the Insulin console for this request. */
  consoleOrganizationId: string
  consoleRole: AppRole
  /** The effective permissions (`readPlatformGrant`): the role's, narrowed by a custom role. Access follows these, not the role. */
  permissions: ReadonlySet<api.Permission>
  /** Who sent the request: a person in the browser, an AI agent (MCP) or an API client. */
  accessVia: api.AccessVia
  preview: boolean
  authMethod: 'console'
  /** Holds `captable.manage`: records changes, and sees what only those who manage the cap table see (unmasked EIN, Pulley ids). */
  fullAccess: boolean
  orgAccess: Map<string, ResolvedOrg>
  portalMatches: PortalMatch[]
}

export interface AppDeps {
  now: () => number
  runImportBatch: (db: D1Database, statements: D1PreparedStatement[], batchIndex: number) => Promise<unknown[]>
}

export type AppEnv = {
  Bindings: { DB: D1Database }
  Variables: {
    config: AppConfig
    auth: AuthContext
    org: ResolvedOrg
  }
}
