// Error and status pages, the messages handlers show instead of a page, and the step that follows a successful POST.
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { ContactLink } from "@/components/contact"
import { AuthCard, Container, proseLinks } from "@/components/layout"
import type { HeaderAccount } from "@/components/site-header"
import type { ActiveOrg, Session } from "../auth/session.ts"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import { apexUrl, ownOrigin } from "../context.ts"
import { htmlResponse, redirect } from "../http/response.ts"
import { accountOf, barePage, page } from "./document.tsx"

function Message({ children }: { children: ReactNode }) {
  return <div className={cn("flex flex-col gap-4 text-sm text-muted-foreground", proseLinks)}>{children}</div>
}

function ButtonLink({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <a className={cn(buttonVariants({ variant: primary ? "default" : "outline" }), "w-full")} href={href}>
      {children}
    </a>
  )
}

/** A short page with a title and a message; `user` as in PageOptions. */
export function messagePage(ctx: Context, status: number, title: string, body: ReactNode, options: { user?: HeaderAccount | null } = {}): Response {
  return htmlResponse(page(ctx, { title, user: options.user }, (
    <AuthCard title={title}>
      <Message>{body}</Message>
    </AuthCard>
  )), { status })
}

export function notFoundPage(ctx: Context): Response {
  return messagePage(ctx, 404, "Page not found", (
    <>
      <p>{ctx.site === "other" ? "There's no app at this address." : "We couldn't find that page."}</p>
      <ButtonLink href={apexUrl(ctx)}>See all apps</ButtonLink>
    </>
  ))
}

export function methodNotAllowed(ctx: Context, allow: string[]): Response {
  const response = messagePage(ctx, 405, "Not allowed", <p>This address doesn&apos;t accept that kind of request.</p>)
  response.headers.set("Allow", allow.join(", "))
  return response
}

export function forbiddenPage(ctx: Context): Response {
  return messagePage(ctx, 403, "Request blocked", (
    <p>This request didn&apos;t come from this site&apos;s own pages, so it was blocked. Go back, reload the page and try again.</p>
  ))
}

export function rateLimitedPage(ctx: Context): Response {
  const response = messagePage(ctx, 429, "Too many attempts", <p>Please wait a minute, then try again.</p>)
  response.headers.set("Retry-After", "60")
  return response
}

export function badRequestPage(ctx: Context, status: 400 | 413 | 415, text: string): Response {
  return messagePage(ctx, status, "Something is wrong with that request", <p>{text}</p>)
}

/** An app host whose Worker is missing or failing. */
export function appUnavailablePage(ctx: Context, status: number): Response {
  return messagePage(ctx, status, "This app is not available right now", <p>Please try again in a few minutes.</p>)
}

/** A member of the active organization who has no access to this app (specific-apps access, without this one). */
export function noAppAccessPage(ctx: Context, session: Session, org: ActiveOrg, app: HostedApp): Response {
  return messagePage(ctx, 403, `You don't have access to ${app.title}`, (
    <>
      <p>
        In <strong className="text-foreground">{org.name}</strong>, you have access to specific apps only, and {app.title} isn&apos;t one of
        them. Ask an owner or admin of the organization to add it, or switch to another organization.
      </p>
      <ButtonLink href={apexUrl(ctx)}>See your apps and organizations</ButtonLink>
    </>
  ), { user: accountOf(session) })
}

/** Sessions are only created for confirmed addresses; this covers an account whose address is somehow unconfirmed. */
export function confirmEmailFirstPage(ctx: Context, session: Session): Response {
  return messagePage(ctx, 403, "Confirm your email first", (
    <p>
      Open the confirmation link we emailed to <strong className="text-foreground">{session.user.email}</strong>, or{" "}
      <a href={apexUrl(ctx, "/resend-verification")}>ask for a new one</a>.
    </p>
  ), { user: accountOf(session) })
}

/**
 * An account the operators suspended or disabled (DESIGN.md §11.3), at every sign-in. Their note stays theirs: the page
 * says only what happened and whom to ask.
 */
export function accountUnavailablePage(ctx: Context, status: "suspended" | "disabled"): Response {
  return messagePage(ctx, 403, status === "suspended" ? "This account is suspended" : "This account is disabled", (
    <p>
      Insulin Apps has {status} this account, so it can&apos;t sign in. If you think this is a mistake, contact <ContactLink ctx={ctx} />.
    </p>
  ))
}

/** An organization the operators suspended or disabled, where something tries to act in it. */
export function orgUnavailablePage(ctx: Context, status: "suspended" | "disabled"): Response {
  return messagePage(ctx, 403, status === "suspended" ? "This organization is suspended" : "This organization is disabled", (
    <>
      <p>
        Insulin Apps has {status} this organization, so nobody can use it for now. Its owners can contact <ContactLink ctx={ctx} />.
      </p>
      <ButtonLink href={apexUrl(ctx)}>See your apps and organizations</ButtonLink>
    </>
  ))
}

/** The credentials changed between verifying who someone is and creating their session: no session, sign in again. */
export function credentialsChangedPage(ctx: Context): Response {
  return messagePage(ctx, 409, "Please sign in again", (
    <>
      <p>The sign-in details of this account changed while you were signing in, so we didn&apos;t sign you in.</p>
      <ButtonLink href="/login" primary>
        Sign in again
      </ButtonLink>
    </>
  ))
}

export function googleFailedPage(ctx: Context, status: number, text: string): Response {
  return messagePage(ctx, status, "Google sign-in didn't work", (
    <>
      <p>{text}</p>
      <ButtonLink href="/login">Back to sign in</ButtonLink>
    </>
  ))
}

/** A member whose role doesn't allow what they asked for. */
export function notAllowedPage(ctx: Context, session: Session): Response {
  return messagePage(ctx, 403, "Not allowed", (
    <>
      <p>Your role in this organization doesn&apos;t allow that.</p>
      <ButtonLink href={apexUrl(ctx)}>Back to your organizations</ButtonLink>
    </>
  ), { user: accountOf(session) })
}

/** A guarded change that did nothing because the actor's own role changed meanwhile. */
export function actorChangedPage(ctx: Context, session: Session, orgId: string): Response {
  return messagePage(ctx, 409, "Nothing was changed", (
    <>
      <p>Your role in this organization changed while you were working, so nothing was changed.</p>
      <ButtonLink href={apexUrl(ctx, `/settings/users?org=${orgId}`)}>Back to the organization</ButtonLink>
    </>
  ), { user: accountOf(session) })
}

/** Shown without any configuration: every host answers 503 and redirects nowhere. */
export function notConfiguredResponse(): Response {
  const body = barePage("Not configured", (
    <Container width="narrow" className="py-16">
      <div className="flex flex-col gap-2 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
        <div className="text-xl font-semibold tracking-tight">
          <h1>This service is not configured yet</h1>
        </div>
        <p className="text-sm text-muted-foreground">Please come back later.</p>
      </div>
    </Container>
  ))
  return htmlResponse(body, { status: 503, headers: { "Retry-After": "300" } })
}

/**
 * Where a successful form POST goes next. Same-origin targets get a 303. A target on another of the site's hosts gets
 * a short page that continues with a meta refresh and a link: the CSP's `form-action 'self'` makes browsers block a
 * cross-origin redirect that follows a form submission.
 */
export function afterPost(ctx: Context, target: string): Response {
  if (new URL(target).origin === ownOrigin(ctx)) return redirect(target, 303)
  return htmlResponse(page(ctx, { title: "Continue", refreshTo: target }, (
    <AuthCard title="Continue">
      <ButtonLink href={target} primary>
        Continue to {describe(ctx, target)}
      </ButtonLink>
    </AuthCard>
  )))
}

function describe(ctx: Context, target: string): string {
  const host = new URL(target).hostname
  const app = ctx.config.appsByHost.get(host)
  if (app) return app.title
  if (host === ctx.config.domain) return "Insulin Apps"
  return "your account"
}

/** The home page, the default destination. */
export function home(ctx: Context): string {
  return apexUrl(ctx, "/")
}
