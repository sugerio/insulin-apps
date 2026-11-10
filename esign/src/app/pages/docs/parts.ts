// The pieces the in-app Docs are written with. Each topic is static content: a title, a one-line summary and sections
// of ordinary markup, with no parser and no data from the server, so the same pages serve every role, and someone not
// signed in. The topics are .ts with React.createElement, not TSX, because the tests run on Node's type stripping,
// which doesn't transform JSX (Cap Table's are TSX).
import React from 'react'
import { Link } from '../../member/router.ts'

export const h = React.createElement

export const TOPIC_SLUGS = ['getting-started', 'sending', 'templates', 'signers', 'statuses', 'evidence', 'roles', 'e-signatures', 'glossary'] as const
export type TopicSlug = (typeof TOPIC_SLUGS)[number]

export interface DocSection {
  /** The heading's id: the "On this page" list and links from other topics point at it. */
  id: string
  title: string
  body: React.ReactNode
}

export interface DocTopic {
  slug: TopicSlug
  title: string
  /** One sentence under the title. */
  summary: string
  /** Where the topic list shows it: using E-sign, or electronic signatures in general. */
  group: 'app' | 'background'
  /** Legal matters: the topic opens with the note that it is general information, not legal advice. */
  generalInformation?: true
  /** The glossary's sections are letters: "On this page" lists them on one line. */
  compactContents?: true
  sections: readonly DocSection[]
}

/** The address of a topic, or of a section in it. */
export const docHref = (topic: TopicSlug, section?: string) => `/docs/${topic}${section ? `#${section}` : ''}`

const LINK = 'font-medium text-foreground underline underline-offset-4'

/** A link to another topic of the Docs, or to a section of one. */
export function DocLink({ to, section, children }: { to: TopicSlug; section?: string; children?: React.ReactNode }) {
  return h(Link, { to: docHref(to, section), className: LINK }, children)
}

/** A link to one of the app's own pages. */
export function PageLink({ to, children }: { to: string; children?: React.ReactNode }) {
  return h(Link, { to, className: LINK }, children)
}

/** An id for a heading or a glossary term: "Audit trail" → "audit-trail", "RFC 3161 timestamp" → "rfc-3161-timestamp". */
export function anchorId(text: string): string {
  return text.toLowerCase().replace(/[()'’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** A list of nodes as separate children, so React needs no keys for them. */
export const children = (node: React.ReactNode): React.ReactNode[] => Array.isArray(node) ? node : [node]

/** Paragraphs, lists and steps, so the topics read as text. A list item may be several nodes. */
export const p = (...nodes: React.ReactNode[]) => h('p', null, ...nodes)
export const ul = (...items: React.ReactNode[]) => h('ul', null, ...items.map((item, i) => h('li', { key: i }, ...children(item))))
export const ol = (...items: React.ReactNode[]) => h('ol', null, ...items.map((item, i) => h('li', { key: i }, ...children(item))))
export const b = (text: string) => h('strong', null, text)
export const code = (text: string) => h('code', null, text)

/** How a general idea shows up in E-sign, at the end of a background section. */
export function InApp({ children }: { children?: React.ReactNode }) {
  return h('p', { className: 'rounded-md border-l-2 border-primary bg-muted/50 px-3 py-2' }, h('strong', null, 'In E-sign: '), children)
}

/** A small table: the first cell of each row heads it. */
export function DocTable({ label, columns, rows }: { label: string; columns: readonly string[]; rows: readonly (readonly React.ReactNode[])[] }) {
  return h('div', { className: 'overflow-x-auto' },
    h('table', { 'aria-label': label, className: 'w-full border-collapse text-sm' },
      h('thead', null, h('tr', { className: 'border-b' }, ...columns.map((column) => h('th', { key: column, scope: 'col', className: 'px-3 py-2 text-left font-medium' }, column)))),
      h('tbody', null, ...rows.map((row, index) => h('tr', { key: index, className: 'border-b align-top last:border-0' },
        ...row.map((cell, column) => column === 0
          ? h('th', { key: column, scope: 'row', className: 'px-3 py-2 text-left font-medium' }, cell)
          : h('td', { key: column, className: 'px-3 py-2' }, cell)))))))
}
