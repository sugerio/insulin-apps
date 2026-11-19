import { createContext, useContext, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx'

// The pieces the in-app Docs are written with, as Cap Table has them (captable/src/app/pages/docs/parts.tsx). Each
// topic is static TSX: a title, a one-line summary and sections of ordinary markup, with no parser and no data from
// the server, so the same pages serve every role, before any collection exists too. Links between topics go through
// DocLink, which knows where the reader's docs live.

export const TOPIC_SLUGS = [
  'getting-started',
  'collections-and-sources',
  'asking',
  'fixing-and-reporting',
  'sharing-and-roles',
  'history',
  'ai-assistants-and-api',
  'hiding-personal-data',
  'limits',
  'your-data',
  'glossary',
] as const
export type TopicSlug = (typeof TOPIC_SLUGS)[number]

export interface DocSection {
  /** The heading's id: the "On this page" list and links from other topics point at it. */
  id: string
  title: string
  body: ReactNode
}

export interface DocTopic {
  slug: TopicSlug
  title: string
  /** One sentence under the title. */
  summary: string
  /** Where the topic list shows it: using Knowledge, or the background a business user needs. */
  group: 'app' | 'background'
  /** The glossary's sections are letters: "On this page" lists them on one line. */
  compactContents?: true
  sections: readonly DocSection[]
}

/** Where the docs are for the reader: `/docs`. */
export const DocsBaseContext = createContext('/docs')

/** The address of a topic, or of a section in it, in the reader's docs. */
export function useDocHref(): (topic: TopicSlug, section?: string) => string {
  const base = useContext(DocsBaseContext)
  return (topic, section) => `${base}/${topic}${section ? `#${section}` : ''}`
}

/** A link to another topic of the docs, or to a section of one. */
export function DocLink({ to, section, children }: { to: TopicSlug; section?: string; children: ReactNode }) {
  const href = useDocHref()
  return <Link className="font-medium underline underline-offset-4 hover:text-primary" to={href(to, section)}>{children}</Link>
}

/** An id for a heading or a glossary term: "Restore point" → "restore-point", "AI assistant" → "ai-assistant". */
export function anchorId(text: string): string {
  return text.toLowerCase().replace(/[()'’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Where to find something in the app: a short line set apart from the text. */
export function InApp({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 rounded-lg bg-muted px-4 py-3"><b>In Knowledge:</b> {children}</p>
}

/** A worked example, set apart from the text around it. */
export function Example({ title = 'Example', children }: { title?: string; children: ReactNode }) {
  return (
    <div className="my-1 mb-3.5 rounded-r-lg border-l-4 border-primary bg-muted/50 px-4 py-3.5 [&>p:last-child]:mb-0">
      <p className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      {children}
    </div>
  )
}

/** Code, an address or an API path, in the monospace font. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere]">{children}</code>
}

/** A small table: the first cell of each row heads it. */
export function DocTable({ label, columns, rows }: { label: string; columns: readonly string[]; rows: readonly (readonly ReactNode[])[] }) {
  return (
    <div className="my-1 mb-3.5 overflow-x-auto rounded-lg border bg-card">
      <Table aria-label={label}>
        <TableHeader className="bg-muted/50">
          <TableRow>{columns.map((column) => <TableHead key={column} scope="col" className="h-auto px-3.5 py-2.5 text-xs text-muted-foreground">{column}</TableHead>)}</TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index} className="hover:bg-transparent">
              {row.map((cell, column) => (column === 0
                ? <TableHead key={column} scope="row" className="h-auto px-3.5 py-2.5 align-top whitespace-normal">{cell}</TableHead>
                : <TableCell key={column} className="px-3.5 py-2.5 align-top whitespace-normal">{cell}</TableCell>))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
