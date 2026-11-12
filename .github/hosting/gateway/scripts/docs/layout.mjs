// The docs' layout, rendered with React at build time: the two-level navigation of DESIGN.md §3.2 (level 1: Overview,
// Platform, one item per app, and the files for AI agents at the bottom; level 2: the open section's pages under its
// title), the article, its table of contents, previous and next, and the /docs/ index. The navigation is static: the
// docs are public, so it has no organization switcher, no person and no per-request state, and its levels don't
// collapse. On narrow screens a <details> menu above the article holds both levels. The gateway puts the result inside
// its shared document (top bar and footer), per request (src/pages/docs.tsx). Classes are Tailwind's, in shadcn's
// neutral theme, the navigation in its sidebar colours and spacing as components/shell.tsx draws them;
// src/styles/gateway.css scans this directory for them.
import { createElement as h } from 'react'
import * as lucide from 'lucide-react'
import { ArrowRight, Bot, BookOpen, ChevronLeft, ChevronRight, KeyRound, Menu, Rocket } from 'lucide-react'

const CARD = 'flex flex-col gap-1.5 rounded-xl border bg-card p-4 text-card-foreground shadow-xs transition-colors hover:bg-accent/60'

const FOCUS = 'outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring'
/** shadcn's SidebarMenuButton, as components/shell.tsx draws it: an icon and a label, the open item highlighted. */
const ITEM = `flex h-8 w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>span]:truncate [&>svg]:size-4 [&>svg]:shrink-0 ${FOCUS}`
/** A page in level 2: the same without an icon, and a long title wraps rather than being cut. */
const PAGE_ITEM = `flex min-h-8 w-full items-center rounded-md px-2 py-1.5 text-left text-sm leading-snug text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground ${FOCUS}`
/** shadcn's SidebarGroupLabel, in small capitals. */
const GROUP_LABEL = 'flex h-8 shrink-0 items-center px-2 text-xs font-medium tracking-wider text-sidebar-foreground/70 uppercase'
/** A column of the navigation on wide screens, below the top bar (3.5rem), scrolling on its own. */
const COLUMN = 'sticky top-14 hidden h-[calc(100svh-3.5rem)] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex'

/** Lucide's older names for two icons, mapped as components/nav-icon.tsx maps them. */
const ICON_ALIASES = { home: 'house', 'check-circle': 'circle-check' }

/** The Lucide component for one of the navigation's icon names (src/nav-icons.ts), or null. */
export function navIcon(name) {
  const pascal = (ICON_ALIASES[name] ?? name).replace(/(?:^|-)([a-z0-9])/g, (_, letter) => letter.toUpperCase())
  return lucide[pascal] ?? null
}

function Icon({ name }) {
  const component = navIcon(name)
  if (!component) throw new Error(`the docs' navigation has no icon named "${name}"`)
  return h(component, { 'aria-hidden': 'true' })
}

/**
 * Level 1 for the page at `current`: Overview and Platform, the apps under their heading, and apart, the files for AI
 * agents. The section holding the page is open (`aria-current` "true"); on /docs/, Overview is the page ("page").
 */
function primaryOf(site, current) {
  const open = site.sections.find((section) => section.pages.some((page) => page.path === current)) ?? null
  const item = (key, label, icon, href, state) => ({ key, label, icon, href, current: state })
  const sectionItem = (section) => item(section.slug, section.title, section.icon, section.pages[0].path, section === open ? 'true' : null)
  const [platform, ...apps] = site.sections
  return {
    open,
    groups: [
      { key: 'docs', heading: null, items: [item('overview', 'Overview', 'book-open', '/docs/', current === '/docs/' ? 'page' : null), sectionItem(platform)] },
      ...(apps.length ? [{ key: 'apps', heading: 'Apps', items: apps.map(sectionItem) }] : []),
    ],
    agents: {
      key: 'agents',
      heading: 'For AI agents',
      items: [item('llms', 'llms.txt', 'file-text', '/docs/llms.txt', null), item('llms-full', 'llms-full.txt', 'files', '/docs/llms-full.txt', null)],
    },
  }
}

/** Groups of level-1 items, each under its heading; `idPrefix` keeps the headings' ids unique in the page. */
function Groups({ groups, idPrefix }) {
  return groups.map((group) => {
    const headingId = group.heading ? `${idPrefix}-${group.key}` : undefined
    return h('div', { key: group.key, className: 'flex flex-col' },
      group.heading ? h('div', { id: headingId, className: GROUP_LABEL }, group.heading) : null,
      h('ul', { 'aria-labelledby': headingId, className: 'flex flex-col gap-1' },
        group.items.map((item) => h('li', { key: item.key },
          h('a', { href: item.href, className: ITEM, ...(item.current ? { 'aria-current': item.current, 'data-active': 'true' } : {}) },
            h(Icon, { name: item.icon }),
            h('span', null, item.label))))))
  })
}

/** Level 2: the open section's pages, the current one marked. */
function Pages({ section, current, labelledBy }) {
  return h('ul', { 'aria-labelledby': labelledBy, className: 'flex flex-col gap-1' },
    section.pages.map((page) => h('li', { key: page.path },
      h('a', { href: page.path, className: PAGE_ITEM, ...(page.path === current ? { 'aria-current': 'page', 'data-active': 'true' } : {}) }, page.title))))
}

/** The columns on wide screens: level 1, then level 2 when a section is open (on every page but /docs/). */
function Navigation({ site, current }) {
  const { open, groups, agents } = primaryOf(site, current)
  return [
    h('nav', { key: 'primary', 'aria-label': 'Documentation', 'data-slot': 'docs-nav-primary', className: `${COLUMN} z-20 w-60` },
      h('div', { className: 'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2' },
        h(Groups, { groups, idPrefix: 'docs-nav' }),
        h('div', { className: 'mt-auto flex flex-col' }, h(Groups, { groups: [agents], idPrefix: 'docs-nav' })))),
    open ? h('nav', { key: 'section', 'aria-label': 'Section', 'data-slot': 'docs-nav-section', className: `${COLUMN} z-10 w-56` },
      h('div', { className: 'flex h-14 shrink-0 items-center border-b border-sidebar-border px-4' },
        h('div', { id: 'docs-nav-section-title', className: 'min-w-0 flex-1 truncate text-sm font-semibold' }, open.title)),
      h('div', { className: 'flex min-h-0 flex-1 flex-col overflow-y-auto p-2' },
        h(Pages, { section: open, current, labelledBy: 'docs-nav-section-title' }))) : null,
  ]
}

/** Below 1024px, a <details> menu above the article with both levels: level 1, the open section's pages, the agents' files. */
function MobileNav({ site, current }) {
  const { open, groups, agents } = primaryOf(site, current)
  return h('details', { className: 'group mb-8 rounded-lg border lg:hidden' },
    h('summary', { className: 'flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden' },
      h(Menu, { className: 'size-4', 'aria-hidden': 'true' }),
      'Documentation menu',
      h(ChevronRight, { className: 'ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-90', 'aria-hidden': 'true' })),
    h('nav', { 'aria-label': 'Documentation menu', className: 'flex flex-col gap-4 rounded-b-lg border-t bg-sidebar p-2 text-sidebar-foreground' },
      h('div', { 'data-slot': 'docs-menu-primary', className: 'flex flex-col gap-4' }, h(Groups, { groups, idPrefix: 'docs-menu' })),
      open ? h('div', { 'data-slot': 'docs-menu-section', className: 'flex flex-col gap-2 border-t border-sidebar-border pt-4' },
        h('div', { id: 'docs-menu-section-title', className: 'px-2 text-sm font-semibold' }, open.title),
        h(Pages, { section: open, current, labelledBy: 'docs-menu-section-title' })) : null,
      h('div', { className: 'flex flex-col border-t border-sidebar-border pt-2' }, h(Groups, { groups: [agents], idPrefix: 'docs-menu' }))))
}

function Breadcrumb({ section }) {
  return h('nav', { 'aria-label': 'Breadcrumb', className: 'mb-4 text-sm text-muted-foreground' },
    h('ol', { className: 'flex flex-wrap items-center gap-1.5' },
      h('li', null, h('a', { href: '/docs/', className: 'hover:text-foreground' }, 'Docs')),
      section ? h('li', { className: 'flex items-center gap-1.5', 'aria-hidden': 'true' }, h(ChevronRight, { className: 'size-3.5' })) : null,
      section ? h('li', null, h('a', { href: section.pages[0].path, className: 'hover:text-foreground' }, section.title)) : null))
}

function TableOfContents({ headings }) {
  const entries = headings.filter((heading) => heading.depth <= 3)
  if (!entries.length) return h('aside', { className: 'hidden xl:block' })
  return h('aside', { className: 'hidden xl:block' },
    h('nav', { 'aria-label': 'On this page', className: 'sticky top-14 max-h-[calc(100svh-3.5rem)] overflow-y-auto py-10 text-sm' },
      h('p', { className: 'mb-3 font-medium' }, 'On this page'),
      h('ul', { className: 'flex flex-col gap-2 border-l' },
        entries.map((heading) => h('li', { key: heading.id },
          h('a', { href: `#${heading.id}`, className: `-ml-px block border-l border-transparent text-muted-foreground hover:border-foreground hover:text-foreground ${heading.depth === 3 ? 'pl-6' : 'pl-3'}` }, heading.text))))))
}

function PreviousNext({ previous, next }) {
  const card = (page, direction) => h('a', {
    href: page.path,
    className: `${CARD} ${direction === 'next' ? 'sm:col-start-2 sm:items-end sm:text-right' : ''}`,
  },
  h('span', { className: 'flex items-center gap-1 text-xs text-muted-foreground' },
    direction === 'previous' ? h(ChevronLeft, { className: 'size-3.5', 'aria-hidden': 'true' }) : null,
    direction === 'previous' ? 'Previous' : 'Next',
    direction === 'next' ? h(ChevronRight, { className: 'size-3.5', 'aria-hidden': 'true' }) : null),
  h('span', { className: 'font-medium' }, page.title),
  page.sectionTitle ? h('span', { className: 'text-xs text-muted-foreground' }, page.sectionTitle) : null)
  return h('nav', { 'aria-label': 'Previous and next', className: 'mt-16 grid gap-4 border-t pt-8 sm:grid-cols-2' },
    previous ? card(previous, 'previous') : null,
    next ? card(next, 'next') : null)
}

/** The navigation's columns at the left edge, then the page, centred in the room left. */
const FRAME = 'flex w-full'
const CONTENT = 'mx-auto w-full min-w-0 max-w-7xl px-4 sm:px-6'

/** One docs page: the navigation, the article (title, description, body), previous and next, the table of contents. */
export function DocsPage({ site, page, body }) {
  return h('div', { className: FRAME },
    h(Navigation, { site, current: page.path }),
    h('div', { className: `${CONTENT} grid xl:grid-cols-[minmax(0,1fr)_13rem] xl:gap-10` },
      h('div', { className: 'min-w-0 py-8 lg:py-10' },
        h(MobileNav, { site, current: page.path }),
        h(Breadcrumb, { section: page.section }),
        h('article', { className: 'max-w-3xl text-[0.9375rem] text-pretty' },
          h('header', { className: 'mb-10 flex flex-col gap-3' },
            h('div', { className: 'text-3xl font-semibold tracking-tight text-balance sm:text-4xl' }, h('h1', null, page.title)),
            h('p', { className: 'text-lg text-muted-foreground text-balance' }, page.description)),
          body),
        h('div', { className: 'max-w-3xl' }, h(PreviousNext, { previous: page.previous, next: page.next }))),
      h(TableOfContents, { headings: page.headings })))
}

const START = [
  { icon: Rocket, title: 'Get started', text: 'Create an account and an organization, and invite your team.', path: '/docs/platform/getting-started' },
  { icon: Bot, title: 'Connect an AI agent', text: 'Use Claude Code, Codex, Gemini CLI or opencode with an app over MCP.', path: '/docs/platform/ai-agents' },
  { icon: KeyRound, title: 'Call the API', text: 'Create a service account, get a token and call an app.', path: '/docs/platform/api-and-service-accounts' },
]

/** /docs/: what the docs cover, where to start, and every page of every section with its description. */
export function DocsIndex({ site, next }) {
  return h('div', { className: FRAME },
    h(Navigation, { site, current: '/docs/' }),
    h('div', { className: `${CONTENT} py-8 lg:py-10` },
      h(MobileNav, { site, current: '/docs/' }),
      h('div', { className: 'max-w-4xl' },
        h('header', { className: 'mb-10 flex flex-col gap-3' },
          h('p', { className: 'flex items-center gap-2 text-sm font-medium text-muted-foreground' }, h(BookOpen, { className: 'size-4', 'aria-hidden': 'true' }), 'Documentation'),
          h('div', { className: 'text-3xl font-semibold tracking-tight text-balance sm:text-4xl' }, h('h1', null, 'Insulin Apps documentation')),
          h('p', { className: 'max-w-2xl text-lg text-muted-foreground text-balance' },
            'How to set up your organization on insulinapps.com, sign in, give people the right access, connect AI agents and call the API, and how to use each app.')),
        h('section', { 'aria-labelledby': 'start-here', className: 'mb-12' },
          h('div', { className: 'mb-4 text-xl font-semibold tracking-tight' }, h('h2', { id: 'start-here' }, 'Start here')),
          h('div', { className: 'grid gap-4 sm:grid-cols-3' },
            START.map(({ icon: Icon, title, text, path }) => h('a', { key: path, href: path, className: CARD },
              h('span', { className: 'mb-2 flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground' }, h(Icon, { className: 'size-4', 'aria-hidden': 'true' })),
              h('span', { className: 'font-medium' }, title),
              h('span', { className: 'text-sm text-muted-foreground' }, text))))),
        site.sections.map((section) => h('section', { key: section.slug, 'aria-labelledby': `section-${section.slug}`, className: 'mb-12' },
          h('div', { className: 'mb-1 text-xl font-semibold tracking-tight' }, h('h2', { id: `section-${section.slug}` }, section.title)),
          h('p', { className: 'mb-4 text-muted-foreground' }, section.summary),
          h('ul', { className: 'grid gap-3 sm:grid-cols-2' },
            section.pages.map((page) => h('li', { key: page.path, className: 'flex' },
              h('a', { href: page.path, className: `${CARD} w-full` },
                h('span', { className: 'flex items-center gap-1.5 font-medium' }, page.title, h(ArrowRight, { className: 'size-3.5 text-muted-foreground', 'aria-hidden': 'true' })),
                h('span', { className: 'text-sm text-muted-foreground' }, page.description))))))),
        h('section', { 'aria-labelledby': 'for-agents', className: 'rounded-xl border bg-muted/40 p-5' },
          h('div', { className: 'mb-1 flex items-center gap-2 font-semibold' }, h(Bot, { className: 'size-4', 'aria-hidden': 'true' }), h('h2', { id: 'for-agents' }, 'For AI agents')),
          h('p', { className: 'text-sm text-muted-foreground' },
            'Every page is also plain Markdown: ',
            h('a', { href: '/docs/llms.txt', className: 'font-medium text-foreground underline underline-offset-4' }, '/docs/llms.txt'),
            ' lists them, ',
            h('a', { href: '/docs/llms-full.txt', className: 'font-medium text-foreground underline underline-offset-4' }, '/docs/llms-full.txt'),
            ' has all of them in one file, and each page is at its address with .md added.')),
        h(PreviousNext, { previous: null, next }))))
}
