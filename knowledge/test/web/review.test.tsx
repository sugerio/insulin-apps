import './setup.ts'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AnswerView } from '../../src/app/components/Answer.tsx'
import { ImportProgress } from '../../src/app/components/ImportProgress.tsx'
import { stateLabel, stateMessage } from '../../src/app/lib/format.ts'
import type { AskAnswer, ImportStatus } from '../../src/app/lib/types.ts'
import { ORG, PEOPLE } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// Screens for fixing once (telling the person who added a file), imports that wait for next month, and corrections
// that ask to be checked.

let live: Live | undefined
afterEach(() => {
  live?.h.close()
  live = undefined
})

describe('fixing and waiting', () => {
  it('J4 the fix can tell the person who added the file: they get an e-mail with a link', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await live.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
    await live.h.share(PEOPLE.maya, id, PEOPLE.eli, 'EDITOR')
    const bytes = new TextEncoder().encode('Deals above $25,000 need sign-off from the alliance lead.')
    const preflight = await live.h.json<{ files: { fileId: string }[] }>(PEOPLE.eli, 'POST', `/api/collections/${id}/preflight`, { files: [{ name: 'Approvals.md', bytes: bytes.byteLength }] })
    const fileId = preflight.body.files[0]!.fileId
    await live.h.call(PEOPLE.eli, 'PUT', `/api/collections/${id}/uploads/${fileId}`, bytes)
    await live.h.call(PEOPLE.eli, 'POST', `/api/collections/${id}/imports`, { fileIds: [fileId] })
    await live.h.tick()
    renderApp(`/collections/${id}/ask`)
    fireEvent.change(await screen.findByLabelText('Question'), { target: { value: 'Who signs off deals above $25,000?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const answer = await screen.findByRole('region', { name: 'Answer' })
    await within(answer).findByRole('button', { name: /^Source 1/ })
    fireEvent.click(within(answer).getByRole('button', { name: 'Not right' }))
    fireEvent.change(within(answer).getByLabelText("What's the right answer?"), { target: { value: 'Deals above $50,000 need sign-off from the alliance lead.' } })
    fireEvent.click(within(answer).getByLabelText(/Tell the person who added this file/))
    fireEvent.click(within(answer).getByRole('button', { name: 'Save the correction' }))
    expect(await within(answer).findByText(/New questions on this site and from AI assistants use your correction/, {}, { timeout: 15_000 })).toBeTruthy()
    const told = live.h.gateway.mail.filter((mail) => mail.to === PEOPLE.eli.email)
    expect(told.map((mail) => mail.subject)).toContain('Maya Example corrected an answer from your file in “Partner Programs”')
  })

  it('an import waiting for next month says so, with the day it starts by itself', () => {
    const status = {
      importId: 'i1', state: 'waiting', attempt: 0, queuePosition: null, waitingFor: 'month', files: [{ fileId: 'f1', name: 'Plan.md', state: 'waiting' }],
      notes: 0, version: null, newFacts: null, failedFileId: null, error: null, etaSeconds: null, createdAt: new Date().toISOString(), finishedAt: null,
    } as ImportStatus
    render(<ImportProgress status={status} collectionName="Partner Programs" />)
    expect(screen.getByText(/Your organization has learned this month's documents, so this file waits and Partner Programs learns it on/)).toBeTruthy()
    expect(screen.getByText(/^Starts /)).toBeTruthy()
  })

  it('a waiting import names the file Insulin couldn\'t keep until then, to add again', () => {
    const status = {
      importId: 'i1', state: 'waiting', attempt: 0, queuePosition: null, waitingFor: 'month',
      files: [{ fileId: 'f1', name: 'Plan.md', state: 'waiting' }, { fileId: 'f2', name: 'Old.md', state: 'failed', reason: "Insulin couldn't keep this file until then. Add it again." }],
      notes: 0, version: null, newFacts: null, failedFileId: null, error: null, etaSeconds: null, createdAt: new Date().toISOString(), finishedAt: null,
    } as ImportStatus
    render(<ImportProgress status={status} collectionName="Partner Programs" />)
    expect(screen.getByText(/so this file waits and Partner Programs learns it on .*Insulin couldn't keep “Old\.md” until then: add it again\./)).toBeTruthy()
  })

  it('at the awake-hours stop, a question and a collection say Knowledge has stopped until the 1st, and nothing asks again', async () => {
    const answer: AskAnswer = {
      answerId: null, outcome: 'waiting', status: 'held', text: null, retryAfterSeconds: 3,
      message: "Your organization has used this month's awake hours, so Knowledge has stopped until the 1st, or until Insulin Apps raises the limit. Everything it learned is kept.",
      citations: [], sources: [], collections: [{ id: 'c1', name: 'Partner Programs', status: 'held', retryAfterSeconds: 3, covered: false }], skipped: [],
    }
    let asked = 0
    render(<AnswerView question="Who signs off?" answer={answer} collections={[]} onOpenSource={() => {}} onAskAgain={() => { asked += 1 }} />)
    expect(screen.getByText(/has stopped until the 1st/)).toBeTruthy()
    expect(screen.queryByText(/Asking again in/)).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 3_200))
    expect(asked).toBe(0)
    expect(stateLabel('held').label).toBe('Stopped until the 1st')
    expect(stateMessage('held', 'Partner Programs')).toMatch(/removing a file for good still works/)
  }, 10_000)

  it('Needs attention shows a correction that asks to be checked after its file was read again', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await live.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
    await live.h.note(PEOPLE.maya, id, 'Project Bluebird ships in March.', 'Plans')
    const found = await live.h.json<{ passages: { documentId: string; textHash: string }[] }>(PEOPLE.maya, 'POST', '/api/search', { collections: [id], query: 'Bluebird ships March' })
    const passage = found.body.passages[0]!
    await live.h.call(PEOPLE.maya, 'POST', `/api/collections/${id}/corrections`, { text: 'Project Bluebird ships in April.', outdated: [{ documentId: passage.documentId, textHash: passage.textHash }] })
    await live.h.call({ ...PEOPLE.dana, org: ORG }, 'PUT', '/api/rules', { hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: ['Bluebird'] } })
    await live.h.tick()
    renderApp('/attention')
    expect(await screen.findByText('A correction asks to be checked')).toBeTruthy()
    expect(screen.getByText(/“Plans” was read again/)).toBeTruthy()
  })
})
