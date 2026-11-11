// The shared document around a docs page. The page itself (navigation, article, table of contents) was rendered with
// React at build time from the repository's Markdown (scripts/build-docs.mjs) and arrives as HTML in
// src/assets/docs-content.ts; here React renders the document (top bar for this visitor, footer) with a placeholder
// element where the page goes, and the placeholder is swapped for it. The page's HTML comes only from that generated
// module, never from a request, and the build refuses any script, style or event handler in it.
import type { HeaderAccount } from "@/components/site-header"
import type { DocsPage } from "../assets/docs-content.ts"
import type { Context } from "../context.ts"
import { page } from "./document.tsx"
import { Html } from "./html.ts"

const SLOT = '<div data-docs-slot=""></div>'

export function docsDocument(ctx: Context, docs: DocsPage, canonical: string, user: HeaderAccount | null): Html {
  const shell = page(ctx, { title: docs.title, description: docs.description, canonical, user }, <div data-docs-slot="" />).value
  const at = shell.indexOf(SLOT)
  if (at === -1 || shell.indexOf(SLOT, at + 1) !== -1) throw new Error("docs_slot_missing")
  return new Html(`${shell.slice(0, at)}${docs.html}${shell.slice(at + SLOT.length)}`)
}
