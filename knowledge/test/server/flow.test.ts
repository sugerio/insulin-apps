import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, PEOPLE, type Harness } from '../support/harness.ts'

let h: Harness
beforeEach(async () => { h = await createHarness() })
afterEach(() => h.close())

describe('the main flow', () => {
  it('starts a collection, learns a note and answers from it with a checked citation', async () => {
    const id = await h.collection(PEOPLE.maya)
    await h.note(PEOPLE.maya, id, 'Deals above $25,000 need sign-off from the alliance lead.\n\nPartner discounts stop at 20 percent.', 'Approvals')
    const answer = await h.json<Record<string, any>>(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'Who signs off deals above $25,000?' })
    expect(answer.status).toBe(200)
    expect(answer.body.outcome).toBe('answered')
    expect(answer.body.text).toMatch(/\[1\]/)
    expect(answer.body.citations[0].documentName).toBe('Approvals')
    const search = await h.json<Record<string, any>>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'partner discounts percent' })
    expect(search.body.covered).toBe(true)
    expect(search.body.passages[0].text).toMatch(/20 percent/)
    const nothing = await h.json<Record<string, any>>(PEOPLE.maya, 'POST', '/api/ask', { collections: [id], question: 'What is the office wifi password?' })
    expect(nothing.body.outcome).toBe('wont_guess')
    expect(nothing.body.message).toMatch(/won't guess/)
  })
})
