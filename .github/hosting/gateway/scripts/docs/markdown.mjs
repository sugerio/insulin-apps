// The docs' Markdown, turned into React elements at build time (scripts/build-docs.mjs). Marked only tokenizes; every
// element is created here with React, so the output can hold nothing but the elements below, with classes from the
// gateway's stylesheet: no raw HTML, no style attribute, no script. Anything the build doesn't understand fails it.
//
// The Markdown it accepts: front matter (title, description, order), ## to #### headings, paragraphs, emphasis, code,
// links, lists, GFM tables, fenced code, rules, blockquotes, GitHub callouts (> [!NOTE], [!TIP], [!IMPORTANT],
// [!WARNING]), images under /docs/assets/, and ```diagram blocks (diagram.mjs). Raw HTML is refused.
import { createElement as h, Fragment } from 'react'
import { Lexer } from 'marked'
import { CircleAlert, Info, Lightbulb, TriangleAlert } from 'lucide-react'
import { renderDiagram } from './diagram.mjs'

export class DocsError extends Error {}

const FRONT_MATTER_KEYS = new Set(['title', 'description', 'order'])

/** The front matter (`---` lines around `key: value` pairs) and the Markdown after it. */
export function parseFrontMatter(source, file) {
  const text = source.replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) throw new DocsError(`${file}: starts without front matter (--- title, description, order ---)`)
  const meta = {}
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue
    const pair = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!pair || !FRONT_MATTER_KEYS.has(pair[1])) throw new DocsError(`${file}: front matter line "${line}" (only title, description, order)`)
    let value = pair[2].trim()
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    meta[pair[1]] = value
  }
  for (const key of FRONT_MATTER_KEYS) if (!meta[key]) throw new DocsError(`${file}: front matter needs ${key}`)
  if (!/^\d{1,3}$/.test(meta.order)) throw new DocsError(`${file}: order must be a whole number`)
  if (meta.description.length > 200) throw new DocsError(`${file}: the description is over 200 characters`)
  return { meta: { title: meta.title, description: meta.description, order: Number(meta.order) }, body: text.slice(match[0].length) }
}

export function lex(markdown) {
  return new Lexer({ gfm: true }).lex(markdown)
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', times: '×', middot: '·', copy: '©' }

/** Marked leaves HTML entities in text as written; React would escape them again. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** The text of inline tokens, without markup. */
export function plainText(tokens = []) {
  return tokens.map((token) => {
    if (token.tokens) return plainText(token.tokens)
    if (token.type === 'br') return ' '
    return decodeEntities(token.text ?? '')
  }).join('')
}

/** GitHub's heading anchors: lower case, punctuation dropped, each space a hyphen. */
export function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

/** Every heading of a page, with its anchor (numbered as GitHub does when two headings share one). */
export function collectHeadings(tokens, file) {
  const seen = new Map()
  const headings = []
  for (const token of tokens) {
    if (token.type !== 'heading') continue
    if (token.depth === 1) throw new DocsError(`${file}: a # heading (the title is the page's only h1; start at ##)`)
    if (token.depth > 4) throw new DocsError(`${file}: a heading deeper than ####`)
    const text = plainText(token.tokens)
    const base = slugify(text) || 'section'
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    headings.push({ depth: token.depth, text, id: count ? `${base}-${count}` : base, token })
  }
  return headings
}

// Classes for the rendered elements: shadcn's typography, in the neutral theme.
export const CLASSES = {
  h2: 'mt-12 scroll-mt-20 border-b pb-2 text-2xl font-semibold tracking-tight first:mt-0',
  h3: 'mt-9 scroll-mt-20 text-xl font-semibold tracking-tight',
  h4: 'mt-7 scroll-mt-20 text-base font-semibold',
  anchor: 'ml-2 text-muted-foreground no-underline opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
  p: 'mt-5 leading-7 first:mt-0',
  ul: 'mt-5 ml-6 list-disc first:mt-0 marker:text-muted-foreground',
  ol: 'mt-5 ml-6 list-decimal first:mt-0 marker:text-muted-foreground',
  nestedList: 'mt-2',
  li: 'mt-2 pl-1 leading-7',
  code: 'rounded bg-muted px-[0.3rem] py-[0.15rem] font-mono text-[0.8125rem] break-words',
  codeBlock: 'mt-5 overflow-hidden rounded-lg border bg-muted/40 first:mt-0',
  codeLabel: 'border-b px-4 py-1.5 font-mono text-xs text-muted-foreground',
  pre: 'overflow-x-auto p-4 font-mono text-[0.8125rem] leading-6',
  a: 'font-medium underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground',
  blockquote: 'mt-5 border-l-2 pl-5 text-muted-foreground first:mt-0',
  hr: 'my-10',
  tableWrap: 'mt-5 w-full overflow-x-auto rounded-lg border first:mt-0',
  table: 'w-full border-collapse text-sm',
  th: 'border-b bg-muted/50 px-3 py-2 text-left align-bottom font-medium',
  td: 'border-b px-3 py-2 align-top leading-6',
  tbody: '[&>tr:last-child>td]:border-b-0',
  figure: 'mt-6 first:mt-0',
  img: 'h-auto w-full rounded-lg border bg-muted',
  inlineImg: 'inline h-auto max-w-full rounded border',
  figcaption: 'mt-2 text-center text-sm text-muted-foreground',
}

const CALLOUTS = {
  NOTE: { label: 'Note', icon: Info, className: 'border-border bg-card' },
  TIP: { label: 'Tip', icon: Lightbulb, className: 'border-border bg-card' },
  IMPORTANT: { label: 'Important', icon: CircleAlert, className: 'border-diagram-accent/40 bg-diagram-accent-soft' },
  WARNING: { label: 'Warning', icon: TriangleAlert, className: 'border-destructive/40 bg-card' },
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' }

/**
 * Renders one page's Markdown tokens. `site` resolves links and images: `site.hasPage(path)`, `site.anchors(path)` (a
 * Set, or null for an unknown page), `site.image(src)` ({ width, height, version } or null), `site.allowTodo`.
 */
export function renderTokens(tokens, { file, path, headings, site }) {
  const fail = (message) => { throw new DocsError(`${file}: ${message}`) }
  const ids = new Map(headings.map((heading) => [heading.token, heading.id]))
  const own = new Set(headings.map((heading) => heading.id))
  let key = 0
  let diagrams = 0
  const next = () => (key += 1)

  function link(href) {
    if (/^https:\/\/[^\s]+$/.test(href) || /^mailto:[^\s@]+@[^\s@]+$/.test(href)) return href
    if (/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(href)) return href
    if (href.startsWith('#')) {
      if (!own.has(href.slice(1))) fail(`a link to #${href.slice(1)}, which isn't a heading on this page`)
      return href
    }
    const match = /^(\/docs\/[^#?\s]*)(#[^\s]*)?$/.exec(href)
    if (!match) fail(`the link "${href}": use https:// or /docs/<section>/<page>[#anchor]`)
    const [, target, hash] = match
    if (target.startsWith('/docs/assets/')) {
      if (!site.image(target)) fail(`a link to ${target}, which isn't in .github/hosting/docs/assets/`)
      return href
    }
    const anchors = site.anchors(target)
    if (!anchors) fail(`a link to ${target}, which isn't a docs page`)
    if (hash && !anchors.has(hash.slice(1))) fail(`a link to ${href}: ${target} has no heading ${hash}`)
    return href
  }

  function image(token, alone) {
    const alt = plainText(token.tokens).trim()
    if (!alt) fail(`the image ${token.href} has no alt text`)
    if (!/^\/docs\/assets\/[a-z0-9][a-z0-9/_.-]*\.(?:png|svg|jpe?g|webp)$/.test(token.href) || token.href.includes('..')) {
      fail(`the image ${token.href}: images live under /docs/assets/ (.github/hosting/docs/assets/) as png, svg, jpg or webp`)
    }
    const found = site.image(token.href)
    if (!found && !site.allowMissingImages) fail(`the image ${token.href} isn't in .github/hosting/docs/assets/`)
    const src = found ? `${token.href}?v=${found.version}` : token.href
    const size = found?.width ? { width: found.width, height: found.height } : {}
    const img = h('img', { key: next(), src, alt, ...size, loading: 'lazy', decoding: 'async', className: alone ? CLASSES.img : CLASSES.inlineImg })
    if (!alone) return img
    return h('figure', { key: next(), className: CLASSES.figure },
      img,
      token.title ? h('figcaption', { className: CLASSES.figcaption }, decodeEntities(token.title)) : null)
  }

  function inline(tokens = []) {
    return tokens.map((token) => {
      switch (token.type) {
        case 'text':
          return token.tokens ? h(Fragment, { key: next() }, inline(token.tokens)) : decodeEntities(token.text)
        case 'escape':
          return token.text
        case 'strong':
          return h('strong', { key: next(), className: 'font-semibold' }, inline(token.tokens))
        case 'em':
          return h('em', { key: next() }, inline(token.tokens))
        case 'del':
          return h('del', { key: next() }, inline(token.tokens))
        case 'codespan':
          return h('code', { key: next(), className: CLASSES.code }, token.text)
        case 'br':
          return h('br', { key: next() })
        case 'link':
          return h('a', { key: next(), href: link(token.href), className: CLASSES.a, ...(token.title ? { title: decodeEntities(token.title) } : {}) }, inline(token.tokens))
        case 'image':
          return image(token, false)
        case 'html':
          return fail(`raw HTML ("${token.raw.trim().slice(0, 40)}"): write Markdown instead`)
        default:
          return fail(`unsupported inline Markdown (${token.type})`)
      }
    })
  }

  function heading(token) {
    const id = ids.get(token)
    const tag = `h${token.depth}`
    return h(tag, { key: next(), id, className: `group ${CLASSES[tag]}` },
      inline(token.tokens),
      h('a', { href: `#${id}`, className: CLASSES.anchor, 'aria-label': `Link to this section: ${plainText(token.tokens)}` }, '#'))
  }

  function list(token, depth) {
    const tag = token.ordered ? 'ol' : 'ul'
    const start = token.ordered && token.start !== '' && token.start !== 1 ? { start: token.start } : {}
    return h(tag, { key: next(), className: `${CLASSES[tag]}${depth ? ` ${CLASSES.nestedList}` : ''}`, ...start },
      token.items.map((item) => {
        if (item.task) fail('task list items ([ ] and [x]) are not supported')
        return h('li', { key: next(), className: CLASSES.li }, blocks(item.tokens, depth + 1))
      }))
  }

  function callout(token) {
    const [first, ...rest] = token.tokens
    const marker = first?.type === 'paragraph' ? /^\[!([A-Z]+)\]\s*\n?/.exec(first.text) : null
    if (!marker) return h('blockquote', { key: next(), className: CLASSES.blockquote }, blocks(token.tokens, 0))
    const kind = CALLOUTS[marker[1]]
    if (!kind) fail(`the callout [!${marker[1]}]: use NOTE, TIP, IMPORTANT or WARNING`)
    // Drop the marker from the first text token of the first paragraph.
    const inner = [...first.tokens]
    const lead = inner[0]
    if (lead?.type !== 'text' || !lead.text.startsWith(marker[0].trimEnd())) fail(`the callout [!${marker[1]}] must start its blockquote`)
    const remainder = lead.text.slice(marker[0].trimEnd().length).replace(/^\s*\n?/, '')
    if (remainder) inner[0] = { ...lead, text: remainder, tokens: undefined }
    else inner.shift()
    const body = [...(inner.length ? [{ ...first, tokens: inner }] : []), ...rest]
    const Icon = kind.icon
    return h('div', { key: next(), role: 'note', className: `mt-5 flex gap-3 rounded-lg border px-4 py-3 text-sm first:mt-0 ${kind.className}` },
      h(Icon, { className: 'mt-0.5 size-4 shrink-0', 'aria-hidden': 'true' }),
      h('div', { className: 'min-w-0 flex-1 [&_p]:mt-2 [&_p]:leading-6 [&_p:first-child]:mt-0' },
        h('p', { className: 'font-medium' }, kind.label),
        blocks(body, 0)))
  }

  function code(token) {
    if (token.lang === 'diagram') {
      if (/^todo:/.test(token.text.trim())) {
        if (site.allowTodo) return h('p', { key: next(), className: CLASSES.p }, `[Diagram to come: ${token.text.trim().slice(5).trim()}]`)
        fail(`a diagram placeholder (${token.text.trim()})`)
      }
      diagrams += 1
      try {
        return h(Fragment, { key: next() }, renderDiagram(token.text, `${path.split('/').pop()}-d${diagrams}`))
      } catch (error) {
        fail(`diagram ${diagrams}: ${error.message}`)
      }
    }
    const lang = (token.lang ?? '').trim()
    if (lang && !/^[a-z0-9+-]{1,20}$/.test(lang)) fail(`the code block language "${lang}"`)
    return h('div', { key: next(), className: CLASSES.codeBlock },
      lang && lang !== 'text' ? h('div', { className: CLASSES.codeLabel }, lang) : null,
      h('pre', { className: CLASSES.pre }, h('code', null, token.text)))
  }

  function table(token) {
    const cell = (tag, item, align) => h(tag, { key: next(), className: `${CLASSES[tag]} ${ALIGN[align] ?? ''}`.trim(), ...(tag === 'th' ? { scope: 'col' } : {}) }, inline(item.tokens))
    return h('div', { key: next(), className: CLASSES.tableWrap },
      h('table', { className: CLASSES.table },
        h('thead', null, h('tr', null, token.header.map((item, index) => cell('th', item, token.align[index])))),
        h('tbody', { className: CLASSES.tbody }, token.rows.map((row) => h('tr', { key: next() }, row.map((item, index) => cell('td', item, token.align[index])))))))
  }

  function blocks(tokens = [], depth) {
    return tokens.map((token) => {
      switch (token.type) {
        case 'space':
        case 'def':
          return null
        case 'heading':
          return heading(token)
        case 'paragraph':
          if (token.tokens.length === 1 && token.tokens[0].type === 'image') return image(token.tokens[0], true)
          return h('p', { key: next(), className: CLASSES.p }, inline(token.tokens))
        case 'text':
          // A tight list item's text.
          return h(Fragment, { key: next() }, token.tokens ? inline(token.tokens) : decodeEntities(token.text))
        case 'list':
          return list(token, depth)
        case 'blockquote':
          return callout(token)
        case 'code':
          return code(token)
        case 'table':
          return table(token)
        case 'hr':
          return h('hr', { key: next(), className: CLASSES.hr })
        case 'html':
          return fail(`raw HTML ("${token.raw.trim().slice(0, 40)}"): write Markdown instead`)
        default:
          return fail(`unsupported Markdown (${token.type})`)
      }
    })
  }

  return blocks(tokens, 0)
}

/** The Markdown as plain text for llms-full.txt: diagrams become their title and description. */
export function textForAgents(markdown) {
  const tokens = lex(markdown)
  let out = ''
  for (const token of tokens) {
    if (token.type === 'code' && token.lang === 'diagram') {
      const title = /^title:\s*(.+)$/m.exec(token.text)?.[1]?.trim()
      const description = /^description:\s*(.+)$/m.exec(token.text)?.[1]?.trim()
      out += `[Diagram: ${[title, description].filter(Boolean).join('. ')}]\n\n`
    } else {
      out += token.raw
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
