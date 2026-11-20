import './setup.ts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORG_HEADER } from '../../engine/src/contract.ts'
import { ORG, PEOPLE, SUPPORT } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// Round 9 of the review, on Sources: the lists of imports not learned yet are read again when the import watched
// changes state or ends and after a cancel that couldn't be done (F168), and waiting for the 1st names Insulin Apps
// support (F184).

let live: Live | undefined
afterEach(() => {
  live?.h.close()
  live = undefined
  vi.useRealTimers()
})

async function collectionWithNote() {
  const id = await live!.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
  await live!.h.note(PEOPLE.maya, id, 'Deals above $25,000 need sign-off from the alliance lead.', 'Approvals')
  return id
}

/** The organization's hold in the engine (its awake hours used up): what Insulin is given waits its turn there. */
const hold = (until: string | null, version: number) =>
  live!.h.engine.fetch(new Request(`https://engine.test/v1/orgs/${ORG}/hold`, { method: 'POST', headers: { [ORG_HEADER]: ORG, 'content-type': 'application/json' }, body: JSON.stringify({ until, version }) }))

describe('Sources: imports not learned yet', () => {
  it('F184 waiting for the 1st names Insulin Apps support, with its address', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await live.h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, 'learned_month', 0, NULL, 0)`).bind(ORG).run()
    await live.h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Tiers', text: 'Gold partners renew every March.' })
    renderApp(`/collections/${id}/sources`)
    const list = await screen.findByRole('list', { name: 'Waiting for the 1st' })
    const card = list.closest('section') ?? list.parentElement!.parentElement!
    expect(within(card as HTMLElement).getByText(new RegExp(`contact Insulin Apps support at ${SUPPORT.replace('.', '\\.')}`))).toBeTruthy()
  })

  it('F168 a cancel that can\'t be done (learning started meanwhile) reads the list again and says why', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await hold('2026-12-01T00:00:00Z', 1)
    await live.h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Rates', text: 'Silver partners renew every June.' })
    renderApp(`/collections/${id}/sources`)
    const list = await screen.findByRole('list', { name: 'Waiting to be learned' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    // The hold lifts and Insulin learns it before the cancel reaches it.
    await hold(null, 2)
    fireEvent.click(within(list).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText(/already being learned|has started or finished/)).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull())
    expect(screen.queryAllByRole('listitem').filter((item) => item.hasAttribute('data-waiting-import'))).toEqual([])
  })

  it('F168 the lists are read again when the import watched starts or ends: what Insulin learned leaves them', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await hold('2026-12-01T00:00:00Z', 1)
    await live.h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Rates', text: 'Silver partners renew every June.' })
    renderApp(`/collections/${id}/sources`)
    expect(within(await screen.findByRole('list', { name: 'Waiting to be learned' })).getAllByRole('listitem')).toHaveLength(1)
    // A note added here waits too, and is watched.
    fireEvent.click(screen.getByRole('button', { name: /Write a note/ }))
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Tiers' } })
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Gold partners renew every March.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and learn it' }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Waiting to be learned' })).getAllByRole('listitem')).toHaveLength(2))
    // The hold lifts: Insulin learns both, and the list follows without anyone reloading the page.
    await hold(null, 2)
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Waiting to be learned' })).toBeNull(), { timeout: 6_000 })
  }, 10_000)
})
