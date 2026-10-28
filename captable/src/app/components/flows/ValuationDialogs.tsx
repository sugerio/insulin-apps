import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { formatDate } from "../../lib/format.ts";
import { fieldProblem, useWriteFlow, type FieldMap, type Reconciled } from "../../lib/flow.ts";
import { DocumentUpload, type UploadedDocument } from "../DocumentUpload.tsx";
import { confirmationMatches, TypedConfirmation } from "../FlowParts.tsx";
import { DateField, TextAreaField, TextField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// The 409A events: flag a material event
// (review required, new grants blocked), clear a review with the provider's or counsel's written confirmation, void a
// valuation recorded in error, and reverse a material-event flag raised in error. Valuations are immutable: these
// append events, and the status is computed from them. None of these routes has a dry run, so the review is the
// dialog's own summary; the rest of the cycle (one key per intent, the server's 422s on their fields) is the same.

const EVENT_FIELDS: FieldMap = {
  issue: (path) => (path === "eventDate" ? "date" : path === "description" ? "description" : path === "documentId" ? "document" : path === "note" ? "note" : null),
  violation: (violation) => (violation.code === "NO_PRESUMPTIVELY_VALID_409A" ? "date" : null),
};

/** After a lost answer: whether the valuation now carries an event matching what was sent (it may be this one). */
async function eventRecorded(orgId: string, valuationId: string | null, matches: (event: api.ValuationEvent, valuation: api.Valuation) => boolean): Promise<Reconciled> {
  const valuations = (await apiRequest(api.routes.listValuations, { params: { orgId } })).items;
  const candidates = valuationId ? valuations.filter((valuation) => valuation.id === valuationId) : valuations;
  return candidates.some((valuation) => valuation.events.some((event) => matches(event, valuation))) ? "unknown" : "not_recorded";
}

interface EventFormState {
  date: string;
  description: string;
  document: UploadedDocument | null;
}

function useEventForm(today: string) {
  const [state, setState] = useState<EventFormState>({ date: today, description: "", document: null });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const set = <K extends keyof EventFormState>(key: K, value: EventFormState[K]) => {
    setState((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key === "date" ? "date" : key]: undefined }));
  };
  const validate = (documentRequired: boolean, futureAllowed = false) => {
    const found: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.date)) found.date = "Enter the date.";
    else if (!futureAllowed && state.date > today) found.date = "The date can't be in the future.";
    if (!state.description.trim()) found.description = "Describe it.";
    if (documentRequired && !state.document) found.document = "Upload the written confirmation.";
    setErrors(found);
    return Object.keys(found).length === 0;
  };
  return { state, set, errors, validate };
}

/** "Flag a material event" (RW+): the valuation presumptively valid on its date needs review. */
export function FlagMaterialEventDialog({ onClose, onDone }: { onClose: () => void; onDone: (valuation: api.Valuation) => void }) {
  const { orgId, today } = useWorkspace();
  const toast = useToast();
  const form = useEventForm(today);
  const flow = useWriteFlow({
    request: () => ({ eventDate: form.state.date, description: form.state.description.trim(), ...(form.state.document ? { documentId: form.state.document.id } : {}) }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.flagMaterialEvent, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: ({ request }) => eventRecorded(orgId, null, (event) => event.kind === "MATERIAL_EVENT" && event.eventDate === request.eventDate && event.description === request.description),
    fields: EVENT_FIELDS,
    onCommitted: (valuation) => {
      toast({ message: `Material event flagged — ${valuation.name}: review required` });
      onDone(valuation);
    },
  });
  const errorOf = (key: string) => form.errors[key] ?? fieldProblem(flow.problem, key);
  return (
    <FlowDialog
      title="Flag a material event"
      flow={flow as never}
      onClose={onClose}
      onReview={() => { if (form.validate(false)) void flow.review(); }}
      confirmLabel="Flag event"
      danger
      review={
        <div className="review-panel" aria-label="Review">
          <p>Flag <b>“{form.state.description.trim()}”</b> on {formatDate(form.state.date)}.</p>
          <p className="small">The 409A presumptively valid on that date becomes <b>Review required</b>: new grants are blocked and the dashboard shows a reminder until a new valuation is recorded or an admin records the written confirmation. Other valuations and draft 409A reports never take a flag.</p>
        </div>
      }
    >
      <DateField label="Date of the event" required max={today} value={form.state.date} onChange={(value) => form.set("date", value)} error={errorOf("date")} />
      <TextField label="Description" required value={form.state.description} onChange={(value) => form.set("description", value)} placeholder="e.g. Series B term sheet signed, secondary sale, new preferred class" error={errorOf("description")} />
      <DocumentUpload label="Document" kind="VALUATION_SUPPORT" value={form.state.document} onChange={(document) => form.set("document", document)} error={errorOf("document")} disabled={flow.phase !== "edit"} />
      <p className="small muted">Sets <b>Review required</b> on the 409A in effect, raises a dashboard reminder and blocks new grants until a new valuation (or written confirmation) is recorded.</p>
    </FlowDialog>
  );
}

/** "Record written confirmation" (owners and admins): the provider's or counsel's letter clears the review. */
export function ClearReviewDialog({ valuation, onClose, onDone }: { valuation: api.Valuation; onClose: () => void; onDone: (valuation: api.Valuation) => void }) {
  const { orgId, today } = useWorkspace();
  const toast = useToast();
  const form = useEventForm(today);
  const flow = useWriteFlow({
    request: () => ({ eventDate: form.state.date, description: form.state.description.trim(), documentId: form.state.document?.id ?? "" }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.clearValuationReview, { params: { orgId, id: valuation.id }, body, idempotencyKey: key }),
    reconcile: ({ request }) => eventRecorded(orgId, valuation.id, (event) => event.kind === "REVIEW_CLEARED" && event.eventDate === request.eventDate && event.description === request.description),
    fields: EVENT_FIELDS,
    onCommitted: (updated) => {
      toast({ message: `Confirmation recorded — ${updated.name} is presumptively valid again` });
      onDone(updated);
    },
  });
  const errorOf = (key: string) => form.errors[key] ?? fieldProblem(flow.problem, key);
  return (
    <FlowDialog
      title="Record written confirmation"
      flow={flow as never}
      onClose={onClose}
      onReview={() => { if (form.validate(true)) void flow.review(); }}
      confirmLabel="Record confirmation"
      review={
        <div className="review-panel" aria-label="Review">
          <p>Record the written confirmation that <b>{valuation.name}</b> still holds after the material event: “{form.state.description.trim()}” ({formatDate(form.state.date)}), with {form.state.document?.filename}.</p>
          <p className="small muted">It clears the material events recorded before it; one flagged later needs review again.</p>
        </div>
      }
    >
      <p className="small">Record the provider's or counsel's written confirmation that {valuation.name} still holds after the material event.</p>
      <DateField label="Date of the confirmation" required max={today} value={form.state.date} onChange={(value) => form.set("date", value)} error={errorOf("date")} />
      <TextField label="Description" required value={form.state.description} onChange={(value) => form.set("description", value)} placeholder="e.g. Provider's bring-down letter" error={errorOf("description")} />
      <DocumentUpload label="Confirmation letter" kind="VALUATION_SUPPORT" required value={form.state.document} onChange={(document) => form.set("document", document)} error={errorOf("document")} disabled={flow.phase !== "edit"} />
    </FlowDialog>
  );
}

/** "Void valuation" (owners and admins): a valuation recorded in error stops pricing anything; it is recorded again, never edited. */
export function VoidValuationDialog({ valuation, onClose, onDone }: { valuation: api.Valuation; onClose: () => void; onDone: (valuation: api.Valuation) => void }) {
  const { orgId, today } = useWorkspace();
  const toast = useToast();
  const form = useEventForm(today);
  const flow = useWriteFlow({
    request: () => ({ eventDate: form.state.date, description: form.state.description.trim(), ...(form.state.document ? { documentId: form.state.document.id } : {}) }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.voidValuation, { params: { orgId, id: valuation.id }, body, idempotencyKey: key }),
    reconcile: ({ request }) => eventRecorded(orgId, valuation.id, (event, current) => current.status === "voided" || (event.kind === "VOIDED" && event.description === request.description)),
    fields: EVENT_FIELDS,
    onCommitted: (updated) => {
      toast({ message: `${updated.name} voided` });
      onDone(updated);
    },
  });
  const errorOf = (key: string) => form.errors[key] ?? fieldProblem(flow.problem, key);
  return (
    <FlowDialog
      title={`Void ${valuation.name}`}
      flow={flow as never}
      onClose={onClose}
      onReview={() => { if (form.validate(false)) void flow.review(); }}
      confirmLabel="Void valuation"
      danger
      review={
        <div className="review-panel" aria-label="Review">
          <p>Void <b>{valuation.name}</b> ({valuation.provider ?? "provider not recorded"}, effective {formatDate(valuation.effectiveDate)}) as of {formatDate(form.state.date)}: “{form.state.description.trim()}”.</p>
          <p className="small">A voided valuation prices no new grant or exercise. A recorded 409A is never edited: record the corrected valuation next.</p>
        </div>
      }
    >
      <DateField label="Date" required max={today} value={form.state.date} onChange={(value) => form.set("date", value)} error={errorOf("date")} />
      <TextField label="Why it is void" required value={form.state.description} onChange={(value) => form.set("description", value)} placeholder="e.g. Recorded against the draft report" error={errorOf("description")} />
      <DocumentUpload label="Document" kind="VALUATION_SUPPORT" value={form.state.document} onChange={(document) => form.set("document", document)} error={errorOf("document")} disabled={flow.phase !== "edit"} />
    </FlowDialog>
  );
}

/**
 * "Reverse flag" (owners and admins): a material event flagged in error counts for nothing once reversed (once only). The typed
 * confirmation is the valuation's name, exactly (case-sensitive, surrounding spaces ignored).
 */
export function ReverseValuationEventDialog({ valuation, event, onClose, onDone }: { valuation: api.Valuation; event: api.ValuationEvent; onClose: () => void; onDone: (valuation: api.Valuation) => void }) {
  const { orgId } = useWorkspace();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | undefined>();
  const [typed, setTyped] = useState("");
  const flow = useWriteFlow({
    request: () => ({ note: note.trim() }),
    preview: null,
    body: ({ request }) => ({ ...request, confirmation: typed.trim() }),
    send: (body, key) => apiRequest(api.routes.reverseValuationEvent, { params: { orgId, id: valuation.id, eventId: event.id }, body, idempotencyKey: key }),
    reconcile: () => eventRecorded(orgId, valuation.id, (item) => item.kind === "EVENT_REVERSED" && item.reversesEventId === event.id),
    fields: EVENT_FIELDS,
    onCommitted: (updated) => {
      toast({ message: `Material event reversed — ${updated.name}` });
      onDone(updated);
    },
  });
  return (
    <FlowDialog
      title="Reverse a material-event flag"
      flow={flow as never}
      onClose={onClose}
      onReview={() => { if (note.trim()) void flow.review(); else setNoteError("A reason is required."); }}
      confirmLabel="Reverse flag"
      confirmReady={confirmationMatches(typed, valuation.name)}
      danger
      review={
        <>
          <div className="review-panel" aria-label="Review">
            <p>Reverse the material event <b>“{event.description}”</b> ({formatDate(event.eventDate)}) on {valuation.name}. It then counts for nothing; the status is computed again. A flag is reversed once.</p>
          </div>
          <TypedConfirmation expected={valuation.name} value={typed} onChange={setTyped} disabled={flow.busy || flow.locked} />
        </>
      }
    >
      <p className="small">{valuation.name} · flagged {formatDate(event.eventDate)} by {event.createdBy}: “{event.description}”</p>
      <TextAreaField label="Reason" required value={note} onChange={(value) => { setNote(value); setNoteError(undefined); }} placeholder="e.g. Flagged on the wrong company" error={noteError ?? fieldProblem(flow.problem, "note")} />
    </FlowDialog>
  );
}
