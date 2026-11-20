import './setup.ts'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportProgress } from '../../src/app/components/ImportProgress.tsx'
import type { ImportStatus } from '../../src/app/lib/types.ts'
import { SessionProvider } from '../../src/app/session.tsx'
import { ORG_HEADER } from '../../engine/src/contract.ts'
import { ORG, PEOPLE, SUPPORT } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// Design line 497, "every limit message names Insulin Apps support": the messages the screens write themselves for a
// limit (the awake-hours stop, keep-ready paused at 90%, the month's learned documents used up) end with the sentence
// the server's limit messages end with, the address from /api/me (SUGER_SUPPORT_EMAIL), never one in the source.

let live: Live | undefined
afterEach(() => {
  live?.h.close()
  live = undefined
})

const SENTENCE = `For a higher limit, contact Insulin Apps support at ${SUPPORT}.`
/** Text holding `before` and then, in the same element, the support sentence with the deploy's address. */
const withSupport = (before: string) => new RegExp(`${before}.*${SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

async function collectionWithNote(text = 'Partner discounts stop at 20 percent for gold partners.') {
  const id = await live!.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
  await live!.h.note(PEOPLE.maya, id, text, 'Partner rules')
  return id
}

const blockLearning = () => live!.h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, 'learned_month', 0, NULL, 0)`).bind(ORG).run()
const holdOrganization = () => live!.h.engine.fetch(new Request(`https://engine.test/v1/orgs/${ORG}/hold`, { method: 'POST', headers: { [ORG_HEADER]: ORG, 'content-type': 'application/json' }, body: JSON.stringify({ until: '2026-12-01T00:00:00Z', version: 1 }) }))
const pauseKeepReady = (id: string) => live!.h.db.prepare(`UPDATE collections SET keep_ready = ?, keep_ready_paused = 1 WHERE id = ?`).bind(JSON.stringify({ days: [1, 2, 3, 4, 5], start: '09:00', hours: 2 }), id).run()

async function ask(question: string) {
  fireEvent.change(await screen.findByLabelText('Question'), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
  return await screen.findByRole('region', { name: 'Answer' })
}

describe('every limit message on a screen names Insulin Apps support', () => {
  it('History, while Knowledge has stopped for the awake hours', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await holdOrganization()
    renderApp(`/collections/${id}/history`)
    // Must catch: "Knowledge has stopped until the 1st" with no word of support.
    expect(await screen.findByText(withSupport('Knowledge has stopped until the 1st: your organization has used this month\'s awake hours\\.'))).toBeTruthy()
  })

  it('History, when the awake-hours stop cut going back short', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    live.h.clock.advance(10 * 60 * 1000)
    await live.h.note(PEOPLE.maya, id, 'Gold partners get a dedicated partner manager.', 'Tiers')
    // The stop arrives while going back: the engine holds the organization and drops the go back.
    let started = false
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://knowledge.insulinapps.test').pathname
      const method = (init.method ?? 'GET').toUpperCase()
      const response = await inner(input, init)
      if (method === 'POST' && path.endsWith('/go-back')) {
        started = true
        const body = (await response.json()) as { collection: { state: string } }
        return Response.json({ collection: { ...body.collection, state: 'going_back' } })
      }
      if (method === 'GET' && path === `/api/collections/${id}` && started) {
        const body = (await response.json()) as { engine: { state: string } }
        return Response.json({ ...body, engine: { ...body.engine, state: 'held' } })
      }
      return response
    })
    renderApp(`/collections/${id}/history`)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Go back to this version' }))[0]!)
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Go back' }))
    expect(await screen.findByText(withSupport('Going back was stopped: Knowledge has stopped until the 1st'), {}, { timeout: 8_000 })).toBeTruthy()
  }, 20_000)

  it('Overview and Sharing, while keep-ready is paused at 90% of the awake hours', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await pauseKeepReady(id)
    const overview = renderApp(`/collections/${id}`)
    expect(await screen.findByText(withSupport('Keep-ready for Partner Programs is paused: your organization has used 90% of its awake hours this month\\. It starts again on the 1st\\.'))).toBeTruthy()
    overview.unmount()
    renderApp(`/collections/${id}/sharing`)
    expect(await screen.findByText(withSupport('Keep-ready is paused: your organization has used 90% of its awake hours this month\\. It starts again on the 1st\\.'))).toBeTruthy()
  })

  it('an import waiting for the 1st, wherever its progress is shown', async () => {
    live = await liveApi(PEOPLE.maya)
    const status = {
      importId: 'i1', state: 'waiting', attempt: 0, queuePosition: null, waitingFor: 'month', files: [{ fileId: 'f1', name: 'Plan.md', state: 'waiting' }],
      notes: 0, version: null, newFacts: null, failedFileId: null, error: null, etaSeconds: null, createdAt: new Date().toISOString(), finishedAt: null,
    } as ImportStatus
    render(<SessionProvider><ImportProgress status={status} collectionName="Partner Programs" /></SessionProvider>)
    expect(await screen.findByText(withSupport('Your organization has learned this month\'s documents, so this file waits'))).toBeTruthy()
  })

  it('a fact\'s fix waiting for the 1st', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await blockLearning()
    renderApp(`/collections/${id}/knows`)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Fix' }))[0]!)
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('The right fact'), { target: { value: 'Partner discounts stop at 15 percent for gold partners.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the fix' }))
    expect(await within(dialog).findByText(withSupport('Your organization has learned this month\'s documents, so Partner Programs learns your fix on December 1, by itself\\.'))).toBeTruthy()
  })

  it('a correction to an answer waiting for the 1st', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await blockLearning()
    renderApp(`/collections/${id}/ask`)
    const answer = await ask('Where do partner discounts stop for gold partners?')
    await within(answer).findByRole('button', { name: /^Source 1/ })
    fireEvent.click(within(answer).getByRole('button', { name: 'Not right' }))
    fireEvent.change(await within(answer).findByLabelText("What's the right answer?", {}, { timeout: 5_000 }), { target: { value: 'Partner discounts stop at 15 percent for gold partners.' } })
    fireEvent.click(within(answer).getByRole('button', { name: 'Save the correction' }))
    expect(await within(answer).findByText(withSupport('so Partner Programs learns your correction on December 1, by itself\\. Until then, answers stay as they are\\.'))).toBeTruthy()
  })

  it('an answer written for a question it couldn\'t answer, waiting for the 1st', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await blockLearning()
    renderApp(`/collections/${id}/ask`)
    const answer = await ask('What is the capital of Atlantis?')
    fireEvent.click(within(answer).getByRole('button', { name: 'Write the answer' }))
    fireEvent.change(await within(answer).findByLabelText(/Your answer, saved as a note/, {}, { timeout: 5_000 }), { target: { value: 'Atlantis has no capital.' } })
    fireEvent.click(within(answer).getByRole('button', { name: 'Save the answer' }))
    expect(await within(answer).findByText(withSupport('Saved\\. Your organization has learned this month\'s documents, so Partner Programs learns your answer on December 1, by itself\\.'))).toBeTruthy()
  })

  it('without the deploy\'s address (or outside the session) it names support without one, never an address of its own', () => {
    const status = {
      importId: 'i1', state: 'waiting', attempt: 0, queuePosition: null, waitingFor: 'month', files: [{ fileId: 'f1', name: 'Plan.md', state: 'waiting' }],
      notes: 0, version: null, newFacts: null, failedFileId: null, error: null, etaSeconds: null, createdAt: new Date().toISOString(), finishedAt: null,
    } as ImportStatus
    render(<ImportProgress status={status} collectionName="Partner Programs" />)
    const text = screen.getByText(/so this file waits/).textContent ?? ''
    expect(text).toMatch(/For a higher limit, contact Insulin Apps support\.$/)
    expect(text).not.toMatch(/@/)
  })
})
