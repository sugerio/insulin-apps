// The apex's `/`: the landing page for visitors, the home page (the active organization's apps, invitations) once
// signed in. Organizations are switched and created from the top bar.
import { ArrowRight, Building2, ChartPie, LayoutGrid, Plus, ShieldCheck, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { GitHubMark } from "@/components/brand"
import { ContactLink } from "@/components/contact"
import { Notice, PostButton } from "@/components/forms"
import { Container, PageHeader, SectionTitle, proseLinks } from "@/components/layout"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import { apexUrl, appUrl, withReturnTo } from "../context.ts"
import type { InvitationGrantRow, InvitationRow } from "../db/invitations.ts"
import type { MembershipRow } from "../db/orgs.ts"
import { accessPhrase } from "../orgs/access-forms.ts"
import type { ActiveOrg, Session } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { accountOf, page } from "./document.tsx"

/** Each app's icon on its card, by directory name; apps without one get a generic icon. */
const APP_ICONS: Record<string, LucideIcon> = {
  captable: ChartPie,
}

/** The apps as cards; each card's title is an h3 under a section's h2, or an h2 right under the page's h1. */
function AppCards({ ctx, apps, level = 3 }: { ctx: Context; apps: HostedApp[]; level?: 2 | 3 }) {
  if (!apps.length) return <p className="text-muted-foreground">No apps are deployed yet.</p>
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {apps.map((app) => {
        const Icon = APP_ICONS[app.name] ?? LayoutGrid
        return (
          <Card key={app.name} className="gap-5">
            <CardHeader className="gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg border bg-muted text-foreground">
                <Icon className="size-5" />
              </div>
              <CardTitle className="text-base">{level === 2 ? <h2>{app.title}</h2> : <h3>{app.title}</h3>}</CardTitle>
              {app.summary ? <CardDescription>{app.summary}</CardDescription> : null}
            </CardHeader>
            <CardFooter className="mt-auto flex-wrap gap-2">
              {app.service ? (
                <a className={buttonVariants({ size: "sm" })} href={appUrl(ctx, app)}>
                  Open {app.title}
                </a>
              ) : (
                <Badge variant="secondary">Not available right now</Badge>
              )}
              {app.source ? (
                <a className={buttonVariants({ variant: "outline", size: "sm" })} href={app.source}>
                  <GitHubMark />
                  Source
                </a>
              ) : null}
            </CardFooter>
          </Card>
        )
      })}
    </div>
  )
}

const FEATURES: { icon: LucideIcon | typeof GitHubMark; title: string; text: string }[] = [
  {
    icon: Building2,
    title: "One organization for every app",
    text: "Create your organization once and invite your teammates. The same organization and members work in every app.",
  },
  {
    icon: ShieldCheck,
    title: "Roles from Owner to Viewer",
    text: "Give each person a role in every app (Owner, Admin, Editor or Viewer), or access to specific apps only, with built-in or custom roles.",
  },
  {
    icon: GitHubMark,
    title: "Open source on Cloudflare",
    text: "Each app runs on Cloudflare's network with its own database, and its source code is public under the MIT License.",
  },
]

/** For visitors only: a signed-in, confirmed user gets the home page at the same address. */
export function landingPage(ctx: Context): Html {
  const signup = apexUrl(ctx, withReturnTo("/signup", apexUrl(ctx)))
  const login = apexUrl(ctx, withReturnTo("/login", apexUrl(ctx)))
  return page(ctx, { title: "Open-source apps, hosted", user: null }, (
    <>
      <section className="border-b">
        <Container width="wide" className="flex flex-col items-center gap-6 py-16 text-center sm:py-24">
          <Badge variant="outline" className="rounded-full px-3 py-1 text-muted-foreground">
            Open source · MIT License
          </Badge>
          <div className="text-4xl font-semibold tracking-tight sm:text-6xl">
            <h1>Insulin Apps</h1>
          </div>
          <p className="max-w-2xl text-lg text-balance text-muted-foreground sm:text-xl">
            Open-source business apps for your team: create an account, set up your organization, and invite teammates
            with a role in every app or in the apps they need.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <a className={buttonVariants({ size: "lg" })} href={signup}>
              Create an account
              <ArrowRight />
            </a>
            <a className={buttonVariants({ variant: "outline", size: "lg" })} href={login}>
              Sign in
            </a>
            <a className={buttonVariants({ variant: "ghost", size: "lg" })} href={apexUrl(ctx, "/docs/")}>
              Read the docs
            </a>
          </div>
        </Container>
      </section>
      <section className="py-12 sm:py-16">
        <Container width="wide" className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <SectionTitle>Apps</SectionTitle>
            <p className="text-muted-foreground">Each app opens in your active organization.</p>
          </div>
          <AppCards ctx={ctx} apps={ctx.config.apps} />
        </Container>
      </section>
      <section className="border-t bg-muted/40 py-12 sm:py-16">
        <Container width="wide" className="flex flex-col gap-6">
          <SectionTitle>How it works</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <Card key={title} className="gap-4">
                <CardHeader className="gap-3">
                  <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Icon className="size-4" />
                  </div>
                  <CardTitle className="text-base">
                    <h3>{title}</h3>
                  </CardTitle>
                  <CardDescription>{text}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
          <p className={cn("text-sm text-muted-foreground", proseLinks)}>
            The service is provided as is, without an uptime guarantee. Read the{" "}
            <a href={apexUrl(ctx, "/terms")}>Terms of use</a> and the <a href={apexUrl(ctx, "/privacy")}>Privacy notice</a>.
            Questions: <ContactLink ctx={ctx} />.
          </p>
        </Container>
      </section>
    </>
  ))
}

const HOME_NOTICES: Record<string, string> = {
  "org-deleted": "The organization was deleted.",
  "org-left": "You left the organization.",
  "invitation-declined": "Invitation declined.",
  joined: "You joined the organization. Your apps are below.",
  "password-set": "Your new password is saved, and every other session is signed out.",
  verified: "Your email address is confirmed.",
}

/** For someone in no organization: what to do first. Their invitations, if any, are listed below it. */
function NoOrgCard({ session, invitations }: { session: Session; invitations: InvitationRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>You&apos;re not in an organization yet</h2>
        </CardTitle>
        <CardDescription>
          {invitations.length
            ? "The apps open in an organization. Accept one of your invitations below, or create your own organization."
            : `The apps open in an organization. Create one, or ask someone to invite ${session.user.email}.`}
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex-wrap gap-2">
        <a className={buttonVariants()} href="/orgs/new">
          <Plus />
          Create an organization
        </a>
        {invitations.length ? (
          <a className={buttonVariants({ variant: "outline" })} href="#invitations">
            See your invitations
          </a>
        ) : null}
      </CardFooter>
    </Card>
  )
}

/**
 * `apps`: the apps the user can use in the active organization (all of them with an organization role); the others
 * aren't listed. The organizations themselves are in the top bar's switcher, with "Create an organization".
 */
export function homePage(ctx: Context, session: Session, memberships: MembershipRow[], invitations: InvitationRow[], grants: Map<string, InvitationGrantRow[]>, active: ActiveOrg | null, apps: HostedApp[]): Html {
  const message = HOME_NOTICES[ctx.url.searchParams.get("notice") ?? ""]
  return page(ctx, { title: "Your apps", user: { ...accountOf(session, memberships), org: active } }, (
    <Container className="flex flex-col gap-8 py-10 sm:py-12">
      <PageHeader
        title={active ? `Apps in ${active.name}` : "Your apps"}
        description={active ? "Each app opens in this organization. Switch organizations from the top bar." : undefined}
      />
      {message ? <Notice kind="ok">{message}</Notice> : null}
      {active ? (
        apps.length ? (
          <AppCards ctx={ctx} apps={apps} level={2} />
        ) : (
          <p className="text-muted-foreground">You don&apos;t have access to any app in this organization yet. Ask one of its owners or admins.</p>
        )
      ) : (
        <NoOrgCard session={session} invitations={invitations} />
      )}
      <InvitationList ctx={ctx} invitations={invitations} grants={grants} returnTo={null} />
    </Container>
  ))
}

/** Open invitations for the signed-in user's address, with accept and decline buttons. */
export function InvitationList({ ctx, invitations, grants, returnTo }: { ctx: Context; invitations: InvitationRow[]; grants: Map<string, InvitationGrantRow[]>; returnTo: string | null }) {
  if (!invitations.length) return null
  return (
    <Card id="invitations">
      <CardHeader>
        <CardTitle>
          <h2>Invitations</h2>
        </CardTitle>
        <CardDescription>Accept one to join that organization with the access it offers.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y rounded-lg border">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm">
                <strong>{invitation.org_name}</strong>: {invitation.inviter_name ?? "A member"} invited you{" "}
                {accessPhrase(ctx.config, invitation.role, grants.get(invitation.id) ?? [])}.
              </p>
              <div className="flex shrink-0 gap-2">
                <PostButton action={`/invitations/${invitation.id}/accept`} fields={returnTo ? { return_to: returnTo } : {}} size="sm">
                  Accept
                </PostButton>
                <PostButton action={`/invitations/${invitation.id}/decline`} variant="outline" size="sm">
                  Decline
                </PostButton>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
