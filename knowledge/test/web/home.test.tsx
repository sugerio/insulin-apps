import './setup.ts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PEOPLE, type Person } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// Home (design J0, J1, J2), against the real API with the in-memory engine. Before any collection: a short headline,
// the next step as a checklist, one action (New collection, or for a Viewer asking a colleague to share one), the Docs,
// how it works as a labelled list of steps, and what makes it different as tiles; its motion only behind motion-safe:,
// so with reduced motion nothing moves. With collections: asking across the ones picked (1 to 5), as before.

let live: Live | undefined
afterEach(() => live?.h.close())

const main = () => document.getElementById('main') ?? document.body

async function firstVisit(person: Person) {
  live = await liveApi(person)
  renderApp('/')
  return screen.findByRole('heading', { level: 1, name: "Your team's knowledge, answered with sources." })
}

/** Every class that starts, delays or shapes an animation (tw-animate-css's and the flow's own). */
const MOTION = /(^|:)(animate-|fade-in|slide-in-|zoom-in|spin-in|fill-mode-|repeat-|direction-)/

describe('J0 the first visit', () => {
  it('J0 gives an Editor a short start: the headline, the next step, New collection and the Docs', async () => {
    await firstVisit(PEOPLE.maya)
    // One clear action, and the Docs beside it.
    const start = within(main()).getAllByRole('link', { name: 'New collection' })
    expect(start).toHaveLength(1)
    expect(start[0]!.getAttribute('href')).toBe('/collections/new')
    expect(within(main()).getByRole('link', { name: 'Read the Docs' }).getAttribute('href')).toBe('/docs')
    // Getting started is a checklist: two steps done, small, then the one to do.
    const steps = within(screen.getByRole('list', { name: 'Getting started' })).getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual(['Signed up, done', 'Joined your organization, done', 'Start a collection'])
    expect(steps.map((step) => step.hasAttribute('data-done'))).toEqual([true, true, false])
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([null, null, 'step'])
    // No paragraphs: the old step cards and their sentences are gone.
    expect(main().textContent).not.toContain('One account for every Insulin app')
    expect(main().querySelectorAll('p').length).toBeLessThanOrEqual(1)
  })

  it('J0 draws how it works as a list named "How it works", in order, with decorative icons hidden', async () => {
    await firstVisit(PEOPLE.maya)
    const flow = screen.getByRole('list', { name: 'How it works' })
    const steps = within(flow).getAllByRole('listitem')
    expect(steps.map((step) => step.querySelector('.font-medium')?.textContent)).toEqual(['Add files', 'Insulin learns', 'Ask', 'Answers with sources'])
    expect(steps[0]!.textContent).toContain('web pages and notes too')
    expect(steps[2]!.textContent).toContain('here or from your AI assistant')
    expect(steps[3]!.textContent).toContain('I won\'t guess')
    // Three connectors join four steps; they, the dot and every icon are hidden from screen readers.
    expect(flow.querySelectorAll('[data-connector]')).toHaveLength(3)
    for (const connector of flow.querySelectorAll('[data-connector]')) expect(connector.getAttribute('aria-hidden')).toBe('true')
    for (const icon of main().querySelectorAll('svg')) expect(icon.closest('[aria-hidden="true"]')).not.toBeNull()
    // What makes it different: six tiles, each a few words and one short line that stays visible.
    const tiles = within(screen.getByRole('list', { name: 'What makes it different' })).getAllByRole('listitem')
    expect(tiles.map((tile) => tile.querySelector('.font-medium')?.textContent)).toEqual(['No setup', 'Checkable', 'Fix once', 'Undo anything', 'Private until shared', 'Yours to keep'])
    for (const tile of tiles) expect(tile.querySelector('.text-muted-foreground')?.textContent?.length).toBeLessThanOrEqual(45)
  })

  it('J0 moves only behind motion-safe:, so with reduced motion nothing is animated and no dot shows', async () => {
    await firstVisit(PEOPLE.maya)
    const flow = screen.getByRole('list', { name: 'How it works' })
    const animated = [...main().querySelectorAll<HTMLElement>('[class]')].flatMap((node) => [...node.classList].filter((name) => MOTION.test(name)))
    // The steps come in one after another, and a dot runs along each connector.
    expect(animated).toContain('motion-safe:animate-in')
    expect(animated).toContain('motion-safe:animate-flow-down')
    expect(animated).toContain('sm:motion-safe:animate-flow-across')
    // Must catch: an animation class without motion-safe: would run with reduced motion too.
    expect(animated.filter((name) => !name.split(':').includes('motion-safe'))).toEqual([])
    // The dots are hidden unless motion is welcome, so reduced motion leaves still lines with arrowheads.
    const dots = [...flow.querySelectorAll<HTMLElement>('[data-flow-dot]')]
    expect(dots).toHaveLength(3)
    for (const dot of dots) {
      expect(dot.classList.contains('hidden')).toBe(true)
      expect([...dot.classList].filter((name) => name.endsWith(':block'))).toEqual(['motion-safe:block'])
    }
    // Each dot waits for the one before it: one connector at a time.
    expect(dots.map((dot) => dot.style.animationDelay)).toEqual(['900ms', '1900ms', '2900ms'])
  })

  it('ACC-02 gives a Viewer no New collection, the plain way to get one shared, and the Docs', async () => {
    await firstVisit(PEOPLE.leo)
    expect(screen.queryByRole('link', { name: /New collection/ })).toBeNull()
    expect(screen.getByText('Nothing is shared with you yet: ask a colleague to share one with you.')).toBeTruthy()
    const steps = within(screen.getByRole('list', { name: 'Getting started' })).getAllByRole('listitem')
    expect(steps[2]!.textContent).toBe('Get a collection shared with you')
    expect(steps[2]!.getAttribute('aria-current')).toBe('step')
    expect(within(main()).getByRole('link', { name: 'Read the Docs' }).getAttribute('href')).toBe('/docs')
    // The same picture of how it works, for them too.
    expect(within(screen.getByRole('list', { name: 'How it works' })).getAllByRole('listitem')).toHaveLength(4)
  })

  it('ACC-02 treats a custom role that can\'t start collections as a Viewer here', async () => {
    await firstVisit({ ...PEOPLE.maya, permissions: ['knowledge.use'] })
    expect(screen.queryByRole('link', { name: /New collection/ })).toBeNull()
    expect(screen.getByText(/ask a colleague to share one with you/)).toBeTruthy()
  })
})

describe('J1 asking from Home, once there are collections', () => {
  async function seeded(person: Person, extra = 0) {
    live = await liveApi(person)
    const partner = await live.h.collection(PEOPLE.maya, 'Partner Programs', 'What the partner team knows')
    await live.h.note(PEOPLE.maya, partner, 'Deals above $25,000 need sign-off from the alliance lead.', 'Approvals')
    const release = await live.h.collection(PEOPLE.maya, 'Release notes', 'What changed in each release')
    for (let n = 1; n <= extra; n += 1) await live.h.collection(PEOPLE.maya, `Team ${n}`, 'Synthetic')
    if (person !== PEOPLE.maya) for (const id of [partner, release]) await live.h.share(PEOPLE.maya, id, person, 'VIEWER')
    return { partner, release }
  }

  it('J1 keeps asking as it was: one collection picked to start, up to five, and the question goes to those picked', async () => {
    const { partner } = await seeded(PEOPLE.maya, 4)
    const asked: unknown[] = []
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).endsWith('/api/ask')) asked.push(JSON.parse(String(init.body)))
      return inner(input, init)
    })
    renderApp('/')
    expect(await screen.findByRole('heading', { level: 1, name: 'Ask your collections' })).toBeTruthy()
    // Nothing on the asking home moves.
    expect([...main().querySelectorAll('[class]')].flatMap((node) => [...node.classList]).filter((name) => MOTION.test(name))).toEqual([])
    const group = screen.getByRole('group', { name: 'Search in' })
    const chips = within(group).getAllByRole('button')
    expect(chips).toHaveLength(6)
    const pressed = () => chips.filter((chip) => chip.getAttribute('aria-pressed') === 'true').map((chip) => chip.textContent)
    // The first collection (by name) is picked to start.
    expect(pressed()).toEqual(['Partner Programs'])
    // At most five: the sixth can't be picked until one is let go.
    for (const name of ['Release notes', 'Team 1', 'Team 2', 'Team 3']) fireEvent.click(within(group).getByRole('button', { name }))
    expect(pressed()).toHaveLength(5)
    expect((within(group).getByRole('button', { name: 'Team 4' }) as HTMLButtonElement).disabled).toBe(true)
    for (const name of ['Release notes', 'Team 1', 'Team 2', 'Team 3']) fireEvent.click(within(group).getByRole('button', { name }))
    expect(pressed()).toEqual(['Partner Programs'])
    // None picked: nothing can be asked.
    fireEvent.click(within(group).getByRole('button', { name: 'Partner Programs' }))
    fireEvent.change(screen.getByLabelText('Ask across the collections you picked'), { target: { value: 'Who signs off deals above $25,000?' } })
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Pick at least one collection to ask.')).toBeTruthy()
    fireEvent.click(within(group).getByRole('button', { name: 'Partner Programs' }))
    expect(screen.getByText('Up to 5 at once. Nothing searches every collection by default.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const answer = await screen.findByRole('region', { name: 'Answer' })
    expect(within(answer).getAllByRole('button', { name: /^Source 1/ }).length).toBeGreaterThan(0)
    expect(asked).toEqual([{ collections: [partner], question: 'Who signs off deals above $25,000?' }])
    // Their collections, and a way to start another.
    expect(screen.getByRole('heading', { level: 2, name: 'Your collections' })).toBeTruthy()
    expect(within(main()).getByRole('link', { name: /New collection/ }).getAttribute('href')).toBe('/collections/new')
  })

  it('J1 gives a Viewer the same asking home, without New collection', async () => {
    await seeded(PEOPLE.leo)
    renderApp('/')
    expect(await screen.findByRole('heading', { level: 1, name: 'Ask your collections' })).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'Search in' })).getAllByRole('button').map((chip) => chip.textContent)).toEqual(['Partner Programs', 'Release notes'])
    expect(screen.queryByRole('link', { name: /New collection/ })).toBeNull()
    expect(screen.queryByRole('list', { name: 'How it works' })).toBeNull()
  })
})
