import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { formatDate } from "../../lib/format.ts";
import { fieldProblem, useWriteFlow } from "../../lib/flow.ts";
import { TERMINATION_TYPE_LABELS } from "../../lib/labels.ts";
import { useResource } from "../../lib/useResource.ts";
import { Modal } from "../Dialog.tsx";
import { InlineError } from "../Feedback.tsx";
import { TextAreaField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// Cancel a scheduled termination (owners and admins): the stakeholder stays active and nothing is cancelled. It is a
// workflow transition by id with the version read: if processing due items applied it first, the server says so and
// the applied termination is reversed instead. Changing the date means cancelling, then recording it again.

type Scheduled = api.SecuritiesStatus["scheduledTerminations"][number];

interface Props {
  scheduledTerminationId: string;
  stakeholderName: string;
  onClose: () => void;
  onDone: (result: api.ScheduledTermination) => void;
}

/** The row of Securities Status carries the version the transition sends; it is read fresh when the dialog opens. */
export function CancelScheduledTerminationDialog({ scheduledTerminationId, stakeholderName, onClose, onDone }: Props) {
  const { orgId } = useWorkspace();
  const status = useResource((signal) => apiRequest(api.routes.getSecuritiesStatus, { params: { orgId }, signal }), [orgId]);
  const row = status.data?.scheduledTerminations.find((item) => item.id === scheduledTerminationId) ?? null;
  if (!status.data || !row) {
    return (
      <Modal title="Cancel the scheduled termination" onClose={onClose}>
        {status.error !== undefined ? <InlineError what="the scheduled termination" error={status.error} onRetry={status.reload} />
          : status.data ? <p>This termination is no longer scheduled: it was applied or cancelled. Reload the page to see its current state.</p>
            : <p className="muted" role="status">Loading the scheduled termination…</p>}
      </Modal>
    );
  }
  return <CancelForm row={row} stakeholderName={stakeholderName} onClose={onClose} onDone={onDone} reload={async () => { status.reload(); }} />;
}

function CancelForm({ row, stakeholderName, onClose, onDone }: { row: Scheduled; stakeholderName: string; onClose: () => void; onDone: (result: api.ScheduledTermination) => void; reload: () => Promise<void> }) {
  const { orgId, format } = useWorkspace();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | undefined>();
  // The version the transition sends; a stale answer reads it again before the next review.
  const [version, setVersion] = useState(row.version);
  // Set when a re-read finds the row gone: processing due items applied it, or someone cancelled it.
  const [gone, setGone] = useState(false);
  const readRow = async () => (await apiRequest(api.routes.getSecuritiesStatus, { params: { orgId } })).scheduledTerminations.find((item) => item.id === row.id) ?? null;
  const flow = useWriteFlow({
    request: () => ({ scheduledTerminationId: row.id, version, note: note.trim() }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.cancelScheduledTermination, { params: { orgId }, body, idempotencyKey: key }),
    refresh: async () => {
      const current = await readRow();
      if (current) setVersion(current.version);
      else setGone(true);
    },
    // Still scheduled at the version sent: the transition didn't happen.
    reconcile: async ({ request }) => ((await readRow())?.version === request.version ? "not_recorded" : "unknown"),
    fields: { issue: (path) => (path === "note" ? "note" : null) },
    onCommitted: (result) => {
      toast({ message: `Scheduled termination cancelled — ${stakeholderName} stays active` });
      onDone(result);
    },
  });
  const review = () => {
    if (!note.trim()) {
      setNoteError("A reason is required.");
      return;
    }
    void flow.review();
  };
  return (
    <FlowDialog
      title="Cancel the scheduled termination"
      flow={flow as never}
      onClose={onClose}
      onReview={review}
      confirmLabel="Cancel scheduled termination"
      confirmReady={!gone}
      danger
      review={
        gone ? (
          <div className="review-panel" aria-label="Review">
            <p><b>This termination is no longer scheduled</b>: it was applied when due items were processed, or someone cancelled it. Close this and reload the page. An admin reverses an applied termination instead.</p>
          </div>
        ) : <div className="review-panel" aria-label="Review">
          <p>
            Cancel the termination of <b>{stakeholderName}</b> scheduled for <b>{formatDate(row.terminationDate)}</b> ({TERMINATION_TYPE_LABELS[row.type]}).
            {" "}{row.securitiesAffected} securit{row.securitiesAffected === 1 ? "y" : "ies"} keep vesting; the {format.shares(row.unvestedToCancel)} unvested options it would cancel stay outstanding.
          </p>
          <p className="small muted">To change the date, cancel it, then record the termination again.</p>
        </div>
      }
    >
      <p className="small">{stakeholderName} · TERMINATING {formatDate(row.terminationDate)} · {TERMINATION_TYPE_LABELS[row.type]}</p>
      <TextAreaField label="Reason" required value={note} onChange={(value) => { setNote(value); setNoteError(undefined); }} placeholder="e.g. Employee decided to stay" error={noteError ?? fieldProblem(flow.problem, "note")} />
    </FlowDialog>
  );
}
