import type {
  D1Database as CloudflareD1Database,
  D1PreparedStatement as CloudflareD1PreparedStatement,
  D1Result as CloudflareD1Result,
} from '@cloudflare/workers-types/index.ts'

declare global {
  type D1Database = Pick<CloudflareD1Database, 'prepare' | 'batch' | 'exec'>
  type D1PreparedStatement = CloudflareD1PreparedStatement
  type D1Result<T = unknown> = CloudflareD1Result<T>
}

export {}
