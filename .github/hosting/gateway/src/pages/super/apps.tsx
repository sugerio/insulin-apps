// /super/apps: what each app reported in its latest hourly report (DESIGN.md §8.6), summed over organizations, with
// 30 days of its app-wide numbers; /super/apps/<app>: the organizations of the latest report ranked by one metric, and
// the ones that grew most in a day.
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Context } from "../../context.ts"
import type { Metrics } from "../../db/metrics.ts"
import type { OperatorSession } from "../../super/auth.ts"
import { superPage } from "./layout.tsx"
import { Bars, Section, SortLink, ago, day, metricLabel, metricValue, when } from "./parts.tsx"

export interface AppSummary {
  app: { name: string; title: string; scheduled: string | null }
  report: { hour: number; received_at: number; organizations: number } | null
  appWide: Metrics
  totals: Metrics
  days: { day: number; metrics: Metrics }[]
}

function MetricList({ metrics }: { metrics: Metrics }) {
  const names = Object.keys(metrics).sort()
  if (!names.length) return <p className="text-sm text-muted-foreground">None.</p>
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
      {names.map((name) => (
        <div key={name}><dt className="text-muted-foreground">{metricLabel(name)}</dt><dd className="tabular-nums">{metricValue(name, metrics[name])}</dd></div>
      ))}
    </dl>
  )
}

export function appsPage(ctx: Context, session: OperatorSession, apps: AppSummary[]): Response {
  return superPage(ctx, session, {
    title: "Apps",
    current: "apps",
    description: "Each app sends its usage every hour: counts and sizes only, never its data. The console has no way into an app's database.",
  }, (
    <>
      {apps.map((entry) => {
        const trend = Object.keys(entry.appWide).includes("database_bytes") ? "database_bytes" : Object.keys(entry.appWide).sort()[0]
        return (
          <Section
            key={entry.app.name}
            title={entry.app.title}
            description={entry.report
              ? `Latest report for ${when(entry.report.hour)}, received ${ago(ctx.now, entry.report.received_at).toLowerCase()}, with ${entry.report.organizations} organizations.`
              : entry.app.scheduled ? "No report in the last three days." : "No report: the app declares no scheduled path, so the platform's tick never reaches it."}
            actions={<a href={`/super/apps/${entry.app.name}`} className="text-sm font-medium underline underline-offset-4">Organizations</a>}
          >
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">The app as a whole</h3>
                <MetricList metrics={entry.appWide} />
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">All organizations together</h3>
                <MetricList metrics={entry.totals} />
              </div>
              {trend && entry.days.length > 1 ? (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{metricLabel(trend)}, the last 30 days</h3>
                  <Bars data={entry.days.map((point) => ({ label: day(point.day), value: point.metrics[trend] ?? 0 }))} caption={`${entry.app.title}: ${metricLabel(trend)} per day`} format={(value) => metricValue(trend, value)} />
                </div>
              ) : null}
            </div>
          </Section>
        )
      })}
    </>
  ))
}

export interface AppDetail {
  app: { name: string; title: string }
  hour: number | null
  appWide: Metrics
  metricNames: string[]
  sort: string | null
  organizations: { orgId: string; name: string | null; metrics: Metrics }[]
  total: number
  growth: { org_id: string; name: string | null; now: number; before: number }[]
}

export function appDetailPage(ctx: Context, session: OperatorSession, data: AppDetail): Response {
  const sortHref = (sort: string) => `/super/apps/${data.app.name}?sort=${encodeURIComponent(sort)}`
  return superPage(ctx, session, {
    title: data.app.title,
    current: "apps",
    description: data.hour === null ? "No report in the last three days." : `The latest report, for ${when(data.hour)}.`,
  }, (
    <>
      <Section title="The app as a whole">
        <MetricList metrics={data.appWide} />
      </Section>
      {data.sort ? (
        <Section title={`Grew most in a day: ${metricLabel(data.sort)}`} description="Compared with the report exactly 24 hours earlier.">
          {data.growth.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {data.growth.map((row) => (
                <li key={row.org_id}>
                  <a href={`/super/orgs/${row.org_id}`} className="font-medium underline underline-offset-4">{row.name ?? row.org_id}</a>: {metricValue(data.sort!, row.before)} to {metricValue(data.sort!, row.now)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No organization grew.</p>
          )}
        </Section>
      ) : null}
      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableCaption className="sr-only">Organizations in the latest report</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                {data.metricNames.map((name) => (
                  <TableHead key={name} className="text-right">
                    <SortLink label={metricLabel(name)} value={name} current={data.sort ?? ""} href={sortHref} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.organizations.length ? data.organizations.map((row) => (
                <TableRow key={row.orgId}>
                  <TableCell className="max-w-64 truncate"><a href={`/super/orgs/${row.orgId}`} className="font-medium underline-offset-4 hover:underline">{row.name ?? row.orgId}</a></TableCell>
                  {data.metricNames.map((name) => (
                    <TableCell key={name} className="text-right tabular-nums">{metricValue(name, row.metrics[name])}</TableCell>
                  ))}
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={data.metricNames.length + 1} className="text-muted-foreground">No organization in the latest report.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {data.total > data.organizations.length ? <p className="text-sm text-muted-foreground">The first {data.organizations.length} of {data.total}.</p> : null}
    </>
  ))
}
