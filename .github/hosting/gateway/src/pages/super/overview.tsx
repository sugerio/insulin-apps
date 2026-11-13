// /super: the operator console's overview (DESIGN.md §11.2). Headline numbers, new accounts and organizations per day,
// the watch list (signals worth a look for abuse), the apps' latest reports, and the Cloudflare limits the platform is
// closest to.
import { TriangleAlert } from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Context } from "../../context.ts"
import { DAY_MS, HOUR_MS } from "../../db/metrics.ts"
import type { OperatorSession } from "../../super/auth.ts"
import { isWarning, type Headroom } from "../../super/cloudflare.ts"
import type { Overview, Signals } from "../../super/db.ts"
import { superPage } from "./layout.tsx"
import { Bars, Meter, Section, Stat, ago, bytes, count, day, when } from "./parts.tsx"

export interface OverviewData {
  counts: Overview
  daily: { users: Map<number, number>; orgs: Map<number, number> }
  /** The first day of the charts. */
  since: number
  signals: Signals
  reports: { app: string; hour: number; received_at: number; organizations: number }[]
  headroom: Headroom[] | null
  snapshotAt: number | null
}

/** An app's report is late when the latest one arrived more than two hours ago. */
export const REPORT_STALE_MS = 2 * HOUR_MS

export function overviewPage(ctx: Context, session: OperatorSession, data: OverviewData): Response {
  const { counts } = data
  const days: number[] = []
  for (let time = data.since; time <= ctx.now; time += DAY_MS) days.push(time)
  const series = (map: Map<number, number>) => days.map((time) => ({ label: day(time), value: map.get(time) ?? 0 }))
  const warnings = (data.headroom ?? []).filter(isWarning)
  const late = ctx.config.apps.filter((app) => {
    const report = data.reports.find((entry) => entry.app === app.name)
    return app.service && (!report || ctx.now - report.received_at > REPORT_STALE_MS)
  })
  const signalCount = data.signals.domainsAtLimit.length + data.signals.signupBursts.length + warnings.length + late.length
  return superPage(ctx, session, { title: "Overview", current: "overview", description: "Usage of Insulin Apps across every organization, and what needs a look." }, (
    <>
      <section aria-label="Totals" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Organizations" value={count(counts.orgs)} hint={`${count(counts.orgs_new_7d)} new this week · ${count(counts.orgs_active_7d)} active`} />
        <Stat label="People" value={count(counts.users)} hint={`${count(counts.users_new_7d)} new this week · ${count(counts.users_unconfirmed)} unconfirmed`} />
        <Stat label="Active people" value={count(counts.active_7d)} hint={`${count(counts.active_1d)} in the last day · ${count(counts.active_30d)} in 30 days`} />
        <Stat
          label="Suspended or disabled"
          value={count(counts.orgs_suspended + counts.orgs_disabled + counts.users_suspended + counts.users_disabled)}
          hint={`${count(counts.orgs_suspended + counts.orgs_disabled)} organizations · ${count(counts.users_suspended + counts.users_disabled)} people`}
        />
      </section>

      <Section title="Watch list" description={signalCount ? "Signals that may need a look, worst first." : "Nothing needs a look right now."}>
        <ul className="flex flex-col gap-3 text-sm">
          {warnings.map((row) => (
            <li key={row.key} className="flex items-start gap-2">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span>
                <a href="/super/cloudflare" className="font-medium underline underline-offset-4">{row.label}</a>: {row.unit === "bytes" ? bytes(row.used) : count(row.used)} of{" "}
                {row.unit === "bytes" ? bytes(row.limit) : count(row.limit)}
                {row.projected !== null ? `, heading for ${count(row.projected)} this month` : ""}.
              </span>
            </li>
          ))}
          {late.map((app) => (
            <li key={app.name} className="flex items-start gap-2">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span>
                <a href={`/super/apps/${app.name}`} className="font-medium underline underline-offset-4">{app.title}</a> hasn&apos;t reported its usage for over two hours
                {app.scheduled ? "" : " (it declares no scheduled path, so the platform's tick never reaches it)"}.
              </span>
            </li>
          ))}
          {data.signals.domainsAtLimit.map((row) => (
            <li key={row.owner_domain}>
              <a href={`/super/orgs?q=${encodeURIComponent(row.owner_domain)}`} className="font-medium underline underline-offset-4">{row.owner_domain}</a>{" "}
              has {count(row.orgs)} organizations, its limit is {count(row.max_orgs)}.
            </li>
          ))}
          {data.signals.signupBursts.map((row) => (
            <li key={row.domain}>
              <a href={`/super/users?q=${encodeURIComponent(`@${row.domain}`)}&sort=created`} className="font-medium underline underline-offset-4">{row.domain}</a>: {count(row.accounts)} new accounts in the last day.
            </li>
          ))}
          <li className="text-muted-foreground">
            {count(data.signals.staleUnconfirmed)} accounts never confirmed their address after a week · {count(data.signals.orgRequests)} requests for more organizations in the last day.
          </li>
        </ul>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="New accounts" description="Per day, the last 30 days (UTC).">
          <Bars data={series(data.daily.users)} caption="New accounts per day" />
        </Section>
        <Section title="New organizations" description="Per day, the last 30 days (UTC).">
          <Bars data={series(data.daily.orgs)} caption="New organizations per day" />
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="App reports" description="Each app reports its usage every hour.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead>Latest report</TableHead>
                <TableHead className="text-right">Organizations</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ctx.config.apps.map((app) => {
                const report = data.reports.find((entry) => entry.app === app.name)
                return (
                  <TableRow key={app.name}>
                    <TableCell><a href={`/super/apps/${app.name}`} className="font-medium underline-offset-4 hover:underline">{app.title}</a></TableCell>
                    <TableCell>{report ? ago(ctx.now, report.received_at) : "None yet"}</TableCell>
                    <TableCell className="text-right tabular-nums">{report ? count(report.organizations) : "–"}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Section>
        <Section title="Cloudflare limits" description={data.snapshotAt ? `Read ${when(data.snapshotAt)}.` : "No snapshot in the last two hours."}>
          {data.headroom?.length ? (
            <div className="flex flex-col gap-4">
              {data.headroom.map((row) => (
                <Meter key={row.key} label={row.label} used={row.used} limit={row.limit} projected={row.projected} hard={row.hard} format={row.unit === "bytes" ? bytes : count} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              See <a href="/super/cloudflare" className="underline underline-offset-4">Cloudflare</a> for what was last read and why.
            </p>
          )}
        </Section>
      </div>
    </>
  ))
}
