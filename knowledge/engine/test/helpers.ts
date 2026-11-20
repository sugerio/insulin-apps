// A whole engine in memory: the Worker's router, the four Durable Object classes on fake storage, fake R2 and
// Workers AI, and fake containers. Time is a fake clock; alarms run when a test drains them.

import { Capacity } from '../src/capacity.ts'
import { CollectionEngine } from '../src/collection.ts'
import { ORG_HEADER } from '../src/contract.ts'
import type { Env } from '../src/env.ts'
import { Outbox } from '../src/outbox.ts'
import { Registry } from '../src/registry.ts'
import { handle } from '../src/router.ts'
import { clock } from '../src/util.ts'
import { FakeAI, FakeCloud, FakeNamespace, FakeR2, sha256 } from './fakes.ts'

export const ORG = 'org-acme'
export const OTHER_ORG = 'org-globex'

export interface TestEngine {
  env: Env
  cloud: FakeCloud
  files: FakeR2
  backups: FakeR2
  ai: FakeAI
  collections: FakeNamespace
  outbox: FakeNamespace
  capacity: FakeNamespace
  registry: FakeNamespace
  api(method: string, path: string, body?: unknown, options?: { org?: string | null; headers?: Record<string, string> }): Promise<{ status: number; body: any; response: Response }>
  drain(collectionId?: string, options?: { org?: string; horizonMs?: number; steps?: number }): Promise<number>
  advance(ms: number): void
  now(): number
  object(collectionId: string, org?: string): CollectionEngine
  container(collectionId: string, org?: string): import('./fakes.ts').FakeContainer
  storage(collectionId: string, org?: string): import('./fakes.ts').FakeStorage
}

export function makeEngine(options: { testControls?: boolean; start?: number } = {}): TestEngine {
  let now = options.start ?? Date.parse('2026-11-16T09:00:00Z')
  clock.now = () => now
  clock.wait = async () => undefined
  // The engine logs every step as JSON; tests read its stored log instead.
  console.log = () => undefined
  const cloud = new FakeCloud()
  const files = new FakeR2()
  const backups = new FakeR2()
  const ai = new FakeAI()
  const collections = new FakeNamespace(CollectionEngine as any, cloud)
  const outbox = new FakeNamespace(Outbox as any, null)
  const capacity = new FakeNamespace(Capacity as any, null)
  const registry = new FakeNamespace(Registry as any, null)
  const env = {
    COLLECTIONS: collections,
    OUTBOX: outbox,
    CAPACITY: capacity,
    REGISTRY: registry,
    FILES: files,
    BACKUPS: backups,
    AI: ai,
    ENGINE_TEST_CONTROLS: options.testControls === false ? undefined : '1',
  } as unknown as Env
  for (const ns of [collections, outbox, capacity, registry]) ns.env = env

  const api: TestEngine['api'] = async (method, path, body, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    const org = opts.org === undefined ? ORG : opts.org
    if (org) headers[ORG_HEADER] = org
    let payload: BodyInit | undefined
    if (body instanceof Uint8Array || typeof body === 'string') payload = body as BodyInit
    else if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['content-type'] ??= 'application/json'
    }
    const response = await handle(new Request(`https://engine.internal${path}`, { method, headers, body: payload }), env)
    const text = await response.clone().text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // not JSON (a zip)
    }
    return { status: response.status, body: parsed, response }
  }

  const name = (collectionId: string, org = ORG) => `${org}:${collectionId}`
  const engine: TestEngine = {
    env,
    cloud,
    files,
    backups,
    ai,
    collections,
    outbox,
    capacity,
    registry,
    api,
    advance(ms) {
      now += ms
    },
    now: () => now,
    object: (cid, org) => collections.instance(name(cid, org)).object,
    container: (cid, org) => collections.instance(name(cid, org)).state.container!,
    storage: (cid, org) => collections.instance(name(cid, org)).state.storage,
    async drain(collectionId, opts = {}) {
      // Runs due alarms (of one collection, or of every object) in time order, moving the clock forward by at most
      // `horizonMs` per step, so polling continues but a sleep ten minutes away doesn't happen by itself.
      const horizon = opts.horizonMs ?? 5_000
      let steps = 0
      for (; steps < (opts.steps ?? 400); steps++) {
        const candidates: { at: number; run: () => Promise<void> }[] = []
        for (const ns of [collections, registry, outbox, capacity]) {
          for (const [key, entry] of ns.instances) {
            if (ns === collections && collectionId && key !== name(collectionId, opts.org)) continue
            const at = entry.state.storage.alarm
            if (at === null || at > now + horizon) continue
            candidates.push({
              at,
              run: async () => {
                entry.state.storage.alarm = null
                await entry.object.alarm?.()
              },
            })
          }
        }
        if (!candidates.length) break
        candidates.sort((a, b) => a.at - b.at)
        now = Math.max(now, candidates[0].at)
        await candidates[0].run()
      }
      return steps
    },
  }
  return engine
}

export const SETTINGS_BODY = {
  settings: {
    hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] as string[] },
    keepReady: null,
    awakeMinutes: 10,
  },
}

export async function createCollection(t: TestEngine, collectionId = 'c1', org = ORG) {
  const res = await t.api('PUT', `/v1/collections/${collectionId}`, SETTINGS_BODY, { org })
  if (res.status !== 200) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body
}

export interface FileSpec {
  fileId: string
  name: string
  text: string
  type?: string
}

export async function stageFile(t: TestEngine, collectionId: string, file: FileSpec, org = ORG) {
  const bytes = new TextEncoder().encode(file.text)
  const res = await t.api('PUT', `/v1/collections/${collectionId}/inbox/${file.fileId}`, bytes, {
    org,
    headers: { 'content-type': file.type ?? 'text/markdown', 'x-file-name': encodeURIComponent(file.name), 'x-file-sha256': sha256(bytes) },
  })
  if (res.status !== 200) throw new Error(`stage failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { fileId: file.fileId, name: file.name, type: file.type ?? 'text/markdown', bytes: bytes.length, sha256: sha256(bytes) }
}

/** Stages files and starts an import; returns the answer of POST /imports. */
export async function startImport(t: TestEngine, collectionId: string, importId: string, files: FileSpec[], org = ORG, extra: Record<string, unknown> = {}) {
  const staged = []
  for (const f of files) staged.push(await stageFile(t, collectionId, f, org))
  return t.api('POST', `/v1/collections/${collectionId}/imports`, { importId, files: staged, notes: [], small: false, ...extra }, { org })
}

/** Imports files and runs the engine until the import ends. Returns the final ImportStatus. */
export async function learn(t: TestEngine, collectionId: string, importId: string, files: FileSpec[], org = ORG) {
  const started = await startImport(t, collectionId, importId, files, org)
  if (started.status !== 202) throw new Error(`import failed: ${started.status} ${JSON.stringify(started.body)}`)
  await t.drain(collectionId, { org })
  return (await t.api('GET', `/v1/collections/${collectionId}/imports/${importId}`, undefined, { org })).body
}

export function doc(n: number, extra = ''): FileSpec {
  return {
    fileId: `f${n}`,
    name: `doc-${n}.md`,
    text: `# Document ${n}\n\nTopic number ${n} says the gateway port is ${8000 + n}.${extra ? `\n\n${extra}` : ''}`,
  }
}

/** Asks until the answer isn't "waking": runs the wake in between. */
export async function ask(t: TestEngine, collectionId: string, query: string, org = ORG) {
  let res = await t.api('POST', `/v1/collections/${collectionId}/search`, { query }, { org })
  for (let i = 0; i < 5 && res.body.status === 'waking'; i++) {
    await t.drain(collectionId, { org })
    res = await t.api('POST', `/v1/collections/${collectionId}/search`, { query }, { org })
  }
  return res
}

export async function outboxEvents(t: TestEngine) {
  return (await t.api('GET', '/v1/outbox?limit=500', undefined, { org: null })).body.events as any[]
}

export async function log(t: TestEngine, collectionId: string, org = ORG) {
  return (await t.storage(collectionId, org).get<any[]>('log')) ?? []
}

/** What the capacity guard holds: the slots running (by key) and the imports waiting (by id). */
export async function guard(t: TestEngine) {
  const res = await t.capacity.get(t.capacity.idFromName('capacity')).fetch('https://engine.internal/state')
  const state = (await res.json()) as { running: Record<string, unknown>; waiting: { importId: string }[] }
  return { running: Object.keys(state.running), waiting: state.waiting.map((w) => w.importId) }
}

/** Wraps the capacity guard: `around` runs for each call to `path`, before (and may replace) the guard's answer. */
export function wrapGuard(t: TestEngine, around: (path: string, call: () => Promise<Response>) => Promise<Response>) {
  const get = t.capacity.get.bind(t.capacity)
  ;(t.capacity as any).get = (id: any) => {
    const stub = get(id)
    return {
      fetch: (input: RequestInfo, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        return around(new URL(url).pathname, () => stub.fetch(input, init))
      },
    }
  }
  return () => {
    ;(t.capacity as any).get = get
  }
}
