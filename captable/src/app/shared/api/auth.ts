import './zod-config.ts'
import { z } from 'zod'
import { epochMsSchema, uuidSchema } from './primitives.ts'
import { importSourceSchema } from './imports.ts'

export const consoleRoleSchema = z.enum(['OWNER', 'ADMIN', 'EDITOR', 'USER', 'VIEWER'])

export const meResponseSchema = z.strictObject({
  user: z.strictObject({
    id: z.string().min(1),
    email: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  consoleRole: consoleRoleSchema,
  preview: z.boolean(),
  company: z.strictObject({
    id: uuidSchema,
    displayName: z.string(),
    legalName: z.string(),
    timezone: z.string(),
    currency: z.string(),
    importSource: importSourceSchema.nullable(),
  }).nullable(),
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
