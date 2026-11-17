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

/** An organization's hold, numbered: every change (a lift too) gets the next number. */
interface HoldState {
  until: string | null
  seq: number
}

/** Collections still to be told of hold change `seq`. */
interface HoldTodo {
  seq: number
  collectionIds: string[]
}

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
   * Each change is numbered (lifts too) and collections refuse a number older than the one they hold, so two calls
   * whose deliveries overlap leave every collection with the newer one.
   */
  async hold(org: string, until: string | null): Promise<{ held: boolean; until: string | null }> {
    const kept = until && Date.parse(until) > clock.now() ? until : null
    const previous = await this.holdState(org)
    await this.storage.put(`hold:${org}`, { until: kept, seq: previous.seq + 1 } satisfies HoldState)
    const live = (await this.entries(org)).filter((e) => e.state === 'live').map((e) => e.collectionId)
    await this.tellHold(org, live)
    return { held: kept !== null, until: kept }
  }

  /** Tells collections the organization's current hold change; those not reached are kept to be told again. */
  async tellHold(org: string, collectionIds: string[]): Promise<void> {
    const state = await this.holdState(org)
    const until = state.until && Date.parse(state.until) > clock.now() ? state.until : null
    const told: string[] = []
    const missed: string[] = []
    for (const collectionId of collectionIds) {
      try {
        const response = await stub(this.env.COLLECTIONS, collectionName(org, collectionId)).fetch('https://engine.internal/internal/hold', {
          method: 'POST',
          headers: { 'x-knowledge-org': org, 'content-type': 'application/json' },
          body: JSON.stringify({ until, seq: state.seq }),
        })
        if (!response.ok) throw new Error(`the collection answered ${response.status}`)
        told.push(collectionId)
      } catch (error) {
        console.warn('registry: a collection could not be told of its hold; will retry', String(error))
        missed.push(collectionId)
      }
    }
    // A newer change came while these were told: it tells every collection itself and keeps its own list.
    if ((await this.holdState(org)).seq !== state.seq) return
    const todo = await this.storage.get<HoldTodo>(`holdTodo:${org}`)
    const still = todo?.seq === state.seq ? [...new Set([...todo.collectionIds.filter((id) => !told.includes(id)), ...missed])] : missed
    if (still.length) {
      await this.storage.put(`holdTodo:${org}`, { seq: state.seq, collectionIds: still } satisfies HoldTodo)
      await this.alarmBy(clock.now() + HOLD_RETRY_MS)
    } else {
      await this.storage.delete(`holdTodo:${org}`)
    }
  }

  async holdState(org: string): Promise<HoldState> {
    return (await this.storage.get<HoldState>(`hold:${org}`)) ?? { until: null, seq: 0 }
  }

  async alarmBy(at: number): Promise<void> {
    const current = await this.storage.getAlarm()
    if (current === null || current > at) await this.storage.setAlarm(at)
  }

  async holdOf(org: string): Promise<string | null> {
    const { until } = await this.holdState(org)
    return until && Date.parse(until) > clock.now() ? until : null
  }

  async register(org: string, collectionId: string): Promise<RegistryEntry & { holdUntil: string | null; holdSeq: number }> {
    const holdUntil = await this.holdOf(org)
    const holdSeq = (await this.holdState(org)).seq
    const existing = await this.storage.get<RegistryEntry>(key(org, collectionId))
    if (existing) return { ...existing, holdUntil, holdSeq }
    const entry: RegistryEntry = { org, collectionId, state: 'live', createdAt: iso(), deletedAt: null }
    const count = ((await this.storage.get<number>('count')) ?? 0) + 1
    await this.storage.put({ [key(org, collectionId)]: entry, count })
    return { ...entry, holdUntil, holdSeq }
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
    for (const [key, todo] of await this.storage.list<HoldTodo>({ prefix: 'holdTodo:' })) {
      const org = key.slice('holdTodo:'.length)
      const live = new Set((await this.entries(org)).filter((e) => e.state === 'live').map((e) => e.collectionId))
      // Those that are gone no longer need telling.
      const left = todo.collectionIds.filter((id) => live.has(id))
      if (left.length < todo.collectionIds.length) await this.storage.put(key, { ...todo, collectionIds: left })
      await this.tellHold(org, left)
    }
    // Set outright: while this handler runs, the alarm being handled may still read as the one scheduled.
    const next: number[] = []
    if (still.length) next.push(clock.now() + PURGE_RETRY_MS)
    if ((await this.storage.list({ prefix: 'holdTodo:', limit: 1 })).size) next.push(clock.now() + HOLD_RETRY_MS)
    if (next.length) await this.storage.setAlarm(Math.min(...next))
  }
}

const key = (org: string, collectionId: string) => `c:${org}:${collectionId}`
