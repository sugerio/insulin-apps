import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, ORG, PEOPLE, type Harness } from '../support/harness.ts'

// Imports waiting for the 1st whose start may have reached the engine, exports that wait, and what a collection
// started from an export counts and says.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const encoder = new TextEncoder()
const setLimit = (key: string, value: number | null) =>
  h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, ?, ?, NULL, 0) ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`).bind(ORG, key, value).run()
const clearLimits = () => h.db.prepare(`DELETE FROM org_limits WHERE org_id = ?`).bind(ORG).run()
const held = async (importId: string) => Number(await h.db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE ref = ? AND state = 'held'`).bind(`import:${importId}`).first('n'))
const learned = async () => Number(await h.db.prepare(`SELECT COALESCE(SUM(used), 0) AS n FROM usage_counters WHERE org_id = ? AND key = 'learned_month'`).bind(ORG).first('n'))
const stateOf = async (importId: string) => (await h.db.prepare(`SELECT state FROM imports WHERE id = ?`).bind(importId).first<{ state: string }>())?.state

/** A note that waits for the 1st, and its import id. */
async function waitingNote() {
  const id = await h.collection(PEOPLE.maya)
  await setLimit('learned_month', 0)
  const added = await h.json<{ import: { importId: string; state: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Rule', text: 'Partner discounts stop at 20 percent.' })
  expect(added.body.import.state).toBe('waiting')
  return { id, importId: added.body.import.importId }
}

/** The engine's answer to the next import start is lost: `took` says whether the engine got it. */
function loseNextStart(took: boolean) {
  const real = h.env.ENGINE!
  let armed = true
  h.env.ENGINE = {
    fetch: async (request: Request) => {
      if (armed && request.method === 'POST' && new URL(request.url).pathname.endsWith('/imports')) {
        armed = false
        if (took) await real.fetch(request)
        return Response.json({ error: 'internal', message: 'The answer was lost.' }, { status: 502 })
      }
      return real.fetch(request)
    },
  }
}

describe('cancelling a waiting import whose start may have been sent', () => {
  it('is refused while the engine may have it, keeps what it reserved, and the engine learns it', async () => {
    const { id, importId } = await waitingNote()
    await clearLimits()
    loseNextStart(true)
    // The engine is still learning it when someone asks to cancel.
    h.engine.control.hold(true)
    await h.tick()
    expect(await stateOf(importId)).toBe('waiting')
    const cancel = await h.json<{ error: string; message: string }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}/imports/${importId}`)
    expect(cancel.status).toBe(409)
    expect(cancel.body.message).toMatch(/already being learned/)
    expect(await held(importId)).toBeGreaterThan(0)
    h.engine.control.hold(false)
    h.engine.control.runUntilIdle()
    await h.tick()
    expect(await stateOf(importId)).toBe('committed')
    expect((await h.json<{ sources: { name: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources.map((source) => source.name)).toEqual(['Rule'])
  })

  it('goes ahead once the engine says it never got it, and frees what it reserved', async () => {
    const { id, importId } = await waitingNote()
    await clearLimits()
    loseNextStart(false)
    await h.tick()
    expect(await stateOf(importId)).toBe('waiting')
    expect((await h.json<{ import: { state: string } }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}/imports/${importId}`)).body.import.state).toBe('cancelled')
    expect(await held(importId)).toBe(0)
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources).toEqual([])
  })
})

describe('cancelling an import Insulin has but hasn\'t started', () => {
  it('is listed as waiting to be learned and cancelled through the engine; once learning has started, it is refused', async () => {
    h.close()
    h = await createHarness({ timing: { importMs: 60_000 } })
    const id = await h.collection(PEOPLE.maya)
    const add = async (title: string) => (await h.json<{ import: { importId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title, text: `${title} partners renew every March.` })).body.import.importId
    // The first is learning; the other two wait their turn.
    await add('Gold')
    const second = await add('Silver')
    const third = await add('Bronze')
    const listed = await h.json<{ imports: { importId: string; kind: string; waitsFor: string | null }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/imports?state=queued`)
    expect(listed.body.imports).toMatchObject([{ importId: second, kind: 'note', waitsFor: null }, { importId: third, kind: 'note', waitsFor: null }])
    const cancel = await h.json<{ import: { state: string } }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}/imports/${second}`)
    expect([cancel.status, cancel.body.import?.state]).toEqual([200, 'cancelled'])
    expect(await held(second)).toBe(0)
    // The first is learned and the third starts learning before Knowledge hears of it: its cancel is refused, and
    // what it reserved is kept.
    h.clock.advance(61_000)
    h.engine.control.advance(0)
    const late = await h.json<{ message: string }>(PEOPLE.maya, 'DELETE', `/api/collections/${id}/imports/${third}`)
    expect(late.status).toBe(409)
    expect(late.body.message).toMatch(/already being learned/)
    expect(await held(third)).toBeGreaterThan(0)
    h.engine.control.runUntilIdle()
    await h.tick()
    const sources = (await h.json<{ sources: { name: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)).body.sources.map((source) => source.name)
    expect(sources.sort()).toEqual(['Bronze', 'Gold'])
    expect(await stateOf(second)).toBe('cancelled')
  })
})

describe('a collection started from an export', () => {
  /** A collection of five files and a note, exported; the export's bytes. */
  async function exported() {
    const id = await h.collection(PEOPLE.maya, 'Partner Programs')
    const names = ['A.md', 'B.md', 'C.md', 'D.md', 'E.md']
    const texts = names.map((name, index) => `Partner tier ${name} renews in month ${index + 1} with a discount of ${10 + index} percent.`)
    const pre = await h.json<{ files: { fileId: string }[] }>(PEOPLE.maya, 'POST', `/api/collections/${id}/preflight`, { files: names.map((name, index) => ({ name, bytes: texts[index]!.length })) })
    for (let index = 0; index < names.length; index += 1) await h.call(PEOPLE.maya, 'PUT', `/api/collections/${id}/uploads/${pre.body.files[index]!.fileId}`, encoder.encode(texts[index]!))
    await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/imports`, { fileIds: pre.body.files.map((file) => file.fileId) })
    h.engine.control.runUntilIdle()
    await h.tick()
    await h.note(PEOPLE.maya, id, 'Platinum partners get a named alliance lead.', 'Platinum')
    const made = await h.json<{ export: { exportId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/exports`)
    return { id, bytes: new Uint8Array(await (await h.call(PEOPLE.maya, 'GET', `/api/collections/${id}/exports/${made.body.export.exportId}?download=1`)).arrayBuffer()) }
  }

  async function startFrom(bytes: Uint8Array, person = PEOPLE.eli) {
    const target = await h.collection(person, 'Again')
    const pre = await h.json<{ files: { fileId: string }[] }>(person, 'POST', `/api/collections/${target}/preflight`, { files: [{ name: 'partner.zip', bytes: bytes.byteLength }], export: true })
    await h.call(person, 'PUT', `/api/collections/${target}/uploads/${pre.body.files[0]!.fileId}`, bytes)
    const started = await h.json<{ import: { importId: string; state: string } }>(person, 'POST', `/api/collections/${target}/import-export`, { fileId: pre.body.files[0]!.fileId })
    return { target, importId: started.body.import.importId, state: started.body.import.state }
  }

  it('counts every document it restored as learned, records them for whoever started it, and says it restored them', async () => {
    const { bytes } = await exported()
    const before = await learned()
    const mail = h.gateway.mail.length
    const { target, importId } = await startFrom(bytes)
    h.engine.control.runUntilIdle()
    await h.tick()
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.eli, 'GET', `/api/collections/${target}/sources`)).body.sources).toHaveLength(6)
    expect(await learned()).toBe(before + 6)
    const detail = JSON.parse((await h.db.prepare(`SELECT detail FROM imports WHERE id = ?`).bind(importId).first<{ detail: string }>())!.detail) as { documents: { id: string; name: string }[] }
    // Its files, for "Tell the person who added this file": whoever started from the export added them here.
    expect(detail.documents.map((document) => document.name).sort()).toEqual(['A.md', 'B.md', 'C.md', 'D.md', 'E.md'])
    const subjects = h.gateway.mail.slice(mail).filter((message) => message.to === PEOPLE.eli.email).map((message) => message.subject)
    expect(subjects).toEqual(['“Again” restored 6 documents from an export'])
  })

  it('an export waiting for the 1st stays an export through every month it waits', async () => {
    const { bytes } = await exported()
    await setLimit('learned_month', 0)
    const { target, importId, state } = await startFrom(bytes)
    expect(state).toBe('waiting')
    // The 1st comes and the month is full again: it waits for the next one, still an export.
    h.clock.now = Date.UTC(2026, 11, 1, 0, 5)
    await h.tick()
    expect(await stateOf(importId)).toBe('waiting')
    const request = JSON.parse((await h.db.prepare(`SELECT request FROM imports WHERE id = ?`).bind(importId).first<{ request: string }>())!.request) as { export?: { documents: number }; waitsFor: string }
    expect(request).toMatchObject({ export: { documents: 6 }, waitsFor: '2027-01-01T00:00:00Z' })
    h.clock.now = Date.UTC(2027, 0, 1, 0, 5)
    await clearLimits()
    await h.tick()
    h.engine.control.runUntilIdle()
    await h.tick()
    expect(await stateOf(importId)).toBe('committed')
    expect((await h.json<{ sources: unknown[] }>(PEOPLE.eli, 'GET', `/api/collections/${target}/sources`)).body.sources).toHaveLength(6)
  })
})
