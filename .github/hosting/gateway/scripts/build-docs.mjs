#!/usr/bin/env node
// npm run build:docs: renders the public documentation at /docs/ into src/assets/docs-content.ts, the module the
// Worker serves it from. The pages come from Markdown kept next to what they describe:
//
//   .github/hosting/docs/*.md     the platform (section "platform")
//   <app>/docs/public/*.md        each app list-apps.mjs finds (section "<app>"), in its order
//   .github/hosting/docs/assets/  images, served from the DOCS_ASSETS binding at /docs/assets/
//
// Each page is rendered with React on the server (scripts/docs/), in the gateway's shadcn style: the two-level
// navigation (the sections, each with its icon, then the open section's pages), the article, its table of contents,
// previous and next. The module also holds each page's Markdown, for llms.txt,
// llms-full.txt and the .md address of every page; the search index (each page's passages, scripts/docs/search-index.mjs)
// and the navigation around /docs/search, for src/docs-search.ts, the search page, its JSON and the docs' MCP server. The
// result is committed, so the deploy needs no docs step.
//
// npm run check:docs (`--check`) writes nothing and fails while the committed module differs from a fresh build; the
// test suite runs the same check. `--allow-todo` and `--allow-missing-images` render diagram placeholders and missing
// screenshots while writing, and can't be combined with --check.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { listApps } from '../../../scripts/list-apps.mjs'
import { appIconName } from '../src/nav-icons.ts'
import { DocsIndex, DocsPage, DocsSearch, SEARCH_SLOT } from './docs/layout.mjs'
import { DocsError, collectHeadings, lex, parseFrontMatter, renderTokens, textForAgents } from './docs/markdown.mjs'
import { searchIndex } from './docs/search-index.mjs'

export const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const repositoryDir = resolve(gatewayDir, '..', '..', '..')
export const DOCS_MODULE = join(gatewayDir, 'src', 'assets', 'docs-content.ts')
export const PLATFORM_DOCS = join(repositoryDir, '.github', 'hosting', 'docs')
export const DOCS_ASSETS = join(PLATFORM_DOCS, 'assets')
/** Replaced with the site's origin when llms.txt is served (src/docs.ts). */
export const ORIGIN_TOKEN = '@@ORIGIN@@'

const PLATFORM = {
  slug: 'platform',
  title: 'Platform',
  icon: 'layers',
  summary: 'What every app shares: accounts, organizations and roles, sign-in and security, AI agents over MCP, the API with service accounts, and integrations.',
}

const posix = (path) => path.split(sep).join('/')

async function markdownFiles(dir) {
  if (!existsSync(dir)) return []
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(dir, entry.name))
    .sort()
}

/** Every file under the assets directory, by its /docs/assets/ address: size (PNG, SVG) and a content version. */
async function readAssets(dir = DOCS_ASSETS) {
  const assets = new Map()
  async function walk(current) {
    if (!existsSync(current)) return
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && !entry.name.startsWith('.')) {
        const bytes = await readFile(path)
        const version = createHash('sha256').update(bytes).digest('hex').slice(0, 10)
        assets.set(`/docs/assets/${posix(relative(dir, path))}`, { ...imageSize(entry.name, bytes), version })
      }
    }
  }
  await walk(dir)
  return assets
}

function imageSize(name, bytes) {
  if (name.endsWith('.png') && bytes.length > 24 && bytes.toString('latin1', 1, 4) === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (name.endsWith('.svg')) {
    const box = /viewBox="\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(bytes.toString('utf8'))
    if (box) return { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) }
  }
  return {}
}

/** The sections and their pages, parsed and checked, in reading order. */
async function readSources() {
  const apps = await listApps(repositoryDir)
  const sources = [{ ...PLATFORM, dir: PLATFORM_DOCS }]
  for (const app of apps) {
    if (app.name === PLATFORM.slug) throw new DocsError(`an app named "${PLATFORM.slug}" would share the platform's docs section`)
    // /docs/assets/, /docs/search and /docs/mcp are the docs' own addresses, not sections.
    if (['assets', 'search', 'mcp'].includes(app.name)) throw new DocsError(`an app named "${app.name}" would take /docs/${app.name}, which the docs use`)
    sources.push({ slug: app.name, title: app.title, summary: app.summary, icon: appIconName(app.name), dir: join(repositoryDir, app.name, 'docs', 'public') })
  }
  const sections = []
  for (const source of sources) {
    const files = await markdownFiles(source.dir)
    const where = posix(relative(repositoryDir, source.dir))
    if (!files.length) throw new DocsError(`${where}/ has no Markdown pages: every app's public docs live in <app>/docs/public/`)
    const pages = []
    for (const path of files) {
      const file = posix(relative(repositoryDir, path))
      const slug = path.slice(path.lastIndexOf(sep) + 1, -'.md'.length)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new DocsError(`${file}: page names are lower-case words joined by hyphens`)
      const { meta, body } = parseFrontMatter(await readFile(path, 'utf8'), file)
      const tokens = lex(body)
      pages.push({ ...meta, slug, file, body, tokens, path: `/docs/${source.slug}/${slug}`, headings: collectHeadings(tokens, file) })
    }
    pages.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
    const section = { slug: source.slug, title: source.title, summary: source.summary, icon: source.icon, pages }
    for (const page of pages) page.section = section
    sections.push(section)
  }
  return sections
}

/**
 * The sections, every page in reading order (each with its previous and next), and the `site` the renderers take: what
 * buildDocs renders, and what the tests check the rendered pages against.
 */
export async function loadDocs({ allowTodo = false, allowMissingImages = false } = {}) {
  const [sections, assets] = await Promise.all([readSources(), readAssets()])
  const pages = sections.flatMap((section) => section.pages)
  const byPath = new Map(pages.map((page) => [page.path, page]))
  const site = {
    sections,
    allowTodo,
    allowMissingImages,
    image: (src) => assets.get(src) ?? null,
    anchors: (path) => (['/docs/', '/docs/llms.txt', '/docs/llms-full.txt', '/docs/search'].includes(path) ? new Set() : byPath.get(path) ? new Set(byPath.get(path).headings.map((heading) => heading.id)) : null),
  }
  pages.forEach((page, index) => {
    const link = (other) => (other ? { path: other.path, title: other.title, sectionTitle: other.section.title } : null)
    page.previous = index === 0 ? { path: '/docs/', title: 'Overview', sectionTitle: 'Documentation' } : link(pages[index - 1])
    page.next = link(pages[index + 1])
  })
  return { sections, pages, site }
}

/** The module's text: every page's HTML and Markdown, the sections' first pages, and llms.txt. */
export async function buildDocs({ allowTodo = false, allowMissingImages = false } = {}) {
  const { sections, pages, site } = await loadDocs({ allowTodo, allowMissingImages })
  const out = {}
  out['/docs/'] = {
    title: 'Documentation',
    description: 'How to set up your organization on Insulin Apps, sign in, manage people and roles, connect AI agents and call the API, and how to use each app.',
    html: render(h(DocsIndex, { site, next: { path: pages[0].path, title: pages[0].title, sectionTitle: pages[0].section.title } }), 'the index'),
    markdown: '',
  }
  for (const page of pages) {
    const body = renderTokens(page.tokens, { file: page.file, path: page.path, headings: page.headings, site })
    out[page.path] = {
      title: `${page.title} · ${page.section.title} docs`,
      description: page.description,
      html: render(h(DocsPage, { site, page, body }), page.file),
      markdown: `# ${page.title}\n\n> ${page.description}\n\n${textForAgents(page.body)}\n`,
    }
  }
  const search = render(h(DocsSearch, { site }), 'the search page')
  if (search.split(SEARCH_SLOT).length !== 2) throw new DocsError('the search page needs its slot once')
  return docsModule(out, Object.fromEntries(sections.map((section) => [section.slug, section.pages[0].path])), llmsTxt(sections), searchIndex(sections), search)
}

/** React's static markup, refused if anything in it could run or style itself. */
function render(element, what) {
  const html = renderToStaticMarkup(element)
  const bad = /<script|<style|<iframe|<object|<embed|\sstyle=|\son[a-z]+=|javascript:/i.exec(html)
  if (bad) throw new DocsError(`${what}: the rendered page contains "${bad[0].trim()}"`)
  return html
}

function llmsTxt(sections) {
  const lines = [
    '# Insulin Apps',
    '',
    '> Open-source business apps hosted at insulinapps.com: one account and organization for every app, roles from Owner to Viewer, AI agents over MCP and service accounts for each app\'s API.',
    '',
    `These pages explain how to set up an organization, sign in, manage people and roles, connect AI agents and call the API, and how to use each app. Each link is the page's Markdown; the same page as HTML is at the address without .md. ${ORIGIN_TOKEN}/docs/llms-full.txt has every page in one file.`,
    '',
    `To search them, with no sign-in: GET ${ORIGIN_TOKEN}/docs/search.json?q=<words> answers in JSON, each result with its page, section and a passage; and the docs' MCP server at ${ORIGIN_TOKEN}/docs/mcp (Streamable HTTP, no OAuth) has the tools search_docs, read_doc and list_docs.`,
  ]
  for (const section of sections) {
    lines.push('', `## ${section.title}`, '', ...section.pages.map((page) => `- [${page.title}](${ORIGIN_TOKEN}${page.path}.md): ${page.description}`))
  }
  return `${lines.join('\n')}\n`
}

function docsModule(pages, sections, llms, search, searchHtml) {
  return [
    '// Generated by `npm run build:docs` from the docs\' Markdown (.github/hosting/docs/, <app>/docs/public/): do not edit.',
    '// The pages of /docs/, rendered with React at build time (scripts/docs/); src/docs.ts serves them.',
    '',
    'export interface DocsPage {',
    '  /** The document title, before " · Insulin Apps". */',
    '  readonly title: string',
    '  readonly description: string',
    '  /** The page below the top bar: navigation, article, table of contents. */',
    '  readonly html: string',
    '  /** The page as Markdown, for its .md address and llms-full.txt (empty for the index). */',
    '  readonly markdown: string',
    '}',
    '',
    `export const DOCS_PAGES: Readonly<Record<string, DocsPage>> = ${JSON.stringify(pages, null, 1)}`,
    '',
    '/** Each section\'s first page, where /docs/<section> leads. */',
    `export const DOCS_SECTIONS: Readonly<Record<string, string>> = ${JSON.stringify(sections)}`,
    '',
    '/** Where llms.txt and llms-full.txt name the site\'s origin, replaced when they are served. */',
    `export const DOCS_ORIGIN_TOKEN = ${JSON.stringify(ORIGIN_TOKEN)}`,
    '',
    '/** /docs/llms.txt. */',
    `export const DOCS_LLMS_TXT = ${JSON.stringify(llms)}`,
    '',
    '/** A page as the search sees it: cut at its headings into passages of plain text, each under its anchor (null: the top). */',
    'export interface DocsSearchPage {',
    '  readonly path: string',
    '  readonly title: string',
    '  readonly section: string',
    '  readonly sectionSlug: string',
    '  readonly description: string',
    '  readonly passages: readonly { readonly anchor: string | null; readonly heading: string | null; readonly text: string }[]',
    '}',
    '',
    '/** Every page in reading order, for src/docs-search.ts. */',
    `export const DOCS_SEARCH_INDEX: readonly DocsSearchPage[] = ${JSON.stringify(search, null, 1)}`,
    '',
    `/** /docs/search below the top bar: the navigation, and ${SEARCH_SLOT} where the search box and results go. */`,
    `export const DOCS_SEARCH_HTML = ${JSON.stringify(searchHtml)}`,
    '',
  ].join('\n')
}

/** Whether the module at `path` matches a fresh build. */
export async function docsAreCurrent(path = DOCS_MODULE) {
  const [expected, committed] = await Promise.all([buildDocs(), readFile(path, 'utf8').catch(() => '')])
  return expected === committed
}

async function main(argv) {
  const check = argv.includes('--check')
  const at = argv.indexOf('--out')
  const out = at === -1 ? DOCS_MODULE : resolve(argv[at + 1])
  const options = { allowTodo: argv.includes('--allow-todo'), allowMissingImages: argv.includes('--allow-missing-images') }
  try {
    if (check) {
      if (options.allowTodo || options.allowMissingImages) throw new DocsError('--check takes no --allow-* option')
      if (await docsAreCurrent(out)) return
      console.error(`${posix(relative(gatewayDir, out))} is stale: run \`npm run build:docs\` and commit the result.`)
      process.exitCode = 1
      return
    }
    const module = await buildDocs(options)
    await writeFile(out, module)
    console.log(`${posix(relative(gatewayDir, out))}: ${Buffer.byteLength(module)} bytes`)
  } catch (error) {
    if (!(error instanceof DocsError)) throw error
    console.error(`build:docs: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
