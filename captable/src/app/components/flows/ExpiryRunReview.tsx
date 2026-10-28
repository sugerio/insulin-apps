import { useRef, useState } from "react";
import { api } from "#shared";
import { ApiError } from "../../api/client.ts";
import { ApiRequestError, apiRequest, newIdempotencyKey } from "../../api/request.ts";
import { describeError } from "../../lib/errors.ts";
import { EXPIRY_RUN_STATE_LABELS, expiryReasonLabel, isConfirmable } from "../../lib/expiry.ts";
import { canonicalJson, classifyFailure, isAmbiguous, type FlowProblem } from "../../lib/flow.ts";
import { transactionLabel } from "../../lib/changes.ts";
import { formatDate } from "../../lib/format.ts";
import { SECURITY_STATUS_LABELS } from "../../lib/labels.ts";
import { useWriteHold } from "../../lib/unsettled.ts";
import { ErrorFocus } from "../ErrorFocus.tsx";
import { Badge, Banner } from "../Feedback.tsx";
import { CommandPreview, confirmationMatches, FlowProblemBanner, TypedConfirmation } from "../FlowParts.tsx";
import { CheckLine } from "../Form.tsx";
import { HolderLink, SecurityLink } from "../Links.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";

// Confirming a report-only expiry run, owners and admins. The run (`GET …/expiry-runs/
// :runId`) lists what processing due items would have expired, each with what confirming would cancel today
// (`confirmable`); the admin chooses which to expire now, as themselves, one command per security. A proposal with nothing left to
// expire (`confirmable: null`) and the admin's own holdings are never sent.
//
// 1. "Check" runs the confirmation's dry run for the chosen securities at the current ledger head: one result per
//    security, in order, each with the `effectSha256` of what its expiry does. A refusal that names securities
//    (NOT_EXPIRABLE, NOT_IN_EXPIRY_RUN) is shown on their rows; one that doesn't (self-dealing) can be narrowed down by
//    checking each security on its own.
// 2. "Confirm" sends that check's head (`expectedLedgerSeq`) and each security's `effectSha256`
//    (`expectedEffectSha256s`), exactly for the securities checked, with an Idempotency-Key bound to that body.
//    - 409 stale_ledger: the head moved before anything was expired. The check runs again; confirm again.
//    - A lost answer: only the same request, with the same key, may go on (the server resumes it or returns what it
//      recorded), so "Try again" resends exactly it. There is no other check: a new request would find the run taken.
//    - A refusal before the server binds the run to the confirmation (the request's checks, the caller's role, the
//      run itself, securities outside the run) expired nothing: the review stays,
//      says so, and offers what helps (try again, or go back and check again).
//    - A refusal after it (409 state_changed, a 422 from an expiry, 403 self_dealing) stops the confirmation, perhaps
//      part-way: expiries are committed one by one, and the run is bound to this request. The securities are read
//      again and each is shown as expired or not; what wasn't expired waits for the next run.
// Expiries can't be reversed in the app (COMMAND_NOT_REVERSIBLE), so confirming also needs a typed phrase.

type Phase = "choose" | "checking" | "review" | "confirming" | "unresolved" | "stopped" | "done";

interface Checked {
  ids: string[];
  automatic: boolean;
  response: api.ConfirmExpiryRunResponse;
  /** Securities whose effect differs from the previous check of the same selection (after a stale head). */
  changed: ReadonlySet<string>;
}

interface Attempt {
  body: api.ConfirmExpiryRun;
  json: string;
  key: string;
}

const phrase = (count: number) => `EXPIRE ${count} SECURIT${count === 1 ? "Y" : "IES"}`;

/** The field a refusal names: a violation's security goes on its row. */
const SECURITY_FIELD = "security:";
const fields = { violation: (violation: api.Violation) => (violation.securityId ? `${SECURITY_FIELD}${violation.securityId}` : null) };

function rowsOf(problem: FlowProblem): Record<string, string> {
  if (problem.kind !== "invalid") return {};
  return Object.fromEntries(Object.entries(problem.fields).filter(([key]) => key.startsWith(SECURITY_FIELD)).map(([key, message]) => [key.slice(SECURITY_FIELD.length), message]));
}

/** Why a check can't be confirmed from: the server must answer one result per security asked about, in order, at one head. */
function mismatchOf(runId: number, ids: readonly string[], response: api.ConfirmExpiryRunResponse): string | null {
  const seq = response.commands[0]?.ledgerSeq;
  const matches = response.runId === runId && response.commands.length === ids.length
    && response.commands.every((command, index) => command.ledgerSeq === seq && command.transactions.some((transaction) => transaction.securityId === ids[index]));
  return matches ? null : "The server's check didn't come back as one result per security asked about, so nothing can be confirmed from it. Check again.";
}

/**
 * Whether a refusal of the real call came before the server bound the run to this confirmation: the request's checks
 * (400), the console identity and role (401, 403 forbidden), the run itself (404), and securities outside the run
 * (422 NOT_IN_EXPIRY_RUN, checked before the reservation). Nothing was expired then. Everything else — 409
 * state_changed or idempotency_key_reused, a 422 from an expiry such as NOT_EXPIRABLE, 403 self_dealing — comes after
 * the reservation, or can't be told apart from one that does.
 */
function refusedBeforeReservation(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  switch (error.code) {
    case "validation_failed":
    case "unauthenticated":
    case "forbidden":
    case "not_found":
    case "payload_too_large":
    case "unsupported_media_type":
      return true;
    case "invariant_violation": {
      const codes = error instanceof ApiRequestError ? (error.body?.error.violations ?? []).map((violation) => violation.code) : [];
      return codes.length > 0 && codes.every((code) => code === "NOT_IN_EXPIRY_RUN");
    }
    default:
      return false;
  }
}

const NOTHING_EXPIRED = "Nothing was expired: the server refused the confirmation before starting it.";

function expiredQuantity(command: api.CommandResult | undefined, securityId: string): { quantity: string | null; date: string | null; type: string | null } {
  const transaction = command?.transactions.find((item) => item.securityId === securityId);
  return { quantity: transaction?.quantity ?? null, date: transaction?.effectiveDate ?? null, type: transaction?.type ?? null };
}

export function ExpiryRunReview({ run, onClose, onChanged }: {
  run: api.ExpiryRunDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { orgId, format, isOwn, reloadOrg, org } = useWorkspace();
  const toast = useToast();
  const hold = useWriteHold();
  const proposals = run.proposals;
  const own = (proposal: api.ExpiryProposal) => isOwn(proposal.holder.stakeholderId);
  // Offered: what is still expirable and not the admin's own holding (never theirs to confirm). All of it starts chosen.
  const offered = (proposal: api.ExpiryProposal) => isConfirmable(proposal) && !own(proposal);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(proposals.filter(offered).map((proposal) => proposal.securityId)));
  const [automatic, setAutomatic] = useState(false);
  const [phase, setPhase] = useState<Phase>("choose");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<FlowProblem | null>(null);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<api.ConfirmExpiryRunResponse | null>(null);
  const [stop, setStop] = useState<{ message: string; statuses: ReadonlyMap<string, api.SecurityStatus> | null } | null>(null);
  const [narrowing, setNarrowing] = useState(false);
  /** The last check was refused without naming securities (self-dealing, say): each can be checked on its own. */
  const [narrowable, setNarrowable] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const ordered = () => proposals.filter((proposal) => offered(proposal) && selected.has(proposal.securityId)).map((proposal) => proposal.securityId);
  const dryRun = (ids: readonly string[], switchToAutomatic: boolean) => apiRequest(api.routes.confirmExpiryRun, {
    params: { orgId, runId: run.runId }, dryRun: true, body: { securityIds: [...ids], switchToAutomatic },
  });

  /** The check (dry run) of a selection; `previous` is the check it refreshes after a stale head. */
  const check = async (ids: readonly string[], switchToAutomatic: boolean, previous: Checked | null = null) => {
    if (!ids.length) {
      setProblem({ kind: "invalid", message: "Choose at least one security to expire.", fields: {}, unplaced: [] });
      return;
    }
    setPhase("checking");
    if (!previous) setProblem(null);
    setRowErrors({});
    setNarrowable(false);
    try {
      const response = await dryRun(ids, switchToAutomatic);
      const mismatch = mismatchOf(run.runId, ids, response);
      if (mismatch) {
        setProblem({ kind: "blocked", message: mismatch });
        setPhase("choose");
        return;
      }
      const changed = new Set<string>(previous ? ids.filter((id, index) => previous.response.commands[previous.ids.indexOf(id)]?.effectSha256 !== response.commands[index]!.effectSha256) : []);
      setChecked({ ids: [...ids], automatic: switchToAutomatic, response, changed });
      setPhase("review");
    } catch (error) {
      const failure = classifyFailure(error, fields);
      const rows = rowsOf(failure);
      setRowErrors(rows);
      setNarrowable(ids.length > 1 && ((error instanceof ApiError && error.code === "self_dealing") || (failure.kind === "invalid" && Object.keys(rows).length === 0)));
      setProblem(failure.kind === "invalid" && Object.keys(rows).length
        ? { kind: "invalid", message: "The server refused the securities marked below. Leave them out and check again.", fields: {}, unplaced: failure.unplaced }
        : failure);
      setChecked(null);
      setPhase("choose");
    }
  };

  /** A refusal that names no security (self-dealing, say): check each chosen security on its own to find which. */
  const narrow = async () => {
    const ids = ordered();
    setNarrowing(true);
    const found: Record<string, string> = {};
    try {
      for (const id of ids) {
        try {
          await dryRun([id], automatic);
        } catch (error) {
          if (isAmbiguous(error)) throw error;
          const failure = classifyFailure(error, fields);
          found[id] = error instanceof ApiError && error.code === "self_dealing"
            ? "Your own holding (or a linked record's): another admin must confirm it."
            : failure.kind === "invalid" ? [...Object.values(failure.fields), ...failure.unplaced].join(" ") : "message" in failure ? failure.message : describeError(error);
        }
      }
      setRowErrors(found);
      setNarrowable(false);
      setProblem(Object.keys(found).length
        ? { kind: "invalid", message: "The server refused the securities marked below. Leave them out and check again.", fields: {}, unplaced: [] }
        : { kind: "failed", message: "Each security passed on its own. Check them together again.", retry: true });
    } catch (error) {
      setProblem({ kind: "failed", message: `Couldn't check each security (${describeError(error)}).`, retry: true });
    } finally {
      setNarrowing(false);
    }
  };

  const leaveOutRefused = () => {
    const next = new Set(selected);
    for (const id of Object.keys(rowErrors)) next.delete(id);
    setSelected(next);
    void check(proposals.filter((proposal) => offered(proposal) && next.has(proposal.securityId)).map((proposal) => proposal.securityId), automatic);
  };

  const confirm = async () => {
    if (!checked) return;
    const resuming = phase === "unresolved" && attempt.current !== null;
    const body: api.ConfirmExpiryRun = resuming ? attempt.current!.body : {
      expectedLedgerSeq: checked.response.commands[0]!.ledgerSeq,
      securityIds: checked.ids,
      expectedEffectSha256s: Object.fromEntries(checked.ids.map((id, index) => [id, checked.response.commands[index]!.effectSha256])),
      switchToAutomatic: checked.automatic,
    };
    const json = canonicalJson(body);
    const sending: Attempt = attempt.current?.json === json ? attempt.current : { body, json, key: newIdempotencyKey() };
    attempt.current = sending;
    hold(true);
    setPhase("confirming");
    setProblem(null);
    try {
      const response = await apiRequest(api.routes.confirmExpiryRun, { params: { orgId, runId: run.runId }, body: sending.body, idempotencyKey: sending.key });
      attempt.current = null;
      hold(false);
      setResult(response);
      setPhase("done");
      const count = response.commands.length;
      toast({ message: `${count} ${count === 1 ? "security" : "securities"} expired${response.expiryMode === "automatic" && org.settings.expiry.mode !== "automatic" ? " — expiry is automatic from now on" : ""}` });
      if (response.expiryMode !== org.settings.expiry.mode) reloadOrg();
      onChanged();
    } catch (error) {
      if (isAmbiguous(error)) {
        // It may have expired some or all of them: nothing changes until the same request settles it.
        setProblem({ kind: "unresolved", message: `${describeError(error)} Some or all of these may have been expired. Try again: the server resumes this same confirmation, or returns what it recorded — it never expires anything twice. Nothing else can be sent for this run until the outcome is known.`, checked: false });
        setPhase("unresolved");
        return;
      }
      attempt.current = null;
      hold(false);
      if (error instanceof ApiError && error.code === "conflict" && error.reason === "stale_ledger") {
        // Refused before anything was expired: the head moved since the check. Check the same selection again.
        setProblem({ kind: "stale", message: "Another write moved the ledger after your check, so nothing was expired. The results below were checked again at the new head: review them, then confirm again." });
        await check(checked.ids, checked.automatic, checked);
        return;
      }
      if (refusedBeforeReservation(error)) {
        refusedUpFront(error);
        return;
      }
      await stopped(error);
    }
  };

  /** A refusal before the run was bound: nothing expired, so the review stays with the recovery that fits. */
  const refusedUpFront = (error: unknown) => {
    const failure = classifyFailure(error, fields);
    const rows = rowsOf(failure);
    setRowErrors(rows);
    const code = error instanceof ApiError ? error.code : null;
    const messages = failure.kind === "invalid" ? [...Object.values(failure.fields).filter((message) => !Object.values(rows).includes(message)), ...failure.unplaced] : [];
    setProblem(
      Object.keys(rows).length ? { kind: "invalid", message: `${NOTHING_EXPIRED} Go back, leave the securities marked below out, and check again.`, fields: {}, unplaced: messages }
      : code === "validation_failed" ? { kind: "invalid", message: `${NOTHING_EXPIRED} Go back and check again.`, fields: {}, unplaced: messages }
      : code === "not_found" ? { kind: "blocked", message: `${NOTHING_EXPIRED} This run is no longer a report-only run of this company (${describeError(error)}). Go back to the runs.` }
      : { kind: "blocked", message: `${NOTHING_EXPIRED} ${describeError(error)}` },
    );
    setPhase("review");
  };

  /** A refusal of the real call: perhaps part-way, so each security is read again and shown as it now is. */
  const stopped = async (error: unknown) => {
    const failure = classifyFailure(error, fields);
    setRowErrors(rowsOf(failure));
    const reason = error instanceof ApiError ? error.reason : null;
    const said = error instanceof ApiError && error.code === "self_dealing"
      ? "The server refused a security on your own holdings (or a linked record's)."
      : error instanceof ApiError && error.code === "conflict" && reason === "state_changed"
        ? `The server stopped the confirmation (409 state_changed): ${error.message}${/[.!?]$/.test(error.message) ? "" : "."} An expiry whose effect is no longer the one checked isn't recorded.`
        : failure.kind === "invalid"
          ? `The server refused it: ${[...Object.values(failure.fields), ...failure.unplaced].join(" ")}`
          : describeError(error);
    let statuses: ReadonlyMap<string, api.SecurityStatus> | null = null;
    try {
      const list = await apiRequest(api.routes.listSecurities, { params: { orgId } });
      statuses = new Map(list.items.map((security) => [security.id, security.status]));
    } catch {
      statuses = null;
    }
    setStop({ message: said, statuses });
    setPhase("stopped");
    onChanged();
  };

  const busy = phase === "checking" || phase === "confirming" || narrowing;
  const locked = phase === "confirming" || phase === "unresolved";
  const reviewing = phase === "review" || phase === "confirming" || phase === "unresolved";
  const commands = checked ? new Map(checked.ids.map((id, index) => [id, checked.response.commands[index]!])) : new Map<string, api.CommandResult>();
  // Each recorded expiry by the security its transactions name (the answer lists them in the order sent).
  const results = result ? new Map(result.commands.flatMap((command) => {
    const securityId = command.transactions.find((transaction) => transaction.securityId !== null && checked?.ids.includes(transaction.securityId))?.securityId;
    return securityId ? [[securityId, command] as const] : [];
  })) : null;
  const shown = reviewing || phase === "done" || phase === "stopped" ? proposals.filter((proposal) => checked?.ids.includes(proposal.securityId)) : proposals;
  const refusedRows = Object.keys(rowErrors).length > 0;

  const statusNow = (proposal: api.ExpiryProposal) => {
    if (phase === "stopped") {
      if (!stop?.statuses) return <span className="muted">Not read again</span>;
      const status = stop.statuses.get(proposal.securityId);
      return status === "EXPIRED" ? <Badge tone="red">Expired</Badge> : <Badge tone="grey">Not expired{status ? ` (${SECURITY_STATUS_LABELS[status]})` : ""}</Badge>;
    }
    if (results) return results.has(proposal.securityId) ? <Badge tone="red">Expired</Badge> : null;
    if (!isConfirmable(proposal)) return <Badge tone="grey">Nothing left to expire</Badge>;
    if (own(proposal)) return <Badge tone="amber">Your own holding</Badge>;
    return <Badge tone="blue">To expire</Badge>;
  };

  return (
    <section className="card" aria-labelledby={`run-${run.runId}`}>
      <ErrorFocus>
        <div className="card-h">
          <h2 id={`run-${run.runId}`}>Expiry run of {formatDate(run.localDate)}</h2>
          {phase === "done" ? <Badge tone="green">Confirmed</Badge> : phase === "stopped" ? <Badge tone="amber">Stopped</Badge> : null}
        </div>
        {phase === "choose" || phase === "checking" ? (
          <p className="small">
            Choose what to expire now. Each one is cancelled with reason <b>Expired</b>, effective the day after its last exercise day, as its own command recorded by you; "Will be cancelled" is what confirming would cancel today. An expiry can't be reversed in the app. What you leave out isn't expired by this run.
          </p>
        ) : null}
        <FlowProblemBanner
          problem={problem}
          busy={busy}
          onRetry={phase === "unresolved" || (phase === "review" && problem?.kind === "failed") ? () => void confirm() : problem?.kind === "failed" ? () => void check(ordered(), automatic) : undefined}
        />
        {refusedRows && (phase === "choose" || phase === "checking") ? (
          <div className="row mb-8"><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={leaveOutRefused}>Leave the refused ones out and check again</button></div>
        ) : null}
        {narrowable && phase === "choose" ? (
          <div className="row mb-8">
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void narrow()}>{narrowing ? "Checking each security…" : "Find which securities the server refuses"}</button>
          </div>
        ) : null}
        {phase === "stopped" && stop ? (
          <Banner kind="danger" title="The confirmation stopped">
            {stop.message} Any security expired before it stopped stays expired{stop.statuses ? " — each is shown below as the ledger now has it" : " — the securities couldn't be read again: open each one to see its state"}. Once a confirmation has started, the run is bound to it, so it can't be confirmed again with another selection: what wasn't expired waits for the next expiry run.
          </Banner>
        ) : null}
        <div className="tbl-scroll">
          <table className="tbl" aria-label="Proposed expiries">
            <thead>
              <tr>
                {phase === "choose" || phase === "checking" ? <th scope="col"><span className="sr-only">Expire</span></th> : null}
                <th scope="col">Security</th>
                <th scope="col">Holder</th>
                <th scope="col">Why</th>
                <th scope="col">Last exercise day</th>
                <th scope="col">Expires on</th>
                <th scope="col" className="num">Proposed</th>
                <th scope="col" className="num">{reviewing || phase === "done" ? "Will be cancelled (server check)" : "Will be cancelled"}</th>
                <th scope="col">{phase === "stopped" || phase === "done" ? "Now" : "Status"}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((proposal) => {
                const mine = own(proposal);
                const expirable = isConfirmable(proposal);
                const command = commands.get(proposal.securityId);
                const effect = expiredQuantity(results?.get(proposal.securityId) ?? command, proposal.securityId);
                const checkedEffect = reviewing || phase === "done" || phase === "stopped";
                const error = rowErrors[proposal.securityId];
                return (
                  <tr key={proposal.securityId}>
                    {phase === "choose" || phase === "checking" ? (
                      <td>
                        <input type="checkbox" className="cb" aria-label={`Expire ${proposal.displayId}`} disabled={busy || !offered(proposal)}
                          title={!expirable ? "Nothing left to expire: it was exercised, cancelled or extended since the run" : mine ? "Your own holding: another admin confirms it" : undefined}
                          aria-invalid={error ? true : undefined} aria-describedby={error ? `exp-err-${proposal.securityId}` : undefined}
                          checked={selected.has(proposal.securityId) && offered(proposal)} onChange={(event) => setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(proposal.securityId);
                            else next.delete(proposal.securityId);
                            return next;
                          })} />
                      </td>
                    ) : null}
                    <td>
                      <SecurityLink id={proposal.securityId} family={proposal.family} displayId={proposal.displayId} />
                      {checked?.changed.has(proposal.securityId) && reviewing ? <> <Badge tone="amber">Changed since your last check</Badge></> : null}
                      {mine ? <div className="small muted">Your own holding: another admin confirms it.</div> : null}
                      {error ? <div className="err-inline" id={`exp-err-${proposal.securityId}`}>{error}</div> : null}
                    </td>
                    <td>
                      <HolderLink id={proposal.holder.stakeholderId} name={proposal.holder.name} />
                      {proposal.holder.email ? <div className="small muted">{proposal.holder.email}</div> : null}
                    </td>
                    <td>{expiryReasonLabel(proposal.reason)}</td>
                    <td>{formatDate(proposal.lastExerciseDate)}</td>
                    <td>{formatDate(checkedEffect ? effect.date ?? proposal.confirmable?.effectiveDate ?? proposal.effectiveDate : proposal.confirmable?.effectiveDate ?? proposal.effectiveDate)}</td>
                    <td className="num">{format.shares(proposal.quantity)}</td>
                    <td className="num">{checkedEffect ? format.shares(effect.quantity) : expirable ? format.shares(proposal.confirmable!.quantity) : <span className="muted">Nothing left</span>}</td>
                    <td>{statusNow(proposal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {reviewing && checked ? (
          <div className="stack-8 mt-12">
            {checked.ids.map((id) => {
              const command = commands.get(id)!;
              const proposal = proposals.find((item) => item.securityId === id)!;
              const type = expiredQuantity(command, id).type;
              return (
                <details key={id} className="adv">
                  <summary>{proposal.displayId}: what the ledger records{type ? ` (${transactionLabel(type)})` : ""}{command.warnings.length ? ` — ${command.warnings.length} note${command.warnings.length === 1 ? "" : "s"}` : ""}</summary>
                  <div className="adv-b">
                    {command.warnings.length ? (
                      <ul className="small" aria-label={`Notes for ${proposal.displayId}`} style={{ margin: "0 0 8px", paddingLeft: 18 }}>
                        {command.warnings.map((warning) => <li key={warning.code}>{warning.message} <span className="mono">({warning.code})</span></li>)}
                      </ul>
                    ) : null}
                    <CommandPreview transactions={command.transactions} changes={command.changes} names={new Map([[id, proposal.displayId]])} title={`${proposal.displayId}: the server's check`} />
                  </div>
                </details>
              );
            })}
            <div className="review-panel" aria-label="Review">
              <p>
                Confirming expires <b>{checked.ids.length} {checked.ids.length === 1 ? "security" : "securities"}</b> as you, one audited command each, held to exactly what this check shows
                {checked.automatic ? <>, and then switches the company to <b>automatic expiry</b>: from the next time due items are processed, options and warrants past their last exercise day expire without review — including any left out here that are still past it</> : <>. Expiry stays <b>report-only</b>: the next time due items are processed, anything still past its last exercise day is listed for review</>}.
              </p>
            </div>
            <TypedConfirmation expected={phrase(checked.ids.length)} value={typed} onChange={setTyped} disabled={locked} />
          </div>
        ) : null}
        {phase === "done" && result ? (
          <p className="small mt-12" role="status">
            {result.commands.length} {result.commands.length === 1 ? "security" : "securities"} expired, each its own command. Expiry is now <b>{result.expiryMode === "automatic" ? "automatic" : "report-only"}</b>.
          </p>
        ) : null}
        <div className="row mt-12">
          {phase === "choose" || phase === "checking" ? (
            <>
              <CheckLine checked={automatic} onChange={setAutomatic} disabled={busy}>Then switch to automatic expiry (after the first confirmed run, expiry is automatic)</CheckLine>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Back to the runs</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void check(ordered(), automatic)}>{phase === "checking" ? "Checking…" : "Check what confirming does"}</button>
            </>
          ) : reviewing ? (
            <>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => { setPhase("choose"); setProblem(null); setTyped(""); }}>Back</button>
              {phase === "unresolved" ? null : (
                <button type="button" className="btn btn-danger" disabled={locked || !confirmationMatches(typed.toUpperCase(), phrase(checked?.ids.length ?? 0))} onClick={() => void confirm()}>
                  {phase === "confirming" ? "Expiring…" : `Confirm ${checked?.ids.length ?? 0} ${checked?.ids.length === 1 ? "expiry" : "expiries"}`}
                </button>
              )}
            </>
          ) : (
            <>
              <span className="spacer" />
              <button type="button" className="btn btn-primary" onClick={onClose}>Back to the runs</button>
            </>
          )}
        </div>
      </ErrorFocus>
    </section>
  );
}

/**
 * A run shown to someone who can't confirm it now: an editor, or an admin while the company refuses writes or while
 * another confirmation is bound to the run. It shows what the run
 * proposes and what confirming would cancel today, and no write.
 */
export function ExpiryRunView({ run, note, onClose }: { run: api.ExpiryRunDetail; note: string; onClose: () => void }) {
  const { format } = useWorkspace();
  return (
    <section className="card" aria-labelledby={`run-${run.runId}`}>
      <div className="card-h">
        <h2 id={`run-${run.runId}`}>Expiry run of {formatDate(run.localDate)}</h2>
        <Badge tone={run.state === "confirmed" ? "green" : run.state === "superseded" ? "grey" : "amber"}>{EXPIRY_RUN_STATE_LABELS[run.state]}</Badge>
      </div>
      <p className="small">{note}</p>
      {run.confirmedAt !== null ? (
        <p className="small">Confirmed {format.dateTime(run.confirmedAt)}{run.confirmedBy ? ` by ${run.confirmedBy}` : ""}.</p>
      ) : run.confirmationStartedAt !== null ? (
        <p className="small">A confirmation started {format.dateTime(run.confirmationStartedAt)}; only it can finish the run, and what it doesn't expire waits for the next run.</p>
      ) : null}
      <div className="tbl-scroll">
        <table className="tbl" aria-label="Proposed expiries">
          <thead>
            <tr>
              <th scope="col">Security</th>
              <th scope="col">Holder</th>
              <th scope="col">Why</th>
              <th scope="col">Last exercise day</th>
              <th scope="col">Expires on</th>
              <th scope="col" className="num">Proposed</th>
              <th scope="col" className="num">Will be cancelled</th>
            </tr>
          </thead>
          <tbody>
            {run.proposals.map((proposal) => (
              <tr key={proposal.securityId}>
                <td><SecurityLink id={proposal.securityId} family={proposal.family} displayId={proposal.displayId} /></td>
                <td>
                  <HolderLink id={proposal.holder.stakeholderId} name={proposal.holder.name} />
                  {proposal.holder.email ? <div className="small muted">{proposal.holder.email}</div> : null}
                </td>
                <td>{expiryReasonLabel(proposal.reason)}</td>
                <td>{formatDate(proposal.lastExerciseDate)}</td>
                <td>{formatDate(proposal.confirmable?.effectiveDate ?? proposal.effectiveDate)}</td>
                <td className="num">{format.shares(proposal.quantity)}</td>
                <td className="num">{proposal.confirmable ? format.shares(proposal.confirmable.quantity) : <span className="muted">Nothing left to expire</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row mt-12">
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={onClose}>Back to the runs</button>
      </div>
    </section>
  );
}
