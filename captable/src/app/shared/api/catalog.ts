import './zod-config.ts'
import { z } from 'zod'

/** A JSON Schema document, passed through as data. */
const jsonSchemaSchema = z.record(z.string(), z.unknown())

/** One endpoint of `GET /api/catalog`: what an AI agent or API client needs to call it. */
export const apiCatalogEndpointSchema = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** The path, with `{param}` placeholders. */
  path: z.string().startsWith('/api/'),
  summary: z.string(),
  query: jsonSchemaSchema.nullable(),
  body: jsonSchemaSchema.nullable(),
  /** Whether the request needs an `Idempotency-Key` header (a fresh random value per change). */
  idempotencyKey: z.boolean(),
})
export type ApiCatalogEndpoint = z.infer<typeof apiCatalogEndpointSchema>

export const apiCatalogSchema = z.strictObject({ endpoints: z.array(apiCatalogEndpointSchema) })
export type ApiCatalog = z.infer<typeof apiCatalogSchema>
