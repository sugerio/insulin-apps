import './zod-config.ts'
import { z } from 'zod'
import { epochMsSchema, uuidSchema } from './primitives.ts'
import { importSourceSchema } from './imports.ts'

export const consoleRoleSchema = z.enum(['OWNER', 'ADMIN', 'EDITOR', 'USER', 'VIEWER'])
export type ConsoleRole = z.infer<typeof consoleRoleSchema>

/**
 * Cap Table's permissions, the catalog declared under `insulin.permissions` in package.json (a test compares them).
 * An organization's custom roles are built from these; every built-in role has a fixed set.
 */
export const PERMISSIONS = ['captable.manage', 'captable.view', 'portfolio.view'] as const
export const permissionSchema = z.enum(PERMISSIONS)
export type Permission = z.infer<typeof permissionSchema>

const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS
const HOLDER_PERMISSIONS: readonly Permission[] = ['portfolio.view']

/** What a role allows when no permissions narrow it: Owner, Admin and Editor manage the cap table; User and Viewer see their own holdings. */
export function rolePermissions(role: ConsoleRole): readonly Permission[] {
  return role === 'USER' || role === 'VIEWER' ? HOLDER_PERMISSIONS : ALL_PERMISSIONS
}

/** How the request reached the app: the browser, an AI agent over MCP, or an API client with its own credentials. */
export const accessViaSchema = z.enum(['browser', 'mcp', 'api'])
export type AccessVia = z.infer<typeof accessViaSchema>

export const meResponseSchema = z.strictObject({
  user: z.strictObject({
    id: z.string().min(1),
    email: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  consoleRole: consoleRoleSchema,
  /** The effective permissions: the role's, narrowed by the organization's custom role when it has one. */
  permissions: z.array(permissionSchema),
  accessVia: accessViaSchema,
  preview: z.boolean(),
  company: z.strictObject({
    id: uuidSchema,
    displayName: z.string(),
    legalName: z.string(),
    timezone: z.string(),
    currency: z.string(),
    importSource: importSourceSchema.nullable(),
  }).nullable(),
  /**
   * Whether this organization has a company, even when the caller can't see it (`company` is then null): someone
   * without access goes to the no-access page, not to setup. Absent means false.
   */
  companyExists: z.boolean().optional(),
  access: z.enum(['admin_rw', 'admin_ro', 'holder', 'none']),
  pii: z.boolean(),
  portal: z.strictObject({
    matches: z.array(z.strictObject({
      orgId: uuidSchema,
      stakeholderId: uuidSchema,
      stakeholderName: z.string(),
    })),
  }),
  serverTime: epochMsSchema,
})
export type MeResponse = z.infer<typeof meResponseSchema>
