import './setup.ts'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportProgress, useImportWatch } from '../../src/app/components/ImportProgress.tsx'
import type { ImportStatus } from '../../src/app/lib/types.ts'
import { ORG, PEOPLE } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// The screens the third review asked for: sharing that opens without an error, checking shares, corrections that are
// still right, imports waiting for the 1st on every screen, "Yes" under an answer, a new question without the old
// answer, going back that finishes later, an export that survives a failed check, and the days of backups.

let live: Live | undefined
afterEach(() => {
  live?.h.close()
  live = undefined
  vi.useRealTimers()
})

async function collectionWithNote(text = 'Deals above $25,000 need sign-off from the alliance lead.') {
  const id = await live!.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
  await live!.h.note(PEOPLE.maya, id, text, 'Approvals')
  return id
}

/** Wraps the page's fetch (the live API) so a test can change what a request answers. */
function around(change: (path: string, method: string, inner: () => Promise<Response>) => Promise<Response>) {
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, 'https://knowledge.insulinapps.test')
    return change(`${url.pathname}${url.search}`, (init.method ?? 'GET').toUpperCase(), () => inner(input, init))
  })
}

async function ask(question: string) {
  fireEvent.change(await screen.findByLabelText('Question'), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
}

describe('sharing', () => {
  it('opens without searching for no one, and each member picker has its own label', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    renderApp(`/collections/${id}/sharing`)
    expect(await screen.findByText('Type a name or an e-mail address to find someone.')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(live.requests.filter((request) => request.startsWith('GET /api/members'))).toEqual([])
    expect(screen.queryByText(/isn't available/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Transfer…' }))
    const share = screen.getByLabelText('Share with a person')
    const owner = screen.getByLabelText('New owner')
    expect(share).not.toBe(owner)
    expect(share.id).not.toBe(owner.id)
  })

  it('shows a share being checked as Knowledge checks who is still here', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await live.h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    await live.h.db.prepare(`UPDATE members SET unchecked = 1 WHERE org_id = ? AND principal_id = ?`).bind(ORG, PEOPLE.eli.id).run()
    renderApp(`/collections/${id}/sharing`)
    const people = await screen.findByRole('list', { name: 'People with access' })
    expect(await within(people).findByText(/Checking: Knowledge is making sure they are still in your organization/)).toBeTruthy()
  })
})

describe('answers', () => {
  it('a new question never shows the previous answer while it waits', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    renderApp(`/collections/${id}/ask`)
    await ask('Who signs off deals above $25,000?')
    expect(await screen.findByRole('region', { name: 'Answer' })).toBeTruthy()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    around(async (path, method, inner) => {
      if (method === 'POST' && path === '/api/ask') await gate
      return inner()
    })
    await ask('And who signs off below that?')
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Answer' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Not right' })).toBeNull()
    release()
    expect(await screen.findByText(/You asked: And who signs off below that\?/)).toBeTruthy()
  })

  it('Was this right? Yes records it, and the collection counts answers marked right', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    renderApp(`/collections/${id}/ask`)
    await ask('Who signs off deals above $25,000?')
    const answer = await screen.findByRole('region', { name: 'Answer' })
    expect(within(answer).getByText('Was this right?')).toBeTruthy()
    fireEvent.click(within(answer).getByRole('button', { name: 'Yes' }))
    expect(await within(answer).findByText('Thanks. Marked right.')).toBeTruthy()
    expect(await live.h.db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE collection_id = ? AND marked_right_at IS NOT NULL`).bind(id).first('n')).toBe(1)
  })
})

describe('corrections to check', () => {
  async function checkItem() {
    const id = await collectionWithNote('Partner discounts stop at 20 percent.')
    const facts = await live!.h.json<{ facts: { factId: string; documentId: string; passageTextHash: string }[] }>(PEOPLE.maya, 'GET', `/api/collections/${id}/facts`)
    const fix = await live!.h.json<{ correction: { id: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Discounts stop at 15 percent.', factId: facts.body.facts[0]!.factId })
    await live!.h.tick()
    await live!.h.db.prepare(`INSERT INTO correction_checks (collection_id, note_id, document_id, text_hash, org_id, at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, fix.body.correction.id.replace(/-/g, ''), facts.body.facts[0]!.documentId, facts.body.facts[0]!.passageTextHash, ORG, live!.h.clock.now).run()
    return id
  }

  it('Still right clears it', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await checkItem()
    renderApp(`/attention?collection=${id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Still right' }))
    await waitFor(() => expect(screen.queryByText('A correction asks to be checked')).toBeNull())
  })

  it('Write it again opens the fix with the correction already in it', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await checkItem()
    renderApp(`/attention?collection=${id}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Write it again' }))
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText("What's the right answer?") as HTMLTextAreaElement).value).toBe('Discounts stop at 15 percent.')
  })
})

describe('imports waiting for the 1st', () => {
  const block = () => live!.h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, 'learned_month', 0, NULL, 0)`).bind(ORG).run()

  it('the write-answer panel says it waits, rather than learning', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await block()
    renderApp(`/collections/${id}/ask`)
    await ask('What is the capital of Atlantis?')
    const answer = await screen.findByRole('region', { name: 'Answer' })
    fireEvent.click(within(answer).getByRole('button', { name: 'Write the answer' }))
    fireEvent.change(within(answer).getByLabelText(/Your answer, saved as a note/), { target: { value: 'Atlantis has no capital.' } })
    fireEvent.click(within(answer).getByRole('button', { name: 'Save the answer' }))
    expect(await within(answer).findByText(/learns your answer on December 1, by itself/)).toBeTruthy()
    expect(within(answer).queryByText(/Learning your answer/)).toBeNull()
  })

  it('the new-collection wizard goes on while its files wait', async () => {
    live = await liveApi(PEOPLE.maya)
    await block()
    renderApp('/collections/new')
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Waiting room' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('button', { name: /Write a note/ }))
    fireEvent.change(await screen.findByLabelText('Note'), { target: { value: 'Gold partners renew every March.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and learn it' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByText(/Share “Waiting room”/)).toBeTruthy()
  })

  it('Sources lists the collection\'s waiting imports, and one can be cancelled', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await block()
    await live.h.json(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Tiers', text: 'Gold partners renew every March.' })
    renderApp(`/collections/${id}/sources`)
    const list = await screen.findByRole('list', { name: 'Waiting for the 1st' })
    expect(within(list).getByText(/Tiers/)).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Waiting for the 1st' })).toBeNull())
  })

  it('a waiting import is checked again when the page comes back into view, and follows a newer status for the same import', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await live.h.collection(PEOPLE.maya)
    await block()
    const added = await live.h.json<{ import: ImportStatus }>(PEOPLE.maya, 'POST', `/api/collections/${id}/notes`, { title: 'Tiers', text: 'Gold partners renew every March.' })
    function Watch({ initial }: { initial: ImportStatus }) {
      const { status } = useImportWatch(id, initial)
      return <ImportProgress status={status ?? initial} collectionName="Partner Programs" />
    }
    let setOuter!: (status: ImportStatus) => void
    function Outer() {
      const [status, setStatus] = useState(added.body.import)
      setOuter = setStatus
      return <Watch initial={status} />
    }
    render(<Outer />)
    expect(await screen.findByText(/Starts December 1/)).toBeTruthy()
    // The limit is raised: the tick starts it, and the engine learns it.
    await live.h.db.prepare(`DELETE FROM org_limits`).run()
    await live.h.tick()
    live.h.engine.control.runUntilIdle()
    await live.h.tick()
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(await screen.findByText(/^Done\./, {}, { timeout: 5_000 })).toBeTruthy()
    // A parent handing a newer status for the same import is followed too.
    act(() => setOuter({ ...added.body.import, state: 'failed', error: { error: 'internal', message: 'Something else happened.' } }))
    expect(await screen.findByText(/Something else happened\./)).toBeTruthy()
  })
})

describe('starting from an export', () => {
  it('a new collection can start from a Knowledge export: it is uploaded, read and learned like files', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    const made = await live.h.json<{ export: { exportId: string } }>(PEOPLE.maya, 'POST', `/api/collections/${id}/exports`)
    const zip = new Uint8Array(await (await live.h.call(PEOPLE.maya, 'GET', `/api/collections/${id}/exports/${made.body.export.exportId}?download=1`)).arrayBuffer())
    renderApp('/collections/new')
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'From the export' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('button', { name: /Start from an export/ }))
    fireEvent.change(await screen.findByLabelText('The export to start from'), { target: { files: [new File([zip], 'partner-programs.zip', { type: 'application/zip' })] } })
    expect(await screen.findByText(/^Done\./, {}, { timeout: 10_000 })).toBeTruthy()
    const created = (await live.h.json<{ collections: { id: string; name: string; documents: number }[] }>(PEOPLE.maya, 'GET', '/api/collections')).body.collections.find((entry) => entry.name === 'From the export')!
    expect(created.documents).toBe(1)
  }, 20_000)
})

describe('history and exports', () => {
  it('going back that finishes later refreshes History and says so then, not when it was accepted', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    live.h.clock.advance(10 * 60 * 1000)
    await live.h.note(PEOPLE.maya, id, 'Gold partners get a dedicated partner manager.', 'Tiers')
    let started = false
    let finished = false
    around(async (path, method, inner) => {
      const response = await inner()
      if (method === 'POST' && path.endsWith('/go-back')) {
        started = true
        const body = (await response.json()) as { collection: { state: string } }
        return Response.json({ collection: { ...body.collection, state: 'going_back' } })
      }
      if (method === 'GET' && path === `/api/collections/${id}` && started && !finished) {
        const body = (await response.json()) as { engine: { state: string } }
        return Response.json({ ...body, engine: { ...body.engine, state: 'going_back' } })
      }
      return response
    })
    renderApp(`/collections/${id}/history`)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Go back to this version' }))[0]!)
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Go back' }))
    expect(await screen.findByText(/Going back to an earlier version/)).toBeTruthy()
    expect(screen.queryByText(/now answers from the version of/)).toBeNull()
    const before = live.requests.filter((request) => request.endsWith('/history')).length
    finished = true
    expect(await screen.findByText(/now answers from the version of/, {}, { timeout: 6_000 })).toBeTruthy()
    expect(live.requests.filter((request) => request.endsWith('/history')).length).toBeGreaterThan(before)
  }, 15_000)

  it('going back that the awake-hours stop cut short says so, and nothing else', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    live.h.clock.advance(10 * 60 * 1000)
    await live.h.note(PEOPLE.maya, id, 'Gold partners get a dedicated partner manager.', 'Tiers')
    let started = false
    around(async (path, method, inner) => {
      const response = await inner()
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
    expect(await screen.findByText(/Going back was stopped: Knowledge has stopped until the 1st/, {}, { timeout: 6_000 })).toBeTruthy()
    expect(screen.queryByText(/now answers from the version of/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Go back to this version' })).toBeNull()
  }, 15_000)

  it('the go-back preview scrolls inside a dialog that fits a phone', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    live.h.clock.advance(10 * 60 * 1000)
    await live.h.note(PEOPLE.maya, id, 'Gold partners get a dedicated partner manager.', 'Tiers')
    renderApp(`/collections/${id}/history`)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Go back to this version' }))[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.className).toMatch(/max-h-/)
    const preview = await within(dialog).findByText(/will answer from what it knew then/)
    expect(preview.closest('[data-go-back-preview]')!.parentElement!.className).toMatch(/overflow-y-auto/)
  })

  it('an export check that fails is tried again, with a button to try now', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    let failures = 1
    let ready = false
    around(async (path, method, inner) => {
      if (method === 'POST' && path.endsWith('/exports')) {
        const response = await inner()
        const body = (await response.json()) as { export: Record<string, unknown> }
        return Response.json({ export: { ...body.export, state: 'running', bytes: null, readyAt: null } }, { status: 202 })
      }
      if (method === 'GET' && path.includes('/exports/')) {
        if (failures > 0) {
          failures -= 1
          return Response.json({ error: 'engine_unavailable', message: 'The engine is busy.' }, { status: 503 })
        }
        if (!ready) {
          const response = await inner()
          const body = (await response.json()) as { export: Record<string, unknown> }
          ready = true
          return Response.json({ export: { ...body.export, state: 'running' } })
        }
      }
      return inner()
    })
    renderApp(`/collections/${id}/sharing`)
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }))
    expect(await screen.findByRole('button', { name: 'Check again now' }, { timeout: 5_000 })).toBeTruthy()
    expect(await screen.findByText('Your export is ready', {}, { timeout: 10_000 })).toBeTruthy()
  }, 20_000)

  it('History and Health name the organization\'s days of daily backups', async () => {
    live = await liveApi(PEOPLE.dana)
    const id = await live.h.collection(PEOPLE.dana)
    await live.h.db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, 'backup_days', 7, NULL, 0)`).bind(ORG).run()
    const view = renderApp(`/collections/${id}/history`)
    expect(await screen.findByText(/Daily backups are kept 7 days/)).toBeTruthy()
    view.unmount()
    renderApp('/health')
    expect(await screen.findByText(/kept 7 days/)).toBeTruthy()
  })
})
