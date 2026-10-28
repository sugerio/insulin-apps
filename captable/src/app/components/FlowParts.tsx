import { useId, type ReactNode } from "react";
import type { api } from "#shared";
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

/** The server's preview, figure for figure ("Review" → Confirm). */
export function CommandPreview({ transactions, changes, names = new Map(), title = "What the ledger will record" }: PreviewProps) {
  const { format } = useWorkspace();
  const groups = describeChanges(changes, { names, shares: (value) => format.shares(value) });
  const securityName = (id: string | null) => {
    if (!id) return DASH;
    return groups.find((group) => group.entity === "security" && group.id === id)?.title ?? names.get(id) ?? DASH;
  };
  return (
    <section className="review-panel" aria-label="Server preview">
      <h3>{title}</h3>
      {transactions && transactions.length ? (
        <div className="tbl-scroll mb-8">
          <table className="tbl dense" aria-label="Transactions">
            <thead><tr><th scope="col">Transaction</th><th scope="col">Effective</th><th scope="col">Security</th><th scope="col" className="num">Quantity</th></tr></thead>
            <tbody>
              {transactions.map((transaction, index) => (
                <tr key={`${transaction.type}-${index}`}>
                  <td>{transactionLabel(transaction.type)}</td>
                  <td>{formatDate(transaction.effectiveDate)}</td>
                  <td>{securityName(transaction.securityId)}</td>
                  <td className="num">{transaction.quantity === null ? DASH : format.shares(transaction.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {groups.length ? (
        <div aria-label="Changes">
          {groups.map((group) => (
            <section className="change-group" key={`${group.entity}-${group.id}`} aria-label={group.title}>
              <h4>{group.title}</h4>
              {group.vesting ? (
                <details className="adv mt-8">
                  <summary>Vesting schedule ({group.vesting.length} events{group.vesting.length ? `, ${formatDate(group.vesting[0]!.date)} to ${formatDate(group.vesting.at(-1)!.date)}` : ""})</summary>
                  <div className="adv-b tbl-scroll" style={{ maxHeight: 240, overflow: "auto" }}>
                    <table className="tbl dense" aria-label={`${group.title} schedule`}>
                      <thead><tr><th scope="col">Date</th><th scope="col" className="num">Tranche</th><th scope="col" className="num">Cumulative</th></tr></thead>
                      <tbody>
                        {group.vesting.map((event, index) => (
                          <tr key={`${event.date}-${index}`}>
                            <td>{formatDate(event.date)}{event.kind === "CLIFF" ? " · cliff" : ""}</td>
                            <td className="num">{format.shares(event.quantity)}</td>
                            <td className="num">{format.shares(event.cumulative)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : group.rows.length ? (
                group.rows.map((row) => (
                  <div className="change-row" key={row.key}>
                    <span>{row.label}</span>
                    <span className="cv">{row.before}<span className="arrow" aria-label="becomes">→</span><b>{row.after}</b></span>
                  </div>
                ))
              ) : <p className="small muted">No change.</p>}
            </section>
          ))}
        </div>
      ) : <p className="small muted">The server reports no change to holdings.</p>}
    </section>
  );
}

/** The warnings the real call needs acknowledged. */
export function WarningsToAcknowledge({ flow }: { flow: WriteFlow<unknown, unknown, unknown> }) {
  if (!flow.warnings.length) return null;
  return (
    <div className="mt-12" aria-label="Warnings">
      <h4>Warnings to acknowledge</h4>
      <div className="warn-list mt-8">
        {flow.warnings.map((warning) => (
          <div className="warn-item" key={warning.code}>
            <CheckLine checked={flow.acknowledged.has(warning.code)} onChange={(accepted) => flow.acknowledge(warning.code, accepted)} disabled={flow.busy || flow.locked}>
              {warning.message} <span className="mono small">({warning.code})</span>
            </CheckLine>
          </div>
        ))}
      </div>
      {!flow.acknowledgedAll ? <p className="small muted mt-8">Acknowledge each warning to continue.</p> : null}
    </div>
  );
}

/** "Type OPT-56 to confirm": irreversible-looking writes need the object's ID typed. */
export function TypedConfirmation({ expected, value, onChange, disabled }: { expected: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="fld typed-confirm">
      <label htmlFor={id}>Type <b className="mono">{expected}</b> to confirm</label>
      <input id={id} className="inp" autoComplete="off" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

export function confirmationMatches(typed: string, expected: string): boolean {
  return typed.trim() === expected;
}

/** What went wrong with the dry run or the real call, and what to do about it. */
export function FlowProblemBanner({ problem, onRetry, onCheck, busy }: { problem: FlowProblem | null; onRetry?: () => void; onCheck?: () => void; busy?: boolean }) {
  if (!problem) return null;
  switch (problem.kind) {
    case "invalid":
      return (
        <div className="mb-8">
          <Banner kind="danger" title={problem.message} />
          {problem.unplaced.length ? <div className="mt-8"><BlockList items={problem.unplaced} /></div> : null}
        </div>
      );
    case "warnings":
      return <Banner kind="warn" title="The server raised warnings to acknowledge">Tick each warning below, then confirm again.</Banner>;
    case "stale":
      return <Banner kind="warn" title="Review again">{problem.message}</Banner>;
    case "changed":
      return (
        <Banner kind="warn" title="Review again" action={onRetry ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onRetry}>Review again</button> : undefined}>
          {problem.message}
        </Banner>
      );
    case "blocked":
      return (
        <Banner kind="danger" title="This can't be recorded">
          {problem.message}
          {problem.dependents?.length ? (
            <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }} aria-label="Commands to reverse first">
              {problem.dependents.map((dependent) => <li key={dependent.commandId}>{commandLabel(dependent.type)} <span className="mono">{dependent.commandId.slice(0, 8)}</span></li>)}
            </ul>
          ) : null}
        </Banner>
      );
    case "failed":
      return (
        <Banner kind="danger" title="Nothing was confirmed" action={problem.retry && onRetry ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onRetry}>Try again</button> : undefined}>
          {problem.message} Trying again can never record it twice.
        </Banner>
      );
    case "unresolved":
      return (
        <Banner
          kind="danger"
          title="The answer was lost — the outcome is unknown"
          action={
            <span className="row nowrap" style={{ gap: 6 }}>
              {onRetry ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onRetry}>Try again</button> : null}
              {onCheck ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCheck}>Check what was recorded</button> : null}
            </span>
          }
        >
          {problem.message}
        </Banner>
      );
  }
}
