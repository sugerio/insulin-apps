import { useState, type ReactNode } from "react";
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import type { api } from "#shared";
import { Badge as UiBadge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { cn } from "@/lib/utils.ts";
import { DASH, formatDate, plural } from "../lib/format.ts";
import {
  countRows, fileKindLabel, isPrecisionWarning, locationLabel, reconciliationGroups, sentenceCase, splitProblems, type ImportSource, type LineGroup,
} from "../lib/imports.ts";
import { useAdminFormat } from "../lib/useAdminFormat.ts";
import { Badge, Banner } from "./Feedback.tsx";

// The import preview, as the server computed it from the uploaded files: what each file was recognized as, the
// problems (blocking ones first, each with its place in the files and the fix in its sentence), the warnings, the
// opening balances that stand in for history the files can't express, the assumptions made, and the totals the import
// produces next to the source's own figures. The browser only counts lines and formats the figures it is given.

/** Long lists show this many lines until the admin asks for all of them. */
const LIST_LIMIT = 50;

/** A card of the import (a wizard step or a part of the preview): its title is a heading, the step's focus target. */
export function ImportCard({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle><h2>{title}</h2></CardTitle>
        {right ? <CardAction>{right}</CardAction> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

/** How many lines a list holds, beside its heading. */
function Count({ value }: { value: number }) {
  return <UiBadge variant="secondary" className="tabular-nums">{value.toLocaleString("en-US")}</UiBadge>;
}

function useLimit<T>(items: readonly T[]): { shown: readonly T[]; more: ReactNode } {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, LIST_LIMIT);
  const more = items.length > shown.length
    ? <Button type="button" variant="link" size="sm" className="h-auto self-start p-0" onClick={() => setAll(true)}>Show all {items.length.toLocaleString("en-US")}</Button>
    : null;
  return { shown, more };
}

export function DetectedFiles({ files }: { files: readonly api.ImportDetectedFile[] }) {
  if (!files.length) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm" aria-label="Files checked">
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className={cn("flex flex-wrap items-center gap-2", file.kind === null && "text-destructive")}>
          {file.kind === null
            ? <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
            : <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />}
          <span className="wrap-anywhere">{file.name}</span>
          <span className={file.kind === null ? undefined : "text-muted-foreground"}>{fileKindLabel(file.kind)}</span>
        </li>
      ))}
    </ul>
  );
}

const PROBLEM_TONES = {
  error: "bg-destructive/10 text-destructive",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
} as const;

function ProblemList({ problems, label, tone }: { problems: readonly api.ImportProblem[]; label: string; tone: "error" | "warning" }) {
  const { shown, more } = useLimit(problems);
  return (
    <>
      <ol className="mt-2 flex flex-col gap-1.5" aria-label={label}>
        {shown.map((problem, index) => {
          const where = locationLabel(problem);
          return (
            <li className={cn("flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm", PROBLEM_TONES[tone])} key={index}>
              {where ? <span className="text-xs font-semibold wrap-anywhere">{where}</span> : null}
              <span className="text-foreground">{problem.message}</span>
            </li>
          );
        })}
      </ol>
      {more}
    </>
  );
}

/**
 * Blocking problems, then warnings. With no blocking problem left, a plain note says the import can go ahead, unless the
 * server still couldn't prepare one from these files.
 */
export function ProblemSections({ problems, canImport }: { problems: readonly api.ImportProblem[]; canImport: boolean }) {
  const { errors, warnings } = splitProblems(problems);
  return (
    <>
      {errors.length ? (
        <section className="flex flex-col gap-1" aria-labelledby="import-errors">
          <h3 id="import-errors" className="flex items-center gap-2 font-medium">Problems to fix <Count value={errors.length} /></h3>
          <p className="text-xs text-muted-foreground">Each one blocks the import. Fix them in your files at the place shown, then upload the corrected files.</p>
          <ProblemList problems={errors} label="Problems to fix" tone="error" />
        </section>
      ) : canImport ? (
        <Banner kind="ok" title="Nothing blocks the import">Check the warnings, opening balances and totals below, then import.</Banner>
      ) : (
        <Banner kind="danger" title="These files can't be imported">The server couldn't prepare an import from them. Upload corrected files and check them again.</Banner>
      )}
      {warnings.length ? (
        <section className="flex flex-col gap-1" aria-labelledby="import-warnings">
          <h3 id="import-warnings" className="flex items-center gap-2 font-medium">Warnings <Count value={warnings.length} /></h3>
          <p className="text-xs text-muted-foreground">Warnings don't stop the import. Make sure each one is what you expect.</p>
          {warnings.some((warning) => isPrecisionWarning(warning.message)) ? (
            <p className="text-xs text-muted-foreground">Excel keeps 15 significant digits, so a longer number may already be rounded in the file: check it against your records.</p>
          ) : null}
          <ProblemList problems={warnings} label="Warnings" tone="warning" />
        </section>
      ) : null}
    </>
  );
}

export function OpeningBalances({ balances }: { balances: readonly api.ImportOpeningBalance[] }) {
  const { shown, more } = useLimit(balances);
  if (!balances.length) return null;
  return (
    <ImportCard title="Opening balances" right={<Count value={balances.length} />}>
      <p className="text-xs text-muted-foreground">The files show where these securities stand today but not every step that led there. Each is imported as a starting balance on the date shown, for the reason given.</p>
      <Table aria-label="Opening balances">
        <TableHeader>
          <TableRow><TableHead scope="col">Security</TableHead><TableHead scope="col">Date</TableHead><TableHead scope="col">Why</TableHead><TableHead scope="col">Where</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((balance, index) => (
            <TableRow key={`${balance.displayId}-${index}`}>
              <TableCell>{balance.displayId}</TableCell>
              <TableCell>{formatDate(balance.date)}</TableCell>
              <TableCell className="min-w-64 whitespace-normal">{balance.reason}</TableCell>
              <TableCell className="min-w-48 text-xs whitespace-normal">{locationLabel(balance) ?? DASH}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {more}
    </ImportCard>
  );
}

export function Assumptions({ assumptions }: { assumptions: readonly string[] }) {
  const { shown, more } = useLimit(assumptions);
  if (!assumptions.length) return null;
  return (
    <ImportCard title="Assumptions" right={<Count value={assumptions.length} />}>
      <p className="text-xs text-muted-foreground">Where the files leave something open, the import makes these choices. You can review them now; nothing here blocks the import.</p>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
        {shown.map((assumption, index) => <li key={index}>{assumption}</li>)}
      </ul>
      {more}
    </ImportCard>
  );
}

/** Figures as tiles in a definition list: what the import adds (also the result's summary), the company after it. */
function FigureList({ label, rows }: { label: string; rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5" aria-label={label}>
      {rows.map(([name, value]) => (
        <div key={name} className="rounded-lg border bg-muted/50 px-3.5 py-3">
          <dt className="text-xs text-muted-foreground">{name}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ImportCounts({ counts, label }: { counts: api.ImportCounts; label: string }) {
  return <FigureList label={label} rows={countRows(counts).map(([name, count]) => [name, count.toLocaleString("en-US")] as const)} />;
}

function ComparisonGroup({ group, sourceName }: { group: LineGroup; sourceName: string }) {
  const format = useAdminFormat();
  return (
    <Collapsible defaultOpen={group.mismatches > 0 || group.lines.length <= 8} className="rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="group/trigger h-auto w-full justify-start gap-2 px-3 py-2 text-left whitespace-normal">
          <ChevronRightIcon aria-hidden="true" className="transition-transform group-data-[state=open]/trigger:rotate-90" />
          <span>
            {group.title}
            <span className="text-xs font-normal text-muted-foreground"> · {plural(group.lines.length, "total")} · {group.mismatches ? `${group.mismatches.toLocaleString("en-US")} differ` : "all match"}</span>
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 pb-2">
        <Table aria-label={`${group.title} compared`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Total</TableHead>
              <TableHead scope="col" className="text-right">{sourceName}</TableHead>
              <TableHead scope="col" className="text-right">Imported</TableHead>
              <TableHead scope="col">Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group.lines.map((line, index) => (
              <TableRow key={`${line.sourceId ?? line.name}-${line.metric}-${index}`}>
                <TableCell>{line.name}</TableCell>
                <TableCell>{sentenceCase(line.metric)}</TableCell>
                <TableCell className="text-right tabular-nums">{format.shares(line.uploaded)}</TableCell>
                <TableCell className="text-right tabular-nums">{line.app === null ? DASH : format.shares(line.app)}</TableCell>
                <TableCell>{line.matches ? <Badge tone="green">Matches</Badge> : <Badge tone="red">Differs</Badge>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The totals: what is imported, the company's figures after the import, and every total the source states next to the
 * same total computed from the imported records (company, classes, plans, holders, then securities).
 */
export function ImportTotals({ totals, counts, source }: { totals: api.ImportTotals; counts: api.ImportCounts; source: ImportSource }) {
  const format = useAdminFormat();
  const groups = reconciliationGroups(totals.reconciliation);
  const lines = totals.reconciliation.length;
  const differ = groups.reduce((sum, group) => sum + group.mismatches, 0);
  const sourceName = source === "pulley" ? "Pulley" : "Spreadsheet";
  const whose = source === "pulley" ? "Pulley's reports" : "your spreadsheet";
  return (
    <ImportCard title="Totals">
      <h3 className="font-medium">What will be imported</h3>
      <ImportCounts counts={counts} label="What will be imported" />
      <h3 className="font-medium">The company after the import</h3>
      <FigureList label="The company after the import" rows={[
        ["Fully diluted shares", format.shares(totals.app.fullyDiluted)],
        ["Issued and outstanding shares", format.shares(totals.app.issuedAndOutstanding)],
      ]} />
      <h3 className="font-medium">Compared with {whose}</h3>
      {lines ? (
        <>
          <p className="text-xs text-muted-foreground">
            {differ
              ? `${differ.toLocaleString("en-US")} of ${plural(lines, "total")} differ from ${whose}; each one is also listed as a problem above.`
              : `All ${plural(lines, "total")} that ${whose} state match what the import produces.`}
          </p>
          {groups.map((group) => <ComparisonGroup key={group.scope} group={group} sourceName={sourceName} />)}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {source === "pulley" ? "Pulley's reports stated no totals to compare." : "The spreadsheet states no totals to compare: check the figures above against your own records."}
        </p>
      )}
    </ImportCard>
  );
}
