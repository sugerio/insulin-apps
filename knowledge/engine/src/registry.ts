// The Registry Durable Object: an index of every organization's collections. It lets POST /v1/orgs/:org/purge find
// each collection of an organization, lets GET answer `deleted` once a collection's own storage is gone, and counts
// collections for /v1/health. It holds ids and states only, never names or content.

import { collectionName, type Env, stub } from './env.ts'
import { json, readJson } from './http.ts'
import { clock, iso } from './util.ts'

export interface RegistryEntry {
  org: string
  collectionId: string
  state: 'live' | 'deleting' | 'deleted'
  createdAt: string
  deletedAt: string | null
}

const PURGE_RETRY_MS = 5 * 60 * 1000
const HOLD_RETRY_MS = 60 * 1000

export class Registry {
  storage: DurableObjectStorage
  env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`
    if (route === 'GET /count') return json({ collections: (await this.storage.get<number>('count')) ?? 0 })
    if (route === 'GET /entry') {
      const entry = await this.storage.get<RegistryEntry>(key(url.searchParams.get('org') ?? '', url.searchParams.get('collectionId') ?? ''))
      return entry ? json(entry) : json({ error: 'not_found', message: 'No such collection.' }, 404)
    }
    const body = await readJson<{ org: string; collectionId?: string; state?: RegistryEntry['state'] }>(request)
    if (route === 'POST /register') return json(await this.register(body.org, body.collectionId ?? ''))
    if (route === 'POST /state') return json(await this.setState(body.org, body.collectionId ?? '', body.state ?? 'live'))
    if (route === 'POST /purge') return json(await this.purge(body.org), 202)
    if (route === 'POST /hold') return json(await this.hold(body.org, (body as { until?: string | null }).until ?? null))
    return json({ error: 'not_found', message: 'No such registry route.' }, 404)
  }

  /**
   * The organization's hold: no container starts for its collections (but to remove a file for good or delete)
   * until `until`, or until it is lifted with null. The hold is kept here and every collection is told now; one
   * that can't be reached is told again from the alarm until it has been, and a new one asks when it is made.
   */
  async hold(org: string, until: string | null): Promise<{ held: boolean; until: string | null }> {
    if (until && Date.parse(until) > clock.now()) await this.storage.put(`hold:${org}`, until)
    else await this.storage.delete(`hold:${org}`)
    const kept = until && Date.parse(until) > clock.now() ? until : null
    const live = (await this.entries(org)).filter((e) => e.state === 'live').map((e) => e.collectionId)
    await this.tellHold(org, live)
    return { held: kept !== null, until: kept }
  }

  /** Tells collections the organization's current hold; those not reached are kept to be told again. */
  async tellHold(org: string, collectionIds: string[]): Promise<void> {
    const until = await this.holdOf(org)
    const missed: string[] = []
    for (const collectionId of collectionIds) {
      try {
        const response = await stub(this.env.COLLECTIONS, collectionName(org, collectionId)).fetch('https://engine.internal/internal/hold', {
          method: 'POST',
          headers: { 'x-knowledge-org': org, 'content-type': 'application/json' },
          body: JSON.stringify({ until }),
        })
        if (!response.ok) throw new Error(`the collection answered ${response.status}`)
      } catch (error) {
        console.warn('registry: a collection could not be told of its hold; will retry', String(error))
        missed.push(collectionId)
      }
    }
    // A newer call tells every collection again, so what it missed replaces what an older one missed.
    if (missed.length) {
      await this.storage.put(`holdTodo:${org}`, missed)
      await this.alarmBy(clock.now() + HOLD_RETRY_MS)
    } else {
      await this.storage.delete(`holdTodo:${org}`)
    }
  }

  async alarmBy(at: number): Promise<void> {
    const current = await this.storage.getAlarm()
    if (current === null || current > at) await this.storage.setAlarm(at)
  }

  async holdOf(org: string): Promise<string | null> {
    const until = await this.storage.get<string>(`hold:${org}`)
    return until && Date.parse(until) > clock.now() ? until : null
  }

  async register(org: string, collectionId: string): Promise<RegistryEntry & { holdUntil: string | null }> {
    const holdUntil = await this.holdOf(org)
    const existing = await this.storage.get<RegistryEntry>(key(org, collectionId))
    if (existing) return { ...existing, holdUntil }
    const entry: RegistryEntry = { org, collectionId, state: 'live', createdAt: iso(), deletedAt: null }
    const count = ((await this.storage.get<number>('count')) ?? 0) + 1
    await this.storage.put({ [key(org, collectionId)]: entry, count })
    return { ...entry, holdUntil }
  }

  async setState(org: string, collectionId: string, state: RegistryEntry['state']): Promise<RegistryEntry | null> {
    const entry = await this.storage.get<RegistryEntry>(key(org, collectionId))
    if (!entry || entry.state === state || entry.state === 'deleted') return entry ?? null
    entry.state = state
    if (state === 'deleted') entry.deletedAt = iso()
    const count = (await this.storage.get<number>('count')) ?? 0
    await this.storage.put({ [key(org, collectionId)]: entry, count: state === 'deleted' ? Math.max(0, count - 1) : count })
    return entry
  }

  async entries(org: string): Promise<RegistryEntry[]> {
    return [...(await this.storage.list<RegistryEntry>({ prefix: `c:${org}:` })).values()]
  }

  /** Asks every collection of the organization to delete itself, and keeps asking until each one has. */
  async purge(org: string): Promise<{ collections: number; remaining: number }> {
    const open = (await this.entries(org)).filter((e) => e.state !== 'deleted')
    for (const entry of open) {
      try {
        await stub(this.env.COLLECTIONS, collectionName(org, entry.collectionId)).fetch(
          `https://engine.internal/v1/collections/${encodeURIComponent(entry.collectionId)}`,
          { method: 'DELETE', headers: { 'x-knowledge-org': org } },
        )
        await this.setState(org, entry.collectionId, 'deleting')
      } catch (error) {
        console.warn('registry: purge could not reach a collection; will retry', String(error))
      }
    }
    const purges = (await this.storage.get<string[]>('purges')) ?? []
    if (open.length && !purges.includes(org)) await this.storage.put('purges', [...purges, org])
    if (open.length) await this.alarmBy(clock.now() + PURGE_RETRY_MS)
    return { collections: open.length, remaining: open.length }
  }

  async alarm(): Promise<void> {
    const purges = (await this.storage.get<string[]>('purges')) ?? []
    const still: string[] = []
    for (const org of purges) {
      const open = (await this.entries(org)).filter((e) => e.state !== 'deleted')
      if (open.length) {
        still.push(org)
        await this.purge(org)
      }
    }
    await this.storage.put('purges', still)
    for (const [key, collectionIds] of await this.storage.list<string[]>({ prefix: 'holdTodo:' })) {
      const org = key.slice('holdTodo:'.length)
      const live = new Set((await this.entries(org)).filter((e) => e.state === 'live').map((e) => e.collectionId))
      await this.tellHold(org, collectionIds.filter((id) => live.has(id)))
    }
    // Set outright: while this handler runs, the alarm being handled may still read as the one scheduled.
    const next: number[] = []
    if (still.length) next.push(clock.now() + PURGE_RETRY_MS)
    if ((await this.storage.list({ prefix: 'holdTodo:', limit: 1 })).size) next.push(clock.now() + HOLD_RETRY_MS)
    if (next.length) await this.storage.setAlarm(Math.min(...next))
  }
}

const key = (org: string, collectionId: string) => `c:${org}:${collectionId}`
