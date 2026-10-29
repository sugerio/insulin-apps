// The HTML document every gateway page shares, rendered on the server with React (react-dom/server). There is no
// client-side React: no hydration, no bundle, no inline script or style. The page links one stylesheet, the favicon,
// and Cloudflare's Turnstile script on the forms that need it, which is what the CSP (http/headers.ts) allows.
//
// React escapes every text and attribute value. Never use dangerouslySetInnerHTML (a test checks): names, e-mail
// addresses and organization names are user input.
import type { ReactElement, ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader, type HeaderAccount } from "@/components/site-header"
import type { Session } from "../auth/session.ts"
import type { Context } from "../context.ts"
import type { MembershipRow } from "../db/orgs.ts"
import { Html } from "./html.ts"

const SITE_NAME = "Insulin Apps"
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js"

export interface PageOptions {
  title: string
  /** Who is signed in, for the top bar (null: signed out); omit on pages that must not depend on the session. */
  user?: HeaderAccount | null
  /** Load the Turnstile widget script. */
  turnstile?: boolean
  /** Continue to this URL at once (a meta refresh; the page also links to it). */
  refreshTo?: string
}

/** The top bar's view of a session; `orgs` lets the organization switcher list every membership. */
export function accountOf(session: Session, orgs?: readonly MembershipRow[]): HeaderAccount {
  return { name: session.user.name, email: session.user.email, org: session.activeOrg, orgs }
}

export function renderDocument(element: ReactElement): Html {
  return new Html(`<!doctype html>\n${renderToStaticMarkup(element)}\n`)
}

/**
 * The favicon. On the apex and auth hosts also /favicon.ico (for browsers without SVG icons) and the Apple touch
 * icon; app hosts serve those paths themselves, so a gateway page shown there links only the reserved SVG.
 */
function IconLinks({ site }: { site: Context["site"] | null }) {
  const own = site === "apex" || site === "auth"
  return (
    <>
      {own ? <link rel="icon" href="/favicon.ico" sizes="32x32" /> : null}
      <link rel="icon" href="/__insulin/icon.svg" type="image/svg+xml" />
      {own ? <link rel="apple-touch-icon" href="/apple-touch-icon.png" /> : null}
    </>
  )
}

function Head({ title, site, options }: { title: string; site: Context["site"] | null; options?: PageOptions }) {
  return (
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{`${title} · ${SITE_NAME}`}</title>
      {options?.refreshTo ? <meta httpEquiv="refresh" content={`0; url=${options.refreshTo}`} /> : null}
      <link rel="stylesheet" href="/__insulin/gateway.css" />
      <IconLinks site={site} />
      {options?.turnstile ? <script src={TURNSTILE_SCRIPT} async defer /> : null}
    </head>
  )
}

const BODY = "flex min-h-svh flex-col bg-background font-sans text-foreground antialiased"

export function page(ctx: Context, options: PageOptions, content: ReactNode): Html {
  return renderDocument(
    <html lang="en">
      <Head title={options.title} site={ctx.site} options={options} />
      <body className={BODY}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SiteHeader ctx={ctx} account={options.user} />
        <main id="main" className="flex-1">
          {content}
        </main>
        <SiteFooter ctx={ctx} />
      </body>
    </html>
  )
}

/** A page without configuration (the 503 shown before the gateway knows its domain): no links to other hosts. */
export function barePage(title: string, content: ReactNode): Html {
  return renderDocument(
    <html lang="en">
      <Head title={title} site={null} />
      <body className={BODY}>
        <main id="main" className="flex flex-1 items-center">
          {content}
        </main>
      </body>
    </html>
  )
}
