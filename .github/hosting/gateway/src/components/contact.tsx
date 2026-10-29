import type { Context } from "../context.ts"

/** The contact on the landing, privacy and terms pages: SUPPORT_EMAIL, else the repository's issues. */
export function ContactLink({ ctx }: { ctx: Context }) {
  if (ctx.config.supportEmail) return <a href={`mailto:${ctx.config.supportEmail}`}>{ctx.config.supportEmail}</a>
  if (ctx.config.issuesUrl) return <a href={ctx.config.issuesUrl}>the project&apos;s GitHub issues</a>
  return <>the project&apos;s public repository</>
}
