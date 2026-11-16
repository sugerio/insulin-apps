import './setup.ts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PEOPLE, type Person } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// Every business screen for every kind of person (COL-02): none says embedding, chunk, vector, Top K, snapshot,
// container, Durable Object or MCP; Health shows the engine's terms only behind "Engine terms". And the phone-width
// basics jsdom can check (COL-05): the navigation opens in a drawer, and asking works from the keyboard alone. The
// sideways-scroll check runs in a real browser (the e2e run), as jsdom lays nothing out.

let live: Live | undefined
afterEach(() => {
  live?.h.close()
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true })
})

export const BANNED = /\b(embeddings?|chunks?|vectors?|top[ -]?k|snapshots?|containers?|durable objects?|mcp)\b/i

async function settled() {
  await screen.findByRole('heading', { level: 1 })
  await waitFor(() => expect(screen.queryAllByRole('status').filter((node) => /Loading|Opening|Checking/.test(node.textContent ?? ''))).toEqual([]))
}

async function seeded(person: Person) {
  live = await liveApi(person)
  const id = await live.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
  await live.h.note(PEOPLE.maya, id, 'Deals above $25,000 need sign-off from the alliance lead. Questions to council@example.com.', 'Approvals')
  for (const other of [PEOPLE.leo, PEOPLE.ada]) await live.h.share(PEOPLE.maya, id, other, 'VIEWER')
  await live.h.json(PEOPLE.leo, 'POST', `/api/collections/${id}/reports`, { question: 'Who signs off?', note: 'Moved.' })
  return id
}

const SCREENS = (id: string, person: Person) => [
  '/', '/collections', '/collections/new', '/docs',
  ...(person === PEOPLE.dana ? [] : [`/collections/${id}`, `/collections/${id}/ask`, `/collections/${id}/sources`, `/collections/${id}/knows`, `/collections/${id}/sharing`, `/collections/${id}/history`]),
  '/attention', '/rules', '/health',
]

describe('COL-02 no technical words on business screens', () => {
  it.each([['a Viewer', PEOPLE.leo], ['an Editor', PEOPLE.maya], ['an Admin', PEOPLE.ada], ['an organization owner', PEOPLE.dana]] as const)(
    'COL-02 shows %s no banned word on any screen, nor in an answer and its source', async (_who, person) => {
      const id = await seeded(person)
      for (const path of SCREENS(id, person)) {
        const view = renderApp(path)
        await settled()
        if (path.endsWith('/ask')) {
          fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Who signs off deals above $25,000?' } })
          fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
          const answer = await screen.findByRole('region', { name: 'Answer' })
          fireEvent.click(await within(answer).findByRole('button', { name: /^Source 1/ }))
          await screen.findByText('The highlighted words are what the answer used.')
        }
        // Must catch: any banned word fails the plan.
        expect({ path, words: (document.body.textContent ?? '').match(BANNED)?.[0] ?? null }).toEqual({ path, words: null })
        view.unmount()
      }
    })

  it('COL-02 Health shows the engine\'s terms only when "Engine terms" is on', async () => {
    await seeded(PEOPLE.ada)
    renderApp('/health')
    await settled()
    expect((await screen.findAllByText('Partner Programs')).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(BANNED)
    fireEvent.click(screen.getByLabelText('Engine terms'))
    expect(await screen.findAllByText(/Durable Object/)).not.toHaveLength(0)
  })
})

describe('COL-05 phone width and keyboard', () => {
  it('COL-05 opens the navigation in a drawer at 390 px, and asks from the keyboard alone', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true })
    const id = await seeded(PEOPLE.maya)
    renderApp(`/collections/${id}/ask`)
    await settled()
    // Both levels are in the drawer, behind the menu button, rather than beside the page.
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByRole('navigation', { name: 'Primary' })).toBeTruthy()
    expect(within(drawer).getByRole('navigation', { name: 'Section' }).textContent).toContain('Partner Programs')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close navigation' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The main action stays there; Enter in the question asks.
    const question = screen.getByLabelText('Question')
    question.focus()
    fireEvent.change(question, { target: { value: 'Who signs off deals above $25,000?' } })
    fireEvent.submit(question.closest('form')!)
    const answer = await screen.findByRole('region', { name: 'Answer' })
    expect(await within(answer).findByRole('button', { name: /^Source 1/ })).toBeTruthy()
  })
})
