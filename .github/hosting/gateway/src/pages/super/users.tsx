// /super/users: every account, searchable by name, address or id, with when it joined and was last active and its
// standing; /super/users/<id>: the same facts, its organizations with its role in each, its history in the audit log
// and, for admins, the standing form. Nothing else of the account is shown (DESIGN.md §11.2).
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ErrorSummary, Notice } from "@/components/forms"
import type { Context } from "../../context.ts"
import { ROLE_LABELS } from "../../roles.ts"
import type { OperatorSession } from "../../super/auth.ts"
import { PAGE_SIZE, type AuditRow, type Status, type UserDetail, type UserListRow, type UserMembershipRow, type UserSort } from "../../super/db.ts"
import { AuditTable } from "./audit.tsx"
import { superPage } from "./layout.tsx"
import { Pagination, SearchForm, Section, SortLink, StandingForm, StatusBadge, ago, count, day, when } from "./parts.tsx"

export interface UserFilters {
  query: string
  status: Status | null
  sort: UserSort
  page: number
}

export function usersPage(ctx: Context, session: OperatorSession, filters: UserFilters, result: { rows: UserListRow[]; total: number }): Response {
  const sortHref = (sort: string) => {
    const params = new URLSearchParams(Object.entries({ q: filters.query, status: filters.status ?? "", sort }).filter(([, value]) => value))
    return `/super/users?${params}`
  }
  return superPage(ctx, session, { title: "People", current: "users", description: "Every account on Insulin Apps. Search by name, address or id." }, (
    <>
      <SearchForm action="/super/users" query={filters.query} status={filters.status} sort={filters.sort} placeholder="Name, someone@example.com, @example.com or an id" />
      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableCaption className="sr-only">People</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead><SortLink label="Name" value="name" current={filters.sort} href={sortHref} /></TableHead>
                <TableHead><SortLink label="Email" value="email" current={filters.sort} href={sortHref} /></TableHead>
                <TableHead className="text-right">Organizations</TableHead>
                <TableHead><SortLink label="Joined" value="created" current={filters.sort} href={sortHref} /></TableHead>
                <TableHead><SortLink label="Last active" value="active" current={filters.sort} href={sortHref} /></TableHead>
                <TableHead>Standing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.length ? result.rows.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="max-w-48 truncate"><a href={`/super/users/${user.id}`} className="font-medium underline-offset-4 hover:underline">{user.name}</a></TableCell>
                  <TableCell className="max-w-64 truncate">
                    {user.email}
                    {user.verified ? null : <span className="ml-2 text-xs text-muted-foreground">(unconfirmed)</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{count(user.orgs)}</TableCell>
                  <TableCell>{day(user.created_at)}</TableCell>
                  <TableCell>{ago(ctx.now, user.last_active_at)}</TableCell>
                  <TableCell><StatusBadge status={user.status} /></TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={6} className="text-muted-foreground">No account matches.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination path="/super/users" params={{ q: filters.query, status: filters.status ?? "", sort: filters.sort }} page={filters.page} total={result.total} pageSize={PAGE_SIZE} />
    </>
  ))
}

export interface UserDetailData {
  user: UserDetail
  memberships: UserMembershipRow[]
  history: AuditRow[]
}

const NOTICES: Record<string, string> = {
  suspended: "The account is suspended.",
  disabled: "The account is disabled, and its sessions and AI agents have ended.",
  active: "The account is reinstated.",
  unchanged: "Nothing changed: the account already had that standing.",
}

export function userDetailPage(ctx: Context, session: OperatorSession, data: UserDetailData, problem?: string, status = 200): Response {
  const { user } = data
  const notice = NOTICES[ctx.url.searchParams.get("notice") ?? ""]
  return superPage(ctx, session, { title: user.name, current: "users", description: user.email, status }, (
    <>
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      <ErrorSummary errors={[problem]} />
      <Section title="About">
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Standing</dt><dd className="flex flex-wrap items-center gap-2"><StatusBadge status={user.status} />{user.status_changed_at ? <span className="text-muted-foreground">since {when(user.status_changed_at)}</span> : null}</dd></div>
          {user.status !== "active" && user.status_reason ? <div><dt className="text-muted-foreground">Reason (operators only)</dt><dd>{user.status_reason}</dd></div> : null}
          <div><dt className="text-muted-foreground">Email</dt><dd>{user.email} {user.verified ? "(confirmed)" : "(unconfirmed)"}</dd></div>
          <div><dt className="text-muted-foreground">Joined</dt><dd>{when(user.created_at)}</dd></div>
          <div><dt className="text-muted-foreground">Last active</dt><dd>{ago(ctx.now, user.last_active_at)}</dd></div>
          <div><dt className="text-muted-foreground">Account id</dt><dd className="font-mono text-xs">{user.id}</dd></div>
        </dl>
      </Section>

      <Section title="Organizations" description={`${count(data.memberships.length)} memberships.`}>
        {data.memberships.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Standing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.memberships.map((membership) => (
                <TableRow key={membership.org_id}>
                  <TableCell className="max-w-64 truncate"><a href={`/super/orgs/${membership.org_id}`} className="font-medium underline-offset-4 hover:underline">{membership.org_name}</a></TableCell>
                  <TableCell>{ROLE_LABELS[membership.role]}</TableCell>
                  <TableCell>{day(membership.joined_at)}</TableCell>
                  <TableCell><StatusBadge status={membership.org_status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">None.</p>
        )}
      </Section>

      {session.admin ? (
        <Section title="Standing" description="Suspending or disabling applies at once: signing in, every session, and the account's AI agents.">
          <StandingForm action={`/super/users/${user.id}/status`} current={user.status} what="account" error={problem} />
        </Section>
      ) : null}

      <Section title="History" description="What operators did to this account.">
        <AuditTable rows={data.history} showTarget={false} />
      </Section>
    </>
  ))
}
