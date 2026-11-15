import { useCallback, useContext, useState, type ReactNode } from "react";
import { api } from "#shared";
import { apiRequest } from "../../api/request.ts";
import { parseAmount, times } from "../../lib/amounts.ts";
import { fieldProblem, ledgerUnmoved, useWriteFlow, type FieldMap } from "../../lib/flow.ts";
import { DASH, formatDate } from "../../lib/format.ts";
import { UnsettledScope } from "../../lib/unsettled.ts";
import { allOf, useResource } from "../../lib/useResource.ts";
import { DescriptionList } from "../DescriptionList.tsx";
import { DismissButton, Modal, NOT_DISMISSIBLE } from "../Dialog.tsx";
import { DocumentUpload, type UploadedDocument } from "../DocumentUpload.tsx";
import { ErrorFocus } from "../ErrorFocus.tsx";
import { Banner, InlineError } from "../Feedback.tsx";
import { CommandPreview, confirmationMatches, FlowProblemBanner, TypedConfirmation, WarningsToAcknowledge } from "../FlowParts.tsx";
import { AmountField, DateField, SelectField, TextAreaField, TextField } from "../Form.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";

// Record a repurchase: a repurchase the company has already completed and paid off-platform, of every share of a
// terminated holder's restricted lot still unvested on the repurchase date. The admin gives the date, the price paid,
// how and when it was paid and the notice sent; after the repurchase deadline, or with none on record, counsel's
// authority too. The server's dry run shows what the ledger records (the repurchase and, for the vested remainder, a new
// share lot), the display ID is typed to confirm, and the real call sends exactly what was reviewed. Nothing is sent
// to the holder: the company's own notice already went.

export const REPURCHASE_METHOD_LABELS: Record<api.RecordRepurchase["consideration"]["method"], string> = {
  CHECK: "Check",
  WIRE: "Wire",
  ACH: "ACH",
  CASH: "Cash",
  OTHER: "Other",
};

type Row = api.SecuritiesStatus["unvestedSharesFromTerminated"][number];
type Result = api.CommandResult;

const FIELDS: FieldMap = {
  issue: (path) => ({
    effectiveDate: "date", quantity: "quantity", pricePerShare: "price", "consideration.method": "method", "consideration.paidDate": "paidDate",
    "consideration.reference": "reference", noticeDocumentId: "notice", authorityDocumentId: "authority", note: "note",
  } as Record<string, string>)[path] ?? null,
  violation: (violation) => ({
    EFFECTIVE_DATE_IN_FUTURE: "date", REPURCHASE_BEFORE_TERMINATION: "date", REPURCHASE_AFTER_DEADLINE: "date", PAID_DATE_IN_FUTURE: "paidDate",
    REPURCHASE_NOT_ALL_UNVESTED: "quantity", NO_UNVESTED_SHARES: "quantity", REPURCHASE_AUTHORITY_REQUIRED: "authority",
    DOCUMENT_ARCHIVED: "notice", DOCUMENT_IS_COMPANY_RESOURCE: "notice", DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER: "notice",
  } as Record<string, string>)[violation.code] ?? null,
};

interface RecordRepurchaseDialogProps {
  securityId: string;
  onClose: () => void;
  onDone: (result: Result) => void;
}

export function RecordRepurchaseDialog({ securityId, onClose, onDone }: RecordRepurchaseDialogProps) {
  const { orgId } = useWorkspace();
  const security = useResource((signal) => apiRequest(api.routes.getSecurity, { params: { orgId, id: securityId }, signal }), [orgId, securityId]);
  const status = useResource((signal) => apiRequest(api.routes.getSecuritiesStatus, { params: { orgId }, signal }), [orgId]);
  const stakeholderId = security.data?.stakeholderId ?? "";
  const stakeholder = useResource((signal) => apiRequest(api.routes.getStakeholder, { params: { orgId, id: stakeholderId }, signal }), [orgId, stakeholderId], stakeholderId !== "");
  const loaded = allOf(security, status, stakeholder);
  if (!loaded.data) {
    return (
      <Modal title="Record repurchase" onClose={onClose}>
        {loaded.error !== undefined ? <InlineError what="the share lot" error={loaded.error} onRetry={loaded.reload} /> : <p className="muted" role="status">Loading the share lot…</p>}
      </Modal>
    );
  }
  const [detail, queues, holder] = loaded.data;
  const row = queues.unvestedSharesFromTerminated.find((item) => item.securityId === securityId);
  if (!row || !holder.termination) {
    return (
      <Modal title={`Record repurchase of ${detail.displayId}`} onClose={onClose} footer={<DismissButton onClick={onClose}>Close</DismissButton>}>
        <Banner kind="info" title="Nothing to repurchase">
          Only the unvested shares of a terminated holder's restricted lot are repurchased. {detail.displayId} has none.
        </Banner>
      </Modal>
    );
  }
  return <RepurchaseForm security={detail} row={row} termination={holder.termination} onClose={onClose} onDone={onDone} />;
}

/**
 * Reports a write in the form (an upload) to the form as well as to the Modal: while its outcome is unknown the dialog
 * can't close, and the repurchase date and Review wait too, since either could unmount counsel's authority field and
 * drop that upload's key.
 */
function FormWrites({ onChange, children }: { onChange: (delta: number) => void; children: ReactNode }) {
  const modal = useContext(UnsettledScope);
  const change = useCallback((delta: number) => {
    onChange(delta);
    modal?.(delta);
  }, [modal, onChange]);
  return <UnsettledScope value={change}>{children}</UnsettledScope>;
}

function RepurchaseForm({ security, row, termination, onClose, onDone }: { security: api.SecurityDetail; row: Row; termination: NonNullable<api.StakeholderDetail["termination"]> } & Omit<RecordRepurchaseDialogProps, "securityId">) {
  const { orgId, today, format } = useWorkspace();
  const toast = useToast();
  const [date, setDate] = useState(today);
  const [price, setPrice] = useState(row.repurchasePrice ?? "");
  const [method, setMethod] = useState<api.RecordRepurchase["consideration"]["method"] | "">("");
  const [paidDate, setPaidDate] = useState(today);
  const [reference, setReference] = useState("");
  const [notice, setNotice] = useState<UploadedDocument | null>(null);
  const [authority, setAuthority] = useState<UploadedDocument | null>(null);
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [writes, setWrites] = useState(0);
  const countWrites = useCallback((delta: number) => setWrites((count) => Math.max(0, count + delta)), []);
  const held = writes > 0;
  // Once asked for, counsel's authority field stays until the dialog closes: unmounting it while its upload's outcome is
  // unknown would drop that upload's key (a review, a retry or a date change can all stop asking for it).
  const [authorityAsked, setAuthorityAsked] = useState(false);
  const deadline = row.lastRepurchaseDate;
  // A lot whose agreement sets no deadline needs no authority; one with no deadline known, or past it, does.
  const late = deadline === null ? row.status !== "no_deadline" : date > deadline;
  const parsedPrice = parseAmount(price, { positive: true });
  const total = parsedPrice?.ok ? times(parsedPrice.value, row.unvested) : null;

  const request = () => {
    const parsed = parseAmount(price, { positive: true });
    return {
      securityId: security.id,
      effectiveDate: date,
      quantity: row.unvested,
      pricePerShare: parsed?.ok ? parsed.value : "",
      consideration: { method: method as api.RecordRepurchase["consideration"]["method"], paidDate, ...(reference.trim() ? { reference: reference.trim() } : {}) },
      noticeDocumentId: notice?.id ?? "",
      // An attached authority always goes: inside the window the server keeps it as evidence, and the server may need it
      // where this form doesn't know (a deadline recorded since the row was read).
      ...(authority ? { authorityDocumentId: authority.id } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
  };
  // The dry run previews before the ID is typed and needs none; the real call carries what the admin typed.
  const dryRun = (frozen: ReturnType<typeof request>, signal?: AbortSignal) => apiRequest(api.routes.recordRepurchase, { params: { orgId }, dryRun: true, body: frozen, signal });
  const flow = useWriteFlow({
    request,
    preview: dryRun,
    body: ({ request: frozen, preview, acknowledge }) => ({ ...frozen, confirmation: typed.trim(), expectedLedgerSeq: preview!.ledgerSeq, expectedDiffSha256: preview!.diffSha256, acknowledge: [...acknowledge] }),
    send: (body, key) => apiRequest(api.routes.recordRepurchase, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: ({ request: frozen, preview }) => ledgerUnmoved(() => dryRun(frozen), preview!.ledgerSeq),
    fields: FIELDS,
    onCommitted: (result) => {
      toast({ message: `${security.displayId} repurchase recorded — ${format.shares(row.unvested)} shares` });
      onDone(result);
    },
  });
  const editing = flow.phase === "edit" || flow.phase === "previewing";
  const clear = (key: string) => setErrors((current) => ({ ...current, [key]: undefined }));
  const review = () => {
    if (held) return;
    const found: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) found.date = "Enter the repurchase date.";
    else if (date > today) found.date = "A repurchase can't be dated in the future.";
    else if (date < termination.date) found.date = `The holder left on ${formatDate(termination.date)}: the repurchase is on or after it.`;
    const parsed = parseAmount(price, { positive: true });
    if (!parsed) found.price = "Enter the price paid per share.";
    else if (!parsed.ok) found.price = parsed.error;
    if (method === "") found.method = "Choose how the company paid.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) found.paidDate = "Enter the date it was paid.";
    else if (paidDate > today) found.paidDate = "Record a repurchase once it is paid.";
    if (!notice) found.notice = "Upload the repurchase notice sent to the holder.";
    if (late && !authority) found.authority = "Upload counsel's authority for this repurchase.";
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  if ((late || errorOf("authority")) && !authorityAsked) setAuthorityAsked(true);
  const lateReason = deadline === null
    ? `No repurchase deadline is recorded for ${security.displayId}.`
    : `The repurchase right ended on ${formatDate(deadline)}.`;
  const footer = editing ? (
    <>
      <DismissButton onClick={onClose} disabled={flow.busy}>Cancel</DismissButton>
      <button type="button" className="btn btn-primary" onClick={review} disabled={flow.busy || held} title={held ? NOT_DISMISSIBLE : undefined}>
        {flow.phase === "previewing" ? "Checking…" : "Review"}
      </button>
    </>
  ) : (
    <>
      <button type="button" className="btn btn-ghost" onClick={flow.edit} disabled={flow.busy || flow.locked}>Back</button>
      <button type="button" className="btn btn-danger" onClick={() => void flow.commit()} disabled={flow.busy || flow.locked || !confirmationMatches(typed, security.displayId) || !flow.acknowledgedAll}>
        {flow.phase === "committing" ? "Recording…" : "Record repurchase"}
      </button>
    </>
  );
  return (
    <Modal title={`Record repurchase of ${security.displayId}`} onClose={onClose} footer={footer} dismissible={!flow.unsettled}>
      <FormWrites onChange={countWrites}>
        <ErrorFocus>
          <p className="small muted">
            Records a repurchase the company has already completed and paid. Every share still unvested on the repurchase date is bought back; the vested remainder
            stays with the holder as a new share lot.
          </p>
          <FlowProblemBanner problem={flow.problem} onRetry={editing ? review : () => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
          <DescriptionList
            split
            label="The lot"
            rows={[
              ["Holder", `${security.stakeholderName} (left ${formatDate(termination.date)})`],
              ["Unvested shares", format.shares(row.unvested)],
              ["Repurchase price on record", row.repurchasePrice ? format.price(row.repurchasePrice) : "Not recorded"],
              ["Last date to repurchase", deadline ? formatDate(deadline) : row.status === "no_deadline" ? "None (per agreement)" : "Not recorded"],
            ]}
          />
          <fieldset className="flow-fields form mt-12" disabled={!editing}>
            <DateField label="Repurchase date" min={termination.date} max={today} value={date} disabled={held}
              onChange={(value) => { setDate(value); clear("date"); }} error={errorOf("date")} />
            <div className="fld">
              <span className="lbl">Shares repurchased</span>
              <div className="small">{format.shares(row.unvested)} — every share unvested on the repurchase date</div>
              {errorOf("quantity") ? <div className="err">{errorOf("quantity")}</div> : null}
            </div>
            <AmountField label="Price paid per share" value={price} onChange={(value) => { setPrice(value); clear("price"); }} error={errorOf("price")}
              hint={`Total paid: ${total === null ? DASH : format.money(total)}`} />
            <SelectField label="Paid by" value={method} placeholder="Choose how the company paid" error={errorOf("method")}
              options={Object.entries(REPURCHASE_METHOD_LABELS)} onChange={(value) => { setMethod(value as typeof method); clear("method"); }} />
            <DateField label="Paid on" max={today} value={paidDate} onChange={(value) => { setPaidDate(value); clear("paidDate"); }} error={errorOf("paidDate")} />
            <TextField label="Payment reference" value={reference} placeholder="Check number, wire or ACH reference" hint="Optional."
              onChange={(value) => { setReference(value); clear("reference"); }} error={errorOf("reference")} />
            <DocumentUpload label="Repurchase notice" kind="OTHER" required value={notice} onChange={(next) => { setNotice(next); clear("notice"); }}
              hint="The notice of repurchase sent to the holder." error={errorOf("notice")} disabled={!editing} />
            {late || errorOf("authority") || authorityAsked ? (
              <>
                {late || errorOf("authority") ? (
                  <Banner kind="warn" title={lateReason}>Record this repurchase only with counsel's written authority for it.</Banner>
                ) : null}
                <DocumentUpload label="Counsel's authority" kind="COUNSEL_MEMO" required value={authority} onChange={(next) => { setAuthority(next); clear("authority"); }}
                  hint="Counsel's memo or approval for this repurchase." error={errorOf("authority")} disabled={!editing} />
              </>
            ) : null}
            <TextAreaField label="Note" value={note} onChange={setNote} />
          </fieldset>
          {!editing && flow.preview ? (
            <div className="mt-12">
              <CommandPreview transactions={flow.preview.transactions} changes={flow.preview.changes} names={new Map([[security.id, security.displayId]])} />
              <WarningsToAcknowledge flow={flow as never} />
              <TypedConfirmation expected={security.displayId} value={typed} onChange={setTyped} disabled={flow.busy || flow.locked} />
            </div>
          ) : null}
        </ErrorFocus>
      </FormWrites>
    </Modal>
  );
}
