// The organization's settings on the apex (DESIGN.md §3): /settings/users (people, their access, invitations),
// /settings/roles (built-in roles, each app's permissions, custom roles), /settings/organization (name, leave, delete),
// plus creating an organization and answering an invitation.
import type { ReactNode } from "react"
import { ArrowRight, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ErrorSummary, Hidden, Notice, PostButton, SelectField, TextField, type Choice } from "@/components/forms"
import { AuthCard, Container, PageHeader } from "@/components/layout"
import type { HostedApp } from "../config.ts"
import type { Context } from "../context.ts"
import { apexUrl, appUrl, withReturnTo } from "../context.ts"
import type { CustomRoleRow, GrantRow } from "../db/grants.ts"
import type { InvitationGrantRow, InvitationRow } from "../db/invitations.ts"
import type { MemberRow, MembershipRow } from "../db/orgs.ts"
import { accessPhrase, accessSummary, grantChoices, grantField, grantLabel, grantValue } from "../orgs/access-forms.ts"
import {
  APP_ROLES, APP_ROLE_LABELS, APP_ROLE_SUMMARIES, ROLES, ROLE_LABELS, ROLE_SUMMARIES, canChangeRole, canDeleteOrg,
  canHandleInvitation, canManageCustomRoles, canManageMembers, canRemoveMember, canRenameOrg, canSeeMembers,
  grantableRoles, roleHas, type Role,
} from "../roles.ts"
import type { Session } from "../auth/session.ts"
import { ORG_NAME_MAX, ROLE_DESCRIPTION_MAX, ROLE_NAME_MAX } from "../validate.ts"
import type { Html } from "./html.ts"
import { accountOf, page } from "./document.tsx"
import { InvitationList } from "./home.tsx"

const DAY_MS = 24 * 60 * 60 * 1000

export type SettingsTab = "users" | "roles" | "organization"

function roleChoices(roles: Role[]): Choice[] {
  return roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))
}

function expiry(ctx: Context, expiresAt: number): string {
  if (expiresAt <= ctx.now) return "Expired"
  const days = Math.ceil((expiresAt - ctx.now) / DAY_MS)
  return days <= 1 ? "Expires within a day" : `Expires in ${days} days`
}

const destructiveGhost = "text-destructive hover:bg-destructive/10 hover:text-destructive"

interface OrgFrame {
  orgId: string
  orgName: string
  role: Role
  active: boolean
  notice?: string | null
  error?: string | null
}

/** The tabs of the organization's settings; each keeps the organization in `?org=`. */
function SettingsNav({ ctx, data, tab }: { ctx: Context; data: OrgFrame; tab: SettingsTab }) {
  const tabs: { tab: SettingsTab; label: string; path: string; show: boolean }[] = [
    { tab: "users", label: "People", path: "/settings/users", show: true },
    { tab: "roles", label: "Roles", path: "/settings/roles", show: canSeeMembers(data.role) },
    { tab: "organization", label: "Organization", path: "/settings/organization", show: true },
  ]
  return (
    <nav aria-label="Organization settings" className="flex gap-1 border-b">
      {tabs.filter((item) => item.show).map((item) => (
        <a
          key={item.tab}
          href={apexUrl(ctx, `${item.path}?org=${data.orgId}`)}
          aria-current={item.tab === tab ? "page" : undefined}
          className={cn(
            "-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            item.tab === tab ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {item.label}
        </a>
      ))}
    </nav>
  )
}

/** The organization's name, the member's role, whether it is active, the tabs, and the page's notice or problem. */
function SettingsFrame({ ctx, data, tab, children }: { ctx: Context; data: OrgFrame; tab: SettingsTab; children: ReactNode }) {
  return (
    <Container className="flex flex-col gap-6 py-10 sm:py-12">
      <PageHeader
        title={data.orgName}
        description={
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              Your access: <strong>{ROLE_LABELS[data.role]}</strong>
            </span>
            {data.active ? <Badge variant="secondary">Active organization</Badge> : null}
          </p>
        }
        actions={
          data.active ? null : (
            <PostButton action="/orgs/switch" fields={{ org_id: data.orgId, return_to: ctx.url.href }} variant="outline">
              Make this my active organization
            </PostButton>
          )
        }
      />
      <SettingsNav ctx={ctx} data={data} tab={tab} />
      {data.notice ? <Notice kind="ok">{data.notice}</Notice> : null}
      <ErrorSummary errors={[data.error]} />
      {children}
    </Container>
  )
}

export function newOrgPage(ctx: Context, session: Session, invitations: InvitationRow[], grants: Map<string, InvitationGrantRow[]>, state: { name?: string; error?: string | null; returnTo?: string | null } = {}): Html {
  return page(ctx, { title: "Create an organization", user: accountOf(session) }, (
    <Container width="prose" className="flex flex-col gap-8 py-10 sm:py-12">
      <PageHeader
        title="Create an organization"
        description="An organization is a shared workspace across every app. You'll be its owner, and you choose who else gets in: with a role in every app, or in specific apps only."
      />
      <ErrorSummary errors={[state.error]} />
      <InvitationList ctx={ctx} invitations={invitations} grants={grants} returnTo={state.returnTo ?? null} />
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

export interface UsersPageData extends OrgFrame {
  members: MemberRow[] | null
  grants: GrantRow[]
  invitations: InvitationRow[] | null
  invitationGrants: Map<string, InvitationGrantRow[]>
  customRoles: CustomRoleRow[]
  ownerCount: number
  /** The viewer's own grants, when their access is specific apps. */
  myGrants: GrantRow[]
}

/** The app selects of an access form: one per app, "No access" first. Used only with "Specific apps". */
function AppFields({ ctx, idPrefix, customRoles, grants }: { ctx: Context; idPrefix: string; customRoles: CustomRoleRow[]; grants: GrantRow[] }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Apps, for &ldquo;Specific apps&rdquo; access</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        {ctx.config.apps.map((app) => {
          const current = grants.find((grant) => grant.app === app.name)
          return (
            <SelectField
              key={app.name}
              id={`${idPrefix}-${app.name}`}
              label={app.title}
              name={grantField(app)}
              choices={grantChoices(app, customRoles, true)}
              selected={current ? grantValue(current) : ""}
            />
          )
        })}
      </div>
    </fieldset>
  )
}

/** "Change access", a disclosure under the member's row: the access and, for specific apps, a role per app. */
function ChangeAccess({ ctx, data, member, grants }: { ctx: Context; data: UsersPageData; member: MemberRow; grants: GrantRow[] }) {
  if (!canChangeRole(data.role, member.role, member.role)) return null
  return (
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        Change access<span className="sr-only"> for {member.name}</span>
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <form method="post" action={`/orgs/${data.orgId}/members/${member.user_id}/role`} className="mt-3 flex flex-col gap-4">
        <SelectField id={`access-${member.user_id}`} label="Access" name="role" choices={roleChoices(grantableRoles(data.role))} selected={member.role} />
        <AppFields ctx={ctx} idPrefix={`access-${member.user_id}`} customRoles={data.customRoles} grants={grants} />
        <div>
          <Button type="submit" variant="outline" size="sm">
            Save access
          </Button>
        </div>
      </form>
    </details>
  )
}

function MembersCard({ ctx, data, session }: { ctx: Context; data: UsersPageData; session: Session }) {
  const manage = canManageMembers(data.role)
  const members = data.members ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>People</h2>
        </CardTitle>
        <CardDescription>
          {`${members.length} ${members.length === 1 ? "person" : "people"}. An organization role applies in every app; "Specific apps" people have a role in each app they were given.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableCaption className="sr-only">People in {data.orgName}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Access</TableHead>
              {manage ? (
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const self = member.user_id === session.user.id
              const grants = data.grants.filter((grant) => grant.user_id === member.user_id)
              return (
                <TableRow key={member.user_id}>
                  <TableCell className="align-top whitespace-normal">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                      {member.name}
                      {self ? <Badge variant="secondary">You</Badge> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{member.email}</div>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <Badge variant="outline">{ROLE_LABELS[member.role]}</Badge>
                    {member.role === "APPS" ? <p className="mt-1 text-xs text-muted-foreground">{accessSummary(ctx.config, member.role, grants)}</p> : null}
                    {manage ? <ChangeAccess ctx={ctx} data={data} member={member} grants={grants} /> : null}
                  </TableCell>
                  {manage ? (
                    <TableCell className="text-right align-top">
                      {!self && canRemoveMember(data.role, member.role) ? (
                        <PostButton action={`/orgs/${data.orgId}/members/${member.user_id}/remove`} variant="ghost" size="sm" className={destructiveGhost}>
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
    </Card>
  )
}

function InvitationsCards({ ctx, data, invitations }: { ctx: Context; data: UsersPageData; invitations: InvitationRow[] }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Invite people</h2>
          </CardTitle>
          <CardDescription>
            We email them a link to join with the access you choose: an organization role for every app, or specific apps with a role in
            each. An invitation is valid for 7 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" action={`/orgs/${data.orgId}/invitations`} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_13rem]">
              <TextField label="Email address" name="email" type="email" autoComplete="off" maxLength={254} />
              <SelectField id="invite-role" label="Access" name="role" choices={roleChoices(grantableRoles(data.role))} selected="VIEWER" />
            </div>
            <AppFields ctx={ctx} idPrefix="invite" customRoles={data.customRoles} grants={[]} />
            <div>
              <Button type="submit">Send invitation</Button>
            </div>
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
                  <TableHead scope="col">Access</TableHead>
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
                    <TableCell className="whitespace-normal">
                      <Badge variant="outline">{ROLE_LABELS[invitation.role]}</Badge>
                      {invitation.role === "APPS" ? (
                        <p className="mt-1 text-xs text-muted-foreground">{accessSummary(ctx.config, invitation.role, data.invitationGrants.get(invitation.id) ?? [])}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-sm:hidden">{expiry(ctx, invitation.expires_at)}</TableCell>
                    <TableCell>
                      {canHandleInvitation(data.role, invitation.role) ? (
                        <div className="flex items-center justify-end gap-2">
                          <PostButton action={`/orgs/${data.orgId}/invitations/${invitation.id}/resend`} variant="outline" size="sm">
                            Resend<span className="sr-only"> to {invitation.email}</span>
                          </PostButton>
                          <PostButton action={`/orgs/${data.orgId}/invitations/${invitation.id}/revoke`} variant="ghost" size="sm" className={destructiveGhost}>
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

/** What a specific-apps member sees instead of the people list: their apps, each with its own people page. */
function MyAppsCard({ ctx, grants }: { ctx: Context; grants: GrantRow[] }) {
  const apps = grants.map((grant) => ({ grant, app: ctx.config.apps.find((app) => app.name === grant.app) })).filter((entry): entry is { grant: GrantRow; app: HostedApp } => Boolean(entry.app))
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Your apps</h2>
        </CardTitle>
        <CardDescription>
          You have access to specific apps in this organization, so its people list isn&apos;t shown here. Each app lists the people who
          use it under its own settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {apps.length ? (
          <ul className="flex flex-col divide-y rounded-lg border">
            {apps.map(({ grant, app }) => (
              <li key={app.name} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                <span>
                  <strong>{app.title}</strong>: {grantLabel(grant)}
                </span>
                <a className={buttonVariants({ variant: "outline", size: "sm" })} href={appUrl(ctx, app, "/settings/users")}>
                  People in {app.title}
                  <ArrowRight />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">You have no apps here right now.</p>
        )}
      </CardContent>
    </Card>
  )
}

export function usersPage(ctx: Context, session: Session, data: UsersPageData, orgs?: readonly MembershipRow[]): Html {
  return page(ctx, { title: `People · ${data.orgName}`, user: accountOf(session, orgs) }, (
    <SettingsFrame ctx={ctx} data={data} tab="users">
      {data.role === "APPS" ? <MyAppsCard ctx={ctx} grants={data.myGrants} /> : <MembersCard ctx={ctx} data={data} session={session} />}
      {data.invitations ? <InvitationsCards ctx={ctx} data={data} invitations={data.invitations} /> : null}
    </SettingsFrame>
  ))
}

export interface RolesPageData extends OrgFrame {
  customRoles: CustomRoleRow[]
  uses: Map<string, number>
}

function parsePermissions(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []
  } catch {
    return []
  }
}

/** The permission checkboxes of a custom-role form, for one app. */
function PermissionFields({ app, idPrefix, checked }: { app: HostedApp; idPrefix: string; checked: string[] }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">Permissions</legend>
      {app.permissions.map((permission) => {
        const id = `${idPrefix}-${permission.key}`
        return (
          <div key={permission.key} className="flex items-start gap-3">
            <input
              id={id}
              type="checkbox"
              name="permission"
              value={permission.key}
              defaultChecked={checked.includes(permission.key)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
              aria-describedby={permission.description ? `${id}-hint` : undefined}
            />
            <label htmlFor={id} className="text-sm">
              <span className="font-medium">{permission.label}</span>
              {permission.description ? (
                <span id={`${id}-hint`} className="block text-muted-foreground">
                  {permission.description}
                </span>
              ) : null}
            </label>
          </div>
        )
      })}
    </fieldset>
  )
}

function RoleTextFields({ idPrefix, role }: { idPrefix: string; role?: CustomRoleRow }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input id={`${idPrefix}-name`} name="name" required maxLength={ROLE_NAME_MAX} defaultValue={role?.name} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-description`}>Description (optional)</Label>
        <Input id={`${idPrefix}-description`} name="description" maxLength={ROLE_DESCRIPTION_MAX} defaultValue={role?.description} />
      </div>
    </div>
  )
}

/** One app: who has each permission by built-in role, its custom roles, and (for owners) the forms. */
function AppRolesCard({ data, app }: { data: RolesPageData; app: HostedApp }) {
  const owner = canManageCustomRoles(data.role)
  const roles = data.customRoles.filter((role) => role.app === app.name)
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{app.title}</h2>
        </CardTitle>
        <CardDescription>The permissions {app.title} defines, which roles have them, and this organization&apos;s custom roles for it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Table>
          <TableCaption className="sr-only">Permissions in {app.title} by role</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Permission</TableHead>
              {APP_ROLES.map((role) => (
                <TableHead key={role} scope="col" className="text-center">
                  {APP_ROLE_LABELS[role]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {app.permissions.map((permission) => (
              <TableRow key={permission.key}>
                <TableCell className="whitespace-normal">
                  <div className="font-medium">{permission.label}</div>
                  {permission.description ? <div className="text-xs text-muted-foreground">{permission.description}</div> : null}
                </TableCell>
                {APP_ROLES.map((role) => (
                  <TableCell key={role} className="text-center">
                    {roleHas(role, permission.role) ? "Yes" : <span className="text-muted-foreground">No</span>}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Custom roles</h3>
          {roles.length ? (
            <ul className="flex flex-col divide-y rounded-lg border">
              {roles.map((role) => {
                const keys = parsePermissions(role.permissions)
                const uses = data.uses.get(role.id) ?? 0
                return (
                  <li key={role.id} className="flex flex-col gap-2 p-4 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>{role.name}</strong>
                      <Badge variant="outline">{uses === 1 ? "Used once" : uses ? `Used ${uses} times` : "Not used"}</Badge>
                    </div>
                    {role.description ? <p className="text-muted-foreground">{role.description}</p> : null}
                    <p className="text-muted-foreground">
                      {app.permissions.filter((permission) => keys.includes(permission.key)).map((permission) => permission.label).join(" · ") || "No permissions"}
                    </p>
                    {owner ? (
                      <details className="group">
                        <summary className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
                          Edit<span className="sr-only"> {role.name}</span>
                          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                        </summary>
                        <form method="post" action={`/orgs/${data.orgId}/roles/${role.id}`} className="mt-3 flex flex-col gap-4">
                          <RoleTextFields idPrefix={`role-${role.id}`} role={role} />
                          <PermissionFields app={app} idPrefix={`role-${role.id}`} checked={keys} />
                          <div>
                            <Button type="submit" variant="outline" size="sm">
                              Save role
                            </Button>
                          </div>
                        </form>
                        <PostButton action={`/orgs/${data.orgId}/roles/${role.id}/delete`} variant="ghost" size="sm" className={cn("mt-2", destructiveGhost)} disabled={uses > 0}>
                          Delete<span className="sr-only"> {role.name}</span>
                        </PostButton>
                      </details>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No custom roles for {app.title} yet.</p>
          )}
        </div>
      </CardContent>
      {owner ? (
        <CardFooter className="flex-col items-stretch gap-4 border-t">
          <h3 className="text-sm font-semibold">New custom role for {app.title}</h3>
          <form method="post" action={`/orgs/${data.orgId}/roles`} className="flex flex-col gap-4">
            <input type="hidden" name="app" defaultValue={app.name} />
            <RoleTextFields idPrefix={`new-${app.name}`} />
            <PermissionFields app={app} idPrefix={`new-${app.name}`} checked={[]} />
            <div>
              <Button type="submit">Create role</Button>
            </div>
          </form>
        </CardFooter>
      ) : null}
    </Card>
  )
}

export function rolesPage(ctx: Context, session: Session, data: RolesPageData, orgs?: readonly MembershipRow[]): Html {
  const catalogued = ctx.config.apps.filter((app) => app.permissions.length)
  return page(ctx, { title: `Roles · ${data.orgName}`, user: accountOf(session, orgs) }, (
    <SettingsFrame ctx={ctx} data={data} tab="roles">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Organization roles</h2>
          </CardTitle>
          <CardDescription>Each person has one of these. An organization role applies in every app.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            {ROLES.map((role) => (
              <div key={role} className="rounded-lg border p-4">
                <dt className="font-medium">{ROLE_LABELS[role]}</dt>
                <dd className="text-sm text-muted-foreground">{ROLE_SUMMARIES[role]}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>App roles</h2>
          </CardTitle>
          <CardDescription>
            What someone with &ldquo;Specific apps&rdquo; access can have in each app, besides custom roles. Only owners create custom roles;
            owners and admins, and each app&apos;s admins, give them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3">
            {APP_ROLES.map((role) => (
              <div key={role} className="rounded-lg border p-4">
                <dt className="font-medium">{APP_ROLE_LABELS[role]}</dt>
                <dd className="text-sm text-muted-foreground">{APP_ROLE_SUMMARIES[role]}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      {catalogued.length ? (
        catalogued.map((app) => <AppRolesCard key={app.name} data={data} app={app} />)
      ) : (
        <Notice>No app defines permissions yet, so there are no custom roles to make.</Notice>
      )}
    </SettingsFrame>
  ))
}

export interface OrgSettingsData extends OrgFrame {
  ownerCount: number
}

export function orgSettingsPage(ctx: Context, session: Session, data: OrgSettingsData, orgs?: readonly MembershipRow[]): Html {
  const lastOwner = data.role === "OWNER" && data.ownerCount <= 1
  return page(ctx, { title: `Organization · ${data.orgName}`, user: accountOf(session, orgs) }, (
    <SettingsFrame ctx={ctx} data={data} tab="organization">
      {canRenameOrg(data.role) ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Name</h2>
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
                This removes the organization, its people, roles, invitations and connections from Insulin Apps sign-in. Apps keep the data
                they stored for it, but nobody can reach that data again, because this organization&apos;s id is never issued again. This
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
    </SettingsFrame>
  ))
}

export type InvitationView = "signed-out" | "mismatch" | "open" | "closed"

function InvitationSummary({ ctx, invitation, grants }: { ctx: Context; invitation: InvitationRow; grants: InvitationGrantRow[] }) {
  return (
    <p className="text-sm">
      <strong>{invitation.inviter_name ?? "A member"}</strong> invited <strong>{invitation.email}</strong> to join{" "}
      <strong>{invitation.org_name}</strong> {accessPhrase(ctx.config, invitation.role, grants)}.
    </p>
  )
}

export function invitationPage(ctx: Context, session: Session | null, invitation: InvitationRow | null, grants: InvitationGrantRow[], view: InvitationView, error: string | null = null): Html {
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
    const back = apexUrl(ctx, self)
    return page(ctx, { title: "Invitation", user: null }, (
      <AuthCard title="You're invited">
        <InvitationSummary ctx={ctx} invitation={invitation} grants={grants} />
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
        <InvitationSummary ctx={ctx} invitation={invitation} grants={grants} />
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
      <InvitationSummary ctx={ctx} invitation={invitation} grants={grants} />
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
