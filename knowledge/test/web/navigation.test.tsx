import './setup.ts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NAV_STORAGE_KEY } from '../../src/app/navigation.ts'
import { PEOPLE, type Person } from '../support/harness.ts'
import { liveApi, renderApp, type Live } from './support/live.tsx'

// The two-level navigation of DESIGN.md §3.2 for each kind of person (COL-04, ACC-01, ACC-02, ACC-04, ACC-05): level 1
// from the navigation manifest for what their permissions leave them, then Docs and Settings, and the person at the
// bottom; level 2 under Collections lists their collections, with "New collection" for those who may start one; each
// level collapses to icons and remembers it. Rendered against the real API with the in-memory engine.

let live: Live | undefined
afterEach(() => live?.h.close())

const primary = () => screen.getByRole('navigation', { name: 'Primary' })
const primaryLinks = () => within(primary()).getAllByRole('link').map((link) => link.textContent)

async function open(person: Person, path = '/') {
  live = await liveApi(person)
  renderApp(path)
  await screen.findByRole('navigation', { name: 'Primary' })
  return live
}

describe('COL-04 the navigation, for every role', () => {
  const ROLES: [string, Person, string[]][] = [
    ['a Viewer', PEOPLE.leo, ['Home', 'Collections', 'Docs']],
    ['an Editor', PEOPLE.maya, ['Home', 'Collections', 'Needs attention', 'Docs']],
    ['an Admin', PEOPLE.ada, ['Home', 'Collections', 'Needs attention', 'Rules and data', 'Health', 'Docs']],
    ['an organization owner', PEOPLE.dana, ['Home', 'Collections', 'Needs attention', 'Rules and data', 'Health', 'Docs']],
  ]

  it.each(ROLES)('COL-04 shows %s their sections, Docs, Settings and themselves', async (_who, person, links) => {
    await open(person)
    expect(primaryLinks()).toEqual(links)
    // Admins' sections sit under their own heading.
    if (links.includes('Health')) expect(within(primary()).getByText('Admin')).toBeTruthy()
    // Settings opens the platform's pages beside level 1.
    fireEvent.click(within(primary()).getByRole('button', { name: 'Settings' }))
    const section = await screen.findByRole('navigation', { name: 'Section' })
    expect(within(section).getAllByRole('link').map((link) => link.textContent)).toEqual(['People', 'Integrations', 'API access', 'Connect AI'])
    expect(within(section).getByRole('link', { name: 'Connect AI' }).getAttribute('href')).toBe('/settings/connect-ai')
    // The person at the bottom, with their role in Knowledge.
    expect(screen.getByRole('button', { name: new RegExp(`^${person.name}, `) }).textContent).toContain(person.role === 'VIEWER' ? 'Viewer in Knowledge' : person.role === 'EDITOR' ? 'Editor in Knowledge' : 'Admin in Knowledge')
  })

  it.each(ROLES)('COL-04 opens the Docs for %s, before any collection exists', async (_who, person) => {
    await open(person, '/')
    fireEvent.click(within(primary()).getByRole('link', { name: 'Docs' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Getting started' })).toBeTruthy()
    expect(within(primary()).getByRole('link', { name: 'Docs' }).getAttribute('aria-current')).toBe('page')
  })

  it('COL-04 a custom role without permission to change content sees a Viewer\'s sections', async () => {
    await open({ ...PEOPLE.maya, permissions: ['knowledge.use', 'knowledge.collections.create'] })
    expect(primaryLinks()).toEqual(['Home', 'Collections', 'Docs'])
  })

  it('COL-04 each level collapses to its icons, with the labels as names, and the browser remembers it', async () => {
    live = await liveApi(PEOPLE.maya)
    await live.h.collection(PEOPLE.maya, 'Partner Programs')
    renderApp('/')
    await screen.findByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(primary()).getByRole('link', { name: 'Collections' }))
    const section = await screen.findByRole('navigation', { name: 'Section' })
    await within(section).findByRole('link', { name: 'Partner Programs' })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }))
    expect(within(primary()).getByRole('link', { name: 'Home' }).getAttribute('title')).toBe('Home')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Collections' }))
    expect(within(section).getByRole('link', { name: 'Partner Programs' }).getAttribute('title')).toBe('Partner Programs')
    expect(JSON.parse(window.localStorage.getItem(NAV_STORAGE_KEY)!)).toEqual({ l1: 'collapsed', l2: 'collapsed' })
    fireEvent.click(screen.getByRole('button', { name: 'Expand navigation' }))
    expect(JSON.parse(window.localStorage.getItem(NAV_STORAGE_KEY)!)).toEqual({ l1: 'expanded', l2: 'collapsed' })
  })
})

describe('level 2 under Collections', () => {
  it('ACC-01 lists the person\'s collections, with New collection for an Editor', async () => {
    const { h } = await open(PEOPLE.maya, '/collections')
    await h.collection(PEOPLE.maya, 'Partner Programs')
    await h.collection(PEOPLE.eli, 'Eli private')
    // The list loads once; a new collection made elsewhere shows on the next visit.
    live!.as(PEOPLE.maya)
    fireEvent.click(within(primary()).getByRole('link', { name: 'Home' }))
    fireEvent.click(within(primary()).getByRole('link', { name: 'Collections' }))
    const section = await screen.findByRole('navigation', { name: 'Section' })
    expect(within(section).getByRole('link', { name: 'New collection' })).toBeTruthy()
    expect(within(primary()).getByRole('link', { name: 'Collections' }).getAttribute('aria-current')).toBe('page')
  })

  it('ACC-02 offers a Viewer no New collection anywhere', async () => {
    const { h } = await open(PEOPLE.leo, '/collections')
    const id = await h.collection(PEOPLE.maya, 'Partner Programs')
    await h.share(PEOPLE.maya, id, PEOPLE.leo, 'VIEWER')
    expect(screen.queryByRole('link', { name: 'New collection' })).toBeNull()
    expect(await screen.findByText(/Viewers in Knowledge can ask the collections shared with them, but can't start one/)).toBeTruthy()
    fireEvent.click(within(primary()).getByRole('link', { name: 'Home' }))
    expect(screen.queryByRole('link', { name: /New collection/ })).toBeNull()
  })

  it('ACC-01 shows a new collection to its owner only: an Admin\'s list doesn\'t contain it', async () => {
    live = await liveApi(PEOPLE.ada)
    const id = await live.h.collection(PEOPLE.maya, 'e2e-private')
    expect(id).toBeTruthy()
    renderApp('/collections')
    await screen.findByRole('heading', { level: 2, name: 'Your collections' })
    await waitFor(() => expect(screen.queryAllByText(/Nothing is shared with you yet|No collections yet/).length).toBeGreaterThan(0))
    expect(screen.queryByText('e2e-private')).toBeNull()
    // ACC-05: an organization admin gets no "Other collections" list.
    expect(screen.queryByText(/Other collections in/)).toBeNull()
  })

  it('ACC-04 LIM-10 shows an organization owner the other collections\' basic information only, turns keep-ready off, and deletes one after its name is typed', async () => {
    live = await liveApi(PEOPLE.dana)
    const id = await live.h.collection(PEOPLE.maya, 'Board prep notes', 'Secret purpose words')
    await live.h.note(PEOPLE.maya, id, 'The board meets in the second week of each quarter.', 'Agenda')
    await live.h.json(PEOPLE.maya, 'PATCH', `/api/collections/${id}`, { keepReady: { days: [1, 2, 3, 4, 5], start: '09:00', hours: 2 } })
    renderApp('/collections')
    const card = await screen.findByRole('heading', { name: /Other collections in/ })
    expect(card).toBeTruthy()
    expect((await screen.findAllByText('Board prep notes')).length).toBeGreaterThan(0)
    // Must catch: no purpose, source or fact text appears.
    expect(document.body.textContent).not.toContain('Secret purpose words')
    expect(document.body.textContent).not.toContain('second week')
    // LIM-10: an organization owner turns keep-ready off without access.
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn off keep-ready' })[0]!)
    expect(await screen.findByText(/Keep-ready is off for “Board prep notes”/)).toBeTruthy()
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Turn off keep-ready' })).toHaveLength(0))
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete…' })[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/gets an e-mail that an owner of your organization deleted it/)).toBeTruthy()
    const confirm = within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText("Type the collection's name to confirm"), { target: { value: 'Board prep notes' } })
    fireEvent.click(confirm)
    expect(await screen.findByText(/“Board prep notes” (was deleted|is being deleted)/)).toBeTruthy()
    expect(live.h.gateway.mail.some((mail) => mail.to === PEOPLE.maya.email)).toBe(true)
  })
})
