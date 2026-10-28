import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { DASH, formatDate } from "../../lib/format.ts";
import { fieldProblem, ledgerUnmoved, useWriteFlow, type FieldMap } from "../../lib/flow.ts";
import * as terms from "../../lib/terms.ts";
import { DocumentUpload, type UploadedDocument } from "../DocumentUpload.tsx";
import { CommandPreview, confirmationMatches, TypedConfirmation } from "../FlowParts.tsx";
import { DateField, SelectField, TextAreaField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// Extend an exercise deadline (owners and admins): a separation
// agreement or counsel's approval moves the contractual deadline later, never past the expiration date. The ISO
// deadline never moves; extending an ISO's window may modify the ISO, so the server warns and counsel decides.

type Result = api.CommandResult;

const FIELDS: FieldMap = {
  issue: (path) => (path === "newContractualDeadline" ? "deadline" : path === "documentId" ? "document" : path === "note" ? "note" : null),
  violation: (violation) => ({ EXTENSION_SHORTENS_DEADLINE: "deadline", EXTENSION_AFTER_EXPIRATION: "deadline", DOCUMENT_ARCHIVED: "document", DOCUMENT_IS_COMPANY_RESOURCE: "document", DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER: "document" } as Record<string, string>)[violation.code] ?? null,
};

const DOCUMENT_KINDS = [["SEPARATION_AGREEMENT", "Separation agreement"], ["COUNSEL_MEMO", "Counsel's approval"]] as const;

export function ExtendDeadlineDialog({ security, onClose, onDone }: { security: api.SecurityDetail; onClose: () => void; onDone: (result: Result) => void }) {
  const { orgId, today } = useWorkspace();
  const toast = useToast();
  const current = security.deadlines?.contractual ?? null;
  const expiration = terms.expirationDate(security.terms);
  const [deadline, setDeadline] = useState("");
  const [kind, setKind] = useState<(typeof DOCUMENT_KINDS)[number][0]>("SEPARATION_AGREEMENT");
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const request = () => ({ securityId: security.id, newContractualDeadline: deadline, documentId: document?.id ?? "", note: note.trim() });
  const dryRun = (frozen: ReturnType<typeof request>, signal?: AbortSignal) => apiRequest(api.routes.extendExerciseDeadline, { params: { orgId }, dryRun: true, body: frozen, signal });
  const flow = useWriteFlow({
    request,
    preview: dryRun,
    body: ({ request: frozen, preview, acknowledge }) => ({ ...frozen, confirmation: typed.trim(), expectedLedgerSeq: preview!.ledgerSeq, expectedDiffSha256: preview!.diffSha256, acknowledge: [...acknowledge] }),
    send: (body, key) => apiRequest(api.routes.extendExerciseDeadline, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: ({ request: frozen, preview }) => ledgerUnmoved(() => dryRun(frozen), preview!.ledgerSeq),
    fields: FIELDS,
    onCommitted: (result) => {
      toast({ message: `${security.displayId}: contractual deadline extended to ${formatDate(deadline)}` });
      onDone(result);
    },
  });
  const review = () => {
    const found: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) found.deadline = "Enter the new contractual deadline.";
    else if (current && deadline <= current) found.deadline = `An extension can't shorten or keep the contractual deadline (${formatDate(current)}).`;
    else if (expiration && deadline > expiration) found.deadline = `No extension can go past the expiration date (${formatDate(expiration)}).`;
    if (!document) found.document = "Upload the separation agreement or counsel's approval.";
    if (!note.trim()) found.note = "Say why the deadline is extended.";
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  return (
    <FlowDialog
      title={`Extend the exercise deadline — ${security.displayId}`}
      flow={flow as never}
      onClose={onClose}
      onReview={review}
      confirmLabel="Extend deadline"
      confirmReady={confirmationMatches(typed, security.displayId)}
      review={
        <>
          {flow.preview ? <CommandPreview transactions={flow.preview.transactions} changes={flow.preview.changes} names={new Map([[security.id, security.displayId]])} /> : null}
          <TypedConfirmation expected={security.displayId} value={typed} onChange={setTyped} disabled={flow.busy || flow.locked} />
        </>
      }
    >
      <p className="small muted">
        Current contractual deadline: <b>{formatDate(current)}</b> · expiration {expiration ? formatDate(expiration) : DASH}. The ISO deadline never moves{security.deadlines?.iso ? ` (${formatDate(security.deadlines.iso)})` : ""}.
      </p>
      <DateField label="New contractual deadline" required min={current ?? today} max={expiration ?? undefined} value={deadline} onChange={(value) => { setDeadline(value); setErrors((previous) => ({ ...previous, deadline: undefined })); }} error={errorOf("deadline")} />
      <SelectField label="Document type" value={kind} onChange={(value) => setKind(value as typeof kind)} options={DOCUMENT_KINDS} />
      <DocumentUpload label="Extension document" kind={kind} required value={document} onChange={(next) => { setDocument(next); setErrors((previous) => ({ ...previous, document: undefined })); }} error={errorOf("document")} disabled={flow.phase !== "edit"} />
      <TextAreaField label="Reason" required value={note} onChange={(value) => { setNote(value); setErrors((previous) => ({ ...previous, note: undefined })); }} placeholder="e.g. Extended to 6 months by the separation agreement" error={errorOf("note")} />
    </FlowDialog>
  );
}
