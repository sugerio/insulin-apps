// The docs' search index, built with the pages (scripts/build-docs.mjs): each page cut at its headings into passages of
// plain text, every passage with the anchor it starts at, so a result can link to the very section. src/docs-search.ts
// ranks the passages per request; nothing is fetched or stored at run time.
import { decodeEntities, plainText } from './markdown.mjs'

/** A block token's text without markup: lists one item per line, tables one row per line, code as written. */
function blockText(token) {
  switch (token.type) {
    case 'paragraph':
    case 'text':
    case 'heading':
      return token.tokens ? plainText(token.tokens) : decodeEntities(token.text ?? '')
    case 'list':
      return token.items.map((item) => item.tokens.map(blockText).filter(Boolean).join(' ')).join('\n')
    case 'blockquote':
      // A callout's marker ([!NOTE], [!WARNING]) is markup, not text.
      return token.tokens.map(blockText).filter(Boolean).join('\n').replace(/^\[![A-Z]+\]\s*/, '')
    case 'table':
      return [token.header, ...token.rows].map((row) => row.map((cell) => plainText(cell.tokens)).join(' · ')).join('\n')
    case 'code':
      if (token.lang === 'diagram') {
        const title = /^title:\s*(.+)$/m.exec(token.text)?.[1]?.trim()
        const description = /^description:\s*(.+)$/m.exec(token.text)?.[1]?.trim()
        return [title, description].filter(Boolean).join('. ')
      }
      return token.text
    case 'html':
      return decodeEntities(token.text.replace(/<[^>]+>/g, ' '))
    default:
      return ''
  }
}

/**
 * A page's passages, in order: the text before its first heading (no anchor: the page's top), then one per heading of
 * depth 2 to 4, under that heading's anchor. Whitespace is collapsed; an empty passage is left out.
 */
export function searchPassages(page) {
  const anchors = new Map(page.headings.map((heading) => [heading.token, heading]))
  const passages = [{ anchor: null, heading: null, parts: [] }]
  for (const token of page.tokens) {
    const heading = token.type === 'heading' ? anchors.get(token) : null
    if (heading) passages.push({ anchor: heading.id, heading: heading.text, parts: [] })
    else passages.at(-1).parts.push(blockText(token))
  }
  return passages
    .map(({ anchor, heading, parts }) => ({ anchor, heading, text: parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim() }))
    .filter((passage) => passage.text || passage.heading)
}

/** The index: every page in reading order, with its section, description and passages. */
export function searchIndex(sections) {
  return sections.flatMap((section) => section.pages.map((page) => ({
    path: page.path,
    title: page.title,
    section: section.title,
    sectionSlug: section.slug,
    description: page.description,
    passages: searchPassages(page),
  })))
}
