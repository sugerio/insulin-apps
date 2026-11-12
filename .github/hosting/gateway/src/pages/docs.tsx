// The shared document around a docs page. The page itself (navigation, article, table of contents) was rendered with
// React at build time from the repository's Markdown (scripts/build-docs.mjs) and arrives as HTML in
// src/assets/docs-content.ts; here React renders the document (top bar for this visitor, footer) with a placeholder
// element where the page goes, and the placeholder is swapped for it. The page's HTML comes only from that generated
// module, never from a request, and the build refuses any script, style or event handler in it; the one exception,
// /docs/search's results, are rendered with React per request (docs-search.tsx), which escapes them.
import type { HeaderAccount } from "@/components/site-header"
import type { DocsPage } from "../assets/docs-content.ts"
import type { Context } from "../context.ts"
import { page, type PageOptions } from "./document.tsx"
import { Html } from "./html.ts"

const SLOT = '<div data-docs-slot=""></div>'

/** `html` in place of `slot`, which must be in `shell` exactly once. */
export function fillSlot(shell: string, slot: string, html: string): string {
  const at = shell.indexOf(slot)
  if (at === -1 || shell.indexOf(slot, at + 1) !== -1) throw new Error("docs_slot_missing")
  return `${shell.slice(0, at)}${html}${shell.slice(at + slot.length)}`
}

/** The document for the docs' generated `html`, with these head options. */
export function docsShell(ctx: Context, options: Omit<PageOptions, "wideHeader" | "shell">, html: string): Html {
  // The top bar spans the window, so its mark lines up with the docs' navigation at the left edge.
  return new Html(fillSlot(page(ctx, { ...options, wideHeader: true }, <div data-docs-slot="" />).value, SLOT, html))
}

export function docsDocument(ctx: Context, docs: DocsPage, canonical: string, user: HeaderAccount | null): Html {
  const kind = canonical.endsWith("/docs/") ? "website" : "article"
  return docsShell(ctx, { title: docs.title, description: docs.description, canonical, user, kind }, docs.html)
}
