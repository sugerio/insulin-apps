import { env } from 'cloudflare:workers'
import type { LocalD1Database } from './local-d1'

/**
 * A published app, on Cloudflare Workers: bindings, vars and secrets arrive on
 * the platform's `env` object. Other builds use platform.local.ts instead
 * (the `#platform` alias in vite.config.ts).
 */
export function readAppEnv(name: string): string | undefined {
  const value = (env as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : undefined
}

/** The app's D1 database, bound as `DB`. */
export async function openAppD1(): Promise<LocalD1Database> {
  return (env as { DB: LocalD1Database }).DB
}
