import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, ORG, PEOPLE, type Harness } from '../support/harness.ts'

// History, export and remove for good as the real engine behaves: restore points of changes within 5 minutes fold
// into one, going back and undo commit with no import, a removal's commit comes later, an export that isn't ready
// has no file, and a finished delete stays finished.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const historyRows = () => h.db.prepare(`SELECT version, summary FROM history WHERE org_id = ? ORDER BY version`).bind(ORG).all<{ version: number; summary: string }>().then((rows) => rows.results)

describe('history follows the engine', () => {
  it('a restore point folded into a later one leaves the D1 history list too', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'The first rule.')
    h.clock.advance(6 * 60_000)
    await h.note(PEOPLE.maya, id, 'The second rule.')
    h.clock.advance(60_000)
    await h.note(PEOPLE.maya, id, 'The third rule.')
    expect(await historyRows()).toEqual([{ version: 1, summary: 'Added a note' }, { version: 3, summary: 'Added 2 notes' }])
    const listed = await h.json<{ restorePoints: { version: number }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/history`)
    expect(listed.body.restorePoints.map((point) => point.version)).toEqual([3, 1])
    expect((await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}/history/2/preview`)).status).toBe(404)
    // Going back commits without an import; undo takes the folded changes back together.
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/history/1/go-back`)).status).toBe(200)
    await h.tick()
    expect((await historyRows()).at(-1)).toEqual({ version: 4, summary: 'Went back to version 1' })
    expect(await h.db.prepare(`SELECT version, documents, active_documents FROM collections WHERE id = ?`).bind(id).first()).toEqual({ version: 4, documents: 3, active_documents: 1 })
    expect((await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/history/undo`)).status).toBe(200)
    await h.tick()
    expect(await h.db.prepare(`SELECT active_documents FROM collections WHERE id = ?`).bind(id).first('active_documents')).toBe(3)
  })

  it('undo with nothing to undo is 409 not_restorable, in plain words', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'The only rule.')
    const refused = await h.json<{ error: string; message: string }>(PEOPLE.maya, 'POST', `/api/collections/${id}/history/undo`)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('not_restorable')
  })

  it('remove for good answers the version it will commit as; the counts follow when the commit arrives', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'The first rule.')
    await h.note(PEOPLE.maya, id, 'The second rule.')
    const sources = await h.json<{ sources: { documentId: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)
    h.engine.control.hold(true)
    const removed = await h.json<{ removed: { version: number } }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}/sources/${sources.body.sources[0]!.documentId}`)
    expect(removed.body.removed.version).toBe(3)
    const busy = await h.json<{ error: string }>(PEOPLE.maya, 'PATCH', `/api/collections/${id}/sources/${sources.body.sources[1]!.documentId}`, { active: false })
    expect(busy).toMatchObject({ status: 409, body: { error: 'busy_learning' } })
    h.engine.control.hold(false)
    await h.tick()
    expect(await h.db.prepare(`SELECT version, documents FROM collections WHERE id = ?`).bind(id).first()).toEqual({ version: 3, documents: 1 })
    const again = await h.json<{ import: { state: string } }>(PEOPLE.maya, 'PATCH', `/api/collections/${id}/sources/${sources.body.sources[1]!.documentId}`, { active: true })
    expect(again.body.import.state).toBe('duplicate')
  })
})

describe('exports and deletes', () => {
  it('a download of an export that isn\'t ready is 409 with its status, not a file', async () => {
    const id = await h.collection(PEOPLE.maya)
    const made = await h.json<{ export: { exportId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/exports`)
    const engine = h.env.ENGINE!
    h.env.ENGINE = {
      fetch: async (request) => (new URL(request.url).pathname.includes('/exports/')
        ? Response.json({ exportId: made.body.export.exportId, state: 'running', bytes: null, readyAt: null, expiresAt: null })
        : engine.fetch(request)),
    }
    const early = await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}/exports/${made.body.export.exportId}?download=1`)
    expect(early.status).toBe(409)
    expect(early.headers.get('content-disposition')).toBeNull()
    expect(await early.json()).toMatchObject({ error: 'conflict', export: { state: 'running' } })
  })

  it('a delete the engine already finished is recorded as deleted', async () => {
    const id = await h.collection(PEOPLE.maya)
    const engine = h.env.ENGINE!
    let deletes = 0
    h.env.ENGINE = {
      fetch: async (request) => {
        if (request.method === 'DELETE') deletes += 1
        // An engine whose status read fails after the delete: the DELETE's own answer says it is done.
        if (request.method === 'GET' && deletes > 0) return Response.json({ error: 'internal', message: 'unavailable' }, { status: 503 })
        return engine.fetch(request)
      },
    }
    await engine.fetch(new Request(`https://engine.test/v1/collections/${id}`, { method: 'DELETE', headers: { 'x-knowledge-org': ORG } }))
    expect((await h.json<{ state: string }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}`, { confirmName: 'Partner Programs' })).body.state).toBe('deleted')
  })
})
