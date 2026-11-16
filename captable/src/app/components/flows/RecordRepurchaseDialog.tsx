import { createContext, useCallback, useContext, useId, useState, type ComponentProps, type ReactNode } from "react";
import { TriangleAlertIcon, XIcon } from "lucide-react";
import { api } from "#shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldTitle } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { apiRequest } from "../../api/request.ts";
import { parseAmount, times } from "../../lib/amounts.ts";
import { fieldProblem, ledgerUnmoved, useWriteFlow, type FieldMap, type WriteFlow } from "../../lib/flow.ts";
import { DASH, formatDate } from "../../lib/format.ts";
import { UnsettledScope } from "../../lib/unsettled.ts";
import { allOf, useResource } from "../../lib/useResource.ts";
import { NOT_DISMISSIBLE, useReturnFocus } from "../Dialog.tsx";
import { DocumentUpload, type UploadedDocument } from "../DocumentUpload.tsx";
import { ErrorFocus } from "../ErrorFocus.tsx";
import { CommandPreview, confirmationMatches, FlowProblemBanner, TypedConfirmation, WarningsToAcknowledge } from "../FlowParts.tsx";
import { useWorkspace } from "../OrgWorkspace.tsx";
import { useToast } from "../Toast.tsx";

// Record a repurchase (the product rules; the API contract's record-repurchase): a repurchase the company has already
// completed and paid off-platform, of every share of a terminated holder's restricted lot still unvested on the
// repurchase date. The admin gives the date, the price paid, how and when it was paid and the notice sent; after the
// repurchase deadline, or with none on record, counsel's authority too. The server's dry run shows what the ledger
// records (the repurchase and, for the vested remainder, a new share lot), the display ID is typed to confirm, and the
// real call sends exactly what was reviewed. Built with shadcn/ui, as internal-apps' Cap Table has it; the upload, the
// problem banner and the preview are Cap Table's shared ones.

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
    REPURCHASE_NOT_ALL_UNVESTED: "quantity", REPURCHASE_TOTAL_TOO_PRECISE: "price", NO_UNVESTED_SHARES: "quantity", REPURCHASE_AUTHORITY_REQUIRED: "authority",
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
      <Shell title="Record repurchase" onClose={onClose}>
        {loaded.error !== undefined ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Couldn't load the share lot</AlertTitle>
            <AlertDescription><Button type="button" variant="outline" size="sm" onClick={loaded.reload}>Try again</Button></AlertDescription>
          </Alert>
        ) : <p className="text-sm text-muted-foreground" role="status">Loading the share lot…</p>}
      </Shell>
    );
  }
  const [detail, queues, holder] = loaded.data;
  const row = queues.unvestedSharesFromTerminated.find((item) => item.securityId === securityId);
  if (!row || !holder.termination) {
    return (
      <Shell title={`Record repurchase of ${detail.displayId}`} onClose={onClose} footer={<Button type="button" variant="outline" onClick={onClose}>Close</Button>}>
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Nothing to repurchase</AlertTitle>
          <AlertDescription>Only the unvested shares of a terminated holder's restricted lot are repurchased. {detail.displayId} has none.</AlertDescription>
        </Alert>
      </Shell>
    );
  }
  return <RepurchaseForm security={detail} row={row} termination={holder.termination} onClose={onClose} onDone={onDone} />;
}

/** Whether a write in the dialog is unsettled: its footer's Cancel or Close waits too. */
const Held = createContext(false);

/**
 * The dialog's frame: it can't be closed while a write's outcome is unknown (lib/flow), the command's or an upload's in
 * its form (lib/unsettled, as the Modal): Escape, a click outside, the ✕ and the footer's Cancel all wait.
 */
function Shell({ title, description, onClose, unsettled = false, footer, children }: { title: string; description?: ReactNode; onClose: () => void; unsettled?: boolean; footer?: ReactNode; children: ReactNode }) {
  const [nested, setNested] = useState(0);
  const change = useCallback((delta: number) => setNested((count) => Math.max(0, count + delta)), []);
  const held = unsettled || nested > 0;
  const returnFocus = useReturnFocus();
  return (
    <UnsettledScope value={change}>
      <Held value={held}>
        <Dialog open onOpenChange={(open) => { if (!open && !held) onClose(); }}>
          <DialogContent showCloseButton={false} {...(description ? {} : { "aria-describedby": undefined })} onCloseAutoFocus={returnFocus} className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
            <Button type="button" variant="ghost" size="icon-sm" className="absolute top-2 right-2" aria-label="Close" disabled={held} title={held ? NOT_DISMISSIBLE : undefined} onClick={onClose}>
              <XIcon />
            </Button>
            <DialogHeader className="pr-8">
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription>{description}</DialogDescription> : null}
            </DialogHeader>
            <ErrorFocus>
              <div className="flex min-w-0 flex-col gap-4">{children}</div>
            </ErrorFocus>
            {footer ? <DialogFooter>{footer}</DialogFooter> : null}
          </DialogContent>
        </Dialog>
      </Held>
    </UnsettledScope>
  );
}

/**
 * The repurchase date, fixed while a write in the dialog is unsettled: moving it inside the window would unmount counsel's
 * authority field and drop that upload's key.
 */
function HeldInput(props: ComponentProps<typeof Input>) {
  const held = useContext(Held);
  return <Input {...props} disabled={held || props.disabled} title={held ? NOT_DISMISSIBLE : props.title} />;
}

/** Review, which waits too: it recomputes what the repurchase needs and could unmount that upload's field. */
function HeldButton(props: ComponentProps<typeof Button>) {
  const held = useContext(Held);
  return <Button {...props} disabled={held || props.disabled} title={held ? NOT_DISMISSIBLE : props.title} />;
}

/** A footer's Cancel or Close (Dialog.tsx's DismissButton): disabled while a write in the dialog is unsettled. */
function DismissButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  const held = useContext(Held);
  return <Button type="button" variant="outline" onClick={onClick} disabled={held || disabled} title={held ? NOT_DISMISSIBLE : undefined}>{children}</Button>;
}

function RepurchaseForm({ security, row, termination, onClose, onDone }: { security: api.SecurityDetail; row: Row; termination: NonNullable<api.StakeholderDetail["termination"]> } & Omit<RecordRepurchaseDialogProps, "securityId">) {
  const { orgId, today, format } = useWorkspace();
  const toast = useToast();
  const ids = { date: useId(), price: useId(), method: useId(), paidDate: useId(), reference: useId(), note: useId() };
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
      <HeldButton type="button" onClick={review} disabled={flow.busy}>{flow.phase === "previewing" ? "Checking…" : "Review"}</HeldButton>
    </>
  ) : (
    <>
      <Button type="button" variant="outline" onClick={flow.edit} disabled={flow.busy || flow.locked}>Back</Button>
      <Button type="button" variant="destructive" onClick={() => void flow.commit()} disabled={flow.busy || flow.locked || !confirmationMatches(typed, security.displayId) || !flow.acknowledgedAll}>
        {flow.phase === "committing" ? "Recording…" : "Record repurchase"}
      </Button>
    </>
  );
  return (
    <Shell
      title={`Record repurchase of ${security.displayId}`}
      description="Records a repurchase the company has already completed and paid. Every share still unvested on the repurchase date is bought back; the vested remainder stays with the holder as a new share lot."
      onClose={onClose}
      unsettled={flow.unsettled}
      footer={footer}
    >
      <FlowProblemBanner problem={flow.problem} onRetry={editing ? review : () => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label="The lot">
        <dt className="text-muted-foreground">Holder</dt><dd>{security.stakeholderName} (left {formatDate(termination.date)})</dd>
        <dt className="text-muted-foreground">Unvested shares</dt><dd>{format.shares(row.unvested)}</dd>
        <dt className="text-muted-foreground">Repurchase price on record</dt><dd>{row.repurchasePrice ? format.price(row.repurchasePrice) : "Not recorded"}</dd>
        <dt className="text-muted-foreground">Last date to repurchase</dt><dd>{deadline ? formatDate(deadline) : row.status === "no_deadline" ? "None (per agreement)" : "Not recorded"}</dd>
      </dl>
      <FieldSet disabled={!editing}>
        <FieldGroup className="gap-4">
          <Field data-invalid={errorOf("date") ? true : undefined}>
            <FieldLabel htmlFor={ids.date}>Repurchase date</FieldLabel>
            <HeldInput id={ids.date} type="date" min={termination.date} max={today} value={date} aria-invalid={errorOf("date") ? true : undefined}
              aria-describedby={errorOf("date") ? `${ids.date}-err` : undefined} onChange={(event) => { setDate(event.target.value); clear("date"); }} />
            {errorOf("date") ? <FieldError id={`${ids.date}-err`} role={undefined}>{errorOf("date")}</FieldError> : null}
          </Field>
          <Field data-invalid={errorOf("quantity") ? true : undefined}>
            <FieldTitle>Shares repurchased</FieldTitle>
            <p className="text-sm">{format.shares(row.unvested)} — every share unvested on the repurchase date</p>
            {errorOf("quantity") ? <FieldError>{errorOf("quantity")}</FieldError> : null}
          </Field>
          <Field data-invalid={errorOf("price") ? true : undefined}>
            <FieldLabel htmlFor={ids.price}>Price paid per share</FieldLabel>
            <Input id={ids.price} inputMode="decimal" value={price} aria-invalid={errorOf("price") ? true : undefined}
              aria-describedby={errorOf("price") ? `${ids.price}-err` : `${ids.price}-hint`} onChange={(event) => { setPrice(event.target.value); clear("price"); }} />
            {errorOf("price") ? <FieldError id={`${ids.price}-err`} role={undefined}>{errorOf("price")}</FieldError> : <FieldDescription id={`${ids.price}-hint`}>Total paid: {total === null ? DASH : format.money(total)}</FieldDescription>}
          </Field>
          <Field data-invalid={errorOf("method") ? true : undefined}>
            <FieldLabel htmlFor={ids.method}>Paid by</FieldLabel>
            <NativeSelect id={ids.method} className="w-full" value={method} disabled={!editing} aria-invalid={errorOf("method") ? true : undefined}
              aria-describedby={errorOf("method") ? `${ids.method}-err` : undefined} onChange={(event) => { setMethod(event.target.value as typeof method); clear("method"); }}>
              <NativeSelectOption value="">Choose how the company paid</NativeSelectOption>
              {Object.entries(REPURCHASE_METHOD_LABELS).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
            </NativeSelect>
            {errorOf("method") ? <FieldError id={`${ids.method}-err`} role={undefined}>{errorOf("method")}</FieldError> : null}
          </Field>
          <Field data-invalid={errorOf("paidDate") ? true : undefined}>
            <FieldLabel htmlFor={ids.paidDate}>Paid on</FieldLabel>
            <Input id={ids.paidDate} type="date" max={today} value={paidDate} aria-invalid={errorOf("paidDate") ? true : undefined}
              aria-describedby={errorOf("paidDate") ? `${ids.paidDate}-err` : undefined} onChange={(event) => { setPaidDate(event.target.value); clear("paidDate"); }} />
            {errorOf("paidDate") ? <FieldError id={`${ids.paidDate}-err`} role={undefined}>{errorOf("paidDate")}</FieldError> : null}
          </Field>
          <Field data-invalid={errorOf("reference") ? true : undefined}>
            <FieldLabel htmlFor={ids.reference}>Payment reference</FieldLabel>
            <Input id={ids.reference} maxLength={200} value={reference} placeholder="Check number, wire or ACH reference" aria-describedby={errorOf("reference") ? `${ids.reference}-err` : `${ids.reference}-hint`}
              onChange={(event) => { setReference(event.target.value); clear("reference"); }} />
            {errorOf("reference") ? <FieldError id={`${ids.reference}-err`} role={undefined}>{errorOf("reference")}</FieldError> : <FieldDescription id={`${ids.reference}-hint`}>Optional.</FieldDescription>}
          </Field>
          <DocumentUpload label="Repurchase notice" kind="OTHER" required value={notice} onChange={(next) => { setNotice(next); clear("notice"); }}
            hint="The notice of repurchase sent to the holder." error={errorOf("notice")} disabled={!editing} />
          {late || errorOf("authority") || authorityAsked ? (
            <>
              {late || errorOf("authority") ? (
                <Alert>
                  <TriangleAlertIcon />
                  <AlertTitle>{lateReason}</AlertTitle>
                  <AlertDescription>Record this repurchase only with counsel's written authority for it.</AlertDescription>
                </Alert>
              ) : null}
              <DocumentUpload label="Counsel's authority" kind="COUNSEL_MEMO" required value={authority} onChange={(next) => { setAuthority(next); clear("authority"); }}
                hint="Counsel's memo or approval for this repurchase." error={errorOf("authority")} disabled={!editing} />
            </>
          ) : null}
          <Field>
            <FieldLabel htmlFor={ids.note}>Note</FieldLabel>
            <Textarea id={ids.note} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </FieldGroup>
      </FieldSet>
      {!editing && flow.preview ? (
        <>
          <CommandPreview transactions={flow.preview.transactions} changes={flow.preview.changes} names={new Map([[security.id, security.displayId]])} />
          <WarningsToAcknowledge flow={flow as WriteFlow<unknown, unknown, unknown>} />
          <TypedConfirmation expected={security.displayId} value={typed} onChange={setTyped} disabled={flow.busy || flow.locked} />
        </>
      ) : null}
    </Shell>
  );
}
