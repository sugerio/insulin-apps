// The engine Worker's bindings (wrangler.jsonc). R2 buckets get their names from the deploy.

import type { EngineEnvSettings } from './settings.ts'

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

export interface Env extends EngineEnvSettings {
  COLLECTIONS: DurableObjectNamespace
  CAPACITY: DurableObjectNamespace
  OUTBOX: DurableObjectNamespace
  REGISTRY: DurableObjectNamespace
  FILES: R2Bucket // inbox/ (staged originals), text/ (redacted text, page maps, facts), exports/
  BACKUPS: R2Bucket // backups/: content-addressed daily backups and the latest one
  AI: AiBinding
  // Set only on the throwaway Engine-lane deployment (harness/README.md): turns on /__test routes.
  ENGINE_TEST_CONTROLS?: string
}

export const testControls = (env: Env): boolean => env.ENGINE_TEST_CONTROLS === '1'

/** Durable Object names. A collection's object is named by organization and collection, so ids never collide. */
export const collectionName = (org: string, collectionId: string): string => `${org}:${collectionId}`
export const CAPACITY_NAME = 'capacity'
export const OUTBOX_NAME = 'outbox'
export const REGISTRY_NAME = 'registry'

export function stub(namespace: DurableObjectNamespace, name: string): DurableObjectStub {
  return namespace.get(namespace.idFromName(name))
}

/** A JSON call to another of the engine's Durable Objects. */
export async function callObject<T>(
  namespace: DurableObjectNamespace,
  name: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const response = await stub(namespace, name).fetch(`https://engine.internal${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${name} ${path} answered ${response.status}: ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : {}) as T
}
