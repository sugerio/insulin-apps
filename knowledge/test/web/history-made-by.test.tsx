import './setup.ts'
import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ORG, PEOPLE, type Person } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// History names who made each change (K3): a person by name, and an API client writing for someone with whom it said it
// acted for (`x-on-behalf-of`), against the real API and the in-memory engine.

let live: Live | undefined
afterEach(() => {
  live?.h.close()
  live = undefined
})

/** An API client of the organization, Editor in Knowledge, that writes what people approved. */
const AGENT: Person = { id: 'sa-partner-agent', role: 'EDITOR', via: 'api', name: 'Partner Agent' }

describe('History names who made each change', () => {
  it('a person by name; an API client writing for someone as "Partner Agent, on behalf of Ana Lee"', async () => {
    live = await liveApi(PEOPLE.maya)
    live.h.gateway.setMember(ORG, AGENT.id, { type: 'client', appRole: 'EDITOR', name: 'Partner Agent' })
    await live.h.call(AGENT, 'GET', '/api/me')
    const id = await live.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
    await live.h.note(PEOPLE.maya, id, 'Deals above $25,000 need sign-off from the alliance lead.', 'Approvals')
    expect(await live.h.share(PEOPLE.maya, id, AGENT, 'EDITOR')).toBe(200)
    live.h.clock.advance(10 * 60 * 1000)
    const added = await live.h.call(AGENT, 'POST', `/api/collections/${id}/notes`, { title: 'Tiers', text: 'Gold partners renew every March.' }, { 'x-on-behalf-of': 'Ana Lee' })
    expect(added.status).toBe(202)
    live.h.engine.control.runUntilIdle()
    await live.h.tick()
    renderApp(`/collections/${id}/history`)
    const points = await screen.findByRole('list', { name: 'Restore points' })
    const newest = within(points).getAllByRole('listitem')[0]!
    expect(await within(newest).findByText('By Partner Agent, on behalf of Ana Lee')).toBeTruthy()
    const oldest = within(points).getAllByRole('listitem').at(-1)!
    expect(within(oldest).getByText('By Maya Example')).toBeTruthy()
    expect(points.querySelectorAll('[data-made-by]')).toHaveLength(2)
  })
})
