import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, PEOPLE, type Harness } from '../support/harness.ts'

// A passage is cited by the pages (or slides) it runs over: the engine's `pageEnd` (optional in the contract) reaches
// the answers, the sources, the API's passages and both answer writers; an engine that sends no `pageEnd` is read as
// one page.

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

const RULES = 'Deals above $25,000 need sign-off from the alliance lead.\n\nPartner discounts stop at 20 percent for gold partners.'

/** The engine's search answers each passage over `pages` ([page, pageEnd], pageEnd left out when it is undefined). */
function enginePages(pages: [number | null, number | null | undefined]) {
  const answers: Record<string, any>[] = []
  const engine = h.env.ENGINE!
  h.env.ENGINE = {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname
      if (path === '/v1/answer') answers.push(await request.clone().json())
      const response = await engine.fetch(request)
      if (!path.endsWith('/search') || !response.ok) return response
      const body = await response.json() as { passages: Record<string, unknown>[] }
      body.passages = body.passages.map((passage) => {
        const { pageEnd: _drop, ...rest } = passage
        return pages[1] === undefined ? { ...rest, page: pages[0] } : { ...rest, page: pages[0], pageEnd: pages[1] }
      })
      return Response.json(body)
    },
  } as typeof engine
  return answers
}

describe('the pages a cited passage runs over', () => {
  it('reach the answer\'s citations and sources, the answer model and the API\'s passages', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, RULES)
    const answers = enginePages([1, 4])
    const answer = await h.json<Record<string, any>>(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off deals above $25,000?' })
    expect(answer.body.outcome).toBe('answered')
    expect(answer.body.citations[0]).toMatchObject({ page: 1, pageEnd: 4 })
    expect(answer.body.sources[0]).toMatchObject({ page: 1, pageEnd: 4 })
    expect(answers.at(-1)!.passages[0]).toMatchObject({ page: 1, pageEnd: 4 })
    const search = await h.json<Record<string, any>>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'Who signs off deals above $25,000?' })
    expect(search.body.passages[0]).toMatchObject({ page: 1, pageEnd: 4 })
  })

  it('an engine that sends no pageEnd is read as one page', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, RULES)
    enginePages([3, undefined])
    const answer = await h.json<Record<string, any>>(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off deals above $25,000?' })
    expect(answer.body.citations[0]).toMatchObject({ page: 3, pageEnd: 3 })
    expect(answer.body.sources[0]).toMatchObject({ page: 3, pageEnd: 3 })
    const search = await h.json<Record<string, any>>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'Who signs off deals above $25,000?' })
    expect(search.body.passages[0]).toMatchObject({ page: 3, pageEnd: 3 })
  })

  it('the organization\'s own model is told the pages: "pages 1–4"', async () => {
    const calls: Record<string, any>[] = []
    h.env.INTEGRATION_FETCH = () => (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: 'The alliance lead signs off deals above $25,000 [1].' } }] })
    }) as typeof fetch
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, RULES)
    expect((await h.call(PEOPLE.dana, 'PUT', '/api/rules', { answerWriter: { kind: 'own', integrationKey: 'acme-llm', url: 'https://llm.example.com/v1/chat/completions', model: 'acme-model-1' } })).status).toBe(200)
    enginePages([1, 4])
    await h.json(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off deals above $25,000?' })
    expect(calls.at(-1)!.messages[1].content).toMatch(/\[1\] Note, pages 1–4:/)
  })
})
