// The docs' layout, rendered with React at build time: the navigation (Platform, then one section per app), the
// article, its table of contents, previous and next, and the /docs/ index. The gateway puts the result inside its
// shared document (top bar and footer), per request (src/pages/docs.tsx). Classes are Tailwind's, in shadcn's neutral
// theme; src/styles/gateway.css scans this directory for them.
import { createElement as h } from 'react'
import { ArrowRight, Bot, BookOpen, ChevronLeft, ChevronRight, KeyRound, Menu, Rocket } from 'lucide-react'

const LINK = 'block rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
const CURRENT = 'block rounded-md bg-accent px-2 py-1.5 text-sm font-medium text-accent-foreground'
const CARD = 'flex flex-col gap-1.5 rounded-xl border bg-card p-4 text-card-foreground shadow-xs transition-colors hover:bg-accent/60'

/** The sections' links; `current` is the path of the page being rendered. */
function NavLinks({ site, current }) {
  return h('div', { className: 'flex flex-col gap-6' },
    h('div', { className: 'flex flex-col gap-0.5' },
      h('a', { href: '/docs/', className: current === '/docs/' ? CURRENT : LINK, ...(current === '/docs/' ? { 'aria-current': 'page' } : {}) }, 'Overview')),
    site.sections.map((section) => h('div', { key: section.slug, className: 'flex flex-col gap-0.5' },
      h('p', { className: 'px-2 pb-1 text-xs font-medium text-muted-foreground' }, section.title),
      h('ul', { className: 'flex flex-col gap-0.5' },
        section.pages.map((page) => h('li', { key: page.path },
          h('a', { href: page.path, className: page.path === current ? CURRENT : LINK, ...(page.path === current ? { 'aria-current': 'page' } : {}) }, page.title)))))),
    h('div', { className: 'flex flex-col gap-0.5' },
      h('p', { className: 'px-2 pb-1 text-xs font-medium text-muted-foreground' }, 'For AI agents'),
      h('a', { href: '/docs/llms.txt', className: LINK }, 'llms.txt'),
      h('a', { href: '/docs/llms-full.txt', className: LINK }, 'llms-full.txt')))
}

/** The sidebar on wide screens, and the same links in a <details> menu above the article on narrow ones. */
function Sidebar({ site, current }) {
  return h('aside', { className: 'hidden border-r lg:block' },
    h('nav', { 'aria-label': 'Documentation', className: 'sticky top-14 max-h-[calc(100svh-3.5rem)] overflow-y-auto py-8 pr-4' },
      h(NavLinks, { site, current })))
}

function MobileNav({ site, current }) {
  return h('details', { className: 'group mb-8 rounded-lg border lg:hidden' },
    h('summary', { className: 'flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden' },
      h(Menu, { className: 'size-4', 'aria-hidden': 'true' }),
      'Documentation menu',
      h(ChevronRight, { className: 'ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-90', 'aria-hidden': 'true' })),
    h('nav', { 'aria-label': 'Documentation menu', className: 'border-t px-2 py-4' }, h(NavLinks, { site, current })))
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

const GRID = 'mx-auto grid w-full max-w-7xl px-4 sm:px-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10'

/** One docs page: sidebar, article (title, description, body), previous and next, table of contents. */
export function DocsPage({ site, page, body }) {
  return h('div', { className: `${GRID} xl:grid-cols-[15rem_minmax(0,1fr)_13rem]` },
    h(Sidebar, { site, current: page.path }),
    h('div', { className: 'min-w-0 py-8 lg:py-10' },
      h(MobileNav, { site, current: page.path }),
      h(Breadcrumb, { section: page.section }),
      h('article', { className: 'max-w-3xl text-[0.9375rem] text-pretty' },
        h('header', { className: 'mb-10 flex flex-col gap-3' },
          h('div', { className: 'text-3xl font-semibold tracking-tight text-balance sm:text-4xl' }, h('h1', null, page.title)),
          h('p', { className: 'text-lg text-muted-foreground text-balance' }, page.description)),
        body),
      h('div', { className: 'max-w-3xl' }, h(PreviousNext, { previous: page.previous, next: page.next }))),
    h(TableOfContents, { headings: page.headings }))
}

const START = [
  { icon: Rocket, title: 'Get started', text: 'Create an account and an organization, and invite your team.', path: '/docs/platform/getting-started' },
  { icon: Bot, title: 'Connect an AI agent', text: 'Use Claude Code, Codex, Gemini CLI or opencode with an app over MCP.', path: '/docs/platform/ai-agents' },
  { icon: KeyRound, title: 'Call the API', text: 'Create a service account, get a token and call an app.', path: '/docs/platform/api-and-service-accounts' },
]

/** /docs/: what the docs cover, where to start, and every page of every section with its description. */
export function DocsIndex({ site, next }) {
  return h('div', { className: GRID },
    h(Sidebar, { site, current: '/docs/' }),
    h('div', { className: 'min-w-0 py-8 lg:py-10' },
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
