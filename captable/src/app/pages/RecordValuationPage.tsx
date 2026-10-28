import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "#shared";
import { apiRequest } from "../api/request.ts";
import { DocumentUpload, type UploadedDocument } from "../components/DocumentUpload.tsx";
import { ErrorState, Loading } from "../components/Feedback.tsx";
import { FlowProblemBanner } from "../components/FlowParts.tsx";
import { AmountField, DateField, TextField } from "../components/Form.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page, PageHead } from "../components/Page.tsx";
import { useToast } from "../components/Toast.tsx";
import { WriteGate } from "../components/WritePage.tsx";
import { amountOf, parseAmount } from "../lib/amounts.ts";
import { addYears, formatDate } from "../lib/format.ts";
import { fieldProblem, useWriteFlow, type FieldMap } from "../lib/flow.ts";
import { allOf, useResource } from "../lib/useResource.ts";
import { classPrice, currentValuation } from "../lib/valuations.ts";

// Record FMV: the independent provider's report, with
// the FMV per class (common required) and the report PDF. The app records 409As, it never performs them. A later
// valuation supersedes earlier ones from its effective date; a recorded 409A is never edited or reversed.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "Oct 2026 Valuation": the server's default name for an effective date. */
export function defaultValuationName(effectiveDate: string): string {
  return DATE.test(effectiveDate) ? `${MONTHS[Number(effectiveDate.slice(5, 7)) - 1]} ${effectiveDate.slice(0, 4)} Valuation` : "";
}

export function RecordValuationPage() {
  const { href } = useWorkspace();
  return (
    <Page title="Record FMV" crumbs={[["Compliance & Tax", href("compliance/409a")], ["Record FMV"]]}>
      <WriteGate back={{ to: href("compliance/409a"), label: "Back to 409A valuations" }}>
        <ValuationLoader />
      </WriteGate>
    </Page>
  );
}

function ValuationLoader() {
  const { orgId } = useWorkspace();
  const classes = useResource((signal) => apiRequest(api.routes.listStockClasses, { params: { orgId }, signal }), [orgId]);
  const valuations = useResource((signal) => apiRequest(api.routes.listValuations, { params: { orgId }, signal }), [orgId]);
  const all = allOf(classes, valuations);
  if (all.error !== undefined) return <ErrorState error={all.error} onRetry={all.reload} />;
  if (!all.data) return <Loading label="Loading the share classes…" />;
  return <ValuationForm classes={all.data[0].items} valuations={all.data[1].items} />;
}

const FIELDS: FieldMap = {
  issue: (path) => {
    if (path.startsWith("prices")) return "prices";
    const direct: Record<string, string> = { provider: "provider", name: "name", effectiveDate: "effective", expirationDate: "expiration", reportDocumentId: "report", boardApprovalDate: "board", boardConsentDocumentId: "consent", methodNotes: "method" };
    return direct[path] ?? null;
  },
};

function ValuationForm({ classes, valuations }: { classes: readonly api.StockClass[]; valuations: readonly api.Valuation[] }) {
  const { orgId, today, format, href } = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const common = classes.find((item) => item.classType === "COMMON") ?? null;
  const ordered = common ? [common, ...classes.filter((item) => item.id !== common.id)] : [...classes];
  const last = currentValuation(valuations, today);
  const lastCommon = last ? classPrice(last, classes) : null;
  const [provider, setProvider] = useState("");
  const [name, setName] = useState("");
  const [effective, setEffective] = useState(today);
  const [expiration, setExpiration] = useState(addYears(today, 1));
  const [expirationTouched, setExpirationTouched] = useState(false);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [report, setReport] = useState<UploadedDocument | null>(null);
  const [board, setBoard] = useState("");
  const [consent, setConsent] = useState<UploadedDocument | null>(null);
  const [method, setMethod] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const clear = (key: string) => setErrors((current) => ({ ...current, [key]: undefined }));
  const typedPrices = ordered.map((item) => ({ stockClassId: item.id, name: item.name, value: amountOf(prices[item.id] ?? "", { positive: true }) })).filter((item) => item.value !== null);

  const flow = useWriteFlow({
    request: () => ({
      ...(name.trim() ? { name: name.trim() } : {}),
      provider: provider.trim(),
      effectiveDate: effective,
      expirationDate: expiration,
      ...(board ? { boardApprovalDate: board } : {}),
      ...(consent ? { boardConsentDocumentId: consent.id } : {}),
      prices: typedPrices.map((item) => ({ stockClassId: item.stockClassId, pricePerShare: item.value! })),
      reportDocumentId: report?.id ?? "",
      ...(method.trim() ? { methodNotes: method.trim() } : {}),
    }),
    preview: null,
    body: ({ request }) => request,
    send: (body, key) => apiRequest(api.routes.recordValuation, { params: { orgId }, body, idempotencyKey: key }),
    // A valuation with this effective date and provider now on record may be this one.
    reconcile: async ({ request }) => ((await apiRequest(api.routes.listValuations, { params: { orgId } })).items
      .some((item) => item.effectiveDate === request.effectiveDate && item.provider === request.provider && item.status !== "voided") ? "unknown" : "not_recorded"),
    fields: FIELDS,
    onCommitted: (valuation) => {
      toast({ message: `${valuation.name} recorded`, to: href(`compliance/409a/${valuation.id}`), linkLabel: "Open" });
      navigate(href("compliance/409a"));
    },
  });
  const review = () => {
    const found: Record<string, string> = {};
    if (!provider.trim()) found.provider = "Provider is required.";
    if (!DATE.test(effective)) found.effective = "Enter the effective date.";
    else if (effective > today) found.effective = "The effective date can't be in the future.";
    if (!DATE.test(expiration)) found.expiration = "Enter the expiration date.";
    else if (DATE.test(effective) && expiration <= effective) found.expiration = "The expiration date must be later than the effective date.";
    for (const item of ordered) {
      const parsed = parseAmount(prices[item.id] ?? "", { positive: true });
      if (parsed && !parsed.ok) found[`price:${item.id}`] = parsed.error;
    }
    if (common && !amountOf(prices[common.id] ?? "", { positive: true }) && !found[`price:${common.id}`]) found[`price:${common.id}`] = "Enter the FMV of common.";
    if (!report) found.report = "Upload the valuation report (PDF).";
    const same = valuations.find((item) => item.effectiveDate === effective && item.status !== "voided");
    if (same) found.effective = `${same.name} is already recorded with the effective date ${formatDate(effective)}. Void it first if it was recorded in error.`;
    setErrors(found);
    if (Object.keys(found).length === 0) void flow.review();
  };
  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  const editing = flow.phase === "edit";
  const resolvedName = name.trim() || defaultValuationName(effective);

  return (
    <Card>
      <PageHead title="Record FMV" />
      {editing ? <FlowProblemBanner problem={flow.problem} /> : null}
      <fieldset className="flow-fields form" disabled={!editing} style={{ maxWidth: 640 }} aria-label="Valuation">
        <div className="form-grid">
          <TextField label="Provider" required value={provider} onChange={(value) => { setProvider(value); clear("provider"); }} placeholder="e.g. Harborline Valuation Partners" error={errorOf("provider")} />
          <TextField label="Name" value={name} onChange={setName} placeholder={`Auto: "${defaultValuationName(effective) || "<Mon YYYY> Valuation"}"`} error={errorOf("name")} />
        </div>
        <div className="form-grid">
          <DateField label="Effective date" required max={today} value={effective} error={errorOf("effective")}
            onChange={(value) => { setEffective(value); clear("effective"); if (!expirationTouched && DATE.test(value)) setExpiration(addYears(value, 1)); }} />
          <DateField label="Expiration date" required value={expiration} hint="Default +12 months — an upper bound, not a guarantee." error={errorOf("expiration")}
            onChange={(value) => { setExpiration(value); setExpirationTouched(true); clear("expiration"); }} />
        </div>
        {ordered.map((item) => (
          <AmountField
            key={item.id}
            label={`FMV per share — ${item.name}`}
            required={item.id === common?.id}
            prefix="$"
            value={prices[item.id] ?? ""}
            onChange={(value) => { setPrices((current) => ({ ...current, [item.id]: value })); clear(`price:${item.id}`); }}
            hint={item.id === common?.id ? (lastCommon && last ? `Previous: ${format.price(lastCommon)} (${last.name})` : undefined) : "Optional: only when the report values this class."}
            error={errorOf(`price:${item.id}`) ?? (item.id === common?.id ? errorOf("prices") : undefined)}
          />
        ))}
        <DocumentUpload label="Valuation report (PDF)" kind="VALUATION_REPORT" required value={report} onChange={(document) => { setReport(document); clear("report"); }} error={errorOf("report")} disabled={!editing} />
        <div className="form-grid">
          <DateField label="Board adoption date (optional)" value={board} onChange={setBoard} error={errorOf("board")} />
          <TextField label="Method notes (optional)" value={method} onChange={setMethod} error={errorOf("method")} />
        </div>
        <DocumentUpload label="Board consent (optional)" kind="BOARD_CONSENT" value={consent} onChange={setConsent} error={errorOf("consent")} disabled={!editing} />
      </fieldset>
      {editing ? (
        <>
          <div className="row mt-12">
            <Link className="btn btn-ghost" to={href("compliance/409a")}>Cancel</Link>
            <button type="button" className="btn btn-primary" onClick={review}>Save</button>
          </div>
          <p className="small muted mt-8">A later valuation marks earlier ones Superseded from its effective date. A recorded 409A cannot be reversed; record a corrected valuation instead.</p>
        </>
      ) : (
        <div className="mt-16">
          <FlowProblemBanner problem={flow.problem} onRetry={() => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
          <div className="review-panel mt-8" aria-label="Review">
            <h3>Review the valuation</h3>
            <p>
              Record <b>{resolvedName}</b> from {provider.trim()}: effective {formatDate(effective)}, presumptively valid until {formatDate(expiration)} at the latest.
            </p>
            <ul className="small" style={{ margin: "4px 0 8px", paddingLeft: 18 }} aria-label="FMV per class">
              {typedPrices.map((item) => <li key={item.stockClassId}>{item.name}: {format.price(item.value!)}</li>)}
            </ul>
            <p className="small">Report: {report?.filename}{last && DATE.test(effective) && effective > last.effectiveDate ? ` · ${last.name} is superseded from ${formatDate(effective)}` : ""}. No e-mail is sent.</p>
          </div>
          <div className="wiz-foot">
            <button type="button" className="btn btn-ghost" onClick={flow.edit} disabled={flow.busy || flow.locked}>Back to edit</button>
            <button type="button" className="btn btn-primary" onClick={() => void flow.commit()} disabled={flow.busy || flow.locked}>{flow.phase === "committing" ? "Saving…" : "Record valuation"}</button>
          </div>
        </div>
      )}
    </Card>
  );
}
