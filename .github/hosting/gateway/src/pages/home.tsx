// The apex landing page and the signed-in home page on the auth host.
import { ArrowRight, Building2, ChartPie, LayoutGrid, Plus, ShieldCheck, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { GitHubMark } from "@/components/brand"
import { ContactLink } from "@/components/contact"
import { Notice, PostButton } from "@/components/forms"
import { Container, PageHeader, SectionTitle, proseLinks } from "@/components/layout"
import { initials } from "@/components/site-header"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import { apexUrl, appUrl, authUrl, withReturnTo } from "../context.ts"
import type { InvitationRow } from "../db/invitations.ts"
import type { MembershipRow } from "../db/orgs.ts"
import { ROLE_LABELS } from "../roles.ts"
import type { ActiveOrg, Session } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { accountOf, page } from "./document.tsx"

/** Each app's icon on its card, by directory name; apps without one get a generic icon. */
const APP_ICONS: Record<string, LucideIcon> = {
  captable: ChartPie,
}

function AppCards({ ctx, apps }: { ctx: Context; apps: HostedApp[] }) {
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
              <CardTitle className="text-base">
                <h3>{app.title}</h3>
              </CardTitle>
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
    text: "Give each person a role: Owner, Admin, Editor, User or Viewer. Their role in the organization is their role in each app.",
  },
  {
    icon: GitHubMark,
    title: "Open source on Cloudflare",
    text: "Each app runs on Cloudflare's network with its own database, and its source code is public under the MIT License.",
  },
]

function SignedInCard({ ctx, session, active }: { ctx: Context; session: Session; active: ActiveOrg | null }) {
  const user = session.user
  return (
    <Card className="w-full max-w-2xl py-4 text-left">
      <CardContent className="flex flex-col gap-4 px-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar size="lg">
            <AvatarFallback className="bg-primary font-medium text-primary-foreground" aria-hidden="true">
              {initials(user.name, user.email)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 text-sm">
            <p>
              Signed in as <strong>{user.name}</strong>
              {active ? (
                <>
                  , working in <strong>{active.name}</strong> as {ROLE_LABELS[active.role]}
                </>
              ) : null}
              .
            </p>
            <p className="truncate text-muted-foreground">{user.email}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {active ? (
            <>
              <a className={buttonVariants({ variant: "outline", size: "sm" })} href={authUrl(ctx, "/")}>
                Switch organization
              </a>
              <a className={buttonVariants({ size: "sm" })} href={authUrl(ctx, `/orgs/${active.id}`)}>
                Manage members
              </a>
            </>
          ) : (
            <a className={buttonVariants({ size: "sm" })} href={authUrl(ctx, "/orgs/new")}>
              Create an organization
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function landingPage(ctx: Context, session: Session | null, active: ActiveOrg | null, orgs?: MembershipRow[]): Html {
  const account = session ? { ...accountOf(session, orgs), org: active } : null
  const signup = authUrl(ctx, withReturnTo("/signup", apexUrl(ctx)))
  const login = authUrl(ctx, withReturnTo("/login", apexUrl(ctx)))
  return page(ctx, { title: "Open-source apps, hosted", user: account }, (
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
            with a role that works in every app.
          </p>
          {session ? (
            <SignedInCard ctx={ctx} session={session} active={active} />
          ) : (
            <div className="flex flex-wrap justify-center gap-3">
              <a className={buttonVariants({ size: "lg" })} href={signup}>
                Create an account
                <ArrowRight />
              </a>
              <a className={buttonVariants({ variant: "outline", size: "lg" })} href={login}>
                Sign in
              </a>
            </div>
          )}
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
  "password-set": "Your new password is saved, and every other session is signed out.",
  verified: "Your email address is confirmed.",
}

export function homePage(ctx: Context, session: Session, memberships: MembershipRow[], invitations: InvitationRow[], active: ActiveOrg | null): Html {
  const message = HOME_NOTICES[ctx.url.searchParams.get("notice") ?? ""]
  return page(ctx, { title: "Your organizations", user: { ...accountOf(session, memberships), org: active } }, (
    <Container className="flex flex-col gap-8 py-10 sm:py-12">
      <PageHeader
        title={`Welcome, ${session.user.name}`}
        description="Your organizations, your invitations and the apps."
        actions={
          <a className={buttonVariants()} href="/orgs/new">
            <Plus />
            Create an organization
          </a>
        }
      />
      {message ? <Notice kind="ok">{message}</Notice> : null}
      <InvitationList invitations={invitations} returnTo={null} />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Your organizations</h2>
          </CardTitle>
          <CardDescription>
            {memberships.length
              ? "Apps open in your active organization. You can also switch from the account bar inside an app."
              : "You're not in an organization yet. Create one to start using the apps, or accept an invitation."}
          </CardDescription>
        </CardHeader>
        {memberships.length ? (
          <CardContent>
            <Table>
              <TableCaption className="sr-only">Organizations you belong to</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Organization</TableHead>
                  <TableHead scope="col" className="max-sm:hidden">
                    Your role
                  </TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberships.map((membership) => {
                  const isActive = active?.id === membership.org_id
                  return (
                    <TableRow key={membership.org_id}>
                      <TableCell className="whitespace-normal">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <a
                            className="font-medium underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground"
                            href={`/orgs/${membership.org_id}`}
                          >
                            {membership.org_name}
                          </a>
                          {isActive ? <Badge variant="secondary">Active</Badge> : null}
                          {/* On a phone the role sits here, and its column is hidden. */}
                          <Badge variant="outline" className="sm:hidden">
                            {ROLE_LABELS[membership.role]}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="max-sm:hidden">
                        <Badge variant="outline">{ROLE_LABELS[membership.role]}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {isActive ? null : (
                          <PostButton action="/orgs/switch" fields={{ org_id: membership.org_id }} variant="outline" size="sm">
                            Make active
                          </PostButton>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        ) : null}
      </Card>
      <section className="flex flex-col gap-4">
        <SectionTitle>Apps</SectionTitle>
        <AppCards ctx={ctx} apps={ctx.config.apps} />
      </section>
    </Container>
  ))
}

/** Open invitations for the signed-in user's address, with accept and decline buttons. */
export function InvitationList({ invitations, returnTo }: { invitations: InvitationRow[]; returnTo: string | null }) {
  if (!invitations.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Invitations</h2>
        </CardTitle>
        <CardDescription>Accept one to join that organization with the role it offers.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y rounded-lg border">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm">
                <strong>{invitation.org_name}</strong>: {invitation.inviter_name ?? "A member"} invited you as{" "}
                {ROLE_LABELS[invitation.role]}.
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
