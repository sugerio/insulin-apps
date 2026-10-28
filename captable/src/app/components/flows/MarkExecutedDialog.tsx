import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { fieldProblem, ledgerUnmoved, useWriteFlow, type FieldMap } from "../../lib/flow.ts";
import { EXECUTION_LABELS } from "../../lib/labels.ts";
import { useResource } from "../../lib/useResource.ts";
import { Modal } from "../Dialog.tsx";
import { DocumentUpload, type UploadedDocument } from "../DocumentUpload.tsx";
import { InlineError } from "../Feedback.tsx";
import { CommandPreview, confirmationMatches, TypedConfirmation } from "../FlowParts.tsx";
import { CheckLine, DateField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// Mark executed: an execution-pending grant becomes
// exercisable once the agreement signed by both parties is uploaded, with the signature date(s) and the attestation.
// It is a ledger command, so an admin can reverse it.

type Result = api.CommandResult;
const ATTESTATION = "This PDF bears both signatures" as const;

const FIELDS: FieldMap = {
  issue: (path) => (path.startsWith("executedAgreement") ? "document" : path.startsWith("signatureDates.company") ? "company" : path.startsWith("signatureDates") ? "holder" : path === "attestation" ? "attest" : null),
  violation: (violation) => ({
    SIGNATURE_DATE_IN_FUTURE: "company", SIGNATURE_DATE_BEFORE_ISSUE: "company", DOCUMENT_ARCHIVED: "document", DOCUMENT_IS_COMPANY_RESOURCE: "document", DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER: "document",
  } as Record<string, string>)[violation.code] ?? null,
};

export function MarkExecutedDialog({ securityId, onClose, onDone }: { securityId: string; onClose: () => void; onDone: (result: Result) => void }) {
  const { orgId } = useWorkspace();
  const security = useResource((signal) => apiRequest(api.routes.getSecurity, { params: { orgId, id: securityId }, signal }), [orgId, securityId]);
  if (!security.data) {
    return (
      <Modal title="Mark executed" onClose={onClose}>
        {security.error !== undefined ? <InlineError what="the security" error={security.error} onRetry={security.reload} /> : <p className="muted" role="status">Loading the security…</p>}
      </Modal>
    );
  }
  return <MarkExecutedForm security={security.data} onClose={onClose} onDone={onDone} />;
}

function MarkExecutedForm({ security, onClose, onDone }: { security: api.SecurityDetail; onClose: () => void; onDone: (result: Result) => void }) {
  const { orgId, today } = useWorkspace();
  const toast = useToast();
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [company, setCompany] = useState("");
  const [holder, setHolder] = useState("");
  const [attest, setAttest] = useState(false);
  const [typed, setTyped] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const request = () => ({
    securityId: security.id,
    executedAgreementDocumentId: document?.id ?? "",
    signatureDates: { ...(company ? { company } : {}), ...(holder ? { holder } : {}) },
    attestation: ATTESTATION,
  });
  const dryRun = (frozen: ReturnType<typeof request>, signal?: AbortSignal) => apiRequest(api.routes.markExecuted, { params: { orgId }, dryRun: true, body: frozen, signal });
  const flow = useWriteFlow({
    request,
    preview: dryRun,
    body: ({ request: frozen, preview, acknowledge }) => ({ ...frozen, confirmation: typed.trim(), expectedLedgerSeq: preview!.ledgerSeq, expectedDiffSha256: preview!.diffSha256, acknowledge: [...acknowledge] }),
    send: (body, key) => apiRequest(api.routes.markExecuted, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: ({ request: frozen, preview }) => ledgerUnmoved(() => dryRun(frozen), preview!.ledgerSeq),
    fields: FIELDS,
    onCommitted: (result) => {
      toast({ message: `${security.displayId} marked executed` });
      onDone(result);
    },
  });
  const review = () => {
    const found: Record<string, string> = {};
    if (!document) found.document = "Upload the agreement signed by both the holder and the company signatory.";
    if (!company && !holder) found.company = "Enter at least one signature date.";
    for (const [key, value] of [["company", company], ["holder", holder]] as const) {
      if (value && value > today) found[key] = "A signature date can't be in the future.";
    }
    if (!attest) found.attest = "Confirm that the PDF bears both signatures.";
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  return (
    <FlowDialog
      title={`Mark ${security.displayId} executed`}
      flow={flow as never}
      onClose={onClose}
      onReview={review}
      confirmLabel="Confirm"
      confirmReady={confirmationMatches(typed, security.displayId)}
      review={
        <>
          {flow.preview ? <CommandPreview transactions={flow.preview.transactions} changes={flow.preview.changes} names={new Map([[security.id, security.displayId]])} /> : null}
          <TypedConfirmation expected={security.displayId} value={typed} onChange={setTyped} disabled={flow.busy || flow.locked} />
        </>
      }
    >
      <p className="small muted">{security.stakeholderName} · {EXECUTION_LABELS[security.executionStatus]}. Upload the agreement signed by both the holder and the company signatory.</p>
      <DocumentUpload label="Fully signed agreement" kind="GRANT_AGREEMENT" required value={document} onChange={(next) => { setDocument(next); setErrors((current) => ({ ...current, document: undefined })); }} error={errorOf("document")} disabled={flow.phase !== "edit"} />
      <div className="form-grid">
        <DateField label="Company signature date" max={today} value={company} onChange={(value) => { setCompany(value); setErrors((current) => ({ ...current, company: undefined })); }} error={errorOf("company")} />
        <DateField label="Holder signature date" max={today} value={holder} onChange={(value) => { setHolder(value); setErrors((current) => ({ ...current, holder: undefined })); }} error={errorOf("holder")} hint="The later date is when the grant becomes exercisable." />
      </div>
      <CheckLine checked={attest} onChange={(checked) => { setAttest(checked); setErrors((current) => ({ ...current, attest: undefined })); }} error={errorOf("attest")}>{ATTESTATION}</CheckLine>
    </FlowDialog>
  );
}
