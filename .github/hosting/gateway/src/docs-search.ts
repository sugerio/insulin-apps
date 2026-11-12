// Searching the public docs (DESIGN.md §1; .github/hosting/docs/searching-the-docs.md). /docs/search, its JSON and the
// docs' MCP server rank the same passages: each page cut at its headings, built with the pages
// (scripts/docs/search-index.mjs) and held in memory, so a search reads nothing and stores nothing.
//
// A query is a few words. A word matches the words that start with its stem ("rotate", "rotating" and "rotation" share
// "rotat"), in any case and without accents. Each page stands for its passage with the most of the words (the highest
// score among those): the words in the passage's heading count most, then in the page's title, its description, and the
// passage's text; a passage with every word, and one
// with the words side by side, comes first. Only the pages with the most of the words are listed, so a page with some
// of them shows only when none has them all. Common words are dropped when the query has others.
import { DOCS_PAGES, DOCS_SEARCH_INDEX, type DocsSearchPage } from './assets/docs-content.ts'

/** The longest query read; the rest is ignored. */
export const QUERY_LIMIT = 200
/** At most this many words of a query count. */
const TERM_LIMIT = 8
const SNIPPET_LENGTH = 220

const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'if', 'in', 'is',
  'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
  'you', 'your',
])

/** One page found: the passage that matched best, and the query's stems, to mark in `snippet`. */
export interface DocsResult {
  title: string
  section: string
  /** The heading the passage is under; null for the page's top, before its first heading. */
  heading: string | null
  path: string
  anchor: string | null
  snippet: string
  stems: string[]
}

interface Term {
  word: string
  stem: string
}

interface Passage {
  anchor: string | null
  heading: string | null
  text: string
  headingWords: string[]
  textWords: string[]
  /** The passage's words joined by single spaces, for the side-by-side bonus. */
  joined: string
}

interface Prepared {
  page: DocsSearchPage
  titleWords: string[]
  descriptionWords: string[]
  passages: Passage[]
}

/** Lower case, accents dropped. */
function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

function words(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

/** The stem a word matches by: common English endings cut, when at least three letters remain. */
function stem(word: string): string {
  if (word.length <= 3) return word
  const cut = word.replace(/(?:ations?|ings?|ed|es|s|e|ly)$/, '')
  return cut.length >= 3 ? cut : word
}

let prepared: Prepared[] | null = null

function index(): Prepared[] {
  prepared ??= DOCS_SEARCH_INDEX.map((page) => ({
    page,
    titleWords: words(page.title),
    descriptionWords: words(page.description),
    passages: page.passages.map((passage) => {
      const textWords = words(passage.text)
      return { ...passage, headingWords: words(passage.heading ?? ''), textWords, joined: ` ${textWords.join(' ')} ` }
    }),
  }))
  return prepared
}

/** The words of a query that count: unique, common words dropped while others remain, at most TERM_LIMIT. */
function termsOf(query: string): Term[] {
  const all = [...new Set(words(query.slice(0, QUERY_LIMIT)))]
  const meaningful = all.filter((word) => !STOPWORDS.has(word))
  return (meaningful.length ? meaningful : all).slice(0, TERM_LIMIT).map((word) => ({ word, stem: stem(word) }))
}

/** How many of `list` match `term`, an exact word counting a little more than another form of it. */
function hits(list: string[], term: Term): number {
  let found = 0
  for (const word of list) {
    if (word === term.word) found += 1.2
    else if (word.startsWith(term.stem)) found += 1
  }
  return found
}

/** The passage's score for `terms` (0: none of them), and how many of them it has. */
function score(entry: Prepared, passage: Passage, terms: Term[]): { value: number; matched: number } {
  let total = 0
  let missing = 0
  for (const term of terms) {
    const inHeading = hits(passage.headingWords, term)
    const inTitle = hits(entry.titleWords, term)
    const inDescription = hits(entry.descriptionWords, term)
    const inText = hits(passage.textWords, term)
    if (!inHeading && !inTitle && !inDescription && !inText) {
      missing += 1
      continue
    }
    total += 5 * Math.min(inHeading, 1.2) + 3 * Math.min(inTitle, 1.2) + Math.min(inDescription, 1.2) + (inText ? 1 + Math.log2(inText) : 0)
  }
  if (!total) return { value: 0, matched: 0 }
  if (!missing) total += 10
  if (terms.length > 1 && passage.joined.includes(` ${terms.map((term) => term.word).join(' ')} `)) total += 5
  const matched = terms.length - missing
  return { value: total * (matched / terms.length), matched }
}

/** The best pages for `query`, best first: each page once, with its best passage. */
export function searchDocs(query: string, limit: number): DocsResult[] {
  const terms = termsOf(query)
  if (!terms.length) return []
  const stems = terms.map((term) => term.stem)
  const found: { result: DocsResult; score: number; matched: number; order: number }[] = []
  index().forEach((entry, order) => {
    let best: { passage: Passage; value: number; matched: number } | null = null
    for (const passage of entry.passages) {
      const scored = score(entry, passage, terms)
      if (!scored.value) continue
      if (!best || scored.matched > best.matched || (scored.matched === best.matched && scored.value > best.value)) best = { passage, ...scored }
    }
    if (!best) return
    found.push({
      order,
      score: best.value,
      matched: best.matched,
      result: {
        title: entry.page.title,
        section: entry.page.section,
        heading: best.passage.heading,
        path: entry.page.path,
        anchor: best.passage.anchor,
        snippet: snippet(best.passage.text || entry.page.description, stems),
        stems,
      },
    })
  })
  const most = Math.max(0, ...found.map((entry) => entry.matched))
  return found.filter((entry) => entry.matched === most)
    .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(({ result }) => result)
}

/** Matches a word starting with one of `stems`, whole, in any case. */
function stemPattern(stems: string[]): RegExp {
  const alternatives = stems.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})[\\p{L}\\p{N}]*`, 'giu')
}

/** About SNIPPET_LENGTH characters of `text` around the first word that matches, cut at spaces, with … where cut. */
function snippet(text: string, stems: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= SNIPPET_LENGTH) return flat
  const first = stemPattern(stems).exec(flat)?.index ?? 0
  let start = Math.max(0, first - 60)
  if (start > 0) start = flat.indexOf(' ', start) + 1 || start
  let end = Math.min(flat.length, start + SNIPPET_LENGTH)
  if (end < flat.length) end = flat.lastIndexOf(' ', end) > start ? flat.lastIndexOf(' ', end) : end
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

/** `text` cut into the words that match `stems` (`mark`) and the rest, for the search page to highlight. */
export function markParts(text: string, stems: string[]): { text: string; mark: boolean }[] {
  if (!stems.length) return [{ text, mark: false }]
  const parts: { text: string; mark: boolean }[] = []
  let at = 0
  for (const match of text.matchAll(stemPattern(stems))) {
    if (match.index > at) parts.push({ text: text.slice(at, match.index), mark: false })
    parts.push({ text: match[0], mark: true })
    at = match.index + match[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false })
  return parts
}

/**
 * The docs page `ref` names, with its Markdown: a path such as /docs/platform/ai-agents (or platform/ai-agents), or its
 * full address on `origin`; a #heading, a query, .md or a slash at the end are ignored. Null for anything else.
 */
export function findDocsPage(ref: string, origin: string): { page: DocsSearchPage; markdown: string } | null {
  let path = ref.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    let url: URL
    try {
      url = new URL(path)
    } catch {
      return null
    }
    if (url.origin !== origin) return null
    path = url.pathname
  }
  path = path.replace(/[?#].*$/, '').replace(/\.md$/, '').replace(/\/+$/, '')
  if (!path.startsWith('/')) path = path.startsWith('docs/') ? `/${path}` : `/docs/${path}`
  const page = DOCS_SEARCH_INDEX.find((entry) => entry.path === path)
  const markdown = page ? DOCS_PAGES[page.path]?.markdown : undefined
  return page && markdown ? { page, markdown } : null
}

/** Every page by section, in reading order. */
export function docsSections(): { title: string; slug: string; pages: DocsSearchPage[] }[] {
  const sections: { title: string; slug: string; pages: DocsSearchPage[] }[] = []
  for (const page of DOCS_SEARCH_INDEX) {
    const last = sections.at(-1)
    if (last?.slug === page.sectionSlug) last.pages.push(page)
    else sections.push({ title: page.section, slug: page.sectionSlug, pages: [page] })
  }
  return sections
}
