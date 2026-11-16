// App limits in the operator console (DESIGN.md §12.2). /super/apps/<app>/limits: each limit of the app's catalog with
// the catalog's default and the default in force, and for admins the forms to change a default or put the catalog's
// back. Each organization's page: a Limits section with the usage its apps last reported beside each limit, its
// overrides, and for admins the forms to override a limit (a number or unlimited, an optional last day) or remove one.
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { ErrorSummary, Notice } from "@/components/forms"
import type { Context } from "../../context.ts"
import type { Metrics } from "../../db/metrics.ts"
import { defaultInForce, limitInForce, type CatalogRow, type DefaultRow, type LimitUnit, type OverrideRow } from "../../db/limits.ts"
import type { OperatorSession } from "../../super/auth.ts"
import type { AuditRow } from "../../super/db.ts"
import { AuditTable } from "./audit.tsx"
import { superPage } from "./layout.tsx"
import { Section, bytes, count, day, percent, when } from "./parts.tsx"

/** A limit's value for people: a size for bytes, hours or days, a count, or "Unlimited". */
export function limitValue(unit: LimitUnit, value: number | null | undefined): string {
  if (value === undefined) return "–"
  if (value === null) return "Unlimited"
  if (unit === "bytes") return bytes(value)
  if (unit === "hours") return `${count(value)} ${value === 1 ? "hour" : "hours"}`
  if (unit === "days") return `${count(value)} ${value === 1 ? "day" : "days"}`
  return count(value)
}

/** What to type for a value (super/limits.ts parseLimitValue). */
const VALUE_HINT = "A whole number in the limit's unit (a size such as 25 MB or 2 GB), or unlimited."

function ReasonField({ id }: { id: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Reason</FieldLabel>
      <Textarea id={id} name="reason" required minLength={3} maxLength={500} rows={2} aria-describedby={`${id}-hint`} />
      <FieldDescription id={`${id}-hint`}>The audit log keeps it with your address.</FieldDescription>
    </Field>
  )
}

function KeySelect({ id, rows, label = "Limit" }: { id: string; rows: CatalogRow[]; label?: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect id={id} name="key" required defaultValue="">
        <NativeSelectOption value="" disabled>Choose…</NativeSelectOption>
        {rows.map((row) => (
          <NativeSelectOption key={row.key} value={row.key}>{row.label}</NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  )
}

const APP_NOTICES: Record<string, string> = {
  default_set: "The default is changed. The app applies it within five minutes.",
  default_reset: "The catalog's default applies again. The app applies it within five minutes.",
  unchanged: "Nothing changed: the default was already that.",
}

export interface AppLimitsData {
  app: { name: string; title: string }
  catalog: CatalogRow[]
  defaults: DefaultRow[]
  history: AuditRow[]
}

export function appLimitsPage(ctx: Context, session: OperatorSession, data: AppLimitsData, problem?: string, status = 200): Response {
  const notice = APP_NOTICES[ctx.url.searchParams.get("notice") ?? ""]
  const set = new Map(data.defaults.map((row) => [row.key, row]))
  const action = `/super/apps/${data.app.name}/limits`
  const changed = data.catalog.filter((row) => set.has(row.key))
  return superPage(ctx, session, {
    title: `${data.app.title} limits`,
    current: "apps",
    description: "What each organization may use, unless its own page overrides it. The app enforces them; a change applies within five minutes.",
    status,
  }, (
    <>
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      <ErrorSummary errors={[problem]} />
      <Section title="Limits" description={data.catalog.length ? "The catalog is the app's own, from its package.json, as the version in production declares it." : undefined}>
        {data.catalog.length ? (
          <Table>
            <TableCaption className="sr-only">{data.app.title} limits</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Limit</TableHead>
                <TableHead className="text-right">Catalog default</TableHead>
                <TableHead className="text-right">In force</TableHead>
                <TableHead>Changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.catalog.map((row) => {
                const own = set.get(row.key)
                return (
                  <TableRow key={row.key}>
                    <TableCell>
                      <span className="font-medium">{row.label}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{row.key}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{limitValue(row.unit, row.default_value)}</TableCell>
                    <TableCell className="text-right tabular-nums">{limitValue(row.unit, defaultInForce(row, own))}</TableCell>
                    <TableCell className="min-w-48 whitespace-normal text-sm">
                      {own ? <>{when(own.changed_at)} by {own.changed_by}: {own.reason}</> : <span className="text-muted-foreground">The catalog&apos;s</span>}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">{data.app.title} declares no limits.</p>
        )}
      </Section>

      {session.admin && data.catalog.length ? (
        <Section title="Change a default" description="For every organization that has no override of its own.">
          <form method="post" action={action} className="flex max-w-xl flex-col gap-4">
            <input type="hidden" name="action" defaultValue="set" />
            <KeySelect id="field-default-key" rows={data.catalog} />
            <Field>
              <FieldLabel htmlFor="field-default-value">New default</FieldLabel>
              <Input id="field-default-value" name="value" required maxLength={40} aria-describedby="field-default-value-hint" />
              <FieldDescription id="field-default-value-hint">{VALUE_HINT}</FieldDescription>
            </Field>
            <ReasonField id="field-default-reason" />
            <div><Button type="submit">Change the default</Button></div>
          </form>
        </Section>
      ) : null}

      {session.admin && changed.length ? (
        <Section title="Put back the catalog's default">
          <form method="post" action={action} className="flex max-w-xl flex-col gap-4">
            <input type="hidden" name="action" defaultValue="reset" />
            <KeySelect id="field-reset-key" rows={changed} />
            <ReasonField id="field-reset-reason" />
            <div><Button type="submit" variant="outline">Put it back</Button></div>
          </form>
        </Section>
      ) : null}

      <Section title="History" description="Changes to this app's limits.">
        <AuditTable rows={data.history} showTarget={false} />
      </Section>
    </>
  ))
}

/** One app's limits as they stand for one organization. */
export interface OrgAppLimits {
  app: { name: string; title: string }
  catalog: CatalogRow[]
  defaults: DefaultRow[]
  overrides: OverrideRow[]
  /** The app's latest report for the organization, or null when it has none. */
  usage: Metrics | null
}

/** A monthly count is a month-to-date gauge (§12.2): its key ends in _month. */
function usageText(row: CatalogRow, usage: Metrics | null): string {
  const used = usage?.[row.key]
  if (used === undefined) return "–"
  return `${limitValue(row.unit, used)}${row.key.endsWith("_month") ? " this month" : ""}`
}

function OverrideText({ row, now }: { row: OverrideRow | undefined; now: number }) {
  if (!row) return <span className="text-muted-foreground">None</span>
  const ended = row.until !== null && row.until <= now
  return (
    <>
      {ended ? "Ended " : ""}
      {row.until === null ? "No end" : `${ended ? "" : "Through "}${day(row.until - 1)}`}. {when(row.changed_at)} by {row.changed_by}: {row.reason}
    </>
  )
}

export const LIMIT_NOTICES: Record<string, string> = {
  limit_set: "The override is set. The app applies it within five minutes.",
  limit_removed: "The override is removed: the default applies again within five minutes.",
  limit_unchanged: "Nothing changed: the organization already had that override.",
}

/** The Limits section of an organization's page: every app with a catalog, the usage beside each limit, and overrides. */
export function OrgLimits({ orgId, apps, admin, now }: { orgId: string; apps: OrgAppLimits[]; admin: boolean; now: number }) {
  if (!apps.length) return null
  return (
    <Section title="Limits" description="What the organization may use in each app, beside its latest reported usage. The app enforces them.">
      <div id="limits" className="flex flex-col gap-8">
        {apps.map((entry) => {
          const set = new Map(entry.defaults.map((row) => [row.key, row]))
          const overrides = new Map(entry.overrides.map((row) => [row.key, row]))
          const overridden = entry.catalog.filter((row) => overrides.has(row.key))
          const prefix = `field-${entry.app.name}`
          return (
            <div key={entry.app.name} className="flex flex-col gap-4">
              <h3 className="text-sm font-medium">{entry.app.title}</h3>
              <Table>
                <TableCaption className="sr-only">{entry.app.title} limits</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Limit</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                    <TableHead className="text-right">Limit in force</TableHead>
                    <TableHead className="text-right">Default</TableHead>
                    <TableHead>Override</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entry.catalog.map((row) => {
                    const inForce = limitInForce(row, set.get(row.key), overrides.get(row.key), now)
                    const used = entry.usage?.[row.key]
                    return (
                      <TableRow key={row.key}>
                        <TableCell className="font-medium">{row.label}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {usageText(row, entry.usage)}
                          {used !== undefined && inForce ? <span className="block text-xs text-muted-foreground">{percent(used, inForce)}</span> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{limitValue(row.unit, inForce)}</TableCell>
                        <TableCell className="text-right tabular-nums">{limitValue(row.unit, defaultInForce(row, set.get(row.key)))}</TableCell>
                        <TableCell className="min-w-48 whitespace-normal text-sm">
                          {overrides.get(row.key) ? <>{limitValue(row.unit, overrides.get(row.key)!.value)}. </> : null}
                          <OverrideText row={overrides.get(row.key)} now={now} />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              {entry.usage ? null : <p className="text-sm text-muted-foreground">{entry.app.title} hasn&apos;t reported this organization in the last three days.</p>}
              {admin ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  <form method="post" action={`/super/orgs/${orgId}/limits`} className="flex flex-col gap-4">
                    <h4 className="text-sm font-medium">Override a limit</h4>
                    <input type="hidden" name="action" defaultValue="set" />
                    <input type="hidden" name="app" defaultValue={entry.app.name} />
                    <KeySelect id={`${prefix}-key`} rows={entry.catalog} />
                    <Field>
                      <FieldLabel htmlFor={`${prefix}-value`}>New limit</FieldLabel>
                      <Input id={`${prefix}-value`} name="value" required maxLength={40} aria-describedby={`${prefix}-value-hint`} />
                      <FieldDescription id={`${prefix}-value-hint`}>{VALUE_HINT}</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${prefix}-until`}>Last day (optional)</FieldLabel>
                      <Input id={`${prefix}-until`} name="until" type="date" aria-describedby={`${prefix}-until-hint`} />
                      <FieldDescription id={`${prefix}-until-hint`}>In UTC. After it, the default applies again. Empty: no end.</FieldDescription>
                    </Field>
                    <ReasonField id={`${prefix}-reason`} />
                    <div><Button type="submit">Set the override</Button></div>
                  </form>
                  {overridden.length ? (
                    <form method="post" action={`/super/orgs/${orgId}/limits`} className="flex flex-col gap-4">
                      <h4 className="text-sm font-medium">Remove an override</h4>
                      <input type="hidden" name="action" defaultValue="remove" />
                      <input type="hidden" name="app" defaultValue={entry.app.name} />
                      <KeySelect id={`${prefix}-remove-key`} rows={overridden} />
                      <ReasonField id={`${prefix}-remove-reason`} />
                      <div><Button type="submit" variant="outline">Remove the override</Button></div>
                    </form>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </Section>
  )
}
