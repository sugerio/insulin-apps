// The Capacity Durable Object: imports at once, 20 across the service and 2 per organization (design section 11).
// Small imports (notes and corrections) wait ahead of the others. A collection asks for a slot for the import at the
// head of its own queue, renews it while the import runs and releases it when the import ends; a slot that isn't
// renewed for 30 minutes is freed. When a slot frees, the next import that fits is granted and its collection is
// told, so it starts without waiting for its own retry.

import { collectionName, type Env, stub } from './env.ts'
import { json, readJson } from './http.ts'
import { SETTINGS } from './settings.ts'
import { clock } from './util.ts'

export interface SlotRequest {
  org: string
  collectionId: string
  importId: string
  small: boolean
}

interface Running extends SlotRequest {
  since: number
  renewedAt: number
}

interface Waiting extends SlotRequest {
  at: number
}

export interface SlotAnswer {
  granted: boolean
  waitingFor: 'organization' | 'service' | null
  position: number | null
  running: { service: number; organization: number }
}

const keyOf = (r: SlotRequest) => `${r.org}:${r.collectionId}:${r.importId}`

export class Capacity {
  storage: DurableObjectStorage
  env: Env
  limits: { service: number; organization: number }

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage
    this.env = env
    this.limits = { service: SETTINGS.importsAtOnce, organization: SETTINGS.importsPerOrganization }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/state') {
      return json({ running: await this.running(), waiting: await this.waiting(), limits: this.limits })
    }
    const body = await readJson<SlotRequest>(request)
    if (request.method === 'POST' && url.pathname === '/acquire') return json(await this.acquire(body))
    if (request.method === 'POST' && url.pathname === '/renew') return json({ renewed: await this.renew(body) })
    if (request.method === 'POST' && url.pathname === '/release') return json({ released: await this.release(body) })
    return json({ error: 'not_found', message: 'No such capacity route.' }, 404)
  }

  async running(): Promise<Record<string, Running>> {
    return (await this.storage.get<Record<string, Running>>('running')) ?? {}
  }

  async waiting(): Promise<Waiting[]> {
    return (await this.storage.get<Waiting[]>('waiting')) ?? []
  }

  async acquire(request: SlotRequest): Promise<SlotAnswer> {
    const running = await this.running()
    const key = keyOf(request)
    if (running[key]) {
      running[key].renewedAt = clock.now()
      await this.storage.put('running', running)
      return this.answer(true, request, running, await this.waiting())
    }
    let waiting = await this.waiting()
    if (!waiting.some((w) => keyOf(w) === key)) waiting = insert(waiting, { ...request, at: clock.now() })
    const granted = await this.grant(running, waiting)
    await this.kick([...granted.values()].filter((g) => keyOf(g) !== key))
    return this.answer(granted.has(key), request, await this.running(), await this.waiting())
  }

  async renew(request: SlotRequest): Promise<boolean> {
    const running = await this.running()
    const slot = running[keyOf(request)]
    if (!slot) return false
    slot.renewedAt = clock.now()
    await this.storage.put('running', running)
    return true
  }

  async release(request: SlotRequest): Promise<boolean> {
    const running = await this.running()
    const key = keyOf(request)
    const had = Boolean(running[key])
    delete running[key]
    const waiting = (await this.waiting()).filter((w) => keyOf(w) !== key)
    await this.kick([...(await this.grant(running, waiting)).values()])
    return had
  }

  /** Grants slots in queue order to every waiting import that fits, and tells their collections. */
  async grant(running: Record<string, Running>, waiting: Waiting[]): Promise<Map<string, Waiting>> {
    const now = clock.now()
    for (const [key, slot] of Object.entries(running)) {
      if (now - slot.renewedAt > SETTINGS.capacityLeaseMs) delete running[key]
    }
    const granted = new Map<string, Waiting>()
    const still: Waiting[] = []
    for (const candidate of waiting) {
      const slots = Object.values(running)
      const orgRunning = slots.filter((s) => s.org === candidate.org).length
      if (slots.length < this.limits.service && orgRunning < this.limits.organization) {
        running[keyOf(candidate)] = { ...candidate, since: now, renewedAt: now }
        granted.set(keyOf(candidate), candidate)
      } else {
        still.push(candidate)
      }
    }
    await this.storage.put({ running, waiting: still })
    return granted
  }

  async kick(granted: Waiting[]): Promise<void> {
    for (const slot of granted) await kickCollection(this.env, slot.org, slot.collectionId)
  }

  answer(granted: boolean, request: SlotRequest, running: Record<string, Running>, waiting: Waiting[]): SlotAnswer {
    const slots = Object.values(running)
    const counts = { service: slots.length, organization: slots.filter((s) => s.org === request.org).length }
    if (granted) return { granted, waitingFor: null, position: null, running: counts }
    const byOrg = counts.organization >= this.limits.organization
    const ahead = byOrg ? waiting.filter((w) => w.org === request.org) : waiting
    const index = ahead.findIndex((w) => keyOf(w) === keyOf(request))
    return { granted, waitingFor: byOrg ? 'organization' : 'service', position: index >= 0 ? index + 1 : null, running: counts }
  }
}

/** Small imports go ahead of every normal import; otherwise first come, first served. */
function insert(waiting: Waiting[], item: Waiting): Waiting[] {
  if (!item.small) return [...waiting, item]
  const firstNormal = waiting.findIndex((w) => !w.small)
  return firstNormal < 0 ? [...waiting, item] : [...waiting.slice(0, firstNormal), item, ...waiting.slice(firstNormal)]
}

/** Tells a collection that its import got a slot. Best effort: the collection also asks again on its own. */
export async function kickCollection(env: Env, org: string, collectionId: string): Promise<void> {
  try {
    await stub(env.COLLECTIONS, collectionName(org, collectionId)).fetch('https://engine.internal/internal/kick', {
      method: 'POST',
      headers: { 'x-knowledge-org': org, 'x-knowledge-collection': collectionId },
    })
  } catch (error) {
    console.warn('capacity: could not tell a collection its import may start', String(error))
  }
}
