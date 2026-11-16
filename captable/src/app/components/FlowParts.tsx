import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { api } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { Field, FieldLabel } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { describeChanges, transactionLabel, type Change } from "../lib/changes.ts";
import { DASH, formatDate } from "../lib/format.ts";
import type { FlowProblem, WriteFlow } from "../lib/flow.ts";
import { commandLabel } from "../lib/changes.ts";
import { Banner } from "./Feedback.tsx";
import { BlockList, CheckLine } from "./Form.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";

// The parts every write flow shares: the server's preview (what the dry run says will be recorded and changed), the
// warnings to acknowledge, the typed confirmation, and what went wrong.

interface PreviewProps {
  /** The dry run's transactions; a reversal preview has its inverse list instead. */
  transactions?: api.CommandResult["transactions"];
  changes: readonly Change[];
  /** Names of the plans, classes, stakeholders and securities the preview mentions, by id. */
  names?: ReadonlyMap<string, string>;
  title?: ReactNode;
}

/** A vesting schedule in the preview: folded to its summary until opened. */
function ScheduleChange({ title, events, format }: { title: string; events: NonNullable<ReturnType<typeof describeChanges>[number]["vesting"]>; format: (value: string) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="-ml-2 h-auto py-1 font-normal">
          <ChevronRight className={open ? "rotate-90 transition-transform" : "transition-transform"} aria-hidden="true" />
          Vesting schedule ({events.length} events{events.length ? `, ${formatDate(events[0]!.date)} to ${formatDate(events.at(-1)!.date)}` : ""})
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 max-h-60 overflow-auto rounded-md border bg-background">
        <Table aria-label={`${title} schedule`}>
          <TableHeader><TableRow><TableHead>Date</TableHead><TableHead className="text-right">Tranche</TableHead><TableHead className="text-right">Cumulative</TableHead></TableRow></TableHeader>
          <TableBody>
            {events.map((event, index) => (
              <TableRow key={`${event.date}-${index}`}>
                <TableCell>{formatDate(event.date)}{event.kind === "CLIFF" ? " · cliff" : ""}</TableCell>
                <TableCell className="text-right tabular-nums">{format(event.quantity)}</TableCell>
                <TableCell className="text-right tabular-nums">{format(event.cumulative)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The server's preview, figure for figure ("Review" → Confirm). */
export function CommandPreview({ transactions, changes, names = new Map(), title = "What the ledger will record" }: PreviewProps) {
  const { format } = useWorkspace();
  const groups = describeChanges(changes, { names, shares: (value) => format.shares(value) });
  const securityName = (id: string | null) => {
    if (!id) return DASH;
    return groups.find((group) => group.entity === "security" && group.id === id)?.title ?? names.get(id) ?? DASH;
  };
  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-muted/50 p-4" aria-label="Server preview">
      <h3 className="text-sm font-semibold">{title}</h3>
      {transactions && transactions.length ? (
        <div className="rounded-md border bg-background">
          <Table aria-label="Transactions">
            <TableHeader><TableRow><TableHead>Transaction</TableHead><TableHead>Effective</TableHead><TableHead>Security</TableHead><TableHead className="text-right">Quantity</TableHead></TableRow></TableHeader>
            <TableBody>
              {transactions.map((transaction, index) => (
                <TableRow key={`${transaction.type}-${index}`}>
                  <TableCell>{transactionLabel(transaction.type)}</TableCell>
                  <TableCell>{formatDate(transaction.effectiveDate)}</TableCell>
                  <TableCell>{securityName(transaction.securityId)}</TableCell>
                  <TableCell className="text-right tabular-nums">{transaction.quantity === null ? DASH : format.shares(transaction.quantity)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {groups.length ? (
        <div className="flex flex-col gap-3" aria-label="Changes">
          {groups.map((group) => (
            <section className="flex flex-col gap-1" key={`${group.entity}-${group.id}`} aria-label={group.title}>
              <h4 className="text-sm font-medium">{group.title}</h4>
              {group.vesting ? (
                <ScheduleChange title={group.title} events={group.vesting} format={(value) => format.shares(value)} />
              ) : group.rows.length ? (
                group.rows.map((row) => (
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm" key={row.key}>
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="tabular-nums">{row.before}<span className="px-1.5 text-muted-foreground" aria-label="becomes">→</span><b className="font-semibold">{row.after}</b></span>
                  </div>
                ))
              ) : <p className="text-xs text-muted-foreground">No change.</p>}
            </section>
          ))}
        </div>
      ) : <p className="text-xs text-muted-foreground">The server reports no change to holdings.</p>}
    </section>
  );
}

/** The warnings the real call needs acknowledged. */
export function WarningsToAcknowledge({ flow }: { flow: WriteFlow<unknown, unknown, unknown> }) {
  if (!flow.warnings.length) return null;
  return (
    <div className="flex flex-col gap-2" aria-label="Warnings">
      <h4 className="text-sm font-semibold">Warnings to acknowledge</h4>
      <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
        {flow.warnings.map((warning) => (
          <CheckLine key={warning.code} checked={flow.acknowledged.has(warning.code)} onChange={(accepted) => flow.acknowledge(warning.code, accepted)} disabled={flow.busy || flow.locked}>
            {warning.message} <span className="font-mono text-xs">({warning.code})</span>
          </CheckLine>
        ))}
      </div>
      {!flow.acknowledgedAll ? <p className="text-xs text-muted-foreground">Acknowledge each warning to continue.</p> : null}
    </div>
  );
}

/** "Type OPT-56 to confirm": irreversible-looking writes need the object's ID typed. */
export function TypedConfirmation({ expected, value, onChange, disabled }: { expected: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id} className="inline">Type <b className="font-mono">{expected}</b> to confirm</FieldLabel>
      <Input id={id} autoComplete="off" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

export function confirmationMatches(typed: string, expected: string): boolean {
  return typed.trim() === expected;
}

/** A small outline Button in a banner. */
function BannerButton({ onClick, busy, children }: { onClick: () => void; busy?: boolean; children: ReactNode }) {
  return <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClick}>{children}</Button>;
}

/** What went wrong with the dry run or the real call, and what to do about it. */
export function FlowProblemBanner({ problem, onRetry, onCheck, busy }: { problem: FlowProblem | null; onRetry?: () => void; onCheck?: () => void; busy?: boolean }) {
  if (!problem) return null;
  switch (problem.kind) {
    case "invalid":
      return (
        <div className="flex flex-col gap-2">
          <Banner kind="danger" title={problem.message} />
          {problem.unplaced.length ? <BlockList items={problem.unplaced} /> : null}
        </div>
      );
    case "warnings":
      return <Banner kind="warn" title="The server raised warnings to acknowledge">Tick each warning below, then confirm again.</Banner>;
    case "stale":
      return <Banner kind="warn" title="Review again">{problem.message}</Banner>;
    case "changed":
      return (
        <Banner kind="warn" title="Review again" action={onRetry ? <BannerButton busy={busy} onClick={onRetry}>Review again</BannerButton> : undefined}>
          {problem.message}
        </Banner>
      );
    case "blocked":
      return (
        <Banner kind="danger" title="This can't be recorded">
          {problem.message}
          {problem.dependents?.length ? (
            <ul className="mt-1.5 list-disc pl-5 text-xs" aria-label="Commands to reverse first">
              {problem.dependents.map((dependent) => <li key={dependent.commandId}>{commandLabel(dependent.type)} <span className="font-mono">{dependent.commandId.slice(0, 8)}</span></li>)}
            </ul>
          ) : null}
        </Banner>
      );
    case "failed":
      return (
        <Banner kind="danger" title="Nothing was confirmed" action={problem.retry && onRetry ? <BannerButton busy={busy} onClick={onRetry}>Try again</BannerButton> : undefined}>
          {problem.message} Trying again can never record it twice.
        </Banner>
      );
    case "unresolved":
      return (
        <Banner
          kind="danger"
          title="The answer was lost — the outcome is unknown"
          action={
            <>
              {onRetry ? <BannerButton busy={busy} onClick={onRetry}>Try again</BannerButton> : null}
              {onCheck ? <BannerButton busy={busy} onClick={onCheck}>Check what was recorded</BannerButton> : null}
            </>
          }
        >
          {problem.message}
        </Banner>
      );
  }
}
