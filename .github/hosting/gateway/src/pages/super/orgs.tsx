// /super/orgs: every organization, searchable by name, id, owner domain or a member's address, with its standing;
// /super/orgs/<id>: its basic facts, its people (name, address, role, joined, last active), its usage (the apps' latest
// reports and 30 days of each, the gateway's own counts), its history in the audit log and, for admins, the standing
// form; /super/orgs/new: an organization for someone past their owner domain's limit (admins).
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ErrorSummary, Notice, TextField } from "@/components/forms"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import type { HostedApp } from "../../config.ts"
import type { Context } from "../../context.ts"
import type { Metrics } from "../../db/metrics.ts"
import { ROLE_LABELS } from "../../roles.ts"
import type { OperatorSession } from "../../super/auth.ts"
import { PAGE_SIZE, type AuditRow, type OrgDetail, type OrgListRow, type OrgMemberRow, type OrgSort, type OrgUsage, type Status } from "../../super/db.ts"
import { AuditTable } from "./audit.tsx"
import { superPage } from "./layout.tsx"
import { Bars, Pagination, SearchForm, Section, SortLink, StandingForm, StatusBadge, ago, count, day, metricLabel, metricValue, when } from "./parts.tsx"

export interface OrgFilters {
  query: string
  status: Status | null
  sort: OrgSort
  page: number
}

function listHref(filters: OrgFilters, sort: string): string {
  const params = new URLSearchParams(Object.entries({ q: filters.query, status: filters.status ?? "", sort }).filter(([, value]) => value))
  return `/super/orgs?${params}`
}

export function orgsPage(ctx: Context, session: OperatorSession, filters: OrgFilters, result: { rows: OrgListRow[]; total: number }): Response {
  const sortHref = (sort: string) => listHref(filters, sort)
  return superPage(ctx, session, {
    title: "Organizations",
    current: "orgs",
    description: "Every organization on Insulin Apps. Search by name, id, owner domain or a member's address.",
    actions: session.admin ? <a className={buttonVariants()} href="/super/orgs/new">Create an organization for someone</a> : undefined,
  }, (
    <>
      <SearchForm action="/super/orgs" query={filters.query} status={filters.status} sort={filters.sort} placeholder="Name, id, example.com or someone@example.com" />
      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableCaption className="sr-only">Organizations</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead><SortLink label="Name" value="name" current={filters.sort} href={sortHref} /></TableHead>
                <TableHead>Owner domain</TableHead>
                <TableHead className="text-right"><SortLink label="People" value="members" current={filters.sort} href={sortHref} /></TableHead>
                <TableHead><SortLink label="Created" value="created" current={filters.sort} href={sortHref} /></TableHead>
                <TableHead><SortLink label="Last active" value="active" current={filters.sort} href={sortHref} /></TableHead>
                <TableHead>Standing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.length ? result.rows.map((org) => (
                <TableRow key={org.id}>
                  <TableCell className="max-w-64 truncate"><a href={`/super/orgs/${org.id}`} className="font-medium underline-offset-4 hover:underline">{org.name}</a></TableCell>
                  <TableCell className="max-w-56 truncate text-muted-foreground">{org.owner_domain ?? "–"}</TableCell>
                  <TableCell className="text-right tabular-nums">{count(org.members)}</TableCell>
                  <TableCell>{day(org.created_at)}</TableCell>
                  <TableCell>{ago(ctx.now, org.last_active_at)}</TableCell>
                  <TableCell><StatusBadge status={org.status} /></TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={6} className="text-muted-foreground">No organization matches.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination path="/super/orgs" params={{ q: filters.query, status: filters.status ?? "", sort: filters.sort }} page={filters.page} total={result.total} pageSize={PAGE_SIZE} />
    </>
  ))
}

export interface OrgAppUsage {
  app: Pick<HostedApp, "name" | "title">
  hour: number
  metrics: Metrics
  days: { day: number; metrics: Metrics }[]
}

export interface OrgDetailData {
  org: OrgDetail
  members: OrgMemberRow[]
  usage: OrgUsage
  apps: OrgAppUsage[]
  history: AuditRow[]
}

const NOTICES: Record<string, string> = {
  suspended: "The organization is suspended.",
  disabled: "The organization is disabled.",
  active: "The organization is reinstated.",
  created: "The organization was created, and its owner was told by e-mail.",
  unchanged: "Nothing changed: the organization already had that standing.",
}

/** One app's 30 days of one metric, as columns. */
function Trend({ usage, metric }: { usage: OrgAppUsage; metric: string }) {
  return <Bars data={usage.days.map((entry) => ({ label: day(entry.day), value: entry.metrics[metric] ?? 0 }))} caption={`${usage.app.title}: ${metricLabel(metric)} per day`} format={(value) => metricValue(metric, value)} />
}

export function orgDetailPage(ctx: Context, session: OperatorSession, data: OrgDetailData, problem?: string, status = 200): Response {
  const { org, usage } = data
  const notice = NOTICES[ctx.url.searchParams.get("notice") ?? ""]
  return superPage(ctx, session, { title: org.name, current: "orgs", description: <span className="font-mono text-xs">{org.id}</span>, status }, (
    <>
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      <ErrorSummary errors={[problem]} />
      <Section title="About">
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Standing</dt><dd className="flex flex-wrap items-center gap-2"><StatusBadge status={org.status} />{org.status_changed_at ? <span className="text-muted-foreground">since {when(org.status_changed_at)}</span> : null}</dd></div>
          {org.status !== "active" && org.status_reason ? <div><dt className="text-muted-foreground">Reason (operators only)</dt><dd>{org.status_reason}</dd></div> : null}
          <div><dt className="text-muted-foreground">Created</dt><dd>{when(org.created_at)}{org.created_by_operator ? `, by ${org.created_by_operator} from the console` : ""}</dd></div>
          <div><dt className="text-muted-foreground">Created by</dt><dd>{org.creator_email ?? "A deleted account"}</dd></div>
          <div><dt className="text-muted-foreground">Last active</dt><dd>{ago(ctx.now, org.last_active_at)}</dd></div>
          <div>
            <dt className="text-muted-foreground">Owner domain</dt>
            <dd>{org.owner_domain ? <><a href={`/super/orgs?q=${encodeURIComponent(org.owner_domain)}`} className="underline underline-offset-4">{org.owner_domain}</a>: {count(org.domain_orgs)} of {count(org.domain_max)} organizations</> : "None"}</dd>
          </div>
        </dl>
      </Section>

      <Section title="People" description={`${count(data.members.length)} members. Their apps' data is theirs: the console shows who they are, not what they do.`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead>Standing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.members.map((member) => (
              <TableRow key={member.user_id}>
                <TableCell className="max-w-48 truncate"><a href={`/super/users/${member.user_id}`} className="font-medium underline-offset-4 hover:underline">{member.name}</a></TableCell>
                <TableCell className="max-w-64 truncate">{member.email}</TableCell>
                <TableCell>{ROLE_LABELS[member.role]}</TableCell>
                <TableCell>{day(member.joined_at)}</TableCell>
                <TableCell>{ago(ctx.now, member.last_active_at)}</TableCell>
                <TableCell><StatusBadge status={member.status} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="Usage" description="The gateway's own counts. Mail is kept for two days.">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
          <div><dt className="text-muted-foreground">Pending invitations</dt><dd className="tabular-nums">{count(usage.invitations)}</dd></div>
          <div><dt className="text-muted-foreground">API clients</dt><dd className="tabular-nums">{count(usage.api_clients)}</dd></div>
          <div><dt className="text-muted-foreground">AI agents</dt><dd className="tabular-nums">{count(usage.agents)}</dd></div>
          <div><dt className="text-muted-foreground">Stored credentials</dt><dd className="tabular-nums">{count(usage.integrations)}</dd></div>
          <div><dt className="text-muted-foreground">Verified domains</dt><dd className="tabular-nums">{count(usage.verified_domains)}</dd></div>
          <div><dt className="text-muted-foreground">Single sign-on</dt><dd>{usage.sso ? usage.sso.toUpperCase() : "Off"}</dd></div>
          <div><dt className="text-muted-foreground">SCIM tokens</dt><dd className="tabular-nums">{count(usage.scim_tokens)}</dd></div>
          <div><dt className="text-muted-foreground">Mail, last 48 hours</dt><dd className="tabular-nums">{count(usage.mail_2d)}</dd></div>
        </dl>
      </Section>

      {data.apps.length ? data.apps.map((entry) => {
        const names = Object.keys(entry.metrics).sort()
        const trend = names.includes("storage_bytes") ? "storage_bytes" : names[0]
        return (
          <Section key={entry.app.name} title={entry.app.title} description={`As the app reported it, ${when(entry.hour)}.`}>
            <div className="flex flex-col gap-6">
              <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
                {names.map((name) => (
                  <div key={name} className="min-w-0 break-words"><dt className="text-muted-foreground">{metricLabel(name)}</dt><dd className="tabular-nums">{metricValue(name, entry.metrics[name])}</dd></div>
                ))}
              </dl>
              {trend && entry.days.length > 1 ? (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{metricLabel(trend)}, the last 30 days</h3>
                  <Trend usage={entry} metric={trend} />
                </div>
              ) : null}
            </div>
          </Section>
        )
      }) : (
        <Section title="Apps">
          <p className="text-sm text-muted-foreground">No app has reported this organization in the last three days.</p>
        </Section>
      )}

      {session.admin ? (
        <Section title="Standing" description="Suspending or disabling applies at once: to its people's pages, the apps, AI agents, API clients, SCIM and the mail relay.">
          <StandingForm action={`/super/orgs/${org.id}/status`} current={org.status} what="organization" error={problem} />
        </Section>
      ) : null}

      <Section title="History" description="What operators did to this organization.">
        <AuditTable rows={data.history} showTarget={false} />
      </Section>
    </>
  ))
}

export interface NewOrgState {
  /** The form's fields; `orgId` is the id of the organization it will create, kept when the form is shown again. */
  values: { orgId: string; email: string; name: string; reason: string }
  error?: string
}

export function newOrgPage(ctx: Context, session: OperatorSession, state: NewOrgState, status = 200): Response {
  return superPage(ctx, session, {
    title: "Create an organization for someone",
    current: "orgs",
    description: "For someone at their owner domain's limit who asked for another. They become its owner; it still counts for their domain.",
    status,
  }, (
    <Card>
      <CardContent>
        <form method="post" action="/super/orgs" className="flex max-w-xl flex-col gap-6">
          <ErrorSummary errors={[state.error]} />
          <input type="hidden" name="org_id" defaultValue={state.values.orgId} />
          <TextField label="Owner's email" name="email" type="email" value={state.values.email} hint="An existing account with a confirmed address." maxLength={254} />
          <TextField label="Organization name" name="name" value={state.values.name} maxLength={80} />
          <Field>
            <FieldLabel htmlFor="field-reason">Reason</FieldLabel>
            <Textarea id="field-reason" name="reason" required minLength={3} maxLength={500} rows={3} defaultValue={state.values.reason || undefined} aria-describedby="field-reason-hint" />
            <FieldDescription id="field-reason-hint">The audit log keeps it with your address, for instance the support request it answers.</FieldDescription>
          </Field>
          <div className="flex gap-2">
            <Button type="submit">Create the organization</Button>
            <a className={cn(buttonVariants({ variant: "outline" }))} href="/super/orgs">Cancel</a>
          </div>
        </form>
      </CardContent>
    </Card>
  ))
}
