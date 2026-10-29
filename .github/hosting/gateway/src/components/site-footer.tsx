// The footer of every gateway page: the privacy notice and terms (Google's OAuth review looks for them), the contact,
// the source code and Insulin. Its links carry no classes of their own; the <nav> styles them.
import { ArrowUpRight } from "lucide-react"
import type { Context } from "../context.ts"
import { apexUrl } from "../context.ts"
import { InsulinMark } from "./brand.tsx"
import { INSULIN_URL } from "./site-header.tsx"

export function SiteFooter({ ctx }: { ctx: Context }) {
  const { supportEmail, issuesUrl, repositoryUrl } = ctx.config
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:px-6 md:flex-row md:items-center md:justify-between">
        <p className="flex items-center gap-2">
          <InsulinMark className="size-5" />
          <span>Insulin Apps: open-source apps, hosted for your team.</span>
        </p>
        <nav
          aria-label="Footer"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 [&_a]:inline-flex [&_a]:items-center [&_a]:gap-1 [&_a]:underline-offset-4 [&_a:hover]:text-foreground [&_a:hover]:underline"
        >
          <a href={apexUrl(ctx, "/privacy")}>Privacy notice</a>
          <a href={apexUrl(ctx, "/terms")}>Terms of use</a>
          {supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : issuesUrl ? <a href={issuesUrl}>Support</a> : null}
          {repositoryUrl ? <a href={repositoryUrl}>Source code</a> : null}
          <a href={INSULIN_URL}>
            Built with Insulin
            <ArrowUpRight className="size-3.5" />
          </a>
        </nav>
      </div>
    </footer>
  )
}
