import './setup.ts'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { Docs } from '../../src/app/components/Docs.tsx'
import { PlatformAccountContext, type PlatformAccount } from '../../src/app/lib/platform.ts'
import { DocsPage } from '../../src/app/pages/DocsPage.tsx'
import { TOPIC_SLUGS } from '../../src/app/pages/docs/parts.tsx'
import { DOC_TOPICS } from '../../src/app/pages/docs/topics.ts'
import { USAGE_REPORT_KEYS } from '../../src/app/pages/docs/yourData.tsx'

// The in-app Docs (root AGENTS.md, "Every app" rule 2): static topics at /docs, open to every role before any
// collection exists, so they never fetch; the topic list, "On this page", previous and next, and the focus moving where
// a link leads. The entry in each role's navigation is tested with the shell (navigation.test.tsx).

const APEX = 'https://insulinapps.test'

function platformAccount(): PlatformAccount {
  return {
    user: { name: 'Leo Example', email: 'leo@example.test' },
    organization: { id: 'org-acme', name: 'Acme Cloud', roleLabel: 'Viewer' },
    organizations: [{ id: 'org-acme', name: 'Acme Cloud', roleLabel: 'Viewer', active: true }],
    apex: APEX,
    links: { members: null, integrations: null, api: null, connectAi: null, organizations: null, account: `${APEX}/account`, apps: `${APEX}/apps` },
  }
}

/** The Docs pages at `path`, with no server at all: any request fails the test. */
function renderDocs(path: string, platform: PlatformAccount | null = null) {
  const fetch = vi.fn(() => Promise.reject(new Error('The Docs must not fetch anything')))
  vi.stubGlobal('fetch', fetch)
  const router = createMemoryRouter([
    { path: '/docs', element: <DocsPage /> },
    { path: '/docs/:topic', element: <DocsPage /> },
    { path: '/', element: <p>Home</p> },
  ], { initialEntries: [path] })
  render(<PlatformAccountContext value={platform}><RouterProvider router={router} /></PlatformAccountContext>)
  return { router, fetch }
}

const title = (name: string) => screen.findByRole('heading', { level: 1, name })
const topicList = () => screen.getByRole('navigation', { name: 'Docs topics' })

/** A topic's text, as the Docs component renders it. */
function textOf(slug: string): string {
  render(<MemoryRouter><Docs base="/docs" topic={DOC_TOPICS.find((topic) => topic.slug === slug)!} /></MemoryRouter>)
  const text = screen.getByRole('article').textContent ?? ''
  cleanup()
  return text
}

describe('COL-04 the Docs', () => {
  it('COL-04 opens on Getting started at /docs, with nothing fetched, before any collection exists', async () => {
    const { fetch } = renderDocs('/docs')
    expect(await title('Getting started')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe('DocsGetting started')
    expect(document.title).toBe('Getting started — Docs · Knowledge')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(DOC_TOPICS.map((topic) => [topic.title, topic] as const))('COL-04 %s renders its title, its sections and their links', async (_name, topic) => {
    const { fetch } = renderDocs(`/docs/${topic.slug}`)
    const heading = await title(topic.title)
    expect(heading.id).toBe('docs-title')
    const article = heading.closest('article')!
    expect(within(article).getByText(topic.summary)).toBeTruthy()
    const contents = within(article).getByRole('navigation', { name: 'On this page' })
    expect(topic.sections.length).toBeGreaterThan(0)
    for (const section of topic.sections) {
      const h2 = within(article).getByRole('heading', { level: 2, name: section.title })
      expect(h2.id).toBe(section.id)
      expect(within(contents).getByRole('link', { name: section.title }).getAttribute('href')).toBe(`/docs/${topic.slug}#${section.id}`)
    }
    // Headings in order: one title, then sections, then their parts; ids unique on the page.
    const levels = within(article).getAllByRole('heading').map((item) => Number(item.tagName.slice(1)))
    expect(levels[0]).toBe(1)
    levels.forEach((level, index) => expect(level - (levels[index - 1] ?? 0)).toBeLessThanOrEqual(1))
    const ids = [...article.querySelectorAll('[id]')].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(within(topicList()).getByRole('link', { name: topic.title }).getAttribute('aria-current')).toBe('page')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('COL-04 lists every topic, under Using Knowledge and Background, in reading order', async () => {
    renderDocs('/docs')
    await title('Getting started')
    expect(within(topicList()).getAllByRole('link').map((link) => link.textContent)).toEqual(DOC_TOPICS.map((topic) => topic.title))
    expect(DOC_TOPICS.map((topic) => topic.slug)).toEqual([...TOPIC_SLUGS])
    const using = within(topicList()).getByRole('list', { name: 'Using Knowledge' })
    const background = within(topicList()).getByRole('list', { name: 'Background' })
    expect(within(using).getAllByRole('link').map((link) => link.textContent)).toEqual(DOC_TOPICS.filter((topic) => topic.group === 'app').map((topic) => topic.title))
    expect(within(background).getAllByRole('link').map((link) => link.textContent)).toEqual(['Hiding personal data', 'Limits and what happens at each', 'Your data', 'Glossary'])
  })

  it('COL-04 opens a topic from the list and from Next, marks it and moves the focus to its title', async () => {
    const { router } = renderDocs('/docs')
    await title('Getting started')
    fireEvent.click(within(topicList()).getByRole('link', { name: 'History and going back' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/docs/history'))
    const heading = await title('History and going back')
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(within(topicList()).getByRole('link', { name: 'Getting started' }).getAttribute('aria-current')).toBeNull()
    const pager = screen.getByRole('navigation', { name: 'Previous and next topics' })
    expect(within(pager).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/docs/sharing-and-roles', '/docs/ai-assistants-and-api'])
    fireEvent.click(within(pager).getByRole('link', { name: /Next/ }))
    const next = await title('AI assistants and the API')
    await waitFor(() => expect(document.activeElement).toBe(next))
  })

  it('COL-04 jumps to a section from On this page and from another topic, and gives it the focus', async () => {
    const { router } = renderDocs('/docs/asking')
    const article = (await title('Asking and checking sources')).closest('article')!
    fireEvent.click(within(within(article).getByRole('navigation', { name: 'On this page' })).getByRole('link', { name: '"I won\'t guess"' }))
    await waitFor(() => expect(document.activeElement?.id).toBe('i-wont-guess'))
    // A link in the text to a section of another topic.
    fireEvent.click(within(article).getByRole('link', { name: 'Keep it ready' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/docs/sharing-and-roles'))
    await waitFor(() => expect(document.activeElement?.id).toBe('keep-it-ready'))
  })

  it('COL-04 loading a topic leaves the focus where it is', async () => {
    renderDocs('/docs/limits')
    const heading = await title('Limits and what happens at each')
    expect(document.activeElement).not.toBe(heading)
  })

  it('COL-04 says when a Docs page doesn\'t exist, with the way back', async () => {
    const { router } = renderDocs('/docs/no-such-topic')
    expect(await title("There's no such Docs page")).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'Open the Docs' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/docs'))
    expect(await title('Getting started')).toBeTruthy()
  })

  it('COL-04 links the public docs on Insulin Apps only where the gateway serves the app', async () => {
    renderDocs('/docs/glossary', platformAccount())
    await title('Glossary')
    expect(within(topicList()).getByRole('link', { name: 'Public docs' }).getAttribute('href')).toBe(`${APEX}/docs/knowledge/`)
    cleanup()
    renderDocs('/docs/glossary')
    await title('Glossary')
    expect(within(topicList()).queryByRole('link', { name: 'Public docs' })).toBeNull()
  })
})

describe('what the Docs say', () => {
  // COL-02's words: none on a business screen, and the Docs are read by every role.
  const BANNED = [/embedding/i, /\bchunk/i, /\bvector/i, /\btop ?k\b/i, /snapshot/i, /container/i, /durable object/i, /\bmcp\b/i, /knowledge base/i, /\bindex(ing|ed)?\b/i]

  it.each(DOC_TOPICS.map((topic) => [topic.title, topic.slug] as const))('COL-02 %s uses no technical words', (_name, slug) => {
    const text = textOf(slug)
    for (const word of BANNED) expect({ slug, word: String(word), found: word.test(text) }).toEqual({ slug, word: String(word), found: false })
  })

  it('COL-02 names no support address and no real host: the address comes from the platform', () => {
    for (const topic of DOC_TOPICS) {
      const text = textOf(topic.slug)
      expect({ topic: topic.slug, address: /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text)?.[0] ?? null }).toEqual({ topic: topic.slug, address: null })
      for (const host of text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app)\b/gi) ?? []) expect(host.toLowerCase()).toMatch(/(^|\.)insulin-apps\.com$/)
    }
  })

  it('COL-04 Your data names exactly the numbers sent to Insulin Apps every hour', () => {
    const text = textOf('your-data')
    expect(USAGE_REPORT_KEYS.map(([key]) => key)).toEqual(['collections', 'documents', 'storage_bytes', 'learned_month', 'questions_month', 'answers_month', 'awake_hours_month', 'ready_collections'])
    for (const [key] of USAGE_REPORT_KEYS) expect(text).toContain(key)
    expect(text).toContain('database_bytes')
    expect(text).toContain('Every hour, Knowledge sends Insulin Apps a few numbers')
    expect(text).toContain('These are counts and sizes only. Knowledge never sends names, e-mail addresses, questions, answers, the text of files or anything else from a collection.')
  })

  it('COL-04 AI assistants and the API: the catalog, and every request names its collections', () => {
    const text = textOf('ai-assistants-and-api')
    expect(text).toContain('GET /api/catalog lists the endpoints the caller may use right now')
    expect(text).toContain('Every request names its collections.')
    expect(text).toContain('at least one collection and at most five')
    expect(text).toContain('400 collection_required')
    expect(text).toContain('400 too_many_collections')
    expect(text).toContain('Settings › Connect AI')
    expect(text).toContain('browser_only')
  })

  it('COL-04 states the rules the app follows, as the server keeps them', () => {
    const roles = textOf('sharing-and-roles')
    expect(roles).toContain('acts as Viewer')
    expect(roles).toContain('Viewer or Editor, or no access')
    expect(roles).toContain('the longest-standing owner of the organization becomes its owner')
    expect(roles).toContain('Being an Admin gives no access to any collection\'s content.')
    const limits = textOf('limits')
    for (const fact of ['20', '500', '25 MB', '2 GB', '1,000', '5,000', '2,000', '100', '30']) expect(limits).toContain(fact)
    expect(limits).toContain('keep-ready pauses at 90%')
    expect(limits).toContain('names Insulin Apps support')
    const history = textOf('history')
    expect(history).toContain('set aside, not deleted')
    expect(history).toContain('Restore points are kept 30 days.')
    const sources = textOf('collections-and-sources')
    expect(sources).toContain('Waiting → Reading → Understanding → learned')
    expect(sources).toContain('up to 3 times')
    const glossary = textOf('glossary')
    for (const term of ['Collection', 'Fact', 'Source', 'Restore point', 'Go back', 'Keep it ready', 'Already here', 'Hidden', 'Stop using', 'Remove for good']) expect(glossary).toContain(term)
  })
})
