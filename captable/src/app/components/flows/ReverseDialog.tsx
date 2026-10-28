import { useEffect, useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { useMe } from "../../auth/AuthProvider.tsx";
import { commandLabel, transactionLabel } from "../../lib/changes.ts";
import { formatDate } from "../../lib/format.ts";
import { useWriteFlow } from "../../lib/flow.ts";
import { RELATIONSHIP_LABELS } from "../../lib/labels.ts";
import { useResource } from "../../lib/useResource.ts";
import { DescriptionList } from "../DescriptionList.tsx";
import { Modal } from "../Dialog.tsx";
import { ErrorFocus } from "../ErrorFocus.tsx";
import { Banner, InlineError } from "../Feedback.tsx";
import { CommandPreview, confirmationMatches, FlowProblemBanner, TypedConfirmation } from "../FlowParts.tsx";
import { TextAreaField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";

// Reverse (owners and admins): a whole command is undone by one
// X_REVERSAL per transaction, in one batch, with a reason. The server's reversal preview shows the inverse transactions,
// the commands that depend on it (they are reversed first, each with its own reason), the effects and whether it is
// blocked; the main object's label is typed to confirm. Imported history isn't reversible in the app.

/** What can be reversed: an exercise with its shares, a grant, termination, cancellation, Mark executed or identity merge. */
export const REVERSIBLE_COMMAND_TYPES = new Set(["exercise-option", "grant-equity-compensation", "terminate-stakeholder", "cancel-security", "mark-executed", "merge-stakeholders"]);

export interface ReverseTarget {
  /**
   * The command to reverse: a termination's, an exercise share's origin, or a security's `lastReversibleCommandId` (the
   * server's newest command on it that reverse-command would accept now). Null when there is none.
   */
  commandId: string | null;
  /** What the admin types for a command on a security: the display ID of the security it was recorded on. */
  securityLabel: string;
  /** What the admin types for a termination: the stakeholder's name (the server's confirmation labels). */
  stakeholderName: string;
  title?: string;
}

/** The label the server accepts for a command: the stakeholder for a termination, else the security. */
export function reversalLabel(type: string, target: ReverseTarget): string {
  return type === "terminate-stakeholder" ? target.stakeholderName : target.securityLabel;
}

export function ReverseDialog({ target, onClose, onDone }: { target: ReverseTarget; onClose: () => void; onDone: (result: api.CommandResult) => void }) {
  const { orgId } = useWorkspace();
  const command = useResource(
    async (signal) => (target.commandId ? apiRequest(api.routes.getCommand, { params: { orgId, id: target.commandId }, signal }) : null),
    [orgId, target.commandId],
  );
  const title = target.title ?? "Reverse last transaction";
  if (command.data === undefined) {
    return (
      <Modal title={title} onClose={onClose}>
        {command.error !== undefined ? <InlineError what="the command to reverse" error={command.error} onRetry={command.reload} /> : <p className="muted" role="status">Finding the command to reverse…</p>}
      </Modal>
    );
  }
  if (command.data === null) {
    return (
      <Modal title={title} onClose={onClose} footer={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
        <Banner kind="info" title="Nothing to reverse">Nothing on this security can be reversed in the app now: imported history isn't reversible, and a command that later ones depend on waits until they are reversed.</Banner>
      </Modal>
    );
  }
  return <ReverseForm command={command.data} target={target} title={title} onClose={onClose} onDone={onDone} />;
}

function blockedReason(preview: api.ReversalPreview): string {
  if (preview.importedFromPulley) return "Imported history isn't reversible in the app.";
  if (preview.dependents.length) return "Later commands depend on this one. Reverse them first, newest first — each is its own act with its own reason.";
  if (preview.violations.length) return preview.violations.map((item) => item.message).join(" ");
  if (!REVERSIBLE_COMMAND_TYPES.has(preview.commandType)) return `A ${commandLabel(preview.commandType).toLowerCase()} can't be reversed in the app yet: record the facts again instead.`;
  return "The server won't reverse this command: it is already reversed, it is itself a reversal, or reversing it would break the ledger.";
}

function ReverseForm({ command, target, title, onClose, onDone }: { command: api.CommandDetail; target: ReverseTarget; title: string; onClose: () => void; onDone: (result: api.CommandResult) => void }) {
  const { orgId, format, today } = useWorkspace();
  const me = useMe();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const [noteError, setNoteError] = useState<string | undefined>();
  const expected = reversalLabel(command.type, target);
  const flow = useWriteFlow({
    request: () => ({ commandId: command.id }),
    preview: (frozen, signal) => apiRequest(api.routes.getReversalPreview, { params: { orgId, id: frozen.commandId }, signal }),
    // The reason and the typed label are given with the preview in view; they don't change it. The app sends no e-mail,
    // so there is no correction notice to choose.
    body: ({ request: frozen, preview }) => ({
      commandId: frozen.commandId, note: note.trim(),
      expectedLedgerSeq: preview!.ledgerSeq, expectedDiffSha256: preview!.diffSha256, confirmation: typed.trim(),
    }),
    send: (body, key) => apiRequest(api.routes.reverseCommand, { params: { orgId }, body, idempotencyKey: key }),
    // A recorded reversal marks the original in the same batch (reversedByCommandId).
    reconcile: async ({ request: frozen }) => ((await apiRequest(api.routes.getCommand, { params: { orgId, id: frozen.commandId } })).reversedByCommandId === null ? "not_recorded" : "unknown"),
    onCommitted: (result) => {
      toast({ message: `Reversed — ${commandLabel(command.type).toLowerCase()} (${expected})` });
      onDone(result);
    },
  });
  // The reversal preview needs no input: load it as the dialog opens.
  const startReview = flow.review;
  useEffect(() => {
    void startReview();
  }, [startReview, command.id]);
  const preview = flow.preview;
  const blocked = preview?.blocked ?? false;
  const confirm = () => {
    if (!note.trim()) {
      setNoteError("A reason is required.");
      return;
    }
    void flow.commit();
  };
  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={flow.unsettled}>Cancel</button>
      {preview ? (
        <button type="button" className="btn btn-danger" onClick={confirm} disabled={flow.busy || flow.locked || blocked || !confirmationMatches(typed, expected)}>
          {flow.phase === "committing" ? "Reversing…" : "Reverse"}
        </button>
      ) : flow.phase === "edit" ? (
        <button type="button" className="btn btn-primary" onClick={() => void flow.review()}>Review again</button>
      ) : null}
    </>
  );
  return (
    <Modal title={title} onClose={onClose} footer={footer} dismissible={!flow.unsettled}>
      <ErrorFocus>
      <div className="form">
        <DescriptionList rows={[["Command", `${commandLabel(command.type)} · ${expected}`], ["Recorded", `${format.dateTime(command.createdAt)}${command.actor ? ` by ${command.actor}` : ""}`]]} />
        <FlowProblemBanner problem={flow.problem} onRetry={() => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
        {flow.phase === "previewing" && !preview ? <p className="muted" role="status">Loading the reversal preview…</p> : null}
        {preview ? (
          <>
            {blocked ? (
              <Banner kind="danger" title="Blocked">
                {blockedReason(preview)}
                {preview.dependents.length ? (
                  <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }} aria-label="Commands to reverse first">
                    {preview.dependents.map((dependent) => <li key={dependent.commandId}>{commandLabel(dependent.type)} · {format.dateTime(dependent.createdAt)}</li>)}
                  </ul>
                ) : null}
              </Banner>
            ) : null}
            <section className="review-panel" aria-label="Reversal preview">
              <h3>What the reversal records</h3>
              <ul className="small" style={{ margin: "0 0 8px", paddingLeft: 18 }} aria-label="Inverse transactions">
                {preview.inverse.map((item) => <li key={item.reversesTransactionId}>Reverses: {transactionLabel(item.type)} ({formatDate(item.effectiveDate)})</li>)}
              </ul>
              {preview.workflowEffects.map((effect) => (
                <p className="small" key={`${effect.kind}-${effect.id}`}>
                  {effect.kind === "stakeholder_relationship"
                    ? `Relationship restored: ${RELATIONSHIP_LABELS[effect.from as api.Relationship] ?? effect.from} → ${RELATIONSHIP_LABELS[effect.to as api.Relationship] ?? effect.to}`
                    : `Exercise request: ${effect.from} → ${effect.to}`}
                </p>
              ))}
            </section>
            {preview.changes.length ? <div className="mt-8"><CommandPreview changes={preview.changes} title="What changes" /></div> : null}
            <TextAreaField label="Reason" required value={note} onChange={(value) => { setNote(value); setNoteError(undefined); }} placeholder="e.g. Cancelled in error — holder will sign" error={noteError} disabled={flow.locked} />
            <TypedConfirmation expected={expected} value={typed} onChange={setTyped} disabled={flow.busy || flow.locked || blocked} />
            <p className="small muted">The inverse transactions are written atomically; the original stays visible, marked “Reversed on {formatDate(today)} by {me.user.displayName ?? me.user.email}”.</p>
          </>
        ) : null}
      </div>
      </ErrorFocus>
    </Modal>
  );
}
