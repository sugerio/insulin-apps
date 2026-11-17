import './setup.ts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PEOPLE, SUPPORT } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// The main flows on the screens, against the real API and the in-memory engine (design section 09): start a collection,
// teach it a note and get a cited answer (COL-01); "I won't guess"; fix an answer once and report one; share like a
// shared document with the Viewer cap; go back and undo; the awake-hours stop; Looks right.

let live: Live | undefined
afterEach(() => live?.h.close())

const NOTE = 'Deals above $25,000 need sign-off from the alliance lead.\n\nPartner discounts stop at 20 percent.'

async function collectionWithNote(owner = PEOPLE.maya) {
  const id = await live!.h.collection(owner, 'Partner Programs', 'What the partner team knows')
  await live!.h.note(owner, id, NOTE, 'Approvals')
  return id
}

async function ask(question: string) {
  fireEvent.change(await screen.findByLabelText('Question'), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
  return screen.findByRole('region', { name: 'Answer' })
}

describe('COL-01 from a new collection to a cited answer', () => {
  it('COL-01 starts a collection, learns a note, answers with a source that opens at the exact words', async () => {
    live = await liveApi(PEOPLE.maya)
    renderApp('/collections/new')
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renewals playbook' } })
    fireEvent.change(screen.getByLabelText('In one sentence, what is it for?'), { target: { value: 'How we run renewals.' } })
    expect(screen.getByText('Private to you until you share it.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    // Step 2: add what you know, here a note.
    fireEvent.click(await screen.findByRole('button', { name: /Write a note/ }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renewal timeline' } })
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Start the renewal conversation 120 days before the contract end date.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and learn it' }))
    // Step 3, learning, then step 4: what it learned.
    expect(await screen.findByRole('heading', { name: "Here's what Insulin learned" }, { timeout: 15_000 })).toBeTruthy()
    // The fact to check, and a question to try made from it.
    await waitFor(() => expect(screen.getAllByText(/Start the renewal conversation 120 days/).some((node) => node.closest('[data-fact]'))).toBe(true))
    expect(within(await screen.findByRole('list', { name: 'Questions to try' })).getByRole('button', { name: /Start the renewal conversation 120 days .* — is that right\?$/ })).toBeTruthy()
    const answer = await ask('When should we start the renewal conversation?')
    const citation = await within(answer).findByRole('button', { name: /^Source 1: Renewal timeline/ })
    expect(within(answer).getByText(/Written by Insulin Knowledge's built-in model/)).toBeTruthy()
    // Must catch: the answer has at least one source that opens.
    fireEvent.click(citation)
    const viewer = await screen.findByRole('dialog')
    expect(within(viewer).getByRole('heading', { name: 'Renewal timeline' })).toBeTruthy()
    await waitFor(() => expect(viewer.querySelector('[data-cited]')?.textContent).toMatch(/120 days before the contract end date/))
    expect(within(viewer).getByText('Maya Example')).toBeTruthy()
    fireEvent.keyDown(viewer, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Next: share it' }))
    expect(await screen.findByText(/Share “Renewals playbook”/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Renewals playbook' })).toBeTruthy()
  })

  it('IMP-01 names a file that can\'t be learned before anything starts, and learns the rest', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await live.h.collection(PEOPLE.maya, 'Partner Programs')
    renderApp(`/collections/${id}/sources`)
    fireEvent.click(await screen.findByRole('button', { name: /Upload files/ }))
    const input = screen.getByLabelText('Files to add to Partner Programs') as HTMLInputElement
    const good = new File(['# Partners\n\nGold partners get a named contact.'], 'Partners.md', { type: 'text/markdown' })
    const bad = new File(['macros'], 'Budget.xlsm')
    fireEvent.change(input, { target: { files: [good, bad] } })
    expect(await screen.findByText(/1 of 2 files can't be learned/)).toBeTruthy()
    expect(screen.getByText(/“Budget.xlsm” is a type Insulin can't read/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Learn 1 file' }))
    expect(await screen.findByText(/Done\. Partner Programs learned 1 file/, {}, { timeout: 15_000 })).toBeTruthy()
    expect((await screen.findAllByRole('button', { name: 'Partners.md' })).length).toBeGreaterThan(0)
  })
})

describe('asking', () => {
  it('ASK-02 says "I won\'t guess" when nothing covers the question, and lets a Viewer ask the owner', async () => {
    live = await liveApi(PEOPLE.leo)
    const id = await collectionWithNote()
    await live.h.share(PEOPLE.maya, id, PEOPLE.leo, 'VIEWER')
    renderApp(`/collections/${id}/ask`)
    const answer = await ask('What is the office wifi password?')
    expect(await within(answer).findByText(/I couldn't find this in “Partner Programs”, so I won't guess\./)).toBeTruthy()
    expect(within(answer).queryByRole('button', { name: 'Write the answer' })).toBeNull()
    fireEvent.click(within(answer).getByRole('button', { name: 'Ask Maya Example to add it' }))
    fireEvent.click(within(answer).getByRole('button', { name: 'Send to Maya Example' }))
    expect(await within(answer).findByText('Sent to Maya Example, the owner.')).toBeTruthy()
    expect(live.h.gateway.mail.some((mail) => mail.to === PEOPLE.maya.email)).toBe(true)
  })

  it('J4 fixes a wrong answer once: the correction is learned and asking again cites it', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    renderApp(`/collections/${id}/ask`)
    const answer = await ask('Who signs off deals above $25,000?')
    await within(answer).findByRole('button', { name: /^Source 1/ })
    fireEvent.click(within(answer).getByRole('button', { name: 'Not right' }))
    fireEvent.change(within(answer).getByLabelText("What's the right answer?"), { target: { value: 'Since October, deals above $50,000 need sign-off from the alliance lead; partner managers sign off up to $50,000.' } })
    fireEvent.click(within(answer).getByRole('button', { name: 'Save the correction' }))
    expect(await within(answer).findByText(/New questions on this site and from AI assistants use your correction/, {}, { timeout: 15_000 })).toBeTruthy()
    fireEvent.click(within(answer).getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Answer' }).textContent).toMatch(/Correction: Who signs off deals above \$25,000\?/))
  })

  it('FIX-03 a Viewer reports an answer; it shows as reported, and the owner settles it in Needs attention', async () => {
    live = await liveApi(PEOPLE.leo)
    const id = await collectionWithNote()
    await live.h.share(PEOPLE.maya, id, PEOPLE.leo, 'EDITOR')
    const view = renderApp(`/collections/${id}/ask`)
    // ACC-07: shared as Editor, Leo acts as Viewer.
    expect(await screen.findByText('Your role: Viewer')).toBeTruthy()
    const answer = await ask('Who signs off deals above $25,000?')
    await within(answer).findByRole('button', { name: /^Source 1/ })
    fireEvent.click(within(answer).getByRole('button', { name: 'Not right' }))
    expect(within(answer).getByRole('heading', { name: "Tell Maya Example what's wrong" })).toBeTruthy()
    fireEvent.change(within(answer).getByLabelText('What did you expect?'), { target: { value: 'The limit went up to $50,000.' } })
    fireEvent.click(within(answer).getByRole('button', { name: 'Send to Maya Example' }))
    expect(await within(answer).findByText('Sent to Maya Example, the owner.')).toBeTruthy()
    const again = await ask('Who signs off deals above $25,000?')
    expect(await within(again).findByText(/Leo Example reported that this answer may be wrong\. Maya Example is checking\./)).toBeTruthy()
    view.unmount()
    live.as(PEOPLE.maya)
    renderApp('/attention')
    const item = await screen.findByText('Leo Example says an answer is wrong')
    const card = item.closest('li')!
    expect(within(card).getByText(/The limit went up to \$50,000/)).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: "It's right" }))
    await waitFor(() => expect(screen.queryByText('Leo Example says an answer is wrong')).toBeNull())
  })

  it('LIM-01 at 100% of awake hours a pop-up says Knowledge has stopped, naming Insulin Apps support', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    await live.h.db.prepare(`INSERT INTO limit_defaults (key, value, updated_at) VALUES ('awake_hours_month', 0, ?)`).bind(Date.now()).run()
    renderApp(`/collections/${id}/ask`)
    await ask('Who signs off deals above $25,000?').catch(() => null)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Knowledge has stopped for this month' })).toBeTruthy()
    expect(within(dialog).getByText(new RegExp(`Knowledge can't answer until .*${SUPPORT.replace('.', '\\.')}`))).toBeTruthy()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy the address' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SUPPORT))
  })
})

describe('sharing, history and what it knows', () => {
  it('ACC-07 ACC-09 shares like a shared document: a Viewer in Knowledge acts as Viewer; general access stops at Editor', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    renderApp(`/collections/${id}/sharing`)
    const general = await screen.findByLabelText('Everyone in your organization who can use Knowledge') as HTMLSelectElement
    expect([...general.options].map((option) => option.textContent)).toEqual(['No access', 'Viewer', 'Editor'])
    fireEvent.change(screen.getByLabelText('Share with a person'), { target: { value: 'Leo' } })
    fireEvent.click(await screen.findByRole('button', { name: /Leo Example/ }))
    const role = screen.getByLabelText('Role') as HTMLSelectElement
    expect([...role.options].map((option) => option.textContent)).toEqual(['Viewer', 'Editor (acts as Viewer)', 'Admin (acts as Viewer)'])
    fireEvent.change(role, { target: { value: 'EDITOR' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(await screen.findByText(/Shared with Leo Example as Editor\. They get an e-mail with a link\./)).toBeTruthy()
    const people = screen.getByRole('list', { name: 'People with access' })
    expect(await within(people).findByText(/Acts as Viewer: their role in Knowledge is Viewer/)).toBeTruthy()
    fireEvent.change(general, { target: { value: 'VIEWER' } })
    expect(await screen.findByText('Everyone in your organization now gets Viewer.')).toBeTruthy()
  })

  it('J8 going back explains first, sets later files aside, and can be undone', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    // Changes close together share one restore point: the second note comes later.
    live.h.clock.advance(10 * 60 * 1000)
    await live.h.note(PEOPLE.maya, id, 'Gold partners get a dedicated partner manager.', 'Tiers')
    renderApp(`/collections/${id}/history`)
    const points = await screen.findByRole('list', { name: 'Restore points' })
    const older = within(points).getAllByRole('button', { name: 'Go back to this version' })
    expect(older).toHaveLength(1)
    fireEvent.click(older[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/1 file added later will be set aside, not deleted: “Tiers”/)).toBeTruthy()
    expect(within(dialog).getByText("Who has access doesn't change.")).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Go back' }))
    expect(await screen.findByText(/now answers from the version of/)).toBeTruthy()
    expect(await screen.findByText(/Went back to the version from/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Undone. Everything is back as it was before you went back.')).toBeTruthy()
  })

  it('FIX-04 What it knows: Looks right records the checker; viewers report a problem instead', async () => {
    live = await liveApi(PEOPLE.maya)
    const id = await collectionWithNote()
    const view = renderApp(`/collections/${id}/knows`)
    const facts = await screen.findAllByText(/Deals above \$25,000|Partner discounts stop/)
    const row = facts[0]!.closest('[data-fact]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Looks right' }))
    expect(await within(row).findByText(/Checked by Maya Example/)).toBeTruthy()
    view.unmount()
    await live.h.share(PEOPLE.maya, id, PEOPLE.leo, 'VIEWER')
    live.as(PEOPLE.leo)
    renderApp(`/collections/${id}/knows`)
    await screen.findAllByText(/Checked by Maya Example/)
    expect(screen.queryByRole('button', { name: 'Looks right' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Report a problem' }).length).toBeGreaterThan(0)
  })

  it('HID-05 Rules and data: the "Try it" box hides what the rules hide, before anything is saved', async () => {
    live = await liveApi(PEOPLE.ada)
    renderApp('/rules')
    const box = await screen.findByLabelText('Try it')
    fireEvent.change(box, { target: { value: 'Write to jordan@example.com or call +1 415 555 0132.' } })
    const result = document.querySelector('[data-try-it-result]') as HTMLElement
    await waitFor(() => expect(result.querySelectorAll('[data-hidden-value]').length).toBe(2))
    expect(result.textContent).not.toContain('jordan@example.com')
    fireEvent.click(screen.getByLabelText('E-mail addresses'))
    await waitFor(() => expect(result.textContent).toContain('jordan@example.com'))
    expect(await screen.findByText(/Awake hours a month/)).toBeTruthy()
  })
})
