import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyHiding as engineHiding, DEFAULT_HIDING } from '../../engine/src/stub/hiding.ts'
import { checkCitations } from '../../src/app/server/ask.ts'
import { applyHiding as appHiding } from '../../src/app/server/hiding.ts'
import { createHarness, ORG, PEOPLE, type Harness } from '../support/harness.ts'

// Asking, citations, corrections, reports and hiding: plans ASK-03, ASK-04, ASK-08, FIX-03, FIX-04 and HID-05.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const RULES = 'Deals above $25,000 need sign-off from the alliance lead.\n\nPartner discounts stop at 20 percent for gold partners.\n\nQuestions about this go to partners@example.com or +1 415 555 0134.'

async function answered(id: string, question: string) {
  return h.json<Record<string, any>>(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question })
}

describe('asking on the site', () => {
  it('ASK-03 a citation opens the source at the exact words, with page, owner and last edit; hidden values show as hidden', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, RULES, 'Partner rules')
    const answer = await answered(id, 'Who signs off deals above $25,000?')
    expect(answer.body.outcome).toBe('answered')
    const citation = answer.body.citations[0]
    const source = answer.body.sources.find((entry: { passageId: string }) => entry.passageId === citation.passageId)
    const opened = await h.json<{ source: { text: string; hidden: { kind: string }[] }; owner: { name: string }; lastEdit: string }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources/${citation.documentId}`)
    // Must catch: the highlight matches the cited passage.
    expect(opened.body.source.text.slice(citation.start, citation.end)).toBe(source.text)
    expect(opened.body.owner.name).toBe('Maya Example')
    expect(Date.parse(opened.body.lastEdit)).toBeGreaterThan(0)
    expect(opened.body.source.text).not.toContain('partners@example.com')
    expect(opened.body.source.text).toContain('[hidden]')
    expect(opened.body.source.hidden.map((span) => span.kind).sort()).toEqual(['email', 'phone'])
  })

  it('"I won\'t guess" when nothing covers the question, and the question is logged as a gap', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, RULES)
    const answer = await answered(id, 'What is the office parking policy?')
    expect(answer.body).toMatchObject({ outcome: 'wont_guess', text: null, sources: [], citations: [] })
    expect(answer.body.message).toBe("I couldn't find this in “Partner Programs”, so I won't guess.")
    await answered(id, 'What is the office parking policy?')
    expect(await h.db.prepare(`SELECT asked FROM gaps WHERE org_id = ? AND collection_id = ?`).bind(ORG, id).first('asked')).toBe(2)
  })

  it('ASK-04 the organization\'s own model writes the answer and the built-in counter doesn\'t move; if it fails, the sources alone', async () => {
    const calls: { url: string; key: string; body: Record<string, any> }[] = []
    let fail = false
    h.env.INTEGRATION_FETCH = (key) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), key, body: JSON.parse(String(init?.body)) })
      if (fail) return new Response('{"error":"upstream"}', { status: 502 })
      return Response.json({ choices: [{ message: { content: 'The alliance lead signs off deals above $25,000 [1].' } }] })
    }) as typeof fetch
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, RULES)
    expect((await answered(id, 'Who signs off deals above $25,000?')).body.writer).toBe('builtin')
    const counter = () => h.db.prepare(`SELECT COALESCE(SUM(used), 0) AS n FROM usage_counters WHERE org_id = ? AND key = 'answers_month'`).bind(ORG).first('n')
    expect(await counter()).toBe(1)
    const set = await h.call(PEOPLE.dana, 'PUT', '/api/rules', { answerWriter: { kind: 'own', integrationKey: 'acme-llm', url: 'https://llm.example.com/v1/chat/completions', model: 'acme-model-1' } })
    expect(set.status).toBe(200)
    const own = await answered(id, 'Who signs off deals above $25,000?')
    expect(own.body).toMatchObject({ outcome: 'answered', writer: 'own', model: 'acme-model-1' })
    expect(calls[0]).toMatchObject({ url: 'https://llm.example.com/v1/chat/completions', key: 'acme-llm', body: { model: 'acme-model-1' } })
    expect(calls[0]!.body.messages[1].content).toContain('alliance lead')
    // Must catch: the counter doesn't move.
    expect(await counter()).toBe(1)
    fail = true
    const failed = await answered(id, 'Who signs off deals above $25,000?')
    expect(failed.body).toMatchObject({ outcome: 'sources_only', text: null, writer: 'own' })
    expect(failed.body.sources.length).toBeGreaterThan(0)
    expect(failed.body.message).not.toMatch(/502|upstream/)
  })

  it('every citation must point at a passage the writer was given, or the sources show without the written answer', async () => {
    expect(checkCitations({ text: 'A [1] and B [2].', citations: [1, 2], model: 'm' }, 2)).toEqual([1, 2])
    expect(checkCitations({ text: 'A [3].', citations: [], model: 'm' }, 2)).toBeNull()
    expect(checkCitations({ text: 'No citation at all.', citations: [], model: 'm' }, 2)).toBeNull()
    expect(checkCitations({ text: 'A [1].', citations: [0], model: 'm' }, 2)).toBeNull()
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, RULES)
    h.engine.control.setAnswerMode('bad_citation')
    const bad = await answered(id, 'Who signs off deals above $25,000?')
    expect(bad.body).toMatchObject({ outcome: 'sources_only', text: null, citations: [] })
    h.engine.control.setAnswerMode('fail')
    expect((await answered(id, 'Who signs off deals above $25,000?')).body.outcome).toBe('sources_only')
    // Neither used a written answer.
    expect(await h.db.prepare(`SELECT COALESCE(SUM(used), 0) AS n FROM usage_counters WHERE org_id = ? AND key = 'answers_month'`).bind(ORG).first('n')).toBe(0)
  })

  it('ASK-08 asking across collections: none or more than 5 is refused; with 2 picked only those are searched', async () => {
    const first = await h.collection(PEOPLE.maya, 'First')
    const second = await h.collection(PEOPLE.maya, 'Second')
    const third = await h.collection(PEOPLE.maya, 'Third')
    await h.note(PEOPLE.maya, first, 'Gold partners renew every March.')
    await h.note(PEOPLE.maya, second, 'Silver partners renew every June.')
    await h.note(PEOPLE.maya, third, 'Gold partners renew every March and September.')
    expect((await h.json<{ error: string }>(PEOPLE.maya, 'POST', '/api/ask', { question: 'When do gold partners renew?' })).body.error).toBe('collection_required')
    expect((await h.json<{ error: string }>(PEOPLE.maya, 'POST', '/api/ask', { collections: ['a', 'b', 'c', 'd', 'e', 'f'], question: 'x' })).body.error).toBe('too_many_collections')
    const two = await h.json<Record<string, any>>(PEOPLE.maya, 'POST', '/api/ask', { collections: [first, second], question: 'When do gold partners renew?' })
    expect(two.body.collections.map((entry: { id: string }) => entry.id)).toEqual([first, second])
    // Must catch: a collection not picked is never searched.
    expect(two.body.sources.every((source: { collectionId: string }) => source.collectionId !== third)).toBe(true)
    expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE collection_id = ?`).bind(third).first('n')).toBe(0)
    expect((await h.call(PEOPLE.maya, 'POST', '/api/ask', { collections: [first], question: 'x' }, { 'x-suger-access-via': 'mcp' })).status).toBe(403)
  })
})

describe('fixing and reporting', () => {
  it('FIX-03 a reader reports an answer: the owner and the collection\'s admins hear; "reported" until it is fixed', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, RULES)
    await h.share(PEOPLE.maya, id, PEOPLE.leo, 'VIEWER')
    await h.share(PEOPLE.maya, id, PEOPLE.eli, 'ADMIN')
    const answer = await h.json<{ answerId: string; text: string }>(PEOPLE.leo, 'POST', '/api/ask', { collections: [id], question: 'Where do partner discounts stop?' })
    const report = await h.json<{ report: { id: string } }>(PEOPLE.leo, 'POST', `/api/collections/${id}/reports`, { answerId: answer.body.answerId, question: 'Where do partner discounts stop?', answer: answer.body.text, note: 'It is 15 percent since October.' })
    expect(report.status).toBe(201)
    const told = h.gateway.mail.filter((mail) => /reported an answer/.test(mail.subject)).map((mail) => mail.to).sort()
    expect(told).toEqual([PEOPLE.eli.email, PEOPLE.maya.email].sort())
    const open = await h.json<{ reports: { id: string; status: string }[] }>(PEOPLE.leo, 'GET', `/api/collections/${id}/reports?answerId=${answer.body.answerId}`)
    expect(open.body.reports).toEqual([expect.objectContaining({ id: report.body.report.id, status: 'open' })])
    expect((await h.call(PEOPLE.leo, 'POST', `/api/collections/${id}/corrections`, { text: 'Partner discounts stop at 15 percent.' })).status).toBe(403)
    const fixed = await h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Partner discounts stop at 15 percent for gold partners.', question: 'Where do partner discounts stop?', reportId: report.body.report.id })
    expect(fixed.status).toBe(202)
    // Must catch: the banner disappears after the fix.
    expect((await h.json<{ reports: unknown[] }>(PEOPLE.leo, 'GET', `/api/collections/${id}/reports?answerId=${answer.body.answerId}&status=open`)).body.reports).toEqual([])
  })

  it('FIX-04 fixing a fact changes the answers that used it', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, RULES)
    const before = await answered(id, 'Where do partner discounts stop for gold partners?')
    expect(before.body.text).toMatch(/20 percent/)
    const facts = await h.json<{ facts: { factId: string; sentence: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/facts`)
    const fact = facts.body.facts.find((entry) => /20 percent/.test(entry.sentence))!
    const fixed = await h.json<{ correction: { outdated: unknown[] } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { factId: fact.factId, text: 'Partner discounts stop at 15 percent for gold partners.' })
    expect(fixed.status).toBe(202)
    expect(fixed.body.correction.outdated).toHaveLength(1)
    h.engine.control.runUntilIdle()
    await h.tick()
    const after = await answered(id, 'Where do partner discounts stop for gold partners?')
    // Must catch: the answer changes.
    expect(after.body.text).toMatch(/15 percent/)
    expect(after.body.text).not.toMatch(/20 percent/)
    const factsAfter = await h.json<{ facts: { sentence: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/facts`)
    expect(factsAfter.body.facts.some((entry) => /20 percent/.test(entry.sentence))).toBe(false)
  })

  it.each(['Partner rules', 'Partner discounts stop at 20 percent for gold partners'])('FIX-04 a fact\'s fix sends the engine only the right fact: the wrong sentence is in neither its title nor its text (a source named “%s”)', async (name) => {
    const id = await h.collection(PEOPLE.maya)
    // Must catch: a title naming the source repeats the wrong fact when the source's name says it.
    await h.note(PEOPLE.maya, id, RULES, name)
    const facts = await h.json<{ facts: { factId: string; sentence: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/facts`)
    const wrong = facts.body.facts.find((entry) => /20 percent/.test(entry.sentence))!
    const engine = h.env.ENGINE!
    const sent: string[] = []
    h.env.ENGINE = {
      fetch: async (request: Request) => {
        if (request.method === 'POST' && /\/(imports|corrections)$/.test(new URL(request.url).pathname)) sent.push(await request.clone().text())
        return engine.fetch(request)
      },
    }
    // As What it knows sends it; a title of the client's own is not taken (the server makes it).
    expect((await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { factId: wrong.factId, text: 'Partner discounts stop at 15 percent for gold partners.', title: `Correction: ${wrong.sentence}` })).status).toBe(400)
    const fixed = await h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { factId: wrong.factId, text: 'Partner discounts stop at 15 percent for gold partners.', notifyAuthors: false })
    expect(fixed.status).toBe(202)
    expect(sent).toHaveLength(1)
    const notes = (JSON.parse(sent[0]!) as { notes: { title: string; text: string }[] }).notes
    // Must catch: the old sentence learned again inside its own correction.
    expect(notes).toEqual([expect.objectContaining({ title: 'Correction to a fact', text: 'Partner discounts stop at 15 percent for gold partners.' })])
    expect(sent[0]).not.toContain(wrong.sentence)
    expect(sent[0]).not.toContain(name)
    expect(sent[0]).not.toMatch(/20 percent/)
    h.env.ENGINE = engine
    h.engine.control.runUntilIdle()
    await h.tick()
    const after = await answered(id, 'Where do partner discounts stop for gold partners?')
    const correction = (after.body.sources as { documentName: string }[]).filter((source) => source.documentName === 'Correction to a fact')
    expect(correction).toHaveLength(1)
    expect(JSON.stringify(correction)).toMatch(/15 percent/)
    expect(JSON.stringify(correction)).not.toMatch(/20 percent/)
    // A source named for the wrong fact still says it under its own name (learned with a note, a second time): only
    // the passage the fact came from is marked outdated, as for any other passage that says the same.
    if (name === 'Partner rules') expect(JSON.stringify(after.body)).not.toMatch(/20 percent/)
  })
})

describe('hiding before learning', () => {
  const card = ['4111', '1111', '1111', '1111'].join(' ')
  const awsKey = `${'AKIA'}${'Q'.repeat(16)}`
  const SAMPLES = [
    `Write to dana@example.com or call +1 (415) 555-0134 about the renewal.`,
    `The test card ${card} expires soon; 4111 1111 1111 1112 fails its checksum.`,
    `Deploy with ${awsKey} and sk_${'live'}_${'a'.repeat(24)}.`,
    'password: hunter2-example and api_key = abc123def456',
    'The meeting is on 2026-11-15 at 10:30 in room 12.',
    'Project Bluebird is internal; bluebird stays secret.',
  ]

  it('HID-05 the "Try it" box hides exactly what the engine\'s detectors hide', async () => {
    // One detector module: the app's copy is byte-identical to the in-memory engine's.
    expect(readFileSync(new URL('../../src/app/server/hiding.ts', import.meta.url), 'utf8')).toBe(readFileSync(new URL('../../engine/src/stub/hiding.ts', import.meta.url), 'utf8'))
    const rules = { ...DEFAULT_HIDING, words: ['Bluebird'] }
    for (const text of SAMPLES) expect(appHiding(text, rules)).toEqual(engineHiding(text, rules))
    const first = appHiding(SAMPLES[0]!, rules)
    expect(first.found.map((range) => range.kind)).toEqual(['email', 'phone'])
    expect(appHiding(SAMPLES[1]!, rules).found.map((range) => range.kind)).toEqual(['card'])
    expect(appHiding(SAMPLES[2]!, rules).found.map((range) => range.kind)).toEqual(['api_key', 'api_key'])
    expect(appHiding(SAMPLES[3]!, rules).text).toBe('password: [hidden] and api_key = [hidden]')
    expect(appHiding(SAMPLES[4]!, rules).found).toEqual([])
    expect(appHiding(SAMPLES[5]!, rules).text).toBe('Project [hidden] is internal; [hidden] stays secret.')
    // The preview through the API, and what the engine stores from the same text, match.
    await h.call(PEOPLE.dana, 'PUT', '/api/rules', { hiding: rules })
    const text = SAMPLES.join('\n\n')
    const preview = await h.json<{ text: string }>(PEOPLE.dana, 'POST', '/api/rules/hiding-preview', { text })
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, text, '')
    const sources = await h.json<{ sources: { documentId: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources`)
    const stored = await h.json<{ source: { text: string } }>(PEOPLE.maya, 'GET', `/api/collections/${id}/sources/${sources.body.sources[0]!.documentId}`)
    // Must catch: one mismatch fails.
    expect(stored.body.source.text).toBe(preview.body.text)
    expect(stored.body.source.text).not.toContain(awsKey)
  })

  it('HID-05 the engine\'s shared detector fixtures: the same spans, redacted text and [hidden] positions', () => {
    const fixtures = JSON.parse(readFileSync(new URL('../../engine/test/fixtures/hiding-cases.json', import.meta.url), 'utf8')) as {
      cases: { id: string; rules: typeof DEFAULT_HIDING; input: string; spans: unknown[]; redacted: string; hidden: unknown[] }[]
    }
    expect(fixtures.cases.length).toBeGreaterThan(20)
    for (const entry of fixtures.cases) {
      const result = appHiding(entry.input, entry.rules)
      // Must catch: one mismatch fails.
      expect({ id: entry.id, spans: result.found, redacted: result.text, hidden: result.hidden }).toEqual({ id: entry.id, spans: entry.spans, redacted: entry.redacted, hidden: entry.hidden })
    }
  })
})
