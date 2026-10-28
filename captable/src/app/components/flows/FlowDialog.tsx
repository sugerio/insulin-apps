import type { ReactNode } from "react";
import type { WriteFlow } from "../../lib/flow.ts";
import { DismissButton, Modal } from "../Dialog.tsx";
import { ErrorFocus } from "../ErrorFocus.tsx";
import { FlowProblemBanner, WarningsToAcknowledge } from "../FlowParts.tsx";

// The modal every command dialog shares (cancel, Mark executed, reverse and 409A dialogs): the fields,
// then "Review" freezes the request and runs its dry run; the server's preview, the warnings and any typed confirmation
// follow, and the confirm button sends the frozen request. The fields stay visible, read-only, while the admin reviews.
// From the moment the request is sent until its outcome is known (a lost answer included) nothing can be changed, and
// the dialog can't be closed: Escape, the backdrop and the close button wait for a retry or a check to settle it.

interface FlowDialogProps {
  title: string;
  flow: WriteFlow<unknown, unknown, unknown>;
  onClose: () => void;
  /** Validates the fields, then starts the review (usually `flow.review()`). */
  onReview: () => void;
  /** The fields. */
  children: ReactNode;
  /** The server's preview and anything confirmed with it (a typed ID). */
  review?: ReactNode;
  confirmLabel: string;
  /** Kept disabled until the review is complete (the typed confirmation matches). */
  confirmReady?: boolean;
  danger?: boolean;
  reviewLabel?: string;
}

export function FlowDialog({ title, flow, onClose, onReview, children, review, confirmLabel, confirmReady = true, danger, reviewLabel = "Review" }: FlowDialogProps) {
  const editing = flow.phase === "edit" || flow.phase === "previewing";
  const footer = editing ? (
    <>
      <DismissButton onClick={onClose}>Cancel</DismissButton>
      <button type="button" className="btn btn-primary" onClick={onReview} disabled={flow.busy}>{flow.phase === "previewing" ? "Checking…" : reviewLabel}</button>
    </>
  ) : (
    <>
      <button type="button" className="btn btn-ghost" onClick={flow.edit} disabled={flow.busy || flow.locked}>Back</button>
      <button
        type="button"
        className={danger ? "btn btn-danger" : "btn btn-primary"}
        onClick={() => void flow.commit()}
        disabled={flow.busy || flow.locked || !confirmReady || !flow.acknowledgedAll}
      >
        {flow.phase === "committing" ? "Recording…" : confirmLabel}
      </button>
    </>
  );
  return (
    <Modal title={title} onClose={onClose} footer={footer} dismissible={!flow.unsettled}>
      <ErrorFocus>
        <FlowProblemBanner problem={flow.problem} onRetry={editing ? onReview : () => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
        <fieldset className="flow-fields form" disabled={!editing}>{children}</fieldset>
        {!editing ? (
          <div className="mt-12">
            {review}
            <WarningsToAcknowledge flow={flow} />
          </div>
        ) : null}
      </ErrorFocus>
    </Modal>
  );
}
