import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, engine } from "#shared";
import { apiRequest } from "../api/request.ts";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { DocumentUpload, type UploadedDocument } from "../components/DocumentUpload.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { CommandPreview, FlowProblemBanner, WarningsToAcknowledge } from "../components/FlowParts.tsx";
import { AmountField, BlockList, DateField, RadioCards, SelectField, TextField } from "../components/Form.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page } from "../components/Page.tsx";
import { useToast } from "../components/Toast.tsx";
import { WizardHead, WriteGate } from "../components/WritePage.tsx";
import { ExtendDeadlineDialog } from "../components/flows/ExtendDeadlineDialog.tsx";
import { amountOf, exactMoney, parseAmount } from "../lib/amounts.ts";
import { DASH, formatDate } from "../lib/format.ts";
import { fieldProblem, ledgerUnmoved, useWriteFlow, type FieldMap } from "../lib/flow.ts";
import { isExecutionPending, optionType, RELATIONSHIP_LABELS, VALUATION_STATUS_LABELS } from "../lib/labels.ts";
import { exerciseCost, formatComputedMoney, paymentReference } from "../lib/portal.ts";
import * as terms from "../lib/terms.ts";
import { notFoundAsNull, useResource } from "../lib/useResource.ts";

// Record exercise: the holder reported an exercise; the admin
// records it once the signed notice and full payment are both in. The exercise date is the later of the two; the ISO
// check, the FMV at the exercise date and the tax fields entered (never computed) are reviewed, then the server's dry
// run shows the exercise and its book-entry shares before anything is recorded. The server derives the ISO and NSO lots
// for the date (ISO first, the $100,000 limit, the ISO deadline) and the share IDs; the real call sends exactly those.

type Result = api.CommandResult;
type TaxTreatment = (typeof api.TAX_TREATMENTS)[number];
type ExerciseBody = Omit<api.ExerciseOptionInput, "expectedLedgerSeq" | "expectedDiffSha256">;
type ServerSplit = NonNullable<api.CommandResult["exercise"]>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface ExerciseValues {
  notice: UploadedDocument | null;
  noticeDate: string;
  amount: string;
  payDate: string;
  method: api.ExerciseOption["payment"]["method"];
  reference: string;
  payer: string;
  /** Options exercised. */
  quantity: string;
  /** ISO grants: "auto" leaves the split to the server (ISO lots first); "manual" names the lots, with a reason. */
  lotMode: "auto" | "manual";
  isoLots: string;
  nsoLots: string;
  lotReason: string;
  manualFmv: string;
  fmvSource: string;
  fmvDocument: UploadedDocument | null;
  treatment: TaxTreatment;
  federal: string;
  socialSecurity: string;
  medicare: string;
  stateAmount: string;
  stateCode: string;
  zeroReason: string;
  nonUsNote: string;
}

const VIOLATION_FIELDS: Record<string, keyof ExerciseValues> = {
  EXERCISE_DATE_MISMATCH: "payDate",
  EXERCISE_DATE_IN_FUTURE: "payDate",
  AFTER_CONTRACTUAL_DEADLINE: "payDate",
  EXCEEDS_VESTED_UNEXERCISED: "quantity",
  EARLY_EXERCISE_NOT_IN_R1: "quantity",
  PAYMENT_BELOW_COST: "amount",
  NO_FMV_FOR_EXERCISE_DATE: "manualFmv",
  RESULTING_SHARES_PORTIONS: "quantity",
  LOTS_MISMATCH: "isoLots",
  LOT_CHOICE_NEEDS_REASON: "lotReason",
  ZERO_WITHHOLDING_NEEDS_REASON: "zeroReason",
  NON_US_NOTE_REQUIRED: "nonUsNote",
};

function issueField(path: string): keyof ExerciseValues | null {
  if (path.startsWith("notice.documentId")) return "notice";
  if (path.startsWith("notice")) return "noticeDate";
  if (path.startsWith("payment.amount")) return "amount";
  if (path.startsWith("payment.receivedOn") || path === "exerciseDate") return "payDate";
  if (path.startsWith("payment.method")) return "method";
  if (path.startsWith("payment.reference")) return "reference";
  if (path.startsWith("payment")) return "payer";
  if (path === "quantity") return "quantity";
  if (path.startsWith("lots")) return "isoLots";
  if (path === "lotReason") return "lotReason";
  if (path.startsWith("fmv")) return "manualFmv";
  if (path.startsWith("tax.withholding")) return "federal";
  if (path.startsWith("tax.zeroReason")) return "zeroReason";
  if (path.startsWith("tax.nonUsNote")) return "nonUsNote";
  if (path.startsWith("tax")) return "treatment";
  return null;
}

const FIELDS: FieldMap = { issue: issueField, violation: (violation) => VIOLATION_FIELDS[violation.code] ?? null };

/** The request's lots: one per non-zero lot (a lot's quantity must be positive). */
function lotsOf(isoLots: string, nsoLots: string): { portion: api.OptionType; quantity: string }[] {
  return [
    ...(engine.Dec.parse(isoLots).isPositive() ? [{ portion: "ISO" as const, quantity: isoLots }] : []),
    ...(engine.Dec.parse(nsoLots).isPositive() ? [{ portion: "NSO" as const, quantity: nsoLots }] : []),
  ];
}

/** What the real call sends back from the dry run's split: its lots, and one resulting share per portion with its ID. */
function splitOf(split: ServerSplit): Pick<ExerciseBody, "lots" | "resultingShares"> {
  return { lots: lotsOf(split.lots.iso, split.lots.nso), resultingShares: split.portions.map(({ portion, displayId }) => ({ portion, displayId })) };
}

const NSO_REASONS: Record<NonNullable<ServerSplit["portions"][number]["reason"]>, string> = {
  AFTER_ISO_DEADLINE: "after the ISO deadline",
  ISO_LIMIT: "beyond the $100,000 ISO limit",
  LOT_CHOICE: "the lots chosen",
};

export function RecordExercisePage() {
  const { orgId, href, isOwn } = useWorkspace();
  const { securityId = "" } = useParams();
  const security = useResource((signal) => apiRequest(api.routes.getSecurity, { params: { orgId, id: securityId }, signal }), [orgId, securityId]);
  const back = href(`securities/${securityId}`);
  const title = security.data ? `Record exercise — ${security.data.displayId}` : "Record exercise";
  return (
    <Page title={title} crumbs={[["Cap Table", href("captable")], [security.data?.displayId ?? "Option", back], ["Record exercise"]]}>
      <ResourceView resource={security} notFound="This security does not exist.">
        {(data) => (
          <WriteGate own={isOwn(data.stakeholderId)} back={{ to: back, label: `Back to ${data.displayId}` }}>
            <WizardHead title={title} back={back} />
            {data.family !== "EQUITY_COMPENSATION" || optionType(data.subtype) === null ? (
              <Card><Banner kind="info" title="Only options are exercised here">The app doesn't record warrant exercises; shares are never exercised.</Banner></Card>
            ) : isExecutionPending(data.executionStatus) ? (
              <Card><Banner kind="warn" title="Execution pending">This grant cannot be exercised until it is marked executed.</Banner></Card>
            ) : <ExerciseForm security={data} back={back} />}
          </WriteGate>
        )}
      </ResourceView>
    </Page>
  );
}

function defaultTreatment(security: api.SecurityDetail, relationship: api.Relationship | undefined): TaxTreatment {
  if (security.exemption.federal === "NON_US") return "NON_US";
  return relationship === "employee" || relationship === "ex_employee" || relationship === "founder" || relationship === "officer" ? "W2" : "FORM_1099_NEC";
}

function ExerciseForm({ security, back }: { security: api.SecurityDetail; back: string }) {
  const { orgId, format, href, today, org } = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const iso = optionType(security.subtype) === "ISO";
  const strike = terms.exercisePrice(security.terms);
  const stakeholder = useResource((signal) => apiRequest(api.routes.getStakeholder, { params: { orgId, id: security.stakeholderId }, signal }), [orgId, security.stakeholderId]);
  const plan = useResource((signal) => apiRequest(api.routes.getStockPlan, { params: { orgId, id: security.stockPlanId ?? "" }, signal }), [orgId, security.stockPlanId], security.stockPlanId !== null);
  const instructions = notFoundAsNull(useResource((signal) => apiRequest(api.routes.getPaymentInstructions, { params: { orgId }, signal }), [orgId]));
  const [extending, setExtending] = useState(false);
  const [values, setValues] = useState<ExerciseValues>({
    notice: null, noticeDate: "", amount: "", payDate: "", method: "ACH", reference: "", payer: "", quantity: "", lotMode: "auto", isoLots: "", nsoLots: "", lotReason: "",
    manualFmv: "", fmvSource: "", fmvDocument: null, treatment: defaultTreatment(security, undefined), federal: "", socialSecurity: "", medicare: "",
    stateAmount: "", stateCode: "CA", zeroReason: "", nonUsNote: security.exemption.country ? `Handled by local payroll in ${security.exemption.country}` : "",
  });
  const [touched, setTouched] = useState({ amount: false, treatment: false });
  const [errors, setErrors] = useState<Partial<Record<keyof ExerciseValues, string>>>({});
  const set = <K extends keyof ExerciseValues>(key: K, value: ExerciseValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  };
  const relationship = stakeholder.data?.relationship;
  const treatment = touched.treatment ? values.treatment : defaultTreatment(security, relationship);

  const unit = org.shareUnit;
  const total = engine.Dec.parse(amountOf(values.quantity, { unit, unitName: "options" }) ?? "0");
  const exerciseDate = DATE.test(values.noticeDate) && DATE.test(values.payDate) ? (values.noticeDate > values.payDate ? values.noticeDate : values.payDate) : null;
  const isoDeadline = security.deadlines?.iso ?? null;
  const afterIsoDeadline = iso && isoDeadline !== null && exerciseDate !== null && exerciseDate > isoDeadline;
  const manual = iso && values.lotMode === "manual";
  const manualIso = manual ? amountOf(values.isoLots, { unit }) ?? "0" : "0";
  const manualNso = manual ? amountOf(values.nsoLots, { unit }) ?? "0" : "0";
  // What the page knows of the NSO part before the server's split: all of an NSO grant or of an exercise after the ISO
  // deadline, or the NSO lots the admin chose. Under ISO first, the $100,000 limit is the server's to apply.
  const knownNso = !iso || afterIsoDeadline ? total : manual ? engine.Dec.parse(manualNso) : engine.Dec.ZERO;
  const deliveredClass = security.stockClassId ?? plan.data?.stockClassId ?? null;
  const fmv = useResource(
    (signal) => apiRequest(api.routes.getFmv, { params: { orgId }, query: { date: exerciseDate!, stockClassId: deliveredClass! }, signal }),
    [orgId, exerciseDate, deliveredClass],
    exerciseDate !== null && deliveredClass !== null,
  );
  const fmvPending = exerciseDate !== null && fmv.data === undefined && fmv.error === undefined;
  const fmvValid = fmv.data?.fmv ?? null;
  const fmvPrice = fmvValid?.pricePerShare ?? amountOf(values.manualFmv, { positive: true });
  const cost = strike && total.isPositive() ? exerciseCost(total.toString(), strike) : null;
  const withheld = [values.federal, values.socialSecurity, values.medicare, values.stateAmount].map((value) => amountOf(value) ?? "0").reduce((sum, value) => sum.add(value), engine.Dec.ZERO);
  const withholdingEntered = [values.federal, values.socialSecurity, values.medicare, values.stateAmount].some((value) => value.trim() !== "");
  const holderName = stakeholder.data?.displayName ?? security.stakeholderName;
  const referenceFormat = instructions.data?.details.referenceFormat ?? null;
  const reference = referenceFormat ? paymentReference(referenceFormat, security.displayId, holderName) : null;

  const setQuantity = (text: string) => {
    set("quantity", text);
    if (touched.amount || !strike) return;
    const typed = amountOf(text);
    set("amount", typed && engine.Dec.parse(typed).isPositive() ? exerciseCost(typed, strike).toString() : "");
  };

  function bodyOf(): ExerciseBody {
    const fmvInput: ExerciseBody["fmv"] = fmvValid
      ? { source: "valuation", valuationId: fmvValid.valuationId }
      : { source: "manual", pricePerShare: amountOf(values.manualFmv, { positive: true }) ?? "0", sourceNote: values.fmvSource.trim(), documentId: values.fmvDocument?.id ?? "" };
    // Built from the answers alone (never from a preview), so a preview can't change the request it previewed.
    const zeroReason = values.zeroReason.trim() || (treatment === "FORM_1099_NEC" && knownNso.isPositive() ? "Non-employee" : "");
    return {
      securityId: security.id,
      quantity: total.toString(),
      notice: { documentId: values.notice?.id ?? "", receivedOn: values.noticeDate },
      payment: {
        amount: amountOf(values.amount, { positive: true }) ?? "0",
        receivedOn: values.payDate,
        method: values.method,
        reference: values.reference.trim(),
        payerIsHolder: values.payer.trim() === "",
        ...(values.payer.trim() ? { payerNote: values.payer.trim() } : {}),
      },
      exerciseDate: exerciseDate ?? values.payDate,
      // Only a split the admin chose; otherwise the server applies ISO first for the date.
      ...(manual ? { lots: lotsOf(manualIso, manualNso), ...(values.lotReason.trim() ? { lotReason: values.lotReason.trim() } : {}) } : {}),
      fmv: fmvInput,
      tax: {
        treatment,
        ...(treatment === "W2" && withholdingEntered
          ? { withholding: { federalIncome: amountOf(values.federal) ?? "0", socialSecurity: amountOf(values.socialSecurity) ?? "0", medicare: amountOf(values.medicare) ?? "0", state: amountOf(values.stateAmount) ? [{ code: values.stateCode.trim().toUpperCase(), amount: amountOf(values.stateAmount)! }] : [] } }
          : {}),
        ...(zeroReason ? { zeroReason } : {}),
        ...(treatment === "NON_US" && values.nonUsNote.trim() ? { nonUsNote: values.nonUsNote.trim() } : {}),
      },
    };
  }

  const dryRun = (frozen: ExerciseBody, signal?: AbortSignal) => apiRequest(api.routes.exerciseOption, { params: { orgId }, dryRun: true, body: frozen, signal });
  const flow = useWriteFlow({
    request: bodyOf,
    preview: dryRun,
    // The lots and the resulting shares go back exactly as the server derived them for the date.
    body: ({ request: frozen, preview, acknowledge }) => ({
      ...frozen,
      ...(preview!.exercise ? splitOf(preview!.exercise) : {}),
      expectedLedgerSeq: preview!.ledgerSeq, expectedDiffSha256: preview!.diffSha256, acknowledge: [...acknowledge],
    }),
    send: (body, key) => apiRequest(api.routes.exerciseOption, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: ({ request: frozen, preview }) => ledgerUnmoved(() => dryRun(frozen), preview!.ledgerSeq),
    fields: FIELDS,
    onCommitted: (result: Result) => {
      const ids = result.created.securityIds.map((id) => result.changes.find((change) => change.entity === "security" && change.id === id)?.after?.displayId).filter((id): id is string => typeof id === "string");
      const first = result.created.securityIds[0];
      toast({ message: `Exercise recorded — ${ids.join(", ") || "shares"} issued (book entry)`, to: first ? href(`securities/${first}`) : undefined, linkLabel: "Open share" });
      navigate(back);
    },
  });

  // The split the server showed for these answers: it tells the tax section whether there is an NSO part.
  const splitKey = `${exerciseDate}|${total.toString()}|${manual ? `${manualIso}/${manualNso}` : "auto"}`;
  const [lastSplit, setLastSplit] = useState<{ key: string; split: ServerSplit } | null>(null);
  const shownSplit = flow.preview?.exercise ?? null;
  useEffect(() => {
    if (shownSplit) setLastSplit({ key: splitKey, split: shownSplit });
    // The key is the answers the preview was made from (they can't change while it is shown).
  }, [shownSplit]);
  const serverNso = lastSplit?.key === splitKey ? engine.Dec.sum(lastSplit.split.portions.filter((item) => item.portion === "NSO").map((item) => engine.Dec.parse(item.quantity))) : null;
  const nsoPortion = serverNso ?? knownNso;
  const spread = fmvPrice && strike && nsoPortion.isPositive() ? engine.Dec.parse(fmvPrice).sub(strike).clampZero().mul(nsoPortion) : null;
  const withholdingProblem = (["federal", "socialSecurity", "medicare", "stateAmount", "stateCode", "zeroReason"] as const).some((key) => fieldProblem(flow.problem, key) !== undefined);
  const showWithholding = treatment === "W2" && (nsoPortion.isPositive() || withholdingProblem);

  function validate(): Partial<Record<keyof ExerciseValues, string>> {
    const found: Partial<Record<keyof ExerciseValues, string>> = {};
    if (!values.notice) found.notice = "Upload the holder's signed notice of exercise.";
    if (!DATE.test(values.noticeDate)) found.noticeDate = "Enter the date the notice was received.";
    else if (values.noticeDate > today) found.noticeDate = "The notice can't be received in the future.";
    const amount = parseAmount(values.amount, { positive: true });
    if (!amount) found.amount = "Enter the amount received.";
    else if (!amount.ok) found.amount = amount.error;
    if (!DATE.test(values.payDate)) found.payDate = "Enter the date full payment was received.";
    else if (values.payDate > today) found.payDate = "Payment can't be received in the future.";
    if (!values.reference.trim()) found.reference = "Enter the payment reference.";
    const quantity = parseAmount(values.quantity, { positive: true, unit, unitName: "options" });
    if (!quantity) found.quantity = "Enter how many options were exercised.";
    else if (!quantity.ok) found.quantity = quantity.error;
    if (manual) {
      for (const key of ["isoLots", "nsoLots"] as const) {
        const parsed = parseAmount(values[key], { unit, unitName: "options" });
        if (parsed && !parsed.ok) found[key] = parsed.error;
      }
      if (!found.isoLots && !found.nsoLots && quantity?.ok && !engine.Dec.parse(manualIso).add(manualNso).eq(quantity.value)) found.isoLots = `The lots must add up to the ${format.shares(quantity.value)} options exercised.`;
      if (!values.lotReason.trim()) found.lotReason = "Say why the lots differ from ISO first (audited).";
    }
    if (exerciseDate && fmv.data && !fmvValid) {
      const manual = parseAmount(values.manualFmv, { positive: true });
      if (!manual?.ok) found.manualFmv = manual?.ok === false ? manual.error : "Enter the FMV per share.";
      if (!values.fmvSource.trim()) found.fmvSource = "Enter the FMV's source.";
      if (!values.fmvDocument) found.fmvDocument = "Upload the FMV's source document.";
    }
    if (exerciseDate && !fmv.data) found.manualFmv = fmv.error !== undefined ? "Couldn't load the FMV for the exercise date. Try again." : "Wait for the FMV of the exercise date to load.";
    if (showWithholding) {
      for (const key of ["federal", "socialSecurity", "medicare", "stateAmount"] as const) {
        const parsed = parseAmount(values[key]);
        if (parsed && !parsed.ok) found[key] = parsed.error;
      }
      if (amountOf(values.stateAmount) && !/^[A-Za-z]{2}$/.test(values.stateCode.trim())) found.stateCode = "Use the state's two-letter code.";
      if (spread?.isPositive() && withheld.isZero() && !values.zeroReason.trim()) found.zeroReason = "$0 withheld on a W-2 NSO spread needs a reason.";
    }
    if (treatment === "NON_US" && !values.nonUsNote.trim()) found.nonUsNote = "Note how local payroll handles this exercise.";
    return found;
  }

  const review = () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    void flow.review();
  };
  const errorOf = (key: keyof ExerciseValues) => errors[key] ?? fieldProblem(flow.problem, key);
  const editing = flow.phase === "edit" || flow.phase === "previewing";
  const deadlineViolation = flow.problem?.kind === "invalid" && flow.problem.fields.payDate !== undefined && security.deadlines?.contractual && exerciseDate && exerciseDate > security.deadlines.contractual;

  // The review card's hints: the server's dry run is the authority.
  const blocks: string[] = [];
  const warns: string[] = [];
  const exercisable = security.numbers?.exercisable ?? null;
  if (exercisable !== null && total.gt(exercisable)) blocks.push(`Exceeds the ${format.shares(exercisable)} options vested and unexercised today.`);
  if (exerciseDate && exerciseDate > today) blocks.push("The exercise date can't be in the future.");
  const expiration = terms.expirationDate(security.terms);
  if (exerciseDate && expiration && exerciseDate > expiration) blocks.push(`The option expired on ${formatDate(expiration)}. No exercise can be recorded after the expiration date, and no extension can go past it.`);
  else if (exerciseDate && security.deadlines?.contractual && exerciseDate > security.deadlines.contractual) {
    blocks.push(`The exercise date is after the contractual deadline (${formatDate(security.deadlines.contractual)}). An admin can record a counsel-approved extension first.`);
  }
  const paid = amountOf(values.amount, { positive: true });
  if (cost && paid && engine.Dec.parse(paid).lt(cost)) blocks.push(`The payment is below the exercise cost (${formatComputedMoney(cost).text}).`);
  if (cost && paid && engine.Dec.parse(paid).gt(cost)) warns.push(`The payment exceeds the cost by ${exactMoney(engine.Dec.parse(paid).sub(cost).toString())}: the excess is recorded and refunded off-platform.`);
  if (values.payer.trim()) warns.push("Someone other than the holder paid (noted with the exercise).");
  if (afterIsoDeadline && total.isPositive()) warns.push(`${format.shares(total.toString())} ISO-designated options are exercised after the ISO deadline: the shares are recorded as NSO and excluded from Form 3921.`);

  const holderLine = stakeholder.data
    ? <>{holderName} <span className="muted">({RELATIONSHIP_LABELS[stakeholder.data.relationship]}{stakeholder.data.termination ? `, terminated ${formatDate(stakeholder.data.termination.date)}` : ""})</span></>
    : holderName;
  const reviewedSplit = flow.phase === "edit" || flow.phase === "previewing" ? null : shownSplit;

  return (
    <div className="wiz-body single">
      <div className="stack">
        <Card>
          <h2 className="mb-8">Record exercise — {security.displayId}</h2>
          <DescriptionList
            split
            rows={[
              ["Holder", holderLine],
              ["Vested and unexercised today", <><b>{format.shares(exercisable)}</b> {iso ? "ISO" : "NSO"} options at {format.price(strike)}</>],
              security.deadlines?.contractual ? ["Contractual deadline", formatDate(security.deadlines.contractual)] : null,
              isoDeadline ? ["ISO deadline", formatDate(isoDeadline)] : null,
              ["Expiration", <>{formatDate(expiration)} <span className="small muted">(no exercise after this date, even with an extension)</span></>],
              ["Payment reference format", reference ? <span className="mono">{reference}</span> : DASH],
            ]}
          />
        </Card>
        {editing ? <FlowProblemBanner problem={flow.problem} onRetry={review} busy={flow.busy} /> : null}
        {deadlineViolation ? (
          <Banner kind="info" title="An admin can extend the contractual deadline" action={<button type="button" className="btn btn-ghost btn-sm" onClick={() => setExtending(true)}>Extend exercise deadline</button>}>
            Record the counsel-approved extension with its document, then review this exercise again.
          </Banner>
        ) : null}
        <fieldset className="flow-fields stack" disabled={!editing} aria-label="Exercise details">
          <Section title="1. Notice of exercise">
            <div className="form-grid">
              <DocumentUpload label="Signed notice (counsel's form)" kind="NOTICE_OF_EXERCISE" required value={values.notice} onChange={(document) => set("notice", document)} error={errorOf("notice")} disabled={!editing} />
              <DateField label="Date received" required max={today} value={values.noticeDate} onChange={(value) => set("noticeDate", value)} error={errorOf("noticeDate")} />
            </div>
            <p className="small muted">The standard counsel form.</p>
          </Section>
          <Section title="2. Payment">
            <div className="form-grid">
              <AmountField label="Amount received" required prefix="$" value={values.amount} error={errorOf("amount")} onChange={(value) => { setTouched((current) => ({ ...current, amount: true })); set("amount", value); }} />
              <DateField label="Date full payment received" required max={today} value={values.payDate} onChange={(value) => set("payDate", value)} error={errorOf("payDate")} />
              <SelectField label="Method" required value={values.method} onChange={(value) => set("method", value as ExerciseValues["method"])} options={[["ACH", "ACH"], ["WIRE", "Wire"], ["CHECK", "Check"], ["CASH", "Cash"]]} error={errorOf("method")} />
              <TextField label="Reference" required value={values.reference} onChange={(value) => set("reference", value)} placeholder={reference ?? undefined} error={errorOf("reference")} />
              <TextField label="Payer (if not the holder)" value={values.payer} onChange={(value) => set("payer", value)} placeholder="Holder" error={errorOf("payer")} />
            </div>
            <div className="mt-8 small">
              {exerciseDate ? <>Exercise date: <b>{formatDate(exerciseDate)}</b> <span className="muted">(the later of the notice and full payment)</span></> : <span className="muted">The exercise date is the later of the notice date and the full-payment date.</span>}
            </div>
          </Section>
          <Section title="3. Quantity">
            <div className="form-grid">
              <AmountField label="Options exercised" required value={values.quantity} onChange={setQuantity} error={errorOf("quantity")} hint="Whole options, vested and unexercised." />
            </div>
            {iso ? (
              <div className="mt-8">
                <RadioCards label="Lots" value={values.lotMode} onChange={(value) => set("lotMode", value as ExerciseValues["lotMode"])} options={[
                  { value: "auto", label: "ISO lots first", sub: "The server splits the exercise for its date: ISO lots first, NSO beyond the $100,000 limit or after the ISO deadline" },
                  { value: "manual", label: "Choose the lots", sub: "Another split, with the reason (audited)" },
                ]} />
                {manual ? (
                  <div className="form-grid mt-8">
                    <AmountField label="ISO lots" value={values.isoLots} onChange={(value) => set("isoLots", value)} error={errorOf("isoLots")} />
                    <AmountField label="NSO lots" value={values.nsoLots} onChange={(value) => set("nsoLots", value)} error={errorOf("nsoLots")} />
                    <TextField className="full" label="Reason for this split (audited)" value={values.lotReason} onChange={(value) => set("lotReason", value)} placeholder="e.g. Holder asked to exercise the NSO portion first" error={errorOf("lotReason")} />
                  </div>
                ) : <p className="small muted mt-4">The review shows the server's split and the share IDs before anything is recorded.</p>}
              </div>
            ) : null}
            <div className="mt-8">
              {iso ? (
                isoDeadline ? (
                  afterIsoDeadline
                    ? <Banner kind="warn" title={`Exercise date is after the ISO deadline (${formatDate(isoDeadline)})`}>{format.shares(total.toString())} ISO-designated options become NSO shares, excluded from Form 3921.</Banner>
                    : <Banner kind="ok" title={`ISO deadline ${formatDate(isoDeadline)} — qualifies`}>An exercise dated after {formatDate(isoDeadline)} would be recorded as NSO and excluded from Form 3921.</Banner>
                ) : <Banner kind="ok" title="ISO check">{stakeholder.data?.termination ? "No ISO deadline applies." : "The holder is employed: ISO treatment applies to ISO lots."}</Banner>
              ) : <p className="small muted">NSO grant — no ISO check.</p>}
            </div>
          </Section>
          <Section title="4. FMV at exercise">
            {!exerciseDate ? <p className="muted small">Shown once the dates are entered.</p>
              : fmv.error !== undefined ? <p className="err-inline">Couldn't load the FMV for {formatDate(exerciseDate)}. <button type="button" className="btn-link small" onClick={fmv.reload}>Try again</button></p>
                : !fmv.data ? <p className="muted small" role="status">Loading the FMV…</p>
                  : fmvValid ? <div><b>{format.price(fmvValid.pricePerShare)}</b> <span className="muted">({fmvValid.valuationName}, {VALUATION_STATUS_LABELS[fmvValid.status].toLowerCase()} on {formatDate(exerciseDate)})</span></div>
                    : (
                      <>
                        <Banner kind="warn" title={`No presumptively valid 409A on ${formatDate(exerciseDate)}`}>Enter the FMV and its source (with a document).</Banner>
                        <div className="form-grid mt-8">
                          <AmountField label="FMV per share" prefix="$" value={values.manualFmv} onChange={(value) => set("manualFmv", value)} error={errorOf("manualFmv")} />
                          <TextField label="FMV source" value={values.fmvSource} onChange={(value) => set("fmvSource", value)} placeholder="e.g. Provider bring-down letter dated …" error={errorOf("fmvSource")} />
                          <DocumentUpload label="FMV source document" kind="VALUATION_SUPPORT" value={values.fmvDocument} onChange={(document) => set("fmvDocument", document)} error={errorOf("fmvDocument")} disabled={!editing} />
                        </div>
                      </>
                    )}
            {errorOf("manualFmv") && fmvValid ? <div className="err-inline">{errorOf("manualFmv")}</div> : null}
          </Section>
          <Section title="5. Tax">
            <div className="form-grid">
              <SelectField label="Treatment" value={treatment} error={errorOf("treatment")} onChange={(value) => { setTouched((current) => ({ ...current, treatment: true })); set("treatment", value as TaxTreatment); }}
                options={[["W2", "W-2 (employee or former employee)"], ["FORM_1099_NEC", "1099-NEC (non-employee)"], ["NON_US", `Non-US — local payroll${security.exemption.country ? ` (${security.exemption.country})` : ""}`]]} />
            </div>
            <p className="small mt-8">
              {treatment === "NON_US" ? <span className="muted">No US withholding lines — handled by local payroll in {security.exemption.country ?? "the holder's country"}.</span>
                : nsoPortion.isPositive() ? <>NSO spread: <b>{spread ? formatComputedMoney(spread).text : DASH}</b> (FMV {fmvPrice ? format.price(fmvPrice) : DASH} − strike {format.price(strike)}) × {format.shares(nsoPortion.toString())}{serverNso !== null && iso && !afterIsoDeadline && !manual ? " (the server's split)" : ""}. {treatment === "FORM_1099_NEC" ? "Non-employee: no withholding — the reason “Non-employee” is stored with the exercise." : "Enter the withholding payroll collected, per line."}</>
                  : <span className="muted">ISO exercise: no withholding lines. If the $100,000 limit makes part of it NSO, the review shows that part, and W-2 withholding is entered here. AMT note: the spread may count for the alternative minimum tax.</span>}
            </p>
            {showWithholding ? (
              <div className="form-grid mt-8">
                <AmountField label="Federal income tax withheld" prefix="$" value={values.federal} onChange={(value) => set("federal", value)} error={errorOf("federal")} />
                <AmountField label="Social Security withheld" prefix="$" value={values.socialSecurity} onChange={(value) => set("socialSecurity", value)} error={errorOf("socialSecurity")} />
                <AmountField label="Medicare withheld" prefix="$" value={values.medicare} onChange={(value) => set("medicare", value)} error={errorOf("medicare")} />
                <AmountField label="State income tax withheld" prefix="$" value={values.stateAmount} onChange={(value) => set("stateAmount", value)} error={errorOf("stateAmount")} />
                <TextField label="State" value={values.stateCode} onChange={(value) => set("stateCode", value)} error={errorOf("stateCode")} />
                <TextField label="Reason if $0" value={values.zeroReason} onChange={(value) => set("zeroReason", value)} error={errorOf("zeroReason")} />
              </div>
            ) : null}
            {treatment === "NON_US" ? (
              <div className="mt-8"><TextField label="Local payroll note" value={values.nonUsNote} onChange={(value) => set("nonUsNote", value)} placeholder={`Handled by local payroll in ${security.exemption.country ?? "the holder's country"}`} error={errorOf("nonUsNote")} /></div>
            ) : null}
          </Section>
          <Section title="6. Resulting shares">
            <div className="form-grid">
              <div className="fld"><span className="lbl">Share IDs</span><div className="small">Assigned by the server per class prefix, one lot per portion; the review shows them.</div></div>
              <div className="fld"><span className="lbl">Form</span><div><b>Book entry</b> <span className="muted small">(Cap Table doesn't generate certificates)</span></div></div>
              <div className="fld"><span className="lbl">Legends</span><div className="small">{iso ? "ISO shares: L1, L2, L3 · NSO shares: L1, L2" : "L1, L2"}</div></div>
            </div>
          </Section>
        </fieldset>
        <Card>
          <h2 className="mb-8">Review &amp; submit</h2>
          <DescriptionList
            split
            rows={[
              ["Quantities", reviewedSplit ? `${format.shares(reviewedSplit.lots.iso)} ISO + ${format.shares(reviewedSplit.lots.nso)} NSO lots (the server's split)`
                : total.isPositive() ? `${format.shares(total.toString())} options${manual ? ` — ${format.shares(manualIso)} ISO + ${format.shares(manualNso)} NSO lots, as chosen` : iso ? " — ISO lots first; the review shows the split" : ""}` : DASH],
              ["Exercise date", formatDate(exerciseDate)],
              ["Cost", cost ? `${formatComputedMoney(cost).text}${formatComputedMoney(cost).rounded ? ", rounded to the cent" : ""}` : DASH],
              ["Payment", `${paid ? exactMoney(paid) : DASH} · ${values.method === "WIRE" ? "Wire" : values.method === "CHECK" ? "Check" : values.method === "CASH" ? "Cash" : "ACH"}${values.reference.trim() ? ` · ref ${values.reference.trim()}` : ""}`],
              ["FMV at exercise", fmvPrice ? format.price(fmvPrice) : DASH],
              ["Spread (NSO)", spread ? formatComputedMoney(spread).text : DASH],
              ["Tax treatment", treatment === "NON_US" ? `Non-US — local payroll (${security.exemption.country ?? DASH})` : iso && !nsoPortion.isPositive() ? "ISO — none" : treatment === "W2" ? "W-2" : "1099-NEC"],
              ["Withholding entered", showWithholding ? exactMoney(withheld.toString()) : "None"],
              ["ISO result", !iso ? "Not applicable" : afterIsoDeadline ? "Recorded as NSO (after the ISO deadline)" : reviewedSplit
                ? reviewedSplit.portions.map((item) => (item.portion === "ISO" ? `${format.shares(item.quantity)} ISO — Form 3921` : `${format.shares(item.quantity)} NSO (${item.reason ? NSO_REASONS[item.reason] : "NSO"})`)).join(" · ")
                : "ISO lots first — they join the Form 3921 population"],
              ["Resulting shares", reviewedSplit ? `${reviewedSplit.portions.map((item) => `${item.displayId} (${item.portion} ${format.shares(item.quantity)})`).join(" + ")} · book entry` : "IDs assigned by the server · book entry"],
              ["Fully diluted", "Unchanged (options become shares)"],
            ]}
          />
          <div className="mt-8">
            <BlockList items={blocks} />
            {warns.length ? <div className="mt-8"><BlockList items={warns} kind="warn" /></div> : null}
          </div>
          {editing ? (
            <div className="wiz-foot">
              {fmvPending ? <span id="exercise-fmv-loading" className="small muted" role="status">Loading the FMV for {formatDate(exerciseDate)}…</span> : null}
              <Link className="btn btn-ghost" to={back}>Cancel</Link>
              <button type="button" className="btn btn-primary" onClick={review} disabled={flow.busy || fmvPending} aria-describedby={fmvPending ? "exercise-fmv-loading" : undefined}>{flow.phase === "previewing" ? "Checking…" : "Review"}</button>
            </div>
          ) : (
            <div className="mt-12">
              <FlowProblemBanner problem={flow.problem} onRetry={() => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
              {reviewedSplit ? (
                <section className="review-panel mb-8" aria-label="Lots and resulting shares">
                  <h3>The server's split for {formatDate(reviewedSplit.date)}</h3>
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    {iso ? <li>ISO lots still exercisable as ISO on that date: {format.shares(reviewedSplit.isoAvailable)}</li> : null}
                    <li>Lots used: {format.shares(reviewedSplit.lots.iso)} ISO · {format.shares(reviewedSplit.lots.nso)} NSO</li>
                    {reviewedSplit.portions.map((item) => (
                      <li key={item.portion}>{item.displayId}: {format.shares(item.quantity)} {item.portion} shares{item.reason ? `, NSO ${NSO_REASONS[item.reason]}` : ""}</li>
                    ))}
                  </ul>
                  <p className="small muted">Recorded exactly as shown: these lots and share IDs are what the confirmation sends.</p>
                </section>
              ) : null}
              {flow.preview ? <CommandPreview transactions={flow.preview.transactions} changes={flow.preview.changes} names={new Map([[security.id, security.displayId]])} /> : null}
              <WarningsToAcknowledge flow={flow as never} />
              <div className="wiz-foot">
                <button type="button" className="btn btn-ghost" onClick={flow.edit} disabled={flow.busy || flow.locked}>Change answers</button>
                <button type="button" className="btn btn-primary" onClick={() => void flow.commit()} disabled={flow.busy || flow.locked || !flow.acknowledgedAll}>
                  {flow.phase === "committing" ? "Recording…" : "Record exercise"}
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>
      {extending ? <ExtendDeadlineDialog security={security} onClose={() => setExtending(false)} onDone={() => setExtending(false)} /> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2 className="mb-8">{title}</h2>
      {children}
    </section>
  );
}
