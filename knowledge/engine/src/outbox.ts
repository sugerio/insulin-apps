// The Outbox Durable Object: append-only events the app pulls with GET /v1/outbox?since=, oldest first, kept 7 days.
// Collections write their events here after they commit; a repeated key (a retried write) is dropped.

import type { OutboxEvent, OutboxPage } from './contract.ts'
import { json, readJson } from './http.ts'
import { SETTINGS } from './settings.ts'
import type { PendingEvent } from './types.ts'
import { clock, iso } from './util.ts'

const ID_WIDTH = 12
const DAY_MS = 24 * 60 * 60 * 1000

export class Outbox {
  storage: DurableObjectStorage

  constructor(state: DurableObjectState) {
    this.storage = state.storage
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/append') {
      const { events } = await readJson<{ events: PendingEvent[] }>(request)
      return json({ appended: await this.append(events ?? []) })
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      return json(await this.page(url.searchParams.get('since'), url.searchParams.get('limit')))
    }
    return json({ error: 'not_found', message: 'No such outbox route.' }, 404)
  }

  async append(events: PendingEvent[]): Promise<number> {
    let seq = (await this.storage.get<number>('seq')) ?? 0
    let appended = 0
    const at = iso()
    for (const pending of events) {
      if (await this.storage.get(`k:${pending.key}`)) continue
      seq += 1
      const id = String(seq).padStart(ID_WIDTH, '0')
      await this.storage.put({
        [`e:${id}`]: { ...pending.event, id } as OutboxEvent,
        [`k:${pending.key}`]: { id, at },
        seq,
      })
      appended += 1
    }
    if (appended && (await this.storage.getAlarm()) === null) await this.storage.setAlarm(clock.now() + DAY_MS)
    return appended
  }

  async page(since: string | null, limitParam: string | null): Promise<OutboxPage> {
    const limit = Math.min(Math.max(Number(limitParam) || 100, 1), 500)
    const after = since && /^\d{1,20}$/.test(since) ? since.padStart(ID_WIDTH, '0') : null
    const listed = await this.storage.list<OutboxEvent>({
      prefix: 'e:',
      ...(after ? { startAfter: `e:${after}` } : {}),
      limit: limit + 1,
    })
    const events = [...listed.values()]
    const more = events.length > limit
    const page = events.slice(0, limit)
    return { events: page, cursor: page.at(-1)?.id ?? after ?? '', more }
  }

  /** Drops events, and the keys that de-duplicate them, older than 7 days. */
  async alarm(): Promise<void> {
    const cutoff = iso(clock.now() - SETTINGS.outboxKeepMs)
    // Events are listed oldest first, so the scan stops at the first one to keep. De-duplication keys are in no
    // particular order and are all read.
    for (const [prefix, ordered] of [['e:', true], ['k:', false]] as const) {
      let startAfter: string | undefined
      for (;;) {
        const batch = await this.storage.list<{ at: string }>({ prefix, limit: 500, ...(startAfter ? { startAfter } : {}) })
        const entries = [...batch.entries()]
        const old = entries.filter(([, value]) => value.at < cutoff).map(([key]) => key)
        for (let i = 0; i < old.length; i += 100) await this.storage.delete(old.slice(i, i + 100))
        if (entries.length < 500 || (ordered && old.length < entries.length)) break
        startAfter = entries.at(-1)![0]
      }
    }
    await this.storage.setAlarm(clock.now() + DAY_MS)
  }
}
