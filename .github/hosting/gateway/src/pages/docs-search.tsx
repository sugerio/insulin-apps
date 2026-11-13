// /docs/search: the docs' navigation, generated at build time (DOCS_SEARCH_HTML), around the search box and the results,
// rendered here with React per request, so the query and the passages are escaped like any other text.
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { HeaderAccount } from "@/components/site-header"
import { DOCS_SEARCH_HTML } from "../assets/docs-content.ts"
import type { Context } from "../context.ts"
import { QUERY_LIMIT, markParts, type DocsResult } from "../docs-search.ts"
import { docsShell, fillSlot } from "./docs.tsx"
import type { Html } from "./html.ts"

const SEARCH_SLOT = '<div data-docs-search-slot=""></div>'
const LINK = "font-medium text-foreground underline underline-offset-4"

function Result({ result }: { result: DocsResult }) {
  const href = result.anchor ? `${result.path}#${result.anchor}` : result.path
  return (
    <li className="flex flex-col gap-1 rounded-xl border bg-card p-4 text-card-foreground shadow-xs">
      <a href={href} className="font-medium underline-offset-4 hover:underline">
        {result.title}
        {result.heading ? <span className="text-muted-foreground"> › {result.heading}</span> : null}
      </a>
      <span className="text-xs text-muted-foreground">{result.section} docs</span>
      <p className="text-sm text-muted-foreground">
        {markParts(result.snippet, result.stems).map((part, index) => (part.mark ? <mark key={index} className="rounded-sm bg-primary/10 px-0.5 font-medium text-foreground">{part.text}</mark> : part.text))}
      </p>
    </li>
  )
}

function SearchResults({ query, results }: { query: string; results: DocsResult[] }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          <h1>Search the docs</h1>
        </div>
        <form action="/docs/search" method="get" role="search" aria-label="Search the docs" className="flex items-center gap-2">
          <Input type="search" name="q" defaultValue={query} required maxLength={QUERY_LIMIT} placeholder="Search the docs" aria-label="Search the docs" />
          <Button type="submit">Search</Button>
        </form>
      </header>
      {!query ? (
        <p className="text-muted-foreground">Type a few words, such as &ldquo;rotate secret&rdquo; or &ldquo;custom roles&rdquo;, and press Enter.</p>
      ) : results.length ? (
        <section aria-labelledby="results" className="flex flex-col gap-3">
          <h2 id="results" className="text-sm text-muted-foreground">
            {results.length === 1 ? "1 page" : `${results.length} pages`} for &ldquo;{query}&rdquo;
          </h2>
          <ol className="flex flex-col gap-3">
            {results.map((result) => <Result key={result.path} result={result} />)}
          </ol>
        </section>
      ) : (
        <p className="text-muted-foreground">
          Nothing in the docs matches &ldquo;{query}&rdquo;. Try fewer or other words, or browse <a href="/docs/" className={LINK}>the documentation</a>.
        </p>
      )}
    </div>
  )
}

export function docsSearchDocument(ctx: Context, query: string, results: DocsResult[], user: HeaderAccount | null): Html {
  const title = query ? `${query} · Search the docs` : "Search the docs"
  const html = fillSlot(DOCS_SEARCH_HTML, SEARCH_SLOT, renderToStaticMarkup(<SearchResults query={query} results={results} />))
  return docsShell(ctx, { title, user }, html)
}
