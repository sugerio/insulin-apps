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
import { CheckLine, DateField, RadioCards } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// Mark executed: an execution-pending grant becomes executed once the agreement signed by both parties is uploaded,
// with the signature date(s) and the attestation. A grant awaiting both signatures may record the one party who has
// signed so far ("Who signed?"): it then awaits the other's. It is a ledger command, so an admin can reverse it.

type Result = api.CommandResult;
type Signed = api.MarkExecutedSigned;

const SIGNED_COPY: Record<Signed, { document: string; missing: string; toast: (displayId: string) => string }> = {
  both: { document: "Fully signed agreement", missing: "Upload the agreement signed by both the holder and the company signatory.", toast: (displayId) => `${displayId} marked executed` },
  holder: { document: "Agreement signed by the holder", missing: "Upload the agreement the holder signed.", toast: (displayId) => `${displayId}: the holder's signature recorded — awaiting the company signatory` },
  company: { document: "Agreement signed by the company signatory", missing: "Upload the agreement the company signatory signed.", toast: (displayId) => `${displayId}: the company signatory's signature recorded — awaiting the holder` },
};

/** Where the server's issues land; a signature date's violation goes on the date field shown for the answer. */
function fieldsFor(signed: Signed): FieldMap {
  const date = signed === "holder" ? "holder" : "company";
  return {
    issue: (path) => (path.startsWith("executedAgreement") ? "document" : path.startsWith("signatureDates.company") ? "company" : path.startsWith("signatureDates") ? "holder"
      : path === "attestation" ? "attest" : path === "signed" ? "signed" : null),
    violation: (violation) => ({
      SIGNATURE_DATE_IN_FUTURE: date, SIGNATURE_DATE_BEFORE_ISSUE: date, SIGNATURE_DATE_BEFORE_STATUS: date, SIGNATURE_NOT_PENDING: "signed",
      SIGNATURE_COMPLETES_EXECUTION: "signed", DOCUMENT_ARCHIVED: "document", DOCUMENT_IS_COMPANY_RESOURCE: "document", DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER: "document",
    } as Record<string, string>)[violation.code] ?? null,
  };
}

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
  const [signed, setSigned] = useState<Signed>("both");
  const [company, setCompany] = useState("");
  const [holder, setHolder] = useState("");
  const [attest, setAttest] = useState(false);
  const [typed, setTyped] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  // Only a grant awaiting both signatures can record one party's; otherwise the missing signature completes it.
  const partial = security.executionStatus === "pending_both";
  const attestation = api.MARK_EXECUTED_ATTESTATIONS[signed];
  const copy = SIGNED_COPY[signed];
  const datesOf = { company: signed !== "holder", holder: signed !== "company" };
  const request = () => ({
    securityId: security.id,
    ...(signed !== "both" ? { signed } : {}),
    executedAgreementDocumentId: document?.id ?? "",
    signatureDates: { ...(company && datesOf.company ? { company } : {}), ...(holder && datesOf.holder ? { holder } : {}) },
    attestation,
  });
  const dryRun = (frozen: ReturnType<typeof request>, signal?: AbortSignal) => apiRequest(api.routes.markExecuted, { params: { orgId }, dryRun: true, body: frozen, signal });
  const flow = useWriteFlow({
    request,
    preview: dryRun,
    body: ({ request: frozen, preview, acknowledge }) => ({ ...frozen, confirmation: typed.trim(), expectedLedgerSeq: preview!.ledgerSeq, expectedDiffSha256: preview!.diffSha256, acknowledge: [...acknowledge] }),
    send: (body, key) => apiRequest(api.routes.markExecuted, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: ({ request: frozen, preview }) => ledgerUnmoved(() => dryRun(frozen), preview!.ledgerSeq),
    fields: fieldsFor(signed),
    onCommitted: (result) => {
      toast({ message: copy.toast(security.displayId) });
      onDone(result);
    },
  });
  const review = () => {
    const found: Record<string, string> = {};
    if (!document) found.document = copy.missing;
    if (signed === "both" && !company && !holder) found.company = "Enter at least one signature date.";
    if (signed === "holder" && !holder) found.holder = "Enter the holder's signature date.";
    if (signed === "company" && !company) found.company = "Enter the company signatory's signature date.";
    for (const [key, value] of [["company", company], ["holder", holder]] as const) {
      if (value && datesOf[key] && value > today) found[key] = "A signature date can't be in the future.";
    }
    if (!attest) found.attest = signed === "both" ? "Confirm that the PDF bears both signatures." : `Confirm: ${attestation}.`;
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const choose = (next: Signed) => {
    setSigned(next);
    // The attestation is for what the PDF bears, so it is given again for the new answer.
    setAttest(false);
    setErrors({});
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
      <p className="small muted">{security.stakeholderName} · {EXECUTION_LABELS[security.executionStatus]}. {signed === "both" ? "Upload the agreement signed by both the holder and the company signatory." : "Upload the agreement as signed so far; it is kept as evidence."}</p>
      {partial ? (
        <RadioCards label="Who signed?" value={signed} onChange={(value) => choose(value as Signed)} error={errorOf("signed")} options={[
          { value: "both", label: "Both", sub: "The holder and the company signatory: the grant is executed" },
          { value: "holder", label: "The holder", sub: "It then awaits the company signatory, which doesn't block exercise" },
          { value: "company", label: "The company signatory", sub: "It then awaits the holder, which blocks exercise" },
        ]} />
      ) : null}
      <DocumentUpload label={copy.document} kind="GRANT_AGREEMENT" required value={document} onChange={(next) => { setDocument(next); setErrors((current) => ({ ...current, document: undefined })); }} error={errorOf("document")} disabled={flow.phase !== "edit"} />
      <div className="form-grid">
        {datesOf.company ? <DateField label="Company signature date" max={today} value={company} onChange={(value) => { setCompany(value); setErrors((current) => ({ ...current, company: undefined })); }} error={errorOf("company")} /> : null}
        {datesOf.holder ? <DateField label="Holder signature date" max={today} value={holder} onChange={(value) => { setHolder(value); setErrors((current) => ({ ...current, holder: undefined })); }} error={errorOf("holder")} hint={signed === "both" ? "The later date is when the grant becomes executed." : "The date the new status takes effect."} /> : null}
      </div>
      <CheckLine checked={attest} onChange={(checked) => { setAttest(checked); setErrors((current) => ({ ...current, attest: undefined })); }} error={errorOf("attest")}>{attestation}</CheckLine>
    </FlowDialog>
  );
}
