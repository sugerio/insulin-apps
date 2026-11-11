// An app's settings pages, on the apex at /apps/<app>/settings/... (DESIGN.md §3, §5, §6): the app's people, and its
// integrations (integrations.tsx), API access (api-access.tsx) and Connect AI (connect-ai.tsx). Every form posts to the
// apex, with the organization's id. They are never served on the app's own host, where code the app serves could read
// them and post their forms.
import type { ReactNode } from "react"
import { ArrowUpRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ErrorSummary, Notice, PostButton, SelectField, TextField } from "@/components/forms"
import { Container, PageHeader } from "@/components/layout"
import { cn } from "@/lib/utils"
import type { AppAccess } from "../access.ts"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import { apexUrl, appSettingsPath, type AppSettingsTab } from "../context.ts"
import type { CustomRoleRow, GrantRow } from "../db/grants.ts"
import type { InvitationGrantRow, InvitationRow } from "../db/invitations.ts"
import type { MemberRow, MembershipRow } from "../db/orgs.ts"
import { appShell, type ShellData, type ShellModel } from "../navigation.ts"
import { accessSummary, grantChoices, grantLabel, grantValue } from "../orgs/access-forms.ts"
import { APP_ROLE_LABELS, ROLE_LABELS, appRoleOf, canHandleInvitation, canManageMembers, type Role } from "../roles.ts"
import type { Session } from "../auth/session.ts"
import type { Html } from "./html.ts"
import { page } from "./document.tsx"

const DAY_MS = 24 * 60 * 60 * 1000
const destructiveGhost = "text-destructive hover:bg-destructive/10 hover:text-destructive"

export type { AppSettingsTab }

export interface AppFrame {
  orgId: string
  orgName: string
  orgRole: Role
  access: AppAccess
  notice?: string | null
  error?: string | null
}

/**
 * The navigation of an app's settings page (DESIGN.md §3.2): the app's own level 1, as the person's role in it shows
 * it, with Settings open, so the page reads as part of the app though it is served on the apex.
 */
export function appSettingsShell(ctx: Context, session: Session, app: HostedApp, data: AppFrame, orgs: readonly MembershipRow[], tab: AppSettingsTab): ShellModel {
  const shell: ShellData = { orgs, org: { id: data.orgId, name: data.orgName, role: data.orgRole }, apps: [] }
  return appShell(ctx, session, shell, app, data.access.role, tab)
}

/**
 * The heading and the page's notice or problem. The settings pages themselves (People, Integrations, API access,
 * Connect AI) are the navigation's level 2, and the app's own pages its level 1.
 */
export function AppSettingsFrame({ ctx, app, data, children }: { ctx: Context; app: HostedApp; data: AppFrame; children: ReactNode }) {
  return (
    <Container className="flex flex-col gap-6 py-10 sm:py-12">
      {/* Beside both navigation levels the content is narrower than a phone's at 768px, and 768px only from xl, so the
          header stacks below xl and the link to everyone wraps: a long organization name can't widen the page. */}
      <PageHeader
        className="sm:flex-col sm:items-start xl:flex-row xl:items-end"
        title={`${app.title} settings`}
        description={
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              In <strong>{data.orgName}</strong>. Your role in {app.title}: <strong>{data.access.label}</strong>
            </span>
            {data.access.source === "org" ? <Badge variant="secondary">From your organization role</Badge> : null}
          </p>
        }
        actions={
          canManageMembers(data.orgRole) ? (
            <a className={cn(buttonVariants({ variant: "outline" }), "h-auto min-h-9 max-w-full py-1.5 whitespace-normal xl:max-w-sm")} href={apexUrl(ctx, `/settings/users?org=${data.orgId}`)}>
              Everyone in {data.orgName}
              <ArrowUpRight />
            </a>
          ) : null
        }
      />
      {data.notice ? <Notice kind="ok">{data.notice}</Notice> : null}
      <ErrorSummary errors={[data.error]} />
      {children}
    </Container>
  )
}

export interface AppUsersData extends AppFrame {
  members: MemberRow[]
  /** This app's grants. */
  grants: GrantRow[]
  /** This app's custom roles. */
  customRoles: CustomRoleRow[]
  invitations: InvitationRow[]
  invitationGrants: Map<string, InvitationGrantRow[]>
}

function expiry(ctx: Context, expiresAt: number): string {
  if (expiresAt <= ctx.now) return "Expired"
  const days = Math.ceil((expiresAt - ctx.now) / DAY_MS)
  return days <= 1 ? "Expires within a day" : `Expires in ${days} days`
}

function Person({ member, self }: { member: MemberRow; self: boolean }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
        {member.name}
        {self ? <Badge variant="secondary">You</Badge> : null}
      </div>
      <div className="text-xs text-muted-foreground">{member.email}</div>
    </>
  )
}

/** People whose access comes from their organization role: shown, managed on the apex. */
function InheritedCard({ app, data, session }: { app: HostedApp; data: AppUsersData; session: Session }) {
  const inherited = data.members.filter((member) => member.role !== "APPS")
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>From the organization</h2>
        </CardTitle>
        <CardDescription>
          Their organization role gives them this role in every app, {app.title} included. Owners and admins of {data.orgName} change it in the
          organization&apos;s settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableCaption className="sr-only">People with access to {app.title} through their organization role</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Role in {app.title}</TableHead>
              <TableHead scope="col" className="max-sm:hidden">
                Organization role
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inherited.map((member) => {
              const appRole = appRoleOf(member.role)
              return (
                <TableRow key={member.user_id}>
                  <TableCell className="whitespace-normal">
                    <Person member={member} self={member.user_id === session.user.id} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{appRole ? APP_ROLE_LABELS[appRole] : "None"}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground max-sm:hidden">{ROLE_LABELS[member.role]}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/** People given this app: their role here, and for the app's admins, changing it or taking the app away. */
function GranteesCard({ app, data, session }: { app: HostedApp; data: AppUsersData; session: Session }) {
  const admin = data.access.admin
  const grantees = data.grants
    .map((grant) => ({ grant, member: data.members.find((member) => member.user_id === grant.user_id) }))
    .filter((entry): entry is { grant: GrantRow; member: MemberRow } => Boolean(entry.member))
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>With access to {app.title}</h2>
        </CardTitle>
        <CardDescription>
          {grantees.length
            ? `People given ${app.title} specifically. Taking away someone's last app removes them from ${data.orgName}.`
            : `Nobody has been given ${app.title} specifically yet.`}
        </CardDescription>
      </CardHeader>
      {grantees.length ? (
        <CardContent>
          <Table>
            <TableCaption className="sr-only">People given {app.title}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Role in {app.title}</TableHead>
                {admin ? (
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {grantees.map(({ grant, member }) => {
                const id = `role-${member.user_id}`
                return (
                  <TableRow key={member.user_id}>
                    <TableCell className="whitespace-normal">
                      <Person member={member} self={member.user_id === session.user.id} />
                    </TableCell>
                    <TableCell>
                      {admin ? (
                        <form method="post" action={appSettingsPath(app, "users", `/${member.user_id}/role`)} className="flex items-center gap-2">
                          <input type="hidden" name="org_id" defaultValue={data.orgId} />
                          <label className="sr-only" htmlFor={id}>
                            Role in {app.title} for {member.name}
                          </label>
                          <NativeSelect id={id} name="role" size="sm" defaultValue={grantValue(grant)} className="min-w-32">
                            {grantChoices(app, data.customRoles, false).map((choice) => (
                              <NativeSelectOption key={choice.value} value={choice.value}>
                                {choice.label}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                          <Button type="submit" variant="outline" size="sm">
                            Change
                          </Button>
                        </form>
                      ) : (
                        <Badge variant="outline">{grantLabel(grant)}</Badge>
                      )}
                    </TableCell>
                    {admin ? (
                      <TableCell className="text-right">
                        <PostButton action={appSettingsPath(app, "users", `/${member.user_id}/remove`)} fields={{ org_id: data.orgId }} variant="ghost" size="sm" className={destructiveGhost}>
                          Remove<span className="sr-only"> {member.name} from {app.title}</span>
                        </PostButton>
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

function AppInvitations({ ctx, app, data }: { ctx: Context; app: HostedApp; data: AppUsersData }) {
  const mayHandle = (invitation: InvitationRow) => {
    if (canHandleInvitation(data.orgRole, invitation.role)) return true
    const grants = data.invitationGrants.get(invitation.id) ?? []
    return invitation.role === "APPS" && grants.length > 0 && grants.every((grant) => grant.app === app.name)
  }
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Invite people to {app.title}</h2>
          </CardTitle>
          <CardDescription>
            They get {app.title} only, with the role you choose. Someone who already has specific apps in {data.orgName} gets {app.title} at once;
            someone new gets an email with a link, valid for 7 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Three columns only from xl, for the same reason as the header. */}
          <form method="post" action={appSettingsPath(app, "users", "/invite")} className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_13rem_auto] xl:items-end">
            <input type="hidden" name="org_id" defaultValue={data.orgId} />
            <TextField label="Email address" name="email" type="email" autoComplete="off" maxLength={254} />
            <SelectField label={`Role in ${app.title}`} name="role" choices={grantChoices(app, data.customRoles, false)} selected="VIEWER" />
            <Button type="submit">Invite</Button>
          </form>
        </CardContent>
      </Card>
      {data.invitations.length ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Pending invitations</h2>
            </CardTitle>
            <CardDescription>Invitations that would give {app.title}, from here or from the organization&apos;s settings.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableCaption className="sr-only">Pending invitations that give {app.title}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Email</TableHead>
                  <TableHead scope="col">Access</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>
                      <div className="font-medium">{invitation.email}</div>
                      <div className="text-xs text-muted-foreground">{expiry(ctx, invitation.expires_at)}</div>
                    </TableCell>
                    <TableCell className="whitespace-normal">{accessSummary(ctx.config, invitation.role, data.invitationGrants.get(invitation.id) ?? [])}</TableCell>
                    <TableCell>
                      {mayHandle(invitation) ? (
                        <div className="flex items-center justify-end gap-2">
                          <PostButton action={appSettingsPath(app, "users", `/invitations/${invitation.id}/resend`)} fields={{ org_id: data.orgId }} variant="outline" size="sm">
                            Resend<span className="sr-only"> to {invitation.email}</span>
                          </PostButton>
                          <PostButton action={appSettingsPath(app, "users", `/invitations/${invitation.id}/revoke`)} fields={{ org_id: data.orgId }} variant="ghost" size="sm" className={destructiveGhost}>
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
        </Card>
      ) : null}
    </>
  )
}

export function appUsersPage(ctx: Context, session: Session, app: HostedApp, data: AppUsersData, orgs: readonly MembershipRow[]): Html {
  return page(ctx, { title: `People · ${app.title}`, shell: appSettingsShell(ctx, session, app, data, orgs, "users") }, (
    <AppSettingsFrame ctx={ctx} app={app} data={data}>
      {data.access.admin ? null : (
        <Notice>Only {app.title}&apos;s admins invite people and change their roles here. You can see who uses it.</Notice>
      )}
      <GranteesCard app={app} data={data} session={session} />
      <InheritedCard app={app} data={data} session={session} />
      {data.access.admin ? <AppInvitations ctx={ctx} app={app} data={data} /> : null}
    </AppSettingsFrame>
  ))
}
