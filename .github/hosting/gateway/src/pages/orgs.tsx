// Organization pages: create, overview with members and invitations (what each role may see and do), invitations.
import { ArrowLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ErrorSummary, Hidden, Notice, PostButton, SelectField, TextField, type Choice } from "@/components/forms"
import { AuthCard, Container, PageHeader } from "@/components/layout"
import type { Context } from "../context.ts"
import { authUrl, withReturnTo } from "../context.ts"
import type { InvitationRow } from "../db/invitations.ts"
import type { MemberRow, MembershipRow } from "../db/orgs.ts"
import {
  ROLE_LABELS, canChangeRole, canDeleteOrg, canHandleInvitation, canManageMembers, canRemoveMember, canRenameOrg,
  grantableRoles, type Role,
} from "../roles.ts"
import type { Session } from "../auth/session.ts"
import { ORG_NAME_MAX } from "../validate.ts"
import type { Html } from "./html.ts"
import { accountOf, page } from "./document.tsx"
import { InvitationList } from "./home.tsx"

const DAY_MS = 24 * 60 * 60 * 1000

function roleChoices(roles: Role[]): Choice[] {
  return roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))
}

function expiry(ctx: Context, expiresAt: number): string {
  if (expiresAt <= ctx.now) return "Expired"
  const days = Math.ceil((expiresAt - ctx.now) / DAY_MS)
  return days <= 1 ? "Expires within a day" : `Expires in ${days} days`
}

export function newOrgPage(ctx: Context, session: Session, invitations: InvitationRow[], state: { name?: string; error?: string | null; returnTo?: string | null } = {}): Html {
  return page(ctx, { title: "Create an organization", user: accountOf(session) }, (
    <Container width="prose" className="flex flex-col gap-8 py-10 sm:py-12">
      <PageHeader
        title="Create an organization"
        description="An organization is a shared workspace: one organization spans every app, and each member's role applies in all of them. You'll be its owner."
      />
      <ErrorSummary errors={[state.error]} />
      <InvitationList invitations={invitations} returnTo={state.returnTo ?? null} />
      <Card>
        {invitations.length ? (
          <CardHeader>
            <CardTitle>
              <h2>Or start your own</h2>
            </CardTitle>
          </CardHeader>
        ) : null}
        <CardContent>
          <form method="post" action="/orgs/new" className="flex flex-col gap-6">
            <TextField label="Organization name" name="name" value={state.name} maxLength={ORG_NAME_MAX} autoComplete="organization" error={state.error} />
            <Hidden name="return_to" value={state.returnTo} />
            <div>
              <Button type="submit">Create organization</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </Container>
  ))
}

export interface OrgPageData {
  orgId: string
  orgName: string
  role: Role
  active: boolean
  members: MemberRow[] | null
  invitations: InvitationRow[] | null
  ownerCount: number
  notice?: string | null
  error?: string | null
}

/** The member's role: a role picker for those who may change it, else a badge. */
function MemberRole({ data, member }: { data: OrgPageData; member: MemberRow }) {
  if (!canChangeRole(data.role, member.role, member.role)) return <Badge variant="outline">{ROLE_LABELS[member.role]}</Badge>
  const id = `role-${member.user_id}`
  return (
    <form method="post" action={`/orgs/${data.orgId}/members/${member.user_id}/role`} className="flex items-center gap-2">
      <label className="sr-only" htmlFor={id}>
        Role for {member.name}
      </label>
      <NativeSelect id={id} name="role" size="sm" defaultValue={member.role} className="min-w-28">
        {roleChoices(grantableRoles(data.role)).map((choice) => (
          <NativeSelectOption key={choice.value} value={choice.value}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button type="submit" variant="outline" size="sm">
        Change
      </Button>
    </form>
  )
}

function MembersCard({ data, session }: { data: OrgPageData; session: Session }) {
  const manage = canManageMembers(data.role)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Members</h2>
        </CardTitle>
        <CardDescription>
          {data.members
            ? `${data.members.length} ${data.members.length === 1 ? "member" : "members"}. Each member's role applies in every app.`
            : "Only editors, admins and owners can see the member list."}
        </CardDescription>
      </CardHeader>
      {data.members ? (
        <CardContent>
          <Table>
            <TableCaption className="sr-only">Members of {data.orgName}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col" className="max-md:hidden">
                  Email
                </TableHead>
                <TableHead scope="col">Role</TableHead>
                {manage ? (
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((member) => {
                const self = member.user_id === session.user.id
                return (
                  <TableRow key={member.user_id}>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                        {member.name}
                        {self ? <Badge variant="secondary">You</Badge> : null}
                      </div>
                      {/* Narrower screens show the address here, and its column is hidden. */}
                      <div className="text-xs text-muted-foreground md:hidden">{member.email}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-md:hidden">{member.email}</TableCell>
                    <TableCell>
                      <MemberRole data={data} member={member} />
                    </TableCell>
                    {manage ? (
                      <TableCell className="text-right">
                        {!self && canRemoveMember(data.role, member.role) ? (
                          <PostButton
                            action={`/orgs/${data.orgId}/members/${member.user_id}/remove`}
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            Remove<span className="sr-only"> {member.name}</span>
                          </PostButton>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      ) : null}
    </Card>
  )
}

function InvitationsCards({ ctx, data, invitations }: { ctx: Context; data: OrgPageData; invitations: InvitationRow[] }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Invite people</h2>
          </CardTitle>
          <CardDescription>We email them a link to join with the role you choose. An invitation is valid for 7 days.</CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" action={`/orgs/${data.orgId}/invitations`} className="grid gap-4 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
            <TextField label="Email address" name="email" type="email" autoComplete="off" maxLength={254} />
            <SelectField label="Role" name="role" choices={roleChoices(grantableRoles(data.role))} selected="USER" />
            <Button type="submit">Send invitation</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Pending invitations</h2>
          </CardTitle>
          {invitations.length ? null : <CardDescription>No pending invitations.</CardDescription>}
        </CardHeader>
        {invitations.length ? (
          <CardContent>
            <Table>
              <TableCaption className="sr-only">Pending invitations</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Email</TableHead>
                  <TableHead scope="col">Role</TableHead>
                  <TableHead scope="col" className="max-sm:hidden">
                    Status
                  </TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>
                      <div className="font-medium">{invitation.email}</div>
                      <div className="text-xs text-muted-foreground sm:hidden">{expiry(ctx, invitation.expires_at)}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{ROLE_LABELS[invitation.role]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-sm:hidden">{expiry(ctx, invitation.expires_at)}</TableCell>
                    <TableCell>
                      {canHandleInvitation(data.role, invitation.role) ? (
                        <div className="flex items-center justify-end gap-2">
                          <PostButton action={`/orgs/${data.orgId}/invitations/${invitation.id}/resend`} variant="outline" size="sm">
                            Resend<span className="sr-only"> to {invitation.email}</span>
                          </PostButton>
                          <PostButton
                            action={`/orgs/${data.orgId}/invitations/${invitation.id}/revoke`}
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            Revoke<span className="sr-only"> for {invitation.email}</span>
                          </PostButton>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        ) : null}
      </Card>
    </>
  )
}

export function orgPage(ctx: Context, session: Session, data: OrgPageData, orgs?: readonly MembershipRow[]): Html {
  const lastOwner = data.role === "OWNER" && data.ownerCount <= 1
  return page(ctx, { title: data.orgName, user: accountOf(session, orgs) }, (
    <Container className="flex flex-col gap-6 py-10 sm:py-12">
      <a
        href="/"
        className="-mb-2 inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeft className="size-4" />
        All your organizations
      </a>
      <PageHeader
        title={data.orgName}
        description={
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              Your role: <strong>{ROLE_LABELS[data.role]}</strong>
            </span>
            {data.active ? <Badge variant="secondary">Active organization</Badge> : null}
          </p>
        }
        actions={
          data.active ? null : (
            <PostButton
              action="/orgs/switch"
              fields={{ org_id: data.orgId, return_to: authUrl(ctx, `/orgs/${data.orgId}`) }}
              variant="outline"
            >
              Make this my active organization
            </PostButton>
          )
        }
      />
      {data.notice ? <Notice kind="ok">{data.notice}</Notice> : null}
      <ErrorSummary errors={[data.error]} />
      <MembersCard data={data} session={session} />
      {data.invitations ? <InvitationsCards ctx={ctx} data={data} invitations={data.invitations} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Leave</h2>
          </CardTitle>
          <CardDescription>
            {lastOwner
              ? `You're the only owner, so you can't leave. Make another member an owner first${canDeleteOrg(data.role) ? ", or delete the organization" : ""}.`
              : "You lose access to this organization in every app. A member who manages it can invite you again."}
          </CardDescription>
        </CardHeader>
        {lastOwner ? null : (
          <CardFooter>
            <PostButton action={`/orgs/${data.orgId}/leave`} variant="outline">
              Leave this organization
            </PostButton>
          </CardFooter>
        )}
      </Card>
      {canRenameOrg(data.role) ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Settings</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form method="post" action={`/orgs/${data.orgId}/rename`} className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="flex-1">
                <TextField label="Organization name" name="name" value={data.orgName} maxLength={ORG_NAME_MAX} />
              </div>
              <Button type="submit" variant="outline">
                Rename
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {canDeleteOrg(data.role) ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">
              <h2>Danger zone</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="font-medium">
                <h3>Delete this organization</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                This removes the organization, its members and its invitations from Insulin Apps sign-in. Apps keep the data they
                stored for it, but nobody can reach that data again, because this organization&apos;s id is never issued again. This
                can&apos;t be undone.
              </p>
            </div>
            <form method="post" action={`/orgs/${data.orgId}/delete`} className="flex flex-col gap-4">
              <TextField
                label="Type the organization name to confirm"
                name="confirm"
                autoComplete="off"
                hint={
                  <>
                    Enter <strong className="font-medium text-foreground">{data.orgName}</strong> exactly as shown.
                  </>
                }
              />
              <div>
                <Button type="submit" variant="destructive">
                  Delete organization
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </Container>
  ))
}

export type InvitationView = "signed-out" | "mismatch" | "open" | "closed"

function InvitationSummary({ invitation }: { invitation: InvitationRow }) {
  return (
    <p className="text-sm">
      <strong>{invitation.inviter_name ?? "A member"}</strong> invited <strong>{invitation.email}</strong> to join{" "}
      <strong>{invitation.org_name}</strong> as {ROLE_LABELS[invitation.role]}.
    </p>
  )
}

export function invitationPage(ctx: Context, session: Session | null, invitation: InvitationRow | null, view: InvitationView, error: string | null = null): Html {
  const user = session ? accountOf(session) : null
  if (!invitation || view === "closed") {
    return page(ctx, { title: "Invitation", user }, (
      <AuthCard
        title="This invitation is no longer valid"
        description="It may have expired, been revoked, or already been answered. Ask the person who invited you to send a new one."
      >
        <a className={cn(buttonVariants({ variant: "outline" }), "w-full")} href="/">
          Go to your organizations
        </a>
      </AuthCard>
    ))
  }
  const self = `/invitations/${invitation.id}`
  if (view === "signed-out") {
    const back = authUrl(ctx, self)
    return page(ctx, { title: "Invitation", user: null }, (
      <AuthCard title="You're invited">
        <InvitationSummary invitation={invitation} />
        <p className="text-sm text-muted-foreground">To accept, sign in or create an account with that email address.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <a className={cn(buttonVariants(), "sm:flex-1")} href={withReturnTo(`/signup?email=${encodeURIComponent(invitation.email)}`, back)}>
            Create an account
          </a>
          <a className={cn(buttonVariants({ variant: "outline" }), "sm:flex-1")} href={withReturnTo(`/login?email=${encodeURIComponent(invitation.email)}`, back)}>
            Sign in
          </a>
        </div>
      </AuthCard>
    ))
  }
  if (view === "mismatch") {
    return page(ctx, { title: "Invitation", user }, (
      <AuthCard title="This invitation is for another email address">
        <InvitationSummary invitation={invitation} />
        <p className="text-sm text-muted-foreground">
          You&apos;re signed in as <strong className="text-foreground">{session!.user.email}</strong>. Sign out, then sign in or create
          an account with <strong className="text-foreground">{invitation.email}</strong> to accept it.
        </p>
        <form method="post" action="/logout">
          <Button type="submit" variant="outline" className="w-full">
            Sign out
          </Button>
        </form>
      </AuthCard>
    ))
  }
  return page(ctx, { title: "Invitation", user }, (
    <AuthCard title="You're invited">
      <ErrorSummary errors={[error]} />
      <InvitationSummary invitation={invitation} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <PostButton action={`${self}/accept`} className="w-full" formClassName="sm:flex-1">
          Accept invitation
        </PostButton>
        <PostButton action={`${self}/decline`} variant="outline" className="w-full" formClassName="sm:flex-1">
          Decline
        </PostButton>
      </div>
    </AuthCard>
  ))
}
