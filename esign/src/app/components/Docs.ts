// The in-app Docs: a topic, which opens with its title, the "On this page" list of its sections and, on the background
// topic, the note that it is general information, not legal advice. Every heading has an id, so a section can be linked
// from another topic (`/docs/evidence#the-seal`). Choosing another topic moves the focus to its title; an address with a
// section scrolls to it. The topic list is the Docs' level 2 in the members' navigation (member/Shell.ts), from
// `docsNavigation()`; the topic is the page beside it.
import React, { useEffect, useRef } from 'react'
import { ArrowLeft, ArrowRight, Info } from 'lucide-react'
import { cn } from '../lib/utils.ts'
import type { IconName } from '../member/navigation.ts'
import { Link } from '../member/router.ts'
import { Alert, AlertDescription, AlertTitle } from './ui/alert.ts'
import { children, docHref, type TopicSlug } from '../pages/docs/parts.ts'
import { DOC_TOPICS, docTopic } from '../pages/docs/topics.ts'

const h = React.createElement

/** The topic list's groups, in order, with their headings. */
export const DOC_GROUPS = [['app', 'Using Esign'], ['background', 'Electronic signatures']] as const

const TOPIC_ICONS: Record<TopicSlug, IconName> = {
  'getting-started': 'home', sending: 'send', templates: 'files', signers: 'users', statuses: 'list', evidence: 'shield',
  roles: 'key', 'e-signatures': 'signature', glossary: 'book-open',
}

/** The Docs' level 2: every topic in reading order, under its group's heading. */
export function docsNavigation(): { key: TopicSlug; label: string; icon: IconName; path: string; group: string }[] {
  return DOC_GROUPS.flatMap(([group, heading]) => DOC_TOPICS.filter((topic) => topic.group === group)
    .map((topic) => ({ key: topic.slug, label: topic.title, icon: TOPIC_ICONS[topic.slug], path: docHref(topic.slug), group: heading })))
}

// Text styles for the topics' plain markup.
const PROSE = 'flex flex-col gap-4 text-sm leading-7 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8125rem]'

/** The id an address's "#…" names (a malformed escape is taken as it is, never thrown). */
function hashId(hash: string): string {
  try { return decodeURIComponent(hash.slice(1)) } catch { return hash.slice(1) }
}

export function Docs({ topic: slug }: { topic: string | undefined }) {
  const topic = docTopic(slug)
  const title = useRef<HTMLHeadingElement>(null)
  const first = useRef(true)
  useEffect(() => {
    const hash = typeof window === 'undefined' ? '' : window.location?.hash ?? ''
    const target = hash && typeof document !== 'undefined' ? document.getElementById(hashId(hash)) : null
    if (target) target.scrollIntoView?.({ block: 'start' })
    // Moving between topics moves the focus to the new title; arriving leaves it where the browser put it.
    else if (!first.current) title.current?.focus?.({ preventScroll: true })
    first.current = false
  }, [topic?.slug])

  if (!topic) {
    return h('div', { className: 'flex flex-col gap-2' },
      h('h1', { className: 'text-2xl font-semibold tracking-tight' }, 'Topic not found'),
      h('p', { className: 'text-sm text-muted-foreground' }, 'The Docs have no topic at this address. ', h(Link, { to: docHref('getting-started'), className: 'font-medium text-foreground underline underline-offset-4' }, 'Start with Getting started')))
  }
  const index = DOC_TOPICS.indexOf(topic)
  const before = DOC_TOPICS[index - 1]
  const after = DOC_TOPICS[index + 1]
  return h('article', { 'aria-labelledby': 'docs-title', className: 'mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6' },
    h('header', { className: 'flex flex-col gap-2' },
      h('h1', { id: 'docs-title', ref: title, tabIndex: -1, className: 'text-2xl font-semibold tracking-tight outline-none' }, topic.title),
      h('p', { className: 'text-muted-foreground' }, topic.summary)),
    topic.generalInformation ? h(GeneralInformation) : null,
    h('nav', { 'aria-label': 'On this page', className: 'rounded-lg border p-4' },
      h('p', { 'aria-hidden': true, className: 'mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground' }, 'On this page'),
      h('ul', { className: cn('text-sm', topic.compactContents ? 'flex flex-wrap gap-x-3 gap-y-1' : 'flex flex-col gap-1') },
        ...topic.sections.map((section) => h('li', { key: section.id }, h('a', { href: `#${section.id}`, className: 'text-muted-foreground underline-offset-4 hover:text-foreground hover:underline' }, section.title))))),
    ...topic.sections.map((section) => h('section', { key: section.id, className: 'flex scroll-mt-6 flex-col gap-3' },
      h('h2', { id: section.id, tabIndex: -1, className: 'scroll-mt-6 text-lg font-semibold outline-none' }, section.title),
      h('div', { className: PROSE }, ...children(section.body)))),
    h('nav', { 'aria-label': 'Previous and next topics', className: 'flex flex-wrap justify-between gap-3 border-t pt-6' },
      before ? h(Link, { to: docHref(before.slug), className: 'flex flex-col gap-0.5 rounded-lg border px-4 py-3 text-sm hover:bg-accent' },
        h('span', { className: 'inline-flex items-center gap-1 text-xs text-muted-foreground' }, h(ArrowLeft, { className: 'size-3', 'aria-hidden': true }), 'Previous'),
        h('span', { className: 'font-medium' }, before.title)) : h('span'),
      after ? h(Link, { to: docHref(after.slug), className: 'ml-auto flex flex-col items-end gap-0.5 rounded-lg border px-4 py-3 text-sm hover:bg-accent' },
        h('span', { className: 'inline-flex items-center gap-1 text-xs text-muted-foreground' }, 'Next', h(ArrowRight, { className: 'size-3', 'aria-hidden': true })),
        h('span', { className: 'font-medium' }, after.title)) : null))
}

/** On the background topic: what the page is, and who gives advice. */
function GeneralInformation() {
  return h(Alert, { role: 'note' },
    h(Info, { 'aria-hidden': true }),
    h(AlertTitle, null, 'General information, not legal advice'),
    h(AlertDescription, null, 'This page explains common terms and practices in general. It isn\'t legal advice. Rules differ from country to country and change over time, and what applies depends on the document and the people signing it. For advice about a specific situation, talk to your organization\'s counsel.'))
}
