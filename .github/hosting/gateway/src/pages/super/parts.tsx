// Pieces the operator console's pages share: numbers, sizes and times written out, standing badges, stat tiles, the
// small charts (inline SVG, one hue, each mark with a native tooltip and the same numbers in a table, since the pages
// run no script), search and paging, and the admins' standing form.
import type { ReactNode } from "react"
import { CircleAlert, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import type { Status } from "../../super/db.ts"

export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : Math.round(value).toLocaleString("en-US")
}

/** Bytes in binary units, to three significant figures. */
export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${unit === 0 ? size : size.toPrecision(3)} ${units[unit]}`
}

/** A metric's value: bytes for a name ending in `_bytes`, a count otherwise. */
export function metricValue(name: string, value: number | undefined): string {
  return name.endsWith("_bytes") ? bytes(value) : count(value)
}

/** A metric's name for people: `storage_bytes` → "Storage bytes". */
export function metricLabel(name: string): string {
  const words = name.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function day(ms: number | null): string {
  return ms === null ? "Never" : new Date(ms).toISOString().slice(0, 10)
}

/** A moment in UTC, to the minute. */
export function when(ms: number | null): string {
  return ms === null ? "Never" : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`
}

/** How long ago, in the largest whole unit; activity is kept to within an hour, so less reads "Within the hour". */
export function ago(now: number, ms: number | null): string {
  if (ms === null) return "Never"
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 60) return "Within the hour"
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days < 60 ? `${days} days ago` : day(ms)
}

export function percent(used: number, limit: number): string {
  if (limit <= 0) return "–"
  const share = (used / limit) * 100
  return `${share < 10 ? share.toFixed(1) : Math.round(share)}%`
}

const STATUS_LABELS: Record<Status, string> = { active: "Active", suspended: "Suspended", disabled: "Disabled" }

export function StatusBadge({ status }: { status: Status }) {
  if (status === "active") return <Badge variant="outline">Active</Badge>
  return (
    <Badge variant={status === "disabled" ? "destructive" : "secondary"}>
      {status === "disabled" ? <CircleAlert aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
      {STATUS_LABELS[status]}
    </Badge>
  )
}

/** A headline number with its label and an optional line under it. */
export function Stat({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint ? <CardContent className="px-4 text-sm text-muted-foreground">{hint}</CardContent> : null}
    </Card>
  )
}

/** A card with an <h2> title and an optional description. */
export function Section({ title, description, actions, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <CardTitle>
            <h2>{title}</h2>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export interface BarDatum {
  label: string
  value: number
}

const CHART_WIDTH = 600
const CHART_HEIGHT = 120

/**
 * Columns for one series over time, left to right: one hue, a 2px gap between columns, rounded tops on a shared
 * baseline, and the largest value named at the top. Each column carries its own tooltip; `caption` names the chart for
 * screen readers, and the table under it (collapsed) holds every value.
 */
export function Bars({ data, caption, format = count }: { data: BarDatum[]; caption: string; format?: (value: number) => string }) {
  const max = Math.max(1, ...data.map((datum) => datum.value))
  const slot = CHART_WIDTH / Math.max(1, data.length)
  const width = Math.max(1, slot - 2)
  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT + 16}`} className="h-auto w-full" role="img" aria-label={`${caption}, highest ${format(max)}`}>
        <text x="0" y="10" className="fill-muted-foreground text-[10px]">{format(max)}</text>
        <line x1="0" x2={CHART_WIDTH} y1={CHART_HEIGHT + 14} y2={CHART_HEIGHT + 14} className="stroke-border" strokeWidth="1" />
        {data.map((datum, index) => {
          const height = datum.value > 0 ? Math.max(2, (datum.value / max) * CHART_HEIGHT) : 0
          return (
            <g key={datum.label}>
              <rect x={index * slot} y={14} width={slot} height={CHART_HEIGHT} className="fill-transparent">
                <title>{`${datum.label}: ${format(datum.value)}`}</title>
              </rect>
              {height ? (
                <rect x={index * slot + 1} y={CHART_HEIGHT + 14 - height} width={width} height={height} rx={Math.min(4, width / 2)} className="pointer-events-none fill-diagram-accent" />
              ) : null}
            </g>
          )
        })}
      </svg>
      <figcaption className="flex justify-between text-xs text-muted-foreground">
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </figcaption>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show the numbers</summary>
        <table className="mt-2 w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr><th scope="col" className="font-medium">Day</th><th scope="col" className="text-right font-medium">Value</th></tr>
          </thead>
          <tbody>
            {data.map((datum) => (
              <tr key={datum.label}><td>{datum.label}</td><td className="text-right tabular-nums">{format(datum.value)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}

/**
 * How much of a limit is used: a track with the used share filled, and the projection marked as a thin line when there
 * is one. Past 80%, or projected past the limit, it says so in words with an icon, not by colour alone.
 */
export function Meter({ label, used, limit, projected, format, hard }: { label: string; used: number; limit: number; projected: number | null; format: (value: number) => string; hard: boolean }) {
  const share = Math.min(1, used / Math.max(1, limit))
  const projectedShare = projected === null ? null : Math.min(1, projected / Math.max(1, limit))
  const warning = used >= limit * 0.8 || (projected !== null && projected >= limit)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {format(used)} of {format(limit)} ({percent(used, limit)}){hard ? ", a hard limit" : ", included in the plan"}
        </span>
      </div>
      <svg viewBox="0 0 600 10" preserveAspectRatio="none" className="h-2.5 w-full" role="img" aria-label={`${label}: ${percent(used, limit)} of the limit`}>
        <rect x="0" y="0" width="600" height="10" rx="4" className="fill-muted" />
        {share > 0 ? <rect x="0" y="0" width={Math.max(4, share * 600)} height="10" rx="4" className={warning ? "fill-destructive" : "fill-diagram-accent"} /> : null}
        {projectedShare !== null ? <rect x={Math.min(598, projectedShare * 600)} y="0" width="2" height="10" className="fill-foreground" /> : null}
      </svg>
      <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
        <span>{projected === null ? "" : `At this pace, ${format(projected)} by the end of the month (the thin line)`}</span>
        {warning ? (
          <span className="flex items-center gap-1 font-medium text-destructive">
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            {used >= limit ? "Over the limit" : used >= limit * 0.8 ? "Above 80%" : "Projected past the limit"}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** A search box with a standing filter, as a GET form that keeps the sort. */
export function SearchForm({ action, query, status, sort, placeholder }: { action: string; query: string; status: Status | null; sort: string; placeholder: string }) {
  return (
    <form method="get" action={action} role="search" className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <Field className="sm:flex-1">
        <FieldLabel htmlFor="field-q">Search</FieldLabel>
        <Input id="field-q" name="q" type="search" defaultValue={query || undefined} placeholder={placeholder} maxLength={200} />
      </Field>
      <Field className="sm:w-44">
        <FieldLabel htmlFor="field-status">Standing</FieldLabel>
        <NativeSelect id="field-status" name="status" defaultValue={status ?? ""}>
          <NativeSelectOption value="">Any</NativeSelectOption>
          <NativeSelectOption value="active">Active</NativeSelectOption>
          <NativeSelectOption value="suspended">Suspended</NativeSelectOption>
          <NativeSelectOption value="disabled">Disabled</NativeSelectOption>
        </NativeSelect>
      </Field>
      <input type="hidden" name="sort" defaultValue={sort} />
      <Button type="submit">Search</Button>
    </form>
  )
}

/** Previous and next pages of a list, keeping its other parameters. */
export function Pagination({ path, params, page, total, pageSize }: { path: string; params: Record<string, string>; page: number; total: number; pageSize: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const href = (target: number) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value))
    if (target > 1) query.set("page", String(target))
    const text = query.toString()
    return text ? `${path}?${text}` : path
  }
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
      <span>
        {count(total)} in all{pages > 1 ? `, page ${page} of ${count(pages)}` : ""}
      </span>
      <span className="flex gap-2">
        {page > 1 ? <a className={buttonVariants({ variant: "outline", size: "sm" })} href={href(page - 1)}>Previous</a> : null}
        {page < pages ? <a className={buttonVariants({ variant: "outline", size: "sm" })} href={href(page + 1)}>Next</a> : null}
      </span>
    </nav>
  )
}

/** A sortable column's header: a link that sorts by it, marked when it is the current sort. */
export function SortLink({ label, value, current, href }: { label: string; value: string; current: string; href: (sort: string) => string }) {
  return (
    <a href={href(value)} aria-current={value === current ? "true" : undefined} className={cn("underline-offset-4 hover:underline", value === current && "font-semibold text-foreground")}>
      {label}
    </a>
  )
}

const ACTIONS: { status: Status; label: string; description: string }[] = [
  { status: "suspended", label: "Suspend", description: "Pause all access while you look into it. Everything is kept, and reinstating gives it back." },
  { status: "disabled", label: "Disable", description: "End access for abuse or fraud. Also ends sessions, AI agents, API clients, invitations and SCIM tokens for good." },
  { status: "active", label: "Reinstate", description: "Lift a suspension or a disabling. What disabling ended stays ended." },
]

/**
 * The admins' form to change a standing: what to do (anything but the current standing) and the reason, which the
 * audit log keeps. `what` names the target ("organization", "account") in the descriptions.
 */
export function StandingForm({ action, current, what, error }: { action: string; current: Status; what: string; error?: string }) {
  const choices = ACTIONS.filter((choice) => choice.status !== current)
  return (
    <form method="post" action={action} className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="field-standing">Change this {what}&apos;s standing</FieldLabel>
        <NativeSelect id="field-standing" name="status" required defaultValue="" aria-describedby="field-standing-hint">
          <NativeSelectOption value="" disabled>
            Choose…
          </NativeSelectOption>
          {choices.map((choice) => (
            <NativeSelectOption key={choice.status} value={choice.status}>
              {choice.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription id="field-standing-hint">
          {choices.map((choice) => (
            <span key={choice.status} className="block">
              <strong>{choice.label}:</strong> {choice.description}
            </span>
          ))}
        </FieldDescription>
      </Field>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="field-reason">Reason</FieldLabel>
        <Textarea id="field-reason" name="reason" required minLength={3} maxLength={500} rows={3} aria-describedby="field-reason-hint" aria-invalid={error ? true : undefined} />
        <FieldDescription id="field-reason-hint">The audit log keeps it with your address. The {what}&apos;s people never see it.</FieldDescription>
      </Field>
      <div>
        <Button type="submit" variant="destructive">Change standing</Button>
      </div>
    </form>
  )
}
