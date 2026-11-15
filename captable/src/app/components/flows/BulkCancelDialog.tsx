import { useRef, useState } from "react";
import { api, engine } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { FieldError } from "@/components/ui/field.tsx";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { ApiError } from "../../api/client.ts";
import { apiRequest, newIdempotencyKey } from "../../api/request.ts";
import { canonicalJson, classifyFailure, isAmbiguous, ledgerUnmoved, type FlowProblem } from "../../lib/flow.ts";
import { describeError } from "../../lib/errors.ts";
import { useWriteHold } from "../../lib/unsettled.ts";
import { formatDate } from "../../lib/format.ts";
import { isExecutionPending } from "../../lib/labels.ts";
import { useResource } from "../../lib/useResource.ts";
import { DismissButton, Modal } from "../Dialog.tsx";
import { ErrorFocus } from "../ErrorFocus.tsx";
import { DocumentUpload, type UploadedDocument } from "../DocumentUpload.tsx";
import { Badge, Banner, InlineError } from "../Feedback.tsx";
import { confirmationMatches, FlowProblemBanner, TypedConfirmation } from "../FlowParts.tsx";
import { CheckLine, DateField, SelectField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { CANCEL_REASON_LABELS } from "./CancelSecurityDialog.tsx";

// Cancel options or warrants from the cap table: multi-select sends one command per security, each with its own key.
// Each grant is cancelled in
// full and audited as its own command, so each has its own dry run, its own Idempotency-Key and its own reversal.
//
// The batch goes on without asking again as long as each grant still does what was reviewed: every
// cancellation moves the ledger head and the pool, so before each later grant (and after a 409 for any grant) its dry
// run is run again. If its effectSha256 — what the command itself does, the org-wide totals as deltas — equals the
// reviewed one and every warning it raises is one the admin acknowledged for that grant, it is sent with that dry run's
// new ledgerSeq and its new diffSha256, and the acknowledged codes. Otherwise the batch stops at that grant and shows
// its changed preview, with any new warning to acknowledge, to be confirmed again.

type Kind = "option" | "warrant";
const phrase = (count: number) => `CANCEL ${count} GRANT${count === 1 ? "" : "S"}`;

/** Every message of a refusal: this dialog has no per-field form, so they are shown together. */
const messagesOf = (failure: Extract<FlowProblem, { kind: "invalid" }>) => [...Object.values(failure.fields), ...failure.unplaced];

type CancelBody = api.CancelSecurityInput;
type CancelRequest = Pick<CancelBody, "securityId" | "effectiveDate" | "reason" | "documentId">;

interface Reviewed {
  security: api.Security;
  /** The request this grant's dry run previewed. The real call, a stale refresh and a check all use exactly it. */
  request: CancelRequest;
  /** The preview the admin confirmed (or, after a stop, the changed one shown for confirming again). */
  preview: api.CommandResult;
  /** Its effect changed since the admin confirmed the batch: shown again, to be confirmed again. */
  changed?: boolean;
  /** The warning codes the admin acknowledged for this grant, sent with its real call. */
  acknowledged: readonly string[];
  /** Warnings the real call raised (422 warnings_unacknowledged) that its preview didn't show. */
  raised?: readonly api.Warning[];
  done: boolean;
  /** The body last sent for this grant and its key. Kept while its outcome is unknown, so a retry resends both. */
  attempt: { body: CancelBody; json: string; key: string } | null;
}

type Phase = "edit" | "previewing" | "review" | "committing" | "unresolved";

export function BulkCancelDialog({ kind, onClose, onDone }: { kind: Kind; onClose: () => void; onDone: () => void }) {
  const { orgId, today, format, isOwn } = useWorkspace();
  const toast = useToast();
  const family = kind === "option" ? "EQUITY_COMPENSATION" : "WARRANT";
  const list = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, query: { family }, signal }), [orgId, family]);
  // The admin's own grants are never offered.
  const candidates = (list.data?.items ?? []).filter((security) => security.status === "OUTSTANDING" && engine.Dec.parse(security.numbers?.outstanding ?? "0").isPositive() && !isOwn(security.stakeholderId));
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState<api.CancelSecurity["reason"]>("HOLDER_WAIVER");
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  /** What the server refused, by grant: each refusal is shown on its grant's row. */
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [phase, setPhase] = useState<Phase>("edit");
  const [checking, setChecking] = useState(false);
  const [reviewed, setReviewed] = useState<Reviewed[]>([]);
  const [problem, setProblem] = useState<FlowProblem | null>(null);
  const [typed, setTyped] = useState("");
  /** The key of each grant's body: a retry of the same body reuses it, a changed body gets a new one. */
  const keys = useRef(new Map<string, { json: string; key: string }>());
  const title = kind === "option" ? "Cancel options" : "Cancel warrants";

  /** One grant's request, built at Review; a dry run needs no confirmation, and each real call confirms with the grant's own display ID. */
  const requestFor = (security: api.Security): CancelRequest => ({ securityId: security.id, effectiveDate: date, reason, documentId: document?.id ?? "" });
  const dryRun = (request: CancelRequest) => apiRequest(api.routes.cancelSecurity, { params: { orgId }, dryRun: true, body: request });
  // Held from the moment a cancellation is sent until every outcome in the batch is known (lib/unsettled).
  const hold = useWriteHold();

  const review = async () => {
    const found: Record<string, string> = {};
    if (!selected.size) found.selection = "Select at least one grant.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) found.date = "Enter the cancellation date.";
    else if (date > today) found.date = "A cancellation can't be dated in the future.";
    if (!document) found.document = "Upload the supporting document.";
    setErrors(found);
    if (Object.keys(found).length) return;
    setPhase("previewing");
    setProblem(null);
    const chosen = candidates.filter((security) => selected.has(security.id));
    const requests = chosen.map(requestFor);
    const outcomes = await Promise.allSettled(requests.map(dryRun));
    // A refusal concerns one grant, so it goes on that grant's row; anything else (a lost answer, a block) above the form.
    const refused: Record<string, string> = {};
    const previews: api.CommandResult[] = [];
    let other: FlowProblem | null = null;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "fulfilled") {
        previews.push(outcome.value);
        continue;
      }
      const failure = classifyFailure(outcome.reason);
      if (failure.kind === "invalid") refused[chosen[index]!.id] = messagesOf(failure).join(" ");
      else other ??= failure;
    }
    setRowErrors(refused);
    if (other || Object.keys(refused).length) {
      setProblem(other ?? { kind: "invalid", message: "The server refused the grants marked below. Deselect them or change the cancellation, then review again.", fields: {}, unplaced: [] });
      setPhase("edit");
      return;
    }
    setReviewed(chosen.map((security, index) => ({ security, request: requests[index]!, preview: previews[index]!, acknowledged: [], done: false, attempt: null })));
    setPhase("review");
  };

  const keyFor = (securityId: string, json: string) => {
    const known = keys.current.get(securityId);
    if (known?.json === json) return known.key;
    const key = newIdempotencyKey();
    keys.current.set(securityId, { json, key });
    return key;
  };

  /** Why a refused grant stopped the batch, by its 409's reason: said as it is. */
  const staleReason = (error: unknown) => (error instanceof ApiError ? error.reason : null);

  const commit = async () => {
    const resuming = phase === "unresolved";
    hold(true);
    setPhase("committing");
    setProblem(null);
    const next = [...reviewed];
    // A grant recorded in this run moved the ledger head: each later grant is previewed again before it is sent.
    let headMoved = false;
    for (const [index, item] of next.entries()) {
      if (item.done) continue;
      // A grant whose answer was lost is resent exactly as it was, with its key, before anything else.
      let attempt = resuming && item.attempt ? item.attempt : null;
      let basis = { ledgerSeq: item.preview.ledgerSeq, diffSha256: item.preview.diffSha256 };
      let rerun = headMoved && attempt === null;
      let refusedFor: string | null = null;
      let rounds = 0;
      for (;;) {
        if (!attempt) {
          if (rerun) {
            let fresh: api.CommandResult;
            try {
              fresh = await dryRun(item.request);
            } catch (error) {
              hold(false);
              setReviewed([...next]);
              const failure = classifyFailure(error);
              setProblem(failure.kind === "invalid" ? { ...failure, fields: {}, unplaced: messagesOf(failure).map((message) => `${item.security.displayId}: ${message}`) } : failure);
              setPhase("review");
              return;
            }
            // The same effect, and every warning one the admin acknowledged for this grant: it is what they confirmed,
            // at a new seq and diff.
            const sameEffect = fresh.effectSha256 === item.preview.effectSha256;
            const newWarnings = fresh.warnings.filter((warning) => !item.acknowledged.includes(warning.code));
            if (!sameEffect || newWarnings.length > 0) {
              hold(false);
              next[index] = { ...next[index]!, preview: fresh, changed: !sameEffect || next[index]!.changed, raised: [], attempt: null };
              setReviewed([...next]);
              const why = refusedFor === "stale_ledger" ? "Another write moved the ledger since you confirmed, and"
                : refusedFor === "state_changed" ? "Its recorded changes no longer matched the reviewed ones, and" : "Since you confirmed,";
              setProblem({ kind: "stale", message: !sameEffect
                ? `${item.security.displayId}: ${why} what its cancellation does has changed${newWarnings.length ? ", with a new warning to acknowledge" : ""}. Its new preview is below: review it, then confirm again. Grants already cancelled keep their commands.`
                : `${item.security.displayId}: its cancellation now raises a warning you haven't acknowledged. Acknowledge it below, then confirm again. Grants already cancelled keep their commands.` });
              setPhase("review");
              return;
            }
            basis = { ledgerSeq: fresh.ledgerSeq, diffSha256: fresh.diffSha256 };
          }
          // Only codes of warnings this grant raises now are sent: an acknowledgement is for a warning shown.
          const shown = new Set([...next[index]!.preview.warnings, ...(next[index]!.raised ?? [])].map((warning) => warning.code));
          const acknowledge = item.acknowledged.filter((code) => shown.has(code));
          const sent: CancelBody = { ...item.request, confirmation: item.security.displayId, expectedLedgerSeq: basis.ledgerSeq, expectedDiffSha256: basis.diffSha256, acknowledge };
          const json = canonicalJson(sent);
          attempt = { body: sent, json, key: keyFor(item.security.id, json) };
        }
        next[index] = { ...next[index]!, attempt };
        setReviewed([...next]);
        try {
          await apiRequest(api.routes.cancelSecurity, { params: { orgId }, body: attempt.body, idempotencyKey: attempt.key });
          next[index] = { ...next[index]!, done: true, changed: false, attempt: null };
          setReviewed([...next]);
          headMoved = true;
          break;
        } catch (error) {
          if (isAmbiguous(error)) {
            // It may have been recorded: nothing changes (not even Back) until a retry or a check settles it.
            setProblem({ kind: "unresolved", message: `${item.security.displayId}: ${describeError(error)} It may have been recorded. Try again: if it was, the server returns that result instead of recording it twice.`, checked: false });
            setPhase("unresolved");
            return;
          }
          next[index] = { ...next[index]!, attempt: null };
          attempt = null;
          const failure = classifyFailure(error);
          // A stale seq (409 stale_ledger: another write) or a diff that no longer matches (409 state_changed): nothing
          // was recorded; preview the grant again and go on only if it still does what was confirmed.
          if (failure.kind === "stale" && rounds < 2) {
            rounds += 1;
            refusedFor = staleReason(error);
            rerun = true;
            continue;
          }
          hold(false);
          if (failure.kind === "warnings") {
            // The real call raised a warning its preview didn't show: it is shown on the grant, to acknowledge first.
            next[index] = { ...next[index]!, raised: failure.warnings };
            setReviewed([...next]);
            setProblem({ kind: "warnings", warnings: failure.warnings });
            setPhase("review");
            return;
          }
          setReviewed([...next]);
          setProblem(
            failure.kind === "stale" ? { kind: "stale", message: `${item.security.displayId}: the ledger kept changing while the batch was recorded. Review the previews again before you confirm.` }
            : failure.kind === "invalid" ? { ...failure, fields: {}, unplaced: messagesOf(failure).map((message) => `${item.security.displayId}: ${message}`) }
            : failure,
          );
          setPhase("review");
          return;
        }
      }
    }
    hold(false);
    toast({ message: `${next.length} grant${next.length === 1 ? "" : "s"} cancelled — each is its own audited command.` });
    onDone();
  };

  /** After a lost answer: the grant's dry run again. The same ledger head means its cancellation wasn't recorded. */
  const check = async () => {
    const item = reviewed.find((entry) => entry.attempt !== null && !entry.done);
    if (!item) return;
    setChecking(true);
    try {
      // The head the lost call was sent at (a later grant goes at its re-run seq, not the reviewed one): unmoved, the
      // cancellation wasn't recorded.
      const outcome = await ledgerUnmoved(() => dryRun(item.request), item.attempt!.body.expectedLedgerSeq);
      if (outcome === "not_recorded") {
        hold(false);
        setReviewed((current) => current.map((entry) => (entry.security.id === item.security.id ? { ...entry, attempt: null } : entry)));
        setProblem({ kind: "failed", message: `${item.security.displayId}: the server has no record of it, so nothing was recorded. Confirm again, or go back and change the cancellation.`, retry: true });
        setPhase("review");
      } else {
        setProblem({ kind: "unresolved", message: `${item.security.displayId}: the ledger moved since your review, so it may have been recorded. Try again: if it was, the server returns that result instead of recording it twice.`, checked: true });
      }
    } catch (error) {
      setProblem({ kind: "unresolved", message: `${item.security.displayId}: couldn't check (${describeError(error)}). Try again: it can never be recorded twice.`, checked: false });
    } finally {
      setChecking(false);
    }
  };

  /** The warnings a grant raises now: its preview's, and any its real call raised. */
  const warningsOf = (item: Reviewed) => [...item.preview.warnings, ...(item.raised ?? [])].filter((warning, index, all) => all.findIndex((other) => other.code === warning.code) === index);
  const acknowledge = (securityId: string, code: string, accepted: boolean) => setReviewed((current) => current.map((entry) => (entry.security.id !== securityId ? entry
    : { ...entry, acknowledged: accepted ? [...new Set([...entry.acknowledged, code])] : entry.acknowledged.filter((item) => item !== code) })));
  const allAcknowledged = reviewed.every((item) => item.done || warningsOf(item).every((warning) => item.acknowledged.includes(warning.code)));
  const totalCancelled = engine.Dec.sum(reviewed.map((item) => engine.Dec.parse(item.preview.transactions.find((transaction) => transaction.securityId === item.security.id)?.quantity ?? "0")));
  const footer = phase === "edit" || phase === "previewing" ? (
    <>
      <DismissButton onClick={onClose}>Close</DismissButton>
      <Button type="button" onClick={() => void review()} disabled={phase === "previewing"}>{phase === "previewing" ? "Checking…" : "Review…"}</Button>
    </>
  ) : (
    <>
      <Button type="button" variant="outline" onClick={() => { setPhase("edit"); setProblem(null); }} disabled={phase === "committing" || phase === "unresolved" || checking || reviewed.some((item) => item.done)}>Back</Button>
      <Button type="button" variant="destructive" onClick={() => void commit()} disabled={phase === "committing" || phase === "unresolved" || checking || !allAcknowledged || !confirmationMatches(typed.toUpperCase(), phrase(reviewed.length))}>
        {phase === "committing" ? "Cancelling…" : `Cancel ${reviewed.length} grant${reviewed.length === 1 ? "" : "s"}`}
      </Button>
    </>
  );
  return (
    <Modal title={phase === "edit" || phase === "previewing" ? title : "Review the cancellation"} onClose={onClose} footer={footer} dismissible={phase !== "committing" && phase !== "unresolved" && !checking}>
      <ErrorFocus>
      <FlowProblemBanner problem={problem} onRetry={phase === "edit" || phase === "previewing" ? () => void review() : () => void commit()} onCheck={phase === "unresolved" && !checking ? () => void check() : undefined} busy={checking || phase === "committing"} />
      {phase === "edit" || phase === "previewing" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">Select the grants to cancel in full. Options return to the pool under the plan's rules; warrants do not affect the pool. A data error is not a cancellation — use Reverse.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <DateField label="Cancellation date" required max={today} value={date} onChange={setDate} error={errors.date} />
            <SelectField label="Reason" required value={reason} onChange={(value) => setReason(value as api.CancelSecurity["reason"])} options={Object.entries(CANCEL_REASON_LABELS)} />
          </div>
          <DocumentUpload label="Supporting document" kind="OTHER" required value={document} onChange={setDocument} error={errors.document} />
          {list.error !== undefined ? <InlineError what="the grants" error={list.error} onRetry={list.reload} /> : !list.data ? <p className="text-xs text-muted-foreground" role="status">Loading the grants…</p> : (
            <div className="max-h-75 overflow-auto rounded-lg border">
              <Table aria-label="Grants to cancel">
                <TableHeader><TableRow><TableHead scope="col" className="w-10"><span className="sr-only">Select</span></TableHead><TableHead scope="col">ID</TableHead><TableHead scope="col">Stakeholder</TableHead><TableHead scope="col" className="text-right tabular-nums whitespace-nowrap">Outstanding</TableHead></TableRow></TableHeader>
                <TableBody>
                  {candidates.map((security) => (
                    <TableRow key={security.id}>
                      <TableCell><Checkbox aria-label={`Select ${security.displayId}`} aria-invalid={rowErrors[security.id] ? true : undefined}
                        aria-describedby={rowErrors[security.id] ? `bulk-err-${security.id}` : undefined} checked={selected.has(security.id)} onCheckedChange={(checked) => setSelected((current) => {
                        const nextSet = new Set(current);
                        if (checked === true) nextSet.add(security.id);
                        else nextSet.delete(security.id);
                        return nextSet;
                      })} /></TableCell>
                      <TableCell>
                        {security.displayId}{isExecutionPending(security.executionStatus) ? <> <Badge tone="amber">Execution pending</Badge></> : null}
                        {rowErrors[security.id] ? <FieldError id={`bulk-err-${security.id}`} className="mt-1 whitespace-normal">{rowErrors[security.id]}</FieldError> : null}
                      </TableCell>
                      <TableCell>{security.stakeholderName}</TableCell>
                      <TableCell className="text-right tabular-nums whitespace-nowrap">{format.shares(security.numbers?.outstanding)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {errors.selection ? <p className="text-sm font-medium text-destructive" role="alert">{errors.selection}</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p>Review what will be cancelled on <b>{formatDate(date)}</b> (reason: {CANCEL_REASON_LABELS[reason]}). Each grant is cancelled in full and audited as its own command; an admin can reverse each one.</p>
          <div className="rounded-lg border">
            <Table aria-label="Cancellation preview">
              <TableHeader><TableRow><TableHead scope="col">ID</TableHead><TableHead scope="col">Stakeholder</TableHead><TableHead scope="col" className="text-right tabular-nums whitespace-nowrap">Cancelled (server preview)</TableHead><TableHead scope="col">Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {reviewed.map((item) => (
                  <TableRow key={item.security.id}>
                    <TableCell>{item.security.displayId}</TableCell>
                    <TableCell>{item.security.stakeholderName}</TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">{format.shares(item.preview.transactions.find((transaction) => transaction.securityId === item.security.id)?.quantity ?? null)}</TableCell>
                    <TableCell>{item.done ? <Badge tone="green">Cancelled</Badge> : item.changed ? <Badge tone="amber">Changed — review again</Badge> : <Badge tone="grey">To cancel</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter><TableRow><TableCell colSpan={2}>Total</TableCell><TableCell className="text-right tabular-nums whitespace-nowrap">{format.shares(totalCancelled.toString())}</TableCell><TableCell /></TableRow></TableFooter>
            </Table>
          </div>
          {reviewed.filter((item) => !item.done && warningsOf(item).length > 0).map((item) => (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40" key={item.security.id} aria-label={`Warnings for ${item.security.displayId}`}>
              <h4 className="text-sm font-medium">Warnings to acknowledge — {item.security.displayId}</h4>
              {warningsOf(item).map((warning) => (
                <CheckLine key={warning.code} checked={item.acknowledged.includes(warning.code)} onChange={(accepted) => acknowledge(item.security.id, warning.code, accepted)} disabled={phase === "committing" || phase === "unresolved" || checking}>
                  {warning.message} <span className="font-mono text-xs">({warning.code})</span>
                </CheckLine>
              ))}
            </div>
          ))}
          {!allAcknowledged ? <p className="text-xs text-muted-foreground">Acknowledge each grant's warnings to continue.</p> : null}
          {kind === "warrant" ? <p className="text-xs text-muted-foreground">Warrants do not affect the pool.</p> : null}
          {reviewed.some((item) => item.done) && reviewed.some((item) => !item.done) ? <Banner kind="warn" title="Some grants are already cancelled">Confirming again cancels only the ones still to cancel; the others keep their recorded commands.</Banner> : null}
          <TypedConfirmation expected={phrase(reviewed.length)} value={typed} onChange={setTyped} disabled={phase === "committing" || phase === "unresolved" || checking} />
        </div>
      )}
      </ErrorFocus>
    </Modal>
  );
}
