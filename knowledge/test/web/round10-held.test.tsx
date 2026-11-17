import './setup.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ORG_HEADER } from '../../engine/src/contract.ts'
import { stateMessage } from '../../src/app/lib/format.ts'
import { ORG, PEOPLE, SUPPORT } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// F192, design line 497 ("every limit message names Insulin Apps support"): the state message of a collection stopped
// for the month's awake hours, as Overview and Ask show it, ends with the sentence the other screens' limit messages
// end with, the address from /api/me (SUGER_SUPPORT_EMAIL).

let live: Live | undefined
afterEach(() => {
  live?.h.close()
  live = undefined
})

const SENTENCE = `For a higher limit, contact Insulin Apps support at ${SUPPORT}.`
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HELD = new RegExp(`^${escape("Your organization has used this month's awake hours, so Partner Programs has stopped until the 1st")}.*${escape(SENTENCE)}$`)

async function heldCollection() {
  live = await liveApi(PEOPLE.maya)
  const id = await live.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
  await live.h.note(PEOPLE.maya, id, 'Partner discounts stop at 20 percent for gold partners.', 'Partner rules')
  await live.h.engine.fetch(new Request(`https://engine.test/v1/orgs/${ORG}/hold`, { method: 'POST', headers: { [ORG_HEADER]: ORG, 'content-type': 'application/json' }, body: JSON.stringify({ until: '2026-12-01T00:00:00Z', version: 1 }) }))
  return id
}

describe('F192 the awake-hours stop on Overview and Ask names Insulin Apps support', () => {
  it('Overview', async () => {
    const id = await heldCollection()
    const { container } = renderApp(`/collections/${id}`)
    // Must catch: "has stopped until the 1st" with no word of support.
    expect(await screen.findByText(HELD)).toBeTruthy()
    expect(container.querySelector('[data-state-message="held"]')?.textContent).toMatch(HELD)
  })

  it('Ask', async () => {
    const id = await heldCollection()
    const { container } = renderApp(`/collections/${id}/ask`)
    expect(await screen.findByText(HELD)).toBeTruthy()
    expect(container.querySelector('[data-state-message="held"]')?.textContent).toMatch(HELD)
  })

  it('only the stop names support: other states say nothing of limits', () => {
    const support = 'For a higher limit, contact Insulin Apps support.'
    expect(stateMessage('held', 'Partner Programs', support)).toMatch(/removing a file for good still works\. For a higher limit, contact Insulin Apps support\.$/)
    for (const state of ['ready', 'asleep', 'learning', 'empty']) expect(stateMessage(state, 'Partner Programs', support)).not.toMatch(/support/)
    render(<p>{stateMessage('held', 'Partner Programs')}</p>)
    expect(screen.getByText(/has stopped until the 1st/).textContent).not.toMatch(/undefined/)
  })
})
