import './setup.ts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { factQuestion, suggestedQuestions } from '../../src/app/lib/suggestions.ts'
import { ORG, PEOPLE } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// What the /e2e-test run found on the screens: the day a waiting import starts, the upload control while an import
// starts, the confirmation after a transfer, questions to try in a new collection, its counts while they load, what
// What it knows searches, and API clients in the share dialog.

let live: Live | undefined
const zone = process.env.TZ
afterEach(() => {
  live?.h.close()
  live = undefined
  process.env.TZ = zone
})

/** Wraps the page's fetch (the live API) so a test can hold a request back. */
function around(change: (path: string, method: string, inner: () => Promise<Response>) => Promise<Response>) {
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, 'https://knowledge.insulinapps.test')
    return change(`${url.pathname}${url.search}`, (init.method ?? 'GET').toUpperCase(), () => inner(input, init))
  })
}

/** A request held until `release()`. */
function gate() {
  let release!: () => void
  const open = new Promise<void>((resolve) => { release = resolve })
  return { open, release }
}

async function collectionWithNote(text = 'Deals above $25,000 need sign-off from the alliance lead.') {
  const id = await live!.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
  await live!.h.note(PEOPLE.maya, id, text, 'Approvals')
  return id
}

/** The new-collection wizard up to "Add what you know", with its file picker open. */
async function wizardToUpload(name: string) {
  renderApp('/collections/new')
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  return await screen.findByLabelText(`Files to add to ${name}`) as HTMLInputElement
}

const markdown = (text: string, name: string) => new File([text], name, { type: 'text/markdown' })

describe('BUG-5 the day a waiting import starts', () => {
  it('Sources names the same day as the import, in UTC, for a browser west of UTC', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await live.h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, 'learned_month', 0, NULL, 0)`).bind(ORG).run()
    const added = await live.h.json<{ waiting?: { until: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Tiers', text: 'Gold partners renew every March.' })
    expect(added.body.waiting?.until).toBe('2026-12-01T00:00:00Z')
    // In Los Angeles that moment is still November 30.
    process.env.TZ = 'America/Los_Angeles'
    renderApp(`/collections/${id}/sources`)
    const list = await screen.findByRole('list', { name: 'Waiting for the 1st' })
    expect(within(list).getByText(/starts December 1$/)).toBeTruthy()
    expect(list.textContent).not.toMatch(/Nov 30/)
  })
})

describe('BUG-7 the upload control while an import starts', () => {
  it('shows that learning is starting, never the list of files that can\'t be learned', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await live.h.collection(PEOPLE.maya, 'Partner Programs')
    const held = gate()
    const sent = gate()
    around(async (path, method, inner) => {
      if (method === 'POST' && path === `/api/collections/${id}/imports`) {
        sent.release()
        await held.open
      }
      return inner()
    })
    renderApp(`/collections/${id}/sources`)
    fireEvent.click(await screen.findByRole('button', { name: /Upload files/ }))
    fireEvent.change(screen.getByLabelText('Files to add to Partner Programs'), { target: { files: [markdown('Gold partners get a named contact.', 'Partners.md')] } })
    // The file was accepted and the import is on its way.
    await sent.open
    await waitFor(() => expect(screen.queryByText('Checking and uploading…')).toBeNull())
    expect(screen.queryByText(/can't be learned/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Learn 1 file' })).toBeNull()
    expect(screen.getByText('Starting to learn 1 file…')).toBeTruthy()
    held.release()
    expect(await screen.findByText(/Done\. Partner Programs learned 1 file/, {}, { timeout: 15_000 })).toBeTruthy()
  })
})

describe('BUG-8 the confirmation after a transfer', () => {
  it('says who owns it now, after the page shows the sender as an admin', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    renderApp(`/collections/${id}/sharing`)
    fireEvent.click(await screen.findByRole('button', { name: 'Transfer…' }))
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: 'Eli' } })
    fireEvent.click(await screen.findByRole('button', { name: /Eli Example/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Transfer “Partner Programs” to Eli Example?' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transfer' }))
    // The Owner only card goes with the reload: Maya is an admin of it now.
    expect(await screen.findByText('Your role: Admin')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Transfer…' })).toBeNull())
    expect(screen.getByText('Eli Example owns “Partner Programs” now. You are an admin of it.')).toBeTruthy()
    const people = await screen.findByRole('list', { name: 'People with access' })
    await waitFor(() => expect(people.querySelector('li')?.textContent).toMatch(/^Eli Example.*Owner$/))
  })
})

describe('BUG-9 questions to try in a new collection', () => {
  it('are made from the facts shown, one per document, and the same facts give the same questions', () => {
    const facts = [
      { documentId: 'd1', sentence: 'Every production deploy starts with a canary.' },
      { documentId: 'd1', sentence: 'Kestrel rolls the deploy back automatically.' },
      { documentId: 'd2', sentence: `${'Long '.repeat(40)}sentence.` },
      { documentId: 'd2', sentence: 'Audit logs are kept for 400 days.' },
      { documentId: 'd3', sentence: 'Cut short at three hundred characters…' },
      { documentId: 'd4', sentence: 'Start the renewal 120 days before the end date.' },
      { documentId: 'd5', sentence: 'Gold partners get a named contact.' },
    ]
    expect(suggestedQuestions(facts)).toEqual([
      'Every production deploy starts with a canary — is that right?',
      'Audit logs are kept for 400 days — is that right?',
      'Start the renewal 120 days before the end date — is that right?',
    ])
    expect(suggestedQuestions(facts)).toEqual(suggestedQuestions(facts))
    expect(suggestedQuestions(facts, 1)).toHaveLength(1)
    expect(suggestedQuestions([])).toEqual([])
    expect(factQuestion({ sentence: '  Hawser listens on port 8443. ' })).toBe('Hawser listens on port 8443 — is that right?')
    expect(factQuestion({ sentence: '…' })).toBeNull()
  })

  it('COL-01 clicking one asks it and shows the cited answer, as typing it would', async () => {
    live = await liveApi(PEOPLE.maya)
    const input = await wizardToUpload('Partner handbook')
    fireEvent.change(input, {
      target: {
        files: [
          markdown('Gold partners get a named contact.\n\nSilver partners renew every June.', 'Partners.md'),
          markdown('Start the renewal conversation 120 days before the contract end date.', 'Renewals.md'),
        ],
      },
    })
    expect(await screen.findByRole('heading', { name: "Here's what Insulin learned" }, { timeout: 15_000 })).toBeTruthy()
    const list = await screen.findByRole('list', { name: 'Questions to try' })
    const offered = within(list).getAllByRole('button').map((button) => button.textContent)
    expect(offered).toEqual([
      'Gold partners get a named contact — is that right?',
      'Start the renewal conversation 120 days before the contract end date — is that right?',
    ])
    const asked = live.requests.length
    fireEvent.click(within(list).getByRole('button', { name: /^Start the renewal conversation/ }))
    const answer = await screen.findByRole('region', { name: 'Answer' })
    expect((screen.getByLabelText('Question') as HTMLInputElement).value).toBe(offered[1])
    expect(live.requests.slice(asked)).toContain('POST /api/ask')
    const citation = await within(answer).findByRole('button', { name: /^Source 1: Renewals\.md/ })
    fireEvent.click(citation)
    const viewer = await screen.findByRole('dialog')
    await waitFor(() => expect(viewer.querySelector('[data-cited]')?.textContent).toMatch(/120 days before the contract end date/))
  }, 30_000)
})

describe('the wizard\'s counts', () => {
  it('says it is counting, not "0 documents and 0 facts", until the counts arrive', async () => {
    live = await liveApi(PEOPLE.maya)
    const held = gate()
    around(async (path, method, inner) => {
      if (method === 'GET' && /^\/api\/collections\/[^/?]+$/.test(path) && path !== '/api/collections/others') await held.open
      return inner()
    })
    const input = await wizardToUpload('Partner handbook')
    fireEvent.change(input, { target: { files: [markdown('Gold partners get a named contact.\n\nSilver partners renew every June.', 'Partners.md')] } })
    const card = (await screen.findByRole('heading', { name: "Here's what Insulin learned" }, { timeout: 15_000 })).closest('[data-slot="card"]') as HTMLElement
    expect(card.textContent).not.toMatch(/0 documents|0 facts/)
    expect(within(card).getByText('Counting what Partner handbook learned…')).toBeTruthy()
    held.release()
    expect(await screen.findByText('Partner handbook now has 1 document and 2 facts.')).toBeTruthy()
    expect(screen.queryByText(/Counting what/)).toBeNull()
  }, 30_000)
})

describe('What it knows\' search', () => {
  it('says it looks through the facts shown, and Show more makes later ones searchable', async () => {
    live = await liveApi(PEOPLE.maya)
    // More facts than one page of them (the in-memory engine's pages hold 50).
    const text = Array.from({ length: 55 }, (_, index) => `Rule number ${index + 1} is marker${index + 1}.`).join('\n\n')
    const id = await collectionWithNote(text)
    renderApp(`/collections/${id}/knows`)
    expect(await screen.findByText('The search looks through the facts shown here. When there are more, “Show more” at the end of the list adds them.')).toBeTruthy()
    await screen.findByText(/Rule number 1 is marker1\./)
    fireEvent.change(screen.getByLabelText('Search what it knows'), { target: { value: 'marker55' } })
    expect(await screen.findByText(/No facts match/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('Rule number 55 is marker55.')).toBeTruthy()
  })
})

describe('API clients in the share dialog', () => {
  it('shows a client by its name only, with no role in Knowledge', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    renderApp(`/collections/${id}/sharing`)
    fireEvent.change(await screen.findByLabelText('Share with a person'), { target: { value: 'CRM' } })
    const client = await screen.findByRole('button', { name: /^CRM sync \(API client\)/ })
    expect(client.textContent).not.toMatch(/in Knowledge/)
    expect(client.textContent).toBe('CRM sync (API client)')
    // A person still shows their address and role in Knowledge.
    fireEvent.change(screen.getByLabelText('Share with a person'), { target: { value: 'Leo' } })
    expect((await screen.findByRole('button', { name: /Leo Example/ })).textContent).toMatch(/leo@example\.test · Viewer in Knowledge/)
    fireEvent.change(screen.getByLabelText('Share with a person'), { target: { value: 'CRM' } })
    fireEvent.click(await screen.findByRole('button', { name: 'CRM sync (API client)' }))
    const form = screen.getByLabelText('Role').closest('form')!
    expect(form.querySelector('p')?.textContent).toBe('CRM sync (API client)')
    fireEvent.click(within(form).getByRole('button', { name: 'Share' }))
    expect(await screen.findByText('Shared with CRM sync as Viewer.')).toBeTruthy()
  })
})
