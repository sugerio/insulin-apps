import { useState } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { amountOf, parseAmount } from "../../lib/amounts.ts";
import { fieldProblem, ledgerUnmoved, useWriteFlow, type FieldMap } from "../../lib/flow.ts";
import { isExecutionPending } from "../../lib/labels.ts";
import { useResource } from "../../lib/useResource.ts";
import { Modal } from "../Dialog.tsx";
import { DocumentUpload, type UploadedDocument } from "../DocumentUpload.tsx";
import { InlineError } from "../Feedback.tsx";
import { CommandPreview, confirmationMatches, TypedConfirmation } from "../FlowParts.tsx";
import { AmountField, DateField, SelectField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";
import { FlowDialog } from "./FlowDialog.tsx";

// Cancel an option or a warrant: date, quantity (all outstanding by default),
// reason and the document that supports it; the server's preview shows what is cancelled and what returns to the pool,
// and the display ID is typed to confirm. A data error is not a cancellation: an admin reverses it instead.

export const CANCEL_REASON_LABELS: Record<api.CancelSecurity["reason"], string> = {
  HOLDER_WAIVER: "Holder waiver",
  NOT_EXECUTED: "Not executed",
  MUTUAL_AGREEMENT: "Mutual agreement",
  FORFEITURE_UNDER_AGREEMENT: "Forfeiture under the agreement",
};

type Result = api.CommandResult;

const FIELDS: FieldMap = {
  issue: (path) => (path === "effectiveDate" ? "date" : path === "quantity" ? "quantity" : path === "documentId" ? "document" : path === "reason" ? "reason" : null),
  violation: (violation) => ({ EXCEEDS_OUTSTANDING: "quantity", EFFECTIVE_DATE_IN_FUTURE: "date", DOCUMENT_ARCHIVED: "document", DOCUMENT_IS_COMPANY_RESOURCE: "document", DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER: "document" } as Record<string, string>)[violation.code] ?? null,
};

interface CancelSecurityDialogProps {
  securityId: string;
  defaultReason?: api.CancelSecurity["reason"];
  onClose: () => void;
  onDone: (result: Result) => void;
}

export function CancelSecurityDialog({ securityId, defaultReason, onClose, onDone }: CancelSecurityDialogProps) {
  const { orgId } = useWorkspace();
  const security = useResource((signal) => apiRequest(api.routes.getSecurity, { params: { orgId, id: securityId }, signal }), [orgId, securityId]);
  if (!security.data) {
    return (
      <Modal title="Cancel security" onClose={onClose}>
        {security.error !== undefined ? <InlineError what="the security" error={security.error} onRetry={security.reload} /> : <p className="muted" role="status">Loading the security…</p>}
      </Modal>
    );
  }
  return <CancelForm security={security.data} defaultReason={defaultReason} onClose={onClose} onDone={onDone} />;
}

function CancelForm({ security, defaultReason, onClose, onDone }: { security: api.SecurityDetail } & Omit<CancelSecurityDialogProps, "securityId">) {
  const { orgId, today, format, org } = useWorkspace();
  const toast = useToast();
  const outstanding = security.numbers?.outstanding ?? "0";
  const plan = useResource((signal) => apiRequest(api.routes.getStockPlan, { params: { orgId, id: security.stockPlanId ?? "" }, signal }), [orgId, security.stockPlanId], security.stockPlanId !== null);
  const [date, setDate] = useState(today);
  const [quantity, setQuantity] = useState(outstanding);
  const [reason, setReason] = useState<api.CancelSecurity["reason"]>(defaultReason ?? (isExecutionPending(security.executionStatus) ? "NOT_EXECUTED" : "HOLDER_WAIVER"));
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [typed, setTyped] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const unitName = security.family === "WARRANT" ? "warrant shares" : "options";

  const request = () => {
    const typedQuantity = amountOf(quantity, { positive: true, unit: org.shareUnit });
    return {
      securityId: security.id,
      effectiveDate: date,
      // Left out when it is everything outstanding: the server cancels what is outstanding when it records.
      ...(typedQuantity && typedQuantity !== outstanding ? { quantity: typedQuantity } : {}),
      reason,
      documentId: document?.id ?? "",
    };
  };
  // The dry run previews before the ID is typed and needs none; the real call carries what the admin typed.
  const dryRun = (frozen: ReturnType<typeof request>, signal?: AbortSignal) => apiRequest(api.routes.cancelSecurity, { params: { orgId }, dryRun: true, body: frozen, signal });
  const flow = useWriteFlow({
    request,
    preview: dryRun,
    body: ({ request: frozen, preview, acknowledge }) => ({ ...frozen, confirmation: typed.trim(), expectedLedgerSeq: preview!.ledgerSeq, expectedDiffSha256: preview!.diffSha256, acknowledge: [...acknowledge] }),
    send: (body, key) => apiRequest(api.routes.cancelSecurity, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: ({ request: frozen, preview }) => ledgerUnmoved(() => dryRun(frozen), preview!.ledgerSeq),
    fields: FIELDS,
    onCommitted: (result) => {
      const cancelled = result.transactions.find((transaction) => transaction.securityId === security.id)?.quantity ?? null;
      toast({ message: `${security.displayId} cancelled${cancelled ? ` — ${format.shares(cancelled)} ${unitName}` : ""}` });
      onDone(result);
    },
  });
  const review = () => {
    const found: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) found.date = "Enter the cancellation date.";
    else if (date > today) found.date = "A cancellation can't be dated in the future.";
    const parsed = parseAmount(quantity, { positive: true, unit: org.shareUnit, unitName });
    if (!parsed) found.quantity = "Enter the quantity to cancel.";
    else if (!parsed.ok) found.quantity = parsed.error;
    if (!document) found.document = "Upload the waiver, agreement or evidence that the grant will not be executed.";
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  const names = new Map<string, string>([[security.id, security.displayId], ...(security.stockPlanId && plan.data ? [[security.stockPlanId, plan.data.name] as [string, string]] : [])]);
  return (
    <FlowDialog
      title={`Cancel ${security.displayId}`}
      flow={flow as never}
      onClose={onClose}
      onReview={review}
      confirmLabel="Cancel security"
      confirmReady={confirmationMatches(typed, security.displayId)}
      danger
      review={
        <>
          {flow.preview ? <CommandPreview transactions={flow.preview.transactions} changes={flow.preview.changes} names={names} /> : null}
          <TypedConfirmation expected={security.displayId} value={typed} onChange={setTyped} disabled={flow.busy || flow.locked} />
        </>
      }
    >
      <DateField label="Cancellation date" required max={today} value={date} onChange={(value) => { setDate(value); setErrors((current) => ({ ...current, date: undefined })); }} error={errorOf("date")} />
      <AmountField label="Quantity" required value={quantity} onChange={(value) => { setQuantity(value); setErrors((current) => ({ ...current, quantity: undefined })); }} hint={`Default: all ${format.shares(outstanding)} outstanding.`} error={errorOf("quantity")} />
      <SelectField label="Reason" required value={reason} onChange={(value) => setReason(value as api.CancelSecurity["reason"])} options={Object.entries(CANCEL_REASON_LABELS)} error={errorOf("reason")} />
      <DocumentUpload label="Supporting document" kind="OTHER" required value={document} onChange={(next) => { setDocument(next); setErrors((current) => ({ ...current, document: undefined })); }}
        hint="Waiver, agreement, or evidence that the grant will not be executed." error={errorOf("document")} disabled={flow.phase !== "edit"} />
      <p className="small muted">A data error is not a cancellation — an admin uses Reverse instead.</p>
    </FlowDialog>
  );
}
