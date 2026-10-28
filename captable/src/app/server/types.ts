import type { AppRole } from '@fours/app/server'
import type { AppConfig } from './lib/config.ts'
import type { PortalMatch, ResolvedOrg } from './lib/access/resolve.ts'

export interface AuthContext {
  user: { id: string; email: string | null; displayName: string | null }
  consoleRole: AppRole
  preview: boolean
  authMethod: 'console'
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
