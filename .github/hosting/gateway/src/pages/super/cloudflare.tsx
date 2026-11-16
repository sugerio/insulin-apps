// /super/cloudflare: the Cloudflare resources the platform runs on (DESIGN.md §11.5), as the latest hourly snapshot
// read them: the account against the plan's allowances with the month's projection, 30 days of requests, every
// insulin-apps Worker and the D1 database it binds, and the inventory of everything else the platform uses (its
// domains, the Email Service, rate limiters, static assets, crons and bindings), from the gateway's own
// configuration.
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Notice } from "@/components/forms"
import type { Context } from "../../context.ts"
import type { OperatorSession } from "../../super/auth.ts"
import { GATEWAY_WORKER, RESOURCE_PREFIX, type Headroom, type Snapshot } from "../../super/cloudflare.ts"
import { HOUSEKEEPING_CRON, TICK_CRON } from "../../scheduled.ts"
import { superPage } from "./layout.tsx"
import { Bars, Meter, Section, ago, bytes, count, day, percent, when } from "./parts.tsx"

export interface CloudflareData {
  configured: boolean
  latest: Snapshot | null
  headroom: Headroom[]
  history: Snapshot[]
  job: { hour: number; started_at: number; finished_at: number | null; outcome: string | null } | null
  /** Messages the gateway sent through the Email Service in the last 48 hours (the mail log keeps two days). */
  mail2d: number
}

/** Everything the platform uses on Cloudflare, from the gateway's configuration: what the deploy creates and binds. */
function Inventory({ ctx, mail2d }: { ctx: Context; mail2d: number }) {
  const { domain, apps } = ctx.config
  const rows: { kind: string; name: string; detail: string }[] = [
    { kind: "Worker", name: GATEWAY_WORKER, detail: `Custom domains ${[domain, `www.${domain}`, `auth.${domain}`, ...apps.map((app) => app.host)].join(", ")}` },
    ...apps.map((app) => ({
      kind: "Worker",
      name: `${RESOURCE_PREFIX}${app.name}`,
      detail: `${app.title}: no route of its own; the gateway reaches it through ${app.binding}${app.service ? "" : " (not deployed)"}, and it the gateway through SUGER_GATEWAY`,
    })),
    { kind: "D1 database", name: `One per Worker, named after it`, detail: "Sizes and rows in the table below" },
    { kind: "Email Service", name: "EMAIL (send_email)", detail: `The gateway's mail and the apps' relay: ${count(mail2d)} messages in the last 48 hours` },
    { kind: "Rate limiting", name: "RL_AUTH, RL_APP, RL_PUBLIC", detail: "Sign-in and account forms; app requests; public paths' writes" },
    { kind: "Static assets", name: "DOCS_ASSETS", detail: "The public docs' images" },
    { kind: "Cron triggers", name: `${TICK_CRON} · ${HOUSEKEEPING_CRON}`, detail: "The apps' tick and the console's hourly snapshot · the daily cleanup" },
  ]
  return (
    <Card className="py-0">
      <CardContent className="px-0">
        <Table>
          <TableCaption className="text-left">Everything the platform uses</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Resource</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>What</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.kind}-${row.name}`}>
                <TableCell className="whitespace-nowrap">{row.kind}</TableCell>
                <TableCell className="font-mono text-xs">{row.name}</TableCell>
                <TableCell className="min-w-64 whitespace-normal">{row.detail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/** CPU time in milliseconds, from the analytics' microseconds. */
function cpu(value: number | null): string {
  return value === null ? "–" : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} ms`
}

export function cloudflarePage(ctx: Context, session: OperatorSession, data: CloudflareData): Response {
  const latest = data.latest
  // The last snapshot of each day that read the analytics: the day's total requests over the last 24 hours.
  const byDay = new Map<number, number>()
  for (const snapshot of data.history) {
    if (!snapshot.workers || snapshot.workers.some((worker) => worker.requests24h === null)) continue
    byDay.set(Math.floor(snapshot.takenAt / 86_400_000) * 86_400_000, snapshot.workers.reduce((sum, worker) => sum + (worker.requests24h ?? 0), 0))
  }
  const requests = [...byDay.entries()].sort(([a], [b]) => a - b).map(([time, value]) => ({ label: day(time), value }))
  return superPage(ctx, session, {
    title: "Cloudflare",
    current: "cloudflare",
    description: latest ? `Read ${when(latest.takenAt)} (${ago(ctx.now, latest.takenAt).toLowerCase()}), every hour.` : "Read every hour with a read-only API token.",
  }, (
    <>
      {!data.configured ? (
        <Notice>
          The console has no Cloudflare API token, so it reads nothing. The runbook says how to give it a read-only one (SUPER_CLOUDFLARE_API_TOKEN).
        </Notice>
      ) : null}
      {latest?.problems.length ? <Notice>Part of the last snapshot couldn&apos;t be read: {latest.problems.join(", ")}.</Notice> : null}
      {data.job?.outcome === "failed" ? <Notice>The last hourly read failed ({when(data.job.started_at)}); the next tick tries again.</Notice> : null}

      <Section
        title="Against the plan"
        description="Included amounts are billed past them; a hard limit refuses. The thin line is where the month ends at this pace. The plan's allowances are the account's: these assume an account that runs Insulin Apps alone."
      >
        {data.headroom.length ? (
          <div className="flex flex-col gap-5">
            {data.headroom.map((row) => (
              <Meter key={row.key} label={row.label} used={row.used} limit={row.limit} projected={row.projected} hard={row.hard} format={row.unit === "bytes" ? bytes : count} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing read yet.</p>
        )}
      </Section>

      {requests.length > 1 ? (
        <Section title="Requests" description="All insulin-apps Workers, the 24 hours before each day's last snapshot.">
          <Bars data={requests} caption="Requests per day, all Workers" />
        </Section>
      ) : null}

      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableCaption className="text-left">Workers</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead className="text-right">Requests, 24 h</TableHead>
                <TableHead className="text-right">Errors, 24 h</TableHead>
                <TableHead className="text-right">Requests this month</TableHead>
                <TableHead className="text-right">CPU median</TableHead>
                <TableHead className="text-right">CPU p99</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latest?.workers?.length ? latest.workers.map((worker) => (
                <TableRow key={worker.name}>
                  <TableCell className="font-mono text-xs">{worker.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{count(worker.requests24h)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(worker.errors24h)}
                    {worker.requests24h && worker.errors24h !== null ? <span className="text-muted-foreground"> ({percent(worker.errors24h, worker.requests24h)})</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{count(worker.requestsMonth)}</TableCell>
                  <TableCell className="text-right tabular-nums">{cpu(worker.cpuP50)}</TableCell>
                  <TableCell className="text-right tabular-nums">{cpu(worker.cpuP99)}</TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={6} className="text-muted-foreground">None read.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableCaption className="text-left">D1 databases (each named after the Worker that binds it; D1 counts rows by UTC day)</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Database</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Rows read yesterday</TableHead>
                <TableHead className="text-right">Rows written yesterday</TableHead>
                <TableHead className="text-right">Rows read this month</TableHead>
                <TableHead className="text-right">Rows written this month</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latest?.databases?.length ? latest.databases.map((db) => (
                <TableRow key={db.id}>
                  <TableCell className="font-mono text-xs">{db.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{bytes(db.sizeBytes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{count(db.rowsReadYesterday)}</TableCell>
                  <TableCell className="text-right tabular-nums">{count(db.rowsWrittenYesterday)}</TableCell>
                  <TableCell className="text-right tabular-nums">{count(db.rowsReadMonth)}</TableCell>
                  <TableCell className="text-right tabular-nums">{count(db.rowsWrittenMonth)}</TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={6} className="text-muted-foreground">None read.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Inventory ctx={ctx} mail2d={data.mail2d} />
    </>
  ))
}
