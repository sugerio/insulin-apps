import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, engine } from "#shared";
import { apiRequest } from "../api/request.ts";
import { DocumentUpload, type UploadedDocument } from "../components/DocumentUpload.tsx";
import { Banner, InlineError, ResourceView } from "../components/Feedback.tsx";
import { CommandPreview, FlowProblemBanner, WarningsToAcknowledge } from "../components/FlowParts.tsx";
import { AmountField, CheckLine, DateField, SelectField, TextField } from "../components/Form.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page } from "../components/Page.tsx";
import { useToast } from "../components/Toast.tsx";
import { WriteGate } from "../components/WritePage.tsx";
import { amountOf, parseAmount } from "../lib/amounts.ts";
import { DASH, formatDate } from "../lib/format.ts";
import { fieldProblem, ledgerUnmoved, useWriteFlow, type FieldMap } from "../lib/flow.ts";
import { optionType, periodLabel, RELATIONSHIP_LABELS, TERMINATION_TYPE_LABELS } from "../lib/labels.ts";
import * as terms from "../lib/terms.ts";
import { useResource } from "../lib/useResource.ts";

// Terminate stakeholder: Pulley's four steps for one person —
// details, vesting outcome, exercise and repurchase windows, review. A future date records a scheduled termination
// (vesting continues until then; once the date arrives it is recorded the next time an admin opens the app, or with
// "Process due items"). Steps 2 and 3 show the server's termination preview for each security; step 4 shows the dry run
// of the command itself, which is what the admin confirms.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STEPS = ["Termination details", "Vesting outcome", "Exercise and repurchase windows", "Review"] as const;
const TYPES = Object.entries(TERMINATION_TYPE_LABELS) as [api.TerminationType, string][];
const RELATIONSHIPS = (Object.keys(RELATIONSHIP_LABELS) as api.Relationship[]).map((relationship) => [relationship, RELATIONSHIP_LABELS[relationship]] as const);
const WINDOW_REASON: Record<api.TerminationType, string> = { voluntary: "VOLUNTARY", involuntary: "INVOLUNTARY", with_cause: "WITH_CAUSE", death: "DEATH", disability: "DISABILITY", retirement: "RETIREMENT" };

interface Details {
  date: string;
  type: api.TerminationType;
  stop: string;
  stopTouched: boolean;
  attest: boolean;
  relationshipAfter: api.Relationship;
}

interface Acceleration {
  manual: boolean;
  quantity: string;
  reason: string;
  document: UploadedDocument | null;
}

interface Extension {
  deadline: string;
  document: UploadedDocument | null;
}

/** The termination preview of one security, with the holding it is about. */
interface Row {
  security: api.Security;
  preview: api.TerminationPreview;
}

interface Preview {
  result: api.CommandResult;
  scheduled: boolean;
}

export function TerminatePage() {
  const { orgId, href, isOwn } = useWorkspace();
  const { stakeholderId = "" } = useParams();
  const detail = useResource((signal) => apiRequest(api.routes.getStakeholder, { params: { orgId, id: stakeholderId }, signal }), [orgId, stakeholderId]);
  const back = href(`stakeholders/${stakeholderId}`);
  const name = detail.data?.displayName ?? "Stakeholder";
  return (
    <Page title={`Terminate ${name}`} crumbs={[["Stakeholders", href("stakeholders")], [name, back], ["Terminate"]]}>
      <ResourceView resource={detail} notFound="This stakeholder does not exist.">
        {(data) => (
          <WriteGate own={isOwn(data.id)} back={{ to: back, label: "Back to the stakeholder" }}>
            {data.scheduledTermination || data.termination ? (
              <Card>
                <Banner kind="warn" title={data.scheduledTermination ? "A termination is already scheduled" : "Already terminated"}>
                  {data.scheduledTermination
                    ? "An admin can reverse it from the stakeholder page; changing the date means reverse, then record again."
                    : "An admin can reverse the termination from the stakeholder page."}
                </Banner>
                <div className="row mt-12"><Link className="btn btn-ghost" to={back}>Back to the stakeholder</Link></div>
              </Card>
            ) : <TerminateWizard stakeholder={data} back={back} />}
          </WriteGate>
        )}
      </ResourceView>
    </Page>
  );
}

function TerminateWizard({ stakeholder, back }: { stakeholder: api.StakeholderDetail; back: string }) {
  const { orgId, today, format, org } = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [details, setDetails] = useState<Details>({ date: today, type: "voluntary", stop: today, stopTouched: false, attest: false, relationshipAfter: "ex_employee" });
  const [accelerations, setAccelerations] = useState<Record<string, Acceleration>>({});
  const [extensions, setExtensions] = useState<Record<string, Extension>>({});
  const [repurchases, setRepurchases] = useState<Record<string, Extension>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const scheduled = DATE.test(details.date) && details.date > today;
  const stop = details.stopTouched ? details.stop : details.date;

  const holdings = useResource((signal) => apiRequest(api.routes.getStakeholderHoldings, { params: { orgId, id: stakeholder.id }, signal }), [orgId, stakeholder.id]);
  const affected = (holdings.data?.items ?? []).filter((security) => security.status === "OUTSTANDING"
    && (security.family === "EQUITY_COMPENSATION" || (security.family === "STOCK" && terms.vestingTermsId(security.terms) !== null)));
  const ids = affected.map((security) => security.id).join(",");
  const previewsReady = holdings.data !== undefined && DATE.test(details.date) && DATE.test(stop) && step >= 2;
  const previews = useResource(
    (signal) => Promise.all(affected.map(async (security): Promise<Row> => ({
      security,
      preview: await apiRequest(api.routes.getTerminationPreview, { params: { orgId, id: security.id }, query: { terminationDate: details.date, terminationType: details.type, vestingStopDate: stop }, signal }),
    }))),
    [orgId, ids, details.date, details.type, stop],
    previewsReady,
  );
  const planIds = [...new Set(affected.map((security) => security.stockPlanId).filter((id): id is string => id !== null))];
  const plans = useResource((signal) => Promise.all(planIds.map((id) => apiRequest(api.routes.getStockPlan, { params: { orgId, id }, signal }))), [orgId, planIds.join(",")], planIds.length > 0);

  const options = (previews.data ?? []).filter((row) => row.security.family === "EQUITY_COMPENSATION");
  const shares = (previews.data ?? []).filter((row) => row.security.family === "STOCK");

  function bodyOf() {
    return {
      stakeholderId: stakeholder.id,
      terminationDate: details.date,
      terminationType: details.type,
      vestingStopDate: stop,
      ...(details.type === "disability" ? { disabilityAttestation: details.attest } : {}),
      relationshipAfter: details.relationshipAfter,
      accelerations: Object.entries(accelerations).filter(([, item]) => item.manual).map(([securityId, item]) => ({
        securityId, quantity: amountOf(item.quantity, { positive: true }) ?? "0", reason: item.reason.trim(), documentId: item.document?.id ?? "",
      })),
      deadlineExtensions: Object.entries(extensions).filter(([securityId, item]) => item.deadline && item.deadline !== computedDeadline(securityId)).map(([securityId, item]) => ({
        securityId, newContractualDeadline: item.deadline, documentId: item.document?.id ?? "",
      })),
      repurchaseDeadlines: Object.entries(repurchases).filter(([, item]) => item.deadline).map(([securityId, item]) => ({
        securityId, lastRepurchaseDate: item.deadline, documentId: item.document?.id ?? "",
      })),
    };
  }
  function computedDeadline(securityId: string): string | null {
    return options.find((row) => row.security.id === securityId)?.preview.contractualDeadline ?? null;
  }

  const fields: FieldMap = {
    issue: (path) => {
      if (path === "terminationDate") return "date";
      if (path === "vestingStopDate") return "stop";
      if (path === "terminationType") return "type";
      const match = /^(accelerations|deadlineExtensions|repurchaseDeadlines)\.(\d+)/.exec(path);
      if (match) {
        const body = bodyOf();
        const list = match[1] === "accelerations" ? body.accelerations : match[1] === "deadlineExtensions" ? body.deadlineExtensions : body.repurchaseDeadlines;
        const item = list[Number(match[2])];
        return item ? `${match[1] === "accelerations" ? "accel" : match[1] === "deadlineExtensions" ? "deadline" : "repurchase"}:${item.securityId}` : null;
      }
      return null;
    },
    violation: (violation) => {
      const id = violation.securityId;
      switch (violation.code) {
        case "TERMINATION_DATE_IN_FUTURE":
        case "TERMINATION_DATE_NOT_IN_FUTURE":
          return "date";
        case "VESTING_STOP_AFTER_TERMINATION":
          return "stop";
        case "VESTING_STOP_BEFORE_ISSUE":
          return id ? `row:${id}` : "stop";
        case "ACCELERATION_EXCEEDS_UNVESTED":
          return id ? `accel:${id}` : null;
        case "REPURCHASE_DEADLINE_NOT_RECORDED":
          return id ? `repurchase:${id}` : null;
        case "EXTENSION_AFTER_EXPIRATION":
        case "NOT_OPTION_OR_WARRANT":
          return id ? `deadline:${id}` : null;
        default:
          return null;
      }
    },
  };

  type TerminationRequest = ReturnType<typeof bodyOf>;
  // A future date is a scheduled termination (a workflow row); today or earlier, the command itself.
  const isScheduled = (request: TerminationRequest) => request.terminationDate > today;
  const dryRun = async (frozen: TerminationRequest, signal?: AbortSignal): Promise<Preview> => isScheduled(frozen)
    ? { result: (await apiRequest(api.routes.scheduleTermination, { params: { orgId }, dryRun: true, body: frozen, signal })).preview, scheduled: true }
    : { result: await apiRequest(api.routes.terminateStakeholder, { params: { orgId }, dryRun: true, body: frozen, signal }), scheduled: false };
  const flow = useWriteFlow({
    request: bodyOf,
    preview: dryRun,
    body: ({ request: frozen, preview, acknowledge }) => ({ ...frozen, expectedLedgerSeq: preview!.result.ledgerSeq, expectedDiffSha256: preview!.result.diffSha256, acknowledge: [...acknowledge] }),
    send: async (body, key): Promise<Preview> => isScheduled(body)
      ? { result: (await apiRequest(api.routes.scheduleTermination, { params: { orgId }, body, idempotencyKey: key })).preview, scheduled: true }
      : { result: await apiRequest(api.routes.terminateStakeholder, { params: { orgId }, body, idempotencyKey: key }), scheduled: false },
    // A scheduled termination writes no ledger transaction, so its check is the stakeholder's scheduled row.
    reconcile: async ({ request: frozen, preview }) => isScheduled(frozen)
      ? ((await apiRequest(api.routes.getStakeholder, { params: { orgId, id: stakeholder.id } })).scheduledTermination ? "unknown" : "not_recorded")
      : ledgerUnmoved(async () => (await dryRun(frozen)).result, preview!.result.ledgerSeq),
    fields,
    onCommitted: ({ result, scheduled: wasScheduled }) => {
      const returned = engine.Dec.sum(result.transactions.filter((transaction) => transaction.type === "TX_EQUITY_COMPENSATION_CANCELLATION").map((transaction) => engine.Dec.parse(transaction.quantity ?? "0")));
      toast({
        message: wasScheduled
          ? `Termination scheduled for ${formatDate(details.date)} — TERMINATING badge shown`
          : `${stakeholder.displayName} terminated — ${format.shares(returned.toString())} options cancelled`,
      });
      navigate(back);
    },
  });

  /** The step where a server error belongs: the earliest one with a field it names. */
  const stepOfProblem = () => {
    if (flow.problem?.kind !== "invalid") return null;
    const keys = Object.keys(flow.problem.fields);
    if (keys.some((key) => ["date", "stop", "type"].includes(key))) return 1;
    if (keys.some((key) => key.startsWith("accel:") || key.startsWith("row:"))) return 2;
    if (keys.some((key) => key.startsWith("deadline:") || key.startsWith("repurchase:"))) return 3;
    return null;
  };

  function validate(at: number): Record<string, string> {
    const found: Record<string, string> = {};
    if (at === 1) {
      if (!DATE.test(details.date)) found.date = "Enter the termination date.";
      if (!DATE.test(stop)) found.stop = "Enter the vesting stop date.";
      else if (DATE.test(details.date) && stop > details.date) found.stop = "The vesting stop date may be earlier than the termination date, never later.";
    }
    if (at === 2) {
      for (const row of options) {
        const item = accelerations[row.security.id];
        if (!item?.manual) continue;
        const quantity = parseAmount(item.quantity, { positive: true, unit: org.shareUnit, unitName: "options" });
        if (!quantity?.ok) found[`accel:${row.security.id}`] = quantity?.ok === false ? quantity.error : "Enter the quantity to accelerate.";
        else if (engine.Dec.parse(quantity.value).gt(row.preview.unvested)) found[`accel:${row.security.id}`] = `At most the ${format.shares(row.preview.unvested)} unvested options.`;
        else if (!item.reason.trim()) found[`accel:${row.security.id}`] = "A manual acceleration needs its reason.";
        else if (!item.document) found[`accel:${row.security.id}`] = "A manual acceleration needs its authorizing document.";
      }
    }
    if (at === 3) {
      for (const row of options) {
        const item = extensions[row.security.id];
        const computed = row.preview.contractualDeadline;
        if (!item?.deadline || item.deadline === computed) continue;
        const expiration = terms.expirationDate(row.security.terms);
        if (computed && item.deadline < computed) found[`deadline:${row.security.id}`] = `An extension cannot shorten the contractual deadline (${formatDate(computed)}).`;
        else if (expiration && item.deadline > expiration) found[`deadline:${row.security.id}`] = `The deadline can't be after the expiration date (${formatDate(expiration)}).`;
        else if (!item.document) found[`deadline:${row.security.id}`] = "Changing the contractual deadline needs the extension document.";
      }
      for (const row of shares) {
        const item = repurchases[row.security.id];
        if (item?.deadline && !item.document) found[`repurchase:${row.security.id}`] = "The last date to repurchase needs the agreement it comes from.";
      }
    }
    return found;
  }

  const go = (direction: 1 | -1) => {
    if (direction > 0) {
      const found = validate(step);
      setErrors(found);
      if (Object.keys(found).length) return;
      if ((step === 2 || step === 3) && !previews.data) return;
    }
    const next = Math.min(4, Math.max(1, step + direction));
    if (step === 4 && direction < 0) flow.edit();
    setStep(next);
    if (next === 4) void flow.review().then(() => undefined);
    window.scrollTo?.(0, 0);
  };
  // A dry run refused by the server sends the admin back to the step that holds the field it names.
  const problemStep = stepOfProblem();
  useEffect(() => {
    if (problemStep !== null && step === 4 && flow.phase === "edit") setStep(problemStep);
  }, [problemStep, step, flow.phase]);

  const errorOf = (key: string) => errors[key] ?? fieldProblem(flow.problem, key);
  const setDetail = <K extends keyof Details>(key: K, value: Details[K]) => {
    setDetails((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    if (flow.problem?.kind === "invalid") flow.clearProblem();
  };
  const windowWhy = (row: Row): string => {
    const own = terms.terminationWindows(row.security.terms).get(WINDOW_REASON[details.type]);
    const plan = plans.data?.find((item) => item.id === row.security.stockPlanId);
    const inherited = plan?.defaultTerminationWindows.find((window) => window.reason === WINDOW_REASON[details.type]);
    const window = own ?? inherited;
    return window ? `${periodLabel(window)} after ${TERMINATION_TYPE_LABELS[details.type].toLowerCase()} termination${own ? " (grant)" : ""}` : "";
  };
  const isoWhy = details.type === "death" ? "None after death" : details.type === "disability" && details.attest ? "12 months (Internal Revenue Code section 22(e)(3) disability)" : "3 months after termination";

  let body: ReactNode = null;
  if (step === 1) {
    body = (
      <>
        <Card>
          <h1 className="mb-8">Terminate {stakeholder.displayName}</h1>
          <p className="muted">{RELATIONSHIP_LABELS[stakeholder.relationship]}. A future date records a <b>scheduled termination</b>: vesting continues until then.</p>
        </Card>
        <Card>
          <h2 className="mb-12">1. Termination details</h2>
          <div className="form" style={{ maxWidth: 560 }}>
            <DateField label="Termination date" required value={details.date} onChange={(value) => setDetail("date", value)} hint="Today, a past date, or a future date (scheduled)." error={errorOf("date")} />
            <SelectField label="Termination type" required value={details.type} onChange={(value) => setDetail("type", value as api.TerminationType)} options={TYPES} error={errorOf("type")} />
            {details.type === "disability" ? (
              <CheckLine checked={details.attest} onChange={(checked) => setDetail("attest", checked)}>Permanent and total disability under Internal Revenue Code section 22(e)(3) (affects only the ISO deadline: 12 months instead of 3)</CheckLine>
            ) : null}
            <DateField label="Vesting stop date" required value={stop} onChange={(value) => { setDetails((current) => ({ ...current, stop: value, stopTouched: true })); setErrors((current) => ({ ...current, stop: undefined })); }}
              hint="Defaults to the termination date; may be earlier, never later." error={errorOf("stop")} />
            <SelectField label="New relationship" required value={details.relationshipAfter} onChange={(value) => setDetail("relationshipAfter", value as api.Relationship)} options={RELATIONSHIPS} />
          </div>
        </Card>
      </>
    );
  } else if (step === 2) {
    body = (
      <Card>
        <h2 className="mb-8">2. Vesting outcome</h2>
        <p className="muted">Vested as of the stop date ({formatDate(stop)}){scheduled ? " — applied on the termination date" : ""}; the unvested remainder is cancelled and returns to the pool per the plan's rules. A manual acceleration needs its authorizing document.</p>
        {holdings.error !== undefined ? <InlineError what="the holdings" error={holdings.error} onRetry={holdings.reload} />
          : previews.error !== undefined ? <InlineError what="the termination preview" error={previews.error} onRetry={previews.reload} />
            : !previews.data ? <p className="muted small" role="status">Computing the vesting outcome…</p>
              : previews.data.length === 0 ? <p className="muted">No outstanding options or restricted shares.</p> : (
                <div className="tbl-scroll">
                  <table className="tbl" aria-label="Vesting outcome">
                    <thead><tr><th scope="col">Security</th><th scope="col" className="num">Vested at stop</th><th scope="col" className="num">Unvested to cancel</th><th scope="col">Acceleration</th><th scope="col" className="num">Result (vested)</th></tr></thead>
                    <tbody>
                      {previews.data.map((row) => {
                        const id = row.security.id;
                        if (row.security.family === "STOCK") {
                          return <tr key={id}><td>{row.security.displayId} (restricted shares)</td><td className="num">{format.shares(row.preview.vested)}</td><td className="num">{format.shares(row.preview.repurchaseable)} <span className="small muted">repurchasable</span></td><td className="muted small">—</td><td className="num">{format.shares(row.preview.vested)}</td></tr>;
                        }
                        const item = accelerations[id] ?? { manual: false, quantity: "", reason: "", document: null };
                        const accelerated = item.manual ? amountOf(item.quantity, { positive: true }) : null;
                        const result = accelerated ? engine.Dec.parse(row.preview.vested).add(accelerated).toString() : row.preview.vested;
                        const update = (patch: Partial<Acceleration>) => setAccelerations((current) => ({ ...current, [id]: { ...item, ...patch } }));
                        const rowError = errorOf(`row:${id}`);
                        return (
                          <tr key={id}>
                            <td>{row.security.displayId} <span className="muted small">{optionType(row.security.subtype)}</span>{rowError ? <div className="err-inline">{rowError}</div> : null}</td>
                            <td className="num">{format.shares(row.preview.vested)}</td>
                            <td className="num"><b>{format.shares(row.preview.unvested)}</b>{!engine.Dec.parse(row.preview.vested).isPositive() && engine.Dec.parse(row.preview.unvested).isPositive() ? <span className="small muted"> (whole grant)</span> : null}</td>
                            <td>
                              <SelectField label={<span className="sr-only">Acceleration for {row.security.displayId}</span>} value={item.manual ? "manual" : "none"} onChange={(value) => update({ manual: value === "manual" })} options={[["none", "None"], ["manual", "Manual quantity"]]} />
                              {item.manual ? (
                                <div className="stack mt-8" style={{ gap: 8 }}>
                                  <AmountField label={`Quantity to accelerate (${row.security.displayId})`} value={item.quantity} onChange={(value) => update({ quantity: value })} />
                                  <TextField label={`Reason (${row.security.displayId})`} value={item.reason} onChange={(value) => update({ reason: value })} />
                                  <DocumentUpload label={`Acceleration document (${row.security.displayId})`} kind="BOARD_CONSENT" value={item.document} onChange={(document) => update({ document })} />
                                </div>
                              ) : null}
                              {errorOf(`accel:${id}`) ? <div className="err-inline">{errorOf(`accel:${id}`)}</div> : null}
                            </td>
                            <td className="num">{format.shares(result)}{accelerated ? <span className="badge b-teal"> +{format.shares(accelerated)}</span> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
      </Card>
    );
  } else if (step === 3) {
    body = (
      <Card>
        <h2 className="mb-8">3. Exercise and repurchase windows</h2>
        <p className="muted">Each option carries two dates: the <b>contractual deadline</b> (the grant's or plan's window for a {TERMINATION_TYPE_LABELS[details.type].toLowerCase()} termination; editable only with an extension document) and the <b>ISO deadline</b> (computed: 3 months, 12 months for an attested Internal Revenue Code section 22(e)(3) disability, none after death).</p>
        {!previews.data ? <p className="muted small" role="status">Computing the windows…</p> : (
          <div className="tbl-scroll">
            <table className="tbl" aria-label="Windows">
              <thead><tr><th scope="col">Security</th><th scope="col" className="num">Vested and unexercised</th><th scope="col">Contractual deadline</th><th scope="col">ISO deadline</th><th scope="col">Note</th></tr></thead>
              <tbody>
                {options.map((row) => {
                  const id = row.security.id;
                  if (!engine.Dec.parse(row.preview.exercisable).isPositive()) {
                    return <tr key={id}><td>{row.security.displayId}</td><td className="num">0</td><td>—</td><td>—</td><td className="small muted">Cancelled in full</td></tr>;
                  }
                  const item = extensions[id] ?? { deadline: row.preview.contractualDeadline ?? "", document: null };
                  const changed = item.deadline !== "" && item.deadline !== row.preview.contractualDeadline;
                  const iso = row.preview.isoDeadline;
                  const differs = iso !== null && iso !== (changed ? item.deadline : row.preview.contractualDeadline);
                  const update = (patch: Partial<Extension>) => setExtensions((current) => ({ ...current, [id]: { ...item, ...patch } }));
                  return (
                    <tr key={id}>
                      <td>{row.security.displayId} <span className="muted small">{optionType(row.security.subtype)}</span></td>
                      <td className="num">{format.shares(row.preview.exercisable)}</td>
                      <td>
                        <DateField label={<span className="sr-only">Contractual deadline {row.security.displayId}</span>} value={item.deadline} max={terms.expirationDate(row.security.terms) ?? undefined} onChange={(value) => update({ deadline: value })} hint={windowWhy(row)} />
                        {changed ? <div className="mt-4"><DocumentUpload label={`Extension document (${row.security.displayId})`} kind="SEPARATION_AGREEMENT" value={item.document} onChange={(document) => update({ document })} /></div> : null}
                        {errorOf(`deadline:${id}`) ? <div className="err-inline">{errorOf(`deadline:${id}`)}</div> : null}
                      </td>
                      <td>{iso ? formatDate(iso) : optionType(row.security.subtype) === "NSO" ? "— (NSO)" : DASH}<div className="small muted">{iso ? isoWhy : ""}</div></td>
                      <td className="small" style={differs ? { color: "var(--warning-text)" } : undefined}>{differs ? `Exercises after ${formatDate(iso)} are taxed as NSOs and excluded from Form 3921` : iso ? "Same date" : ""}</td>
                    </tr>
                  );
                })}
                {shares.filter((row) => engine.Dec.parse(row.preview.repurchaseable).isPositive()).map((row) => {
                  const id = row.security.id;
                  const item = repurchases[id] ?? { deadline: "", document: null };
                  const update = (patch: Partial<Extension>) => setRepurchases((current) => ({ ...current, [id]: { ...item, ...patch } }));
                  return (
                    <tr key={id}>
                      <td>{row.security.displayId}</td>
                      <td className="num">{format.shares(row.preview.repurchaseable)} unvested shares</td>
                      <td colSpan={2}>
                        <DateField label={`Last date to repurchase (${row.security.displayId})`} value={item.deadline} onChange={(value) => update({ deadline: value })} hint="Only when the date isn't on record: from the stock purchase agreement." />
                        {item.deadline ? <div className="mt-4"><DocumentUpload label={`Repurchase agreement (${row.security.displayId})`} kind="STOCK_PURCHASE_AGREEMENT" value={item.document} onChange={(document) => update({ document })} /></div> : null}
                        {errorOf(`repurchase:${id}`) ? <div className="err-inline">{errorOf(`repurchase:${id}`)}</div> : null}
                      </td>
                      <td className="small muted">Cap Table doesn't record the repurchase itself: counsel papers it offline</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    );
  } else {
    const result = flow.preview?.result ?? null;
    body = (
      <Card>
        <h2 className="mb-8">4. Review</h2>
        {scheduled ? (
          <Banner kind="info" title={`Scheduled termination — ${formatDate(details.date)}`}>
            {stakeholder.displayName} shows TERMINATING {formatDate(details.date)}. Vesting continues and fully diluted is unchanged until then; the effects below are recorded once that date arrives, the next time an admin opens Cap Table (or uses Process due items on the dashboard).
          </Banner>
        ) : null}
        <FlowProblemBanner problem={flow.problem} onRetry={flow.phase === "edit" ? () => void flow.review() : () => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
        {flow.phase === "previewing" && !result ? <p className="muted" role="status">The server is checking the termination…</p> : null}
        {result ? (
          <CommandPreview
            transactions={result.transactions}
            changes={result.changes}
            names={new Map<string, string>([[stakeholder.id, stakeholder.displayName], ...affected.map((security) => [security.id, security.displayId] as [string, string]), ...(plans.data ?? []).map((plan) => [plan.id, plan.name] as [string, string])])}
            title={scheduled ? `What happens on ${formatDate(details.date)}` : "What the ledger will record"}
          />
        ) : null}
        <WarningsToAcknowledge flow={flow as never} />
      </Card>
    );
  }

  const footer = (
    <div className="wiz-foot">
      {step > 1 ? <button type="button" className="btn btn-ghost" onClick={() => go(-1)} disabled={flow.busy || flow.locked}>Back</button> : null}
      {step < 4 ? (
        <button type="button" className="btn btn-primary" onClick={() => go(1)}>Next</button>
      ) : (
        <button type="button" className="btn btn-danger" onClick={() => void flow.commit()} disabled={flow.busy || flow.locked || !flow.preview || !flow.acknowledgedAll}>
          {flow.phase === "committing" ? "Recording…" : scheduled ? "Schedule termination" : "Terminate"}
        </button>
      )}
    </div>
  );

  return (
    <div className="wiz-body rail">
      <ol className="steps-rail" aria-label="Steps">
        <li className="small mb-12" style={{ listStyle: "none", marginBottom: 14 }}><Link to={back}>← Exit termination</Link></li>
        {STEPS.map((label, index) => (
          <li key={label} className={`st ${index + 1 < step ? "done" : index + 1 === step ? "cur" : ""}`} aria-current={index + 1 === step ? "step" : undefined}>
            <span className="o" aria-hidden="true" /><span>{index + 1}. {label}</span>
          </li>
        ))}
      </ol>
      <div className="stack" aria-label={`Step ${step}: ${STEPS[step - 1]}`}>
        {step < 4 && flow.problem && flow.phase === "edit" ? <FlowProblemBanner problem={flow.problem} /> : null}
        {body}
        {footer}
      </div>
    </div>
  );
}
