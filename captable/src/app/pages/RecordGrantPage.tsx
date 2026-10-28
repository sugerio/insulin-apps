import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api, engine } from "#shared";
import { apiRequest } from "../api/request.ts";
import { DescriptionList } from "../components/DescriptionList.tsx";
import { DocumentUpload, type UploadedDocument } from "../components/DocumentUpload.tsx";
import { Badge, Banner, ErrorState, Loading } from "../components/Feedback.tsx";
import { CommandPreview, FlowProblemBanner, WarningsToAcknowledge } from "../components/FlowParts.tsx";
import { AmountField, BlockList, CheckLine, DateField, RadioCards, SelectField, TextAreaField, TextField } from "../components/Form.tsx";
import { useWorkspace } from "../components/OrgWorkspace.tsx";
import { Card, Page } from "../components/Page.tsx";
import { useToast } from "../components/Toast.tsx";
import { WizardHead, WriteGate } from "../components/WritePage.tsx";
import { NewStakeholderCard } from "./StakeholderFormPage.tsx";
import { amountOf, parseAmount } from "../lib/amounts.ts";
import { addYears, DASH, formatDate } from "../lib/format.ts";
import { fieldProblem, ledgerUnmoved, useWriteFlow, type FieldMap } from "../lib/flow.ts";
import { periodLabel, RELATIONSHIP_LABELS, TERMINATION_WINDOW_LABELS, VALUATION_STATUS_LABELS } from "../lib/labels.ts";
import { counts409A } from "../lib/valuations.ts";
import { usePii } from "../components/Pii.tsx";
import { activeEmails } from "../lib/stakeholders.ts";
import { allOf, useResource, type Resource } from "../lib/useResource.ts";

// Record options: put a grant that is already approved and
// signed on the ledger. Pulley's Issue Options layout: question cards on the left, a sticky summary on the right. The
// summary's checks are early hints; the server's dry run is the authority, and its preview is what the admin confirms.

type GrantResult = api.CommandResult;
type GrantBody = Omit<api.GrantEquityCompensationInput, "expectedLedgerSeq" | "expectedDiffSha256">;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW_REASONS = ["VOLUNTARY", "INVOLUNTARY", "WITH_CAUSE", "DEATH", "DISABILITY", "RETIREMENT"] as const;
type WindowReason = (typeof WINDOW_REASONS)[number];
const NEW_STAKEHOLDER = "__new";
/** Who can hold an ISO (an employee at grant); the server's ISO_NOT_EMPLOYEE is the authority. */
const ISO_ELIGIBLE = new Set<api.Relationship>(["employee", "founder", "officer"]);

interface GrantValues {
  plan: string;
  stakeholder: string;
  quantity: string;
  percent: string;
  boardDate: string;
  consent: UploadedDocument | null;
  dateMode: "board" | "override";
  grantDate: string;
  overrideReason: string;
  optionType: "ISO" | "NSO";
  employeeAtGrant: boolean;
  tenPercent: boolean;
  schedule: string;
  explicit: string;
  vestingStart: string;
  early: "no" | "yes";
  accelKind: "NONE" | "SINGLE_TRIGGER" | "DOUBLE_TRIGGER";
  accelPercent: string;
  accelMonths: string;
  matches: boolean;
  strike: string;
  counselMemo: UploadedDocument | null;
  expiration: string;
  windowsMode: "inherit" | "override";
  windows: Record<WindowReason, { period: string; unit: string }>;
  federal: "RULE_701" | "NON_US";
  country: string;
  state: string;
  issueReason: string;
  displayId: string;
  agreement: UploadedDocument | null;
  signedByBoth: boolean;
}

/** Fields the admin typed into, so a later default (FMV, expiration, start date) no longer overwrites them. */
type Touched = Partial<Record<"strike" | "expiration" | "vestingStart", boolean>>;

const EXPLICIT = "__explicit";

const VIOLATION_FIELDS: Record<string, keyof GrantValues> = {
  EXCEEDS_PLAN_AVAILABLE: "quantity",
  MISSING_BOARD_CONSENT: "consent",
  MISSING_EXECUTED_AGREEMENT: "agreement",
  NO_PRESUMPTIVELY_VALID_409A: "strike",
  ISO_PRICE_BELOW_FMV: "strike",
  ISO_TEN_PERCENT_TERMS: "strike",
  // The violation says the memo is missing (the warning of the same code is acknowledged separately).
  NSO_PRICE_BELOW_FMV: "counselMemo",
  ISO_NOT_EMPLOYEE: "optionType",
  ISO_PLAN_WINDOW: "optionType",
  PLAN_EXPIRED: "plan",
  EXPLICIT_SUM_MISMATCH: "schedule",
  DISPLAY_ID_TAKEN: "displayId",
  NON_US_NEEDS_COUNTRY: "country",
  GRANT_DATE_IN_FUTURE: "boardDate",
};

function issueField(path: string): keyof GrantValues | null {
  const head = path.split(".")[0] ?? "";
  if (path.startsWith("board.consent")) return "consent";
  if (path.startsWith("board.")) return "boardDate";
  if (path.startsWith("executedAgreement")) return "agreement";
  if (path.startsWith("vesting.terms")) return "schedule";
  if (path.startsWith("vesting.vestingStartDate")) return "vestingStart";
  if (path.startsWith("vesting.accelerationTerms")) return "accelKind";
  if (path.startsWith("vesting.")) return "matches";
  if (path.startsWith("exemption.country")) return "country";
  if (path.startsWith("exemption")) return "federal";
  const direct: Record<string, keyof GrantValues> = {
    stockPlanId: "plan", stakeholderId: "stakeholder", quantity: "quantity", grantDate: "grantDate", grantDateOverrideReason: "overrideReason",
    optionType: "optionType", isoAttestations: "employeeAtGrant", exercisePrice: "strike", valuationId: "strike", counselMemoDocumentId: "counselMemo",
    expirationDate: "expiration", terminationExerciseWindows: "windowsMode", displayId: "displayId", issueReason: "issueReason",
  };
  return direct[head] ?? null;
}

/** An admin answers a missing 409A with counsel's memo, so that is where the violation goes. */
const GRANT_FIELDS: FieldMap = {
  issue: issueField,
  violation: (violation) => (violation.code === "NO_PRESUMPTIVELY_VALID_409A" ? "counselMemo" : VIOLATION_FIELDS[violation.code] ?? null),
};

/** "OPT-57": the next free OPT number, as a hint; the server assigns the real one. */
function nextOptionId(securities: readonly api.Security[]): string {
  const numbers = securities.map((security) => /^OPT-(\d+)$/.exec(security.displayId)?.[1]).filter((value): value is string => value !== undefined).map(Number);
  return `OPT-${(numbers.length ? Math.max(...numbers) : 0) + 1}`;
}

function windowsLabel(windows: readonly api.TerminationWindow[]): string {
  if (!windows.length) return "the plan's defaults";
  const by = new Map(windows.map((window) => [window.reason, periodLabel(window)]));
  const parts = [`${by.get("VOLUNTARY") ?? DASH}`];
  if (by.get("DEATH") === by.get("DISABILITY")) parts.push(`${by.get("DEATH") ?? DASH} death or disability`);
  else parts.push(`${by.get("DEATH") ?? DASH} death`, `${by.get("DISABILITY") ?? DASH} disability`);
  parts.push(`${by.get("WITH_CAUSE") ?? DASH} with cause`);
  return parts.join("; ");
}

interface ParsedTranches {
  events: { date: string; quantity: string }[];
  error: string | null;
}

/** The explicit table as typed: one "date, quantity" per line. */
function parseTranches(text: string): ParsedTranches {
  const events: { date: string; quantity: string }[] = [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const match = /^(\d{4}-\d{2}-\d{2})[\s,;]+([\d,.]+)$/.exec(line);
    const quantity = match ? parseAmount(match[2]!, { positive: true }) : null;
    if (!match || !quantity?.ok) return { events: [], error: `Line ${index + 1}: use a date and a quantity, e.g. 2027-10-19, 10000.` };
    events.push({ date: match[1]!, quantity: quantity.value });
  }
  if (!events.length) return { events, error: "Enter one tranche per line: a date and a quantity." };
  return { events, error: null };
}

/** The vesting definition the form describes, or null while it is incomplete. */
function definitionOf(values: GrantValues, templates: readonly api.VestingTerms[]): api.VestingDefinition | null {
  if (values.schedule === EXPLICIT) {
    const parsed = parseTranches(values.explicit);
    return parsed.error ? null : { type: "EXPLICIT", events: parsed.events };
  }
  return templates.find((template) => template.id === values.schedule)?.definition ?? null;
}

function initialValues(plans: readonly api.StockPlan[], templates: readonly api.VestingTerms[]): GrantValues {
  return {
    plan: plans[0]?.id ?? "", stakeholder: "", quantity: "", percent: "", boardDate: "", consent: null, dateMode: "board", grantDate: "",
    overrideReason: "", optionType: "ISO", employeeAtGrant: false, tenPercent: false, schedule: templates[0]?.id ?? EXPLICIT, explicit: "",
    vestingStart: "", early: "no", accelKind: "NONE", accelPercent: "100", accelMonths: "12", matches: false, strike: "", counselMemo: null,
    expiration: "", windowsMode: "inherit",
    windows: Object.fromEntries(WINDOW_REASONS.map((reason) => [reason, { period: "3", unit: "MONTHS" }])) as GrantValues["windows"],
    federal: "RULE_701", country: "", state: "California 25102(o)", issueReason: "New-hire grant", displayId: "", agreement: null, signedByBoth: false,
  };
}

export function RecordGrantPage() {
  const { href } = useWorkspace();
  const back = `${href("captable")}?tab=options`;
  return (
    <Page title="Record options" crumbs={[["Cap Table", href("captable")], ["Record options"]]}>
      <WriteGate back={{ to: back, label: "Back to the cap table" }}>
        <GrantLoader back={back} />
      </WriteGate>
    </Page>
  );
}

function GrantLoader({ back }: { back: string }) {
  const { orgId } = useWorkspace();
  const plans = useResource((signal) => apiRequest(api.routes.listStockPlans, { params: { orgId }, signal }), [orgId]);
  const stakeholders = useResource((signal) => apiRequest(api.routes.listStakeholders, { params: { orgId }, signal }), [orgId]);
  const templates = useResource((signal) => apiRequest(api.routes.listVestingTerms, { params: { orgId }, query: { templates: "true" }, signal }), [orgId]);
  const valuations = useResource((signal) => apiRequest(api.routes.listValuations, { params: { orgId }, signal }), [orgId]);
  const all = allOf(plans, templates, valuations);
  if (all.error !== undefined) return <ErrorState error={all.error} onRetry={all.reload} />;
  if (!all.data) return <Loading label="Loading the plan, vesting schedules and 409A…" />;
  const [planList, templateList, valuationList] = all.data;
  if (!planList.items.length) return <Card><Banner kind="info" title="No equity plan">Options are granted under an equity plan; this company has none on record.</Banner></Card>;
  return (
    <GrantWizard
      back={back}
      plans={planList.items}
      templates={templateList.items.filter((item) => item.isTemplate)}
      valuations={valuationList.items}
      stakeholders={stakeholders}
    />
  );
}

interface WizardProps {
  back: string;
  plans: readonly api.StockPlan[];
  templates: readonly api.VestingTerms[];
  valuations: readonly api.Valuation[];
  stakeholders: Resource<api.StakeholderList>;
}

function GrantWizard({ back, plans, templates, valuations, stakeholders }: WizardProps) {
  const workspace = useWorkspace();
  const { orgId, format, href, org } = workspace;
  const navigate = useNavigate();
  const toast = useToast();
  const pii = usePii();
  const [values, setValues] = useState<GrantValues>(() => initialValues(plans, templates));
  const [touched, setTouched] = useState<Touched>({});
  /** The inline new stakeholder's create is unsettled: see NewStakeholderCard. */
  const [inlineUnsettled, setInlineUnsettled] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof GrantValues, string>>>({});
  const set = <K extends keyof GrantValues>(key: K, value: GrantValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  };

  const plan = plans.find((item) => item.id === values.plan) ?? null;
  const grantDate = values.dateMode === "board" ? values.boardDate : values.grantDate;
  const dateReady = DATE.test(grantDate);
  const iso = values.optionType === "ISO";
  const quantity = amountOf(values.quantity, { positive: true, unit: org.shareUnit, unitName: "options" });
  const definition = definitionOf(values, templates);
  // The admin's own record is never offered: no admin records a grant on their own holdings.
  const holders = (stakeholders.data?.items ?? []).filter((item) => item.termination === null && !workspace.isOwn(item.id)).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const holder = holders.find((item) => item.id === values.stakeholder) ?? null;

  const securities = useResource((signal) => apiRequest(api.routes.listSecurities, { params: { orgId }, query: { family: "EQUITY_COMPENSATION" }, signal }), [orgId]);
  const fmv = useResource(
    (signal) => apiRequest(api.routes.getFmv, { params: { orgId }, query: { date: grantDate, stockClassId: plan!.stockClassId }, signal }),
    [orgId, grantDate, plan?.stockClassId],
    dateReady && plan !== null,
  );
  const vestingStartReady = DATE.test(values.vestingStart);
  const definitionKey = definition ? JSON.stringify(definition) : null;
  const preview = useResource(
    (signal) => apiRequest(api.routes.previewVesting, { params: { orgId }, body: { definition: definition!, quantity: quantity!, vestingStartDate: values.vestingStart }, signal }),
    [orgId, definitionKey, quantity, values.vestingStart],
    definition !== null && quantity !== null && vestingStartReady,
  );
  const isoSplit = useResource((signal) => apiRequest(api.routes.getIsoSplit, { params: { orgId, id: values.stakeholder }, signal }), [orgId, values.stakeholder], iso && holder !== null);

  const fmvPrice = fmv.data?.fmv?.pricePerShare ?? null;
  const fmvValuation = fmv.data?.fmv ? valuations.find((item) => item.id === fmv.data!.fmv!.valuationId) ?? null : null;
  // Without a presumptively valid 409A, the latest final 409A effective by the grant date carries an admin's
  // override. Another type of valuation or a draft report never does (counts409A).
  const fallbackValuation = dateReady
    ? [...valuations].filter((item) => counts409A(item) && item.effectiveDate <= grantDate && item.status !== "voided").sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0] ?? null
    : null;
  const valuationId = fmv.data?.fmv?.valuationId ?? fallbackValuation?.id ?? null;
  const noValid409a = dateReady && fmv.data !== undefined && fmv.data.fmv === null;

  // Defaults that follow the answers until the admin types their own.
  useEffect(() => {
    if (!dateReady) return;
    setValues((current) => ({
      ...current,
      vestingStart: touched.vestingStart ? current.vestingStart : grantDate,
      expiration: touched.expiration ? current.expiration : addYears(grantDate, iso && current.tenPercent ? 5 : 10),
    }));
  }, [grantDate, dateReady, iso, values.tenPercent, touched.vestingStart, touched.expiration]);
  useEffect(() => {
    if (touched.strike || !fmvPrice) return;
    const strike = iso && values.tenPercent ? engine.Dec.parse(fmvPrice).mul("1.1").toString() : fmvPrice;
    setValues((current) => ({ ...current, strike }));
  }, [fmvPrice, iso, values.tenPercent, touched.strike]);

  const setQuantity = (text: string) => {
    set("quantity", text);
    const typed = amountOf(text);
    if (typed && plan && engine.Dec.parse(plan.poolSize).isPositive()) {
      set("percent", engine.Dec.parse(typed).mul(100).divideTo(plan.poolSize, 4, "HALF_UP").toString());
    } else if (!text.trim()) set("percent", "");
  };
  const setPercent = (text: string) => {
    set("percent", text);
    const typed = amountOf(text);
    if (typed && plan) set("quantity", engine.Dec.parse(typed).mul(plan.poolSize).divideTo(100, 0, "FLOOR").toString());
  };

  const dryRun = (frozen: GrantBody, signal?: AbortSignal) => apiRequest(api.routes.grantEquityCompensation, { params: { orgId }, dryRun: true, body: frozen, signal });
  const flow = useWriteFlow({
    request: bodyOf,
    preview: dryRun,
    body: ({ request: frozen, preview: reviewed, acknowledge }) => ({ ...frozen, expectedLedgerSeq: reviewed!.ledgerSeq, expectedDiffSha256: reviewed!.diffSha256, acknowledge: [...acknowledge] }),
    send: (body, key) => apiRequest(api.routes.grantEquityCompensation, { params: { orgId }, body, idempotencyKey: key }),
    reconcile: ({ request: frozen, preview: reviewed }) => ledgerUnmoved(() => dryRun(frozen), reviewed!.ledgerSeq),
    fields: GRANT_FIELDS,
    onCommitted: (result: GrantResult) => {
      const id = result.created.securityIds[0];
      const created = result.changes.find((change) => change.entity === "security" && change.id === id)?.after?.displayId;
      const name = typeof created === "string" ? created : "The grant";
      toast({ message: `${name} recorded — outstanding (executed); no e-mail sent`, to: id ? href(`securities/${id}`) : undefined, linkLabel: "Open grant" });
      navigate(id ? href(`securities/${id}`) : back);
    },
  });

  function bodyOf(): GrantBody {
    const accelerationTerms: api.GrantEquityCompensationInput["vesting"]["accelerationTerms"] = values.accelKind === "NONE"
      ? { kind: "NONE" }
      : {
          kind: values.accelKind,
          ...(amountOf(values.accelPercent) ? { percent: amountOf(values.accelPercent)! } : {}),
          ...(/^\d+$/.test(values.accelMonths) && values.accelKind === "DOUBLE_TRIGGER" ? { months: Number(values.accelMonths) } : {}),
          text: values.accelKind === "DOUBLE_TRIGGER"
            ? `Double trigger ${values.accelPercent || "100"}% — qualifying termination within ${values.accelMonths || "12"} months after a change of control`
            : `Single trigger ${values.accelPercent || "100"}% on a change of control`,
        };
    return {
      stockPlanId: values.plan,
      stakeholderId: values.stakeholder,
      quantity: quantity ?? "0",
      board: { approvalDate: values.boardDate, consentDocumentId: values.consent?.id ?? "" },
      ...(values.dateMode === "override" ? { grantDate: values.grantDate, grantDateOverrideReason: values.overrideReason.trim() } : {}),
      optionType: values.optionType,
      ...(iso ? { isoAttestations: { employeeAtGrant: true as const, tenPercentHolder: values.tenPercent } } : {}),
      vesting: {
        terms: values.schedule === EXPLICIT ? { explicit: parseTranches(values.explicit).events } : { templateId: values.schedule },
        vestingStartDate: values.vestingStart,
        earlyExercisable: values.early === "yes",
        accelerationTerms,
        matchesSignedAgreement: true,
      },
      exercisePrice: amountOf(values.strike, { positive: true }) ?? "0",
      valuationId: valuationId ?? "",
      ...(values.counselMemo ? { counselMemoDocumentId: values.counselMemo.id } : {}),
      expirationDate: values.expiration,
      ...(values.windowsMode === "override"
        ? { terminationExerciseWindows: WINDOW_REASONS.map((reason) => ({ reason, period: amountOf(values.windows[reason].period) ?? "0", unit: values.windows[reason].unit as api.TerminationWindow["unit"] })) }
        : {}),
      exemption: {
        federal: values.federal,
        ...(values.federal === "NON_US" && values.country.trim() ? { country: values.country.trim().toUpperCase() } : {}),
        ...(values.state.trim() ? { state: values.state.trim() } : {}),
      },
      legendIds: [],
      ...(values.issueReason.trim() ? { issueReason: values.issueReason.trim() } : {}),
      ...(values.displayId.trim() ? { displayId: values.displayId.trim() } : {}),
      executedAgreement: { documentId: values.agreement?.id ?? "", signedByHolderAndSignatory: true },
    };
  }

  /** The contract's required inputs: without them there is nothing to send. */
  function validate(): Partial<Record<keyof GrantValues, string>> {
    const found: Partial<Record<keyof GrantValues, string>> = {};
    if (!values.plan) found.plan = "Choose the equity plan.";
    if (!values.stakeholder || values.stakeholder === NEW_STAKEHOLDER) found.stakeholder = "Choose who the grant is for, or save the new stakeholder first.";
    const typed = parseAmount(values.quantity, { positive: true, unit: org.shareUnit, unitName: "options" });
    if (!typed) found.quantity = "Enter the number of options.";
    else if (!typed.ok) found.quantity = typed.error;
    if (!DATE.test(values.boardDate)) found.boardDate = "Enter the board approval date.";
    if (!values.consent) found.consent = "A new grant needs the signed board consent.";
    if (values.dateMode === "override") {
      if (!DATE.test(values.grantDate)) found.grantDate = "Enter the grant date.";
      if (!values.overrideReason.trim()) found.overrideReason = "Say why the grant date differs from the board approval.";
    }
    if (iso && !values.employeeAtGrant) found.employeeAtGrant = "An ISO needs the attestation that the holder is an employee at grant.";
    if (values.schedule === EXPLICIT) {
      const parsed = parseTranches(values.explicit);
      if (parsed.error) found.schedule = parsed.error;
    } else if (!values.schedule) found.schedule = "Choose a vesting schedule.";
    if (!DATE.test(values.vestingStart)) found.vestingStart = "Enter the vesting start date.";
    if (!values.matches) found.matches = "Confirm that the generated table matches the signed agreement.";
    const strike = parseAmount(values.strike, { positive: true });
    if (!strike) found.strike = "Enter the exercise price.";
    else if (!strike.ok) found.strike = strike.error;
    else if (dateReady && valuationId === null) found.strike = "No 409A is recorded for this date. Record the provider's report first.";
    else if (noValid409a && !values.counselMemo) found.counselMemo = "Without a presumptively valid 409A, the override needs counsel's memo.";
    else if (!iso && fmvPrice && engine.Dec.parse(strike.value).lt(fmvPrice) && !values.counselMemo) found.counselMemo = `An NSO priced below the FMV (${format.price(fmvPrice)}) needs counsel's memo.`;
    if (!DATE.test(values.expiration)) found.expiration = "Enter the expiration date.";
    if (values.federal === "NON_US" && !/^[A-Za-z]{2}$/.test(values.country.trim())) found.country = "A non-US grant needs its country (two-letter code, e.g. CA).";
    if (values.windowsMode === "override") {
      for (const reason of WINDOW_REASONS) {
        const period = parseAmount(values.windows[reason].period);
        if (!period?.ok) found.windowsMode = `Enter the ${TERMINATION_WINDOW_LABELS[reason]!.toLowerCase()} window (0 is allowed).`;
      }
    }
    if (!values.agreement) found.agreement = "A new grant needs the executed agreement signed by both parties.";
    else if (!values.signedByBoth) found.signedByBoth = "Confirm that the PDF is signed by both the holder and the company signatory.";
    return found;
  }

  const review = () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    void flow.review();
  };
  const errorOf = (key: keyof GrantValues) => errors[key] ?? fieldProblem(flow.problem, key);

  // The summary card's checks: early hints from what the page knows; the dry run decides.
  const blocks: string[] = [];
  const warns: string[] = [];
  const available = plan ? engine.Dec.parse(plan.availableToGrant) : null;
  if (quantity && available && engine.Dec.parse(quantity).gt(available)) blocks.push(`Exceeds the plan's availability (${format.shares(plan!.availableToGrant)}).`);
  if (!values.consent) blocks.push("A new grant needs the signed board consent.");
  if (noValid409a) blocks.push(`No presumptively valid 409A on ${formatDate(grantDate)}${fallbackValuation ? ` (${fallbackValuation.name}: ${VALUATION_STATUS_LABELS[fallbackValuation.status].toLowerCase()})` : ""}. An admin can override with counsel's memo.`);
  const strike = amountOf(values.strike, { positive: true });
  if (fmvPrice && strike) {
    const fmvDec = engine.Dec.parse(fmvPrice);
    if (iso && values.tenPercent && engine.Dec.parse(strike).lt(fmvDec.mul("1.1"))) blocks.push(`A 10%-holder's ISO needs a strike of at least 110% of FMV (${format.price(fmvDec.mul("1.1").toString())}).`);
    else if (iso && engine.Dec.parse(strike).lt(fmvDec)) blocks.push(`An ISO's exercise price must be at least the FMV (${format.price(fmvPrice)}).`);
    else if (!iso && engine.Dec.parse(strike).lt(fmvDec)) warns.push(`The strike is below the FMV (${format.price(fmvPrice)}): 409A risk. Counsel's memo is required to continue.`);
  }
  if (iso && values.tenPercent && dateReady && DATE.test(values.expiration) && values.expiration > addYears(grantDate, 5)) blocks.push("A 10%-holder's ISO needs a term of at most 5 years.");
  if (iso && holder && !ISO_ELIGIBLE.has(holder.relationship)) blocks.push(`An ISO can be granted only to an employee (${holder.displayName} is recorded as ${RELATIONSHIP_LABELS[holder.relationship]}).`);
  if (!values.agreement) blocks.push("A new grant needs the executed agreement signed by both parties.");
  const memoOffered = noValid409a || (!iso && fmvPrice !== null && strike !== null && engine.Dec.parse(strike).lt(engine.Dec.parse(fmvPrice))) || errorOf("counselMemo") !== undefined;

  const editing = flow.phase === "edit" || flow.phase === "previewing";
  const optionId = securities.data ? nextOptionId(securities.data.items) : null;
  const names = useMemo(() => new Map<string, string>([
    ...plans.map((item) => [item.id, item.name] as [string, string]),
    ...holders.map((item) => [item.id, item.displayName] as [string, string]),
  ]), [plans, holders]);

  return (
    <>
      <WizardHead title="Record options" back={back} />
      <div className="wiz-body">
        <div className="card">
          {editing ? <FlowProblemBanner problem={flow.problem} onRetry={review} busy={flow.busy} /> : null}
          <fieldset className="flow-fields form" disabled={!editing} aria-label="Grant details">
            <Question n={1} title="Equity plan" required>
              <SelectField label="Equity plan" value={values.plan} onChange={(value) => set("plan", value)} error={errorOf("plan")}
                options={plans.map((item) => [item.id, `${item.name} — ${format.shares(item.availableToGrant)} available`] as const)} />
            </Question>
            <Question n={2} title="Who is it for?" required>
              {/* While the inline create's outcome is unknown, the selector that would discard it (and its key) is locked. */}
              <SelectField label="Stakeholder" value={values.stakeholder} disabled={inlineUnsettled} onChange={(value) => { if (!inlineUnsettled) set("stakeholder", value); }} error={errorOf("stakeholder")}
                hint={inlineUnsettled ? "Settle the new stakeholder first: Try again, or Check what was recorded." : undefined}
                placeholder={stakeholders.data ? "Select or add a new stakeholder" : stakeholders.error !== undefined ? "Couldn't load the stakeholders" : "Loading stakeholders…"}
                options={[
                  ...holders.map((item) => [item.id, `${item.displayName} — ${pii.email(activeEmails(item)[0]?.email) || RELATIONSHIP_LABELS[item.relationship]}`] as const),
                  [NEW_STAKEHOLDER, "+ Add a new stakeholder…"] as const,
                ]} />
              {stakeholders.error !== undefined ? <button type="button" className="btn-link small" onClick={stakeholders.reload}>Try loading the stakeholders again</button> : null}
              {values.stakeholder === NEW_STAKEHOLDER ? (
                <NewStakeholderCard
                  stakeholders={stakeholders.data?.items ?? []}
                  onUnsettledChange={setInlineUnsettled}
                  onCreated={(created) => {
                    stakeholders.reload();
                    set("stakeholder", created.id);
                  }}
                />
              ) : null}
            </Question>
            <Question n={3} title="How many?" required>
              <div className="form-grid">
                <AmountField label="Number of options" value={values.quantity} onChange={setQuantity} suffix="Options" hint="Whole options only." error={errorOf("quantity")} />
                <AmountField label="or target % of plan" value={values.percent} onChange={setPercent} suffix="% of plan" />
              </div>
            </Question>
            <Question n={4} title="Board approval" required>
              <div className="form-grid">
                <DateField label="Board approval date" required value={values.boardDate} max={workspace.today} onChange={(value) => set("boardDate", value)} error={errorOf("boardDate")} />
                <DocumentUpload label="Signed board consent (PDF)" kind="BOARD_CONSENT" required value={values.consent} onChange={(document) => set("consent", document)} error={errorOf("consent")} disabled={!editing} />
              </div>
            </Question>
            <Question n={5} title="Grant date" required>
              <RadioCards label="Grant date" value={values.dateMode} onChange={(value) => set("dateMode", value as GrantValues["dateMode"])} options={[
                { value: "board", label: <>Use board approval date <Badge tone="green">Highly recommended</Badge></>, sub: "The grant date equals the board approval date" },
                { value: "override", label: "Override", sub: "A different grant date needs a reason" },
              ]} />
              {values.dateMode === "override" ? (
                <div className="form-grid mt-8">
                  <DateField label="Grant date (override)" value={values.grantDate} max={workspace.today} onChange={(value) => set("grantDate", value)} error={errorOf("grantDate")} />
                  <TextField label="Reason for the override" value={values.overrideReason} onChange={(value) => set("overrideReason", value)} error={errorOf("overrideReason")} />
                </div>
              ) : null}
            </Question>
            <Question n={6} title="Option type" required>
              <RadioCards label="Option type" value={values.optionType} onChange={(value) => set("optionType", value as GrantValues["optionType"])} error={errorOf("optionType")} options={[
                { value: "ISO", label: "ISO", sub: "Incentive stock option — employees only" },
                { value: "NSO", label: "NSO", sub: "Non-qualified stock option" },
              ]} />
              {iso ? (
                <div className="stack mt-8" style={{ gap: 8 }}>
                  <CheckLine checked={values.employeeAtGrant} onChange={(checked) => set("employeeAtGrant", checked)} error={errorOf("employeeAtGrant")}>The holder is an employee at grant (attested)</CheckLine>
                  <CheckLine checked={values.tenPercent} onChange={(checked) => set("tenPercent", checked)}>10%-plus holder (voting power with Internal Revenue Code section 424(d) attribution; attested): an ISO needs strike ≥ 110% of FMV and a 5-year term</CheckLine>
                </div>
              ) : null}
            </Question>
            <Question n={7} title="Vesting">
              <div className="form-grid">
                <SelectField label="Vesting schedule" value={values.schedule} onChange={(value) => set("schedule", value)} error={errorOf("schedule")}
                  options={[...templates.map((template) => [template.id, template.name] as const), [EXPLICIT, "Explicit tranches (from the agreement)"] as const]} />
                <DateField label="Vesting start date" value={values.vestingStart} error={errorOf("vestingStart")} onChange={(value) => { setTouched((current) => ({ ...current, vestingStart: true })); set("vestingStart", value); }} />
              </div>
              {values.schedule === EXPLICIT ? (
                <div className="mt-8">
                  <TextAreaField label="Tranches" value={values.explicit} onChange={(value) => set("explicit", value)} rows={5} placeholder={"2027-10-19, 10000\n2027-11-19, 834"} hint="One tranche per line: the date and the quantity, as in the signed agreement. They must add up to the number of options." />
                </div>
              ) : null}
              <div className="mt-8">
                <span className="small strong">Early exercise allowed (from the agreement)</span>
                <RadioCards label="Early exercise allowed" value={values.early} onChange={(value) => set("early", value as GrantValues["early"])} options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]} />
              </div>
              <div className="form-grid mt-8">
                <SelectField label="Acceleration terms" value={values.accelKind} onChange={(value) => set("accelKind", value as GrantValues["accelKind"])} error={errorOf("accelKind")}
                  options={[["NONE", "None"], ["SINGLE_TRIGGER", "Single trigger"], ["DOUBLE_TRIGGER", "Double trigger"]]} />
                {values.accelKind !== "NONE" ? <AmountField label="Acceleration %" value={values.accelPercent} onChange={(value) => set("accelPercent", value)} suffix="%" /> : null}
                {values.accelKind === "DOUBLE_TRIGGER" ? <AmountField label="Months after change of control" value={values.accelMonths} onChange={(value) => set("accelMonths", value)} /> : null}
              </div>
              <VestingTable preview={preview} ready={definition !== null && quantity !== null && vestingStartReady} />
              <div className="mt-8">
                <CheckLine checked={values.matches} onChange={(checked) => set("matches", checked)} error={errorOf("matches")}><b>Matches the signed agreement</b> <span className="req">*</span></CheckLine>
              </div>
            </Question>
            <Question n={8} title="Exercise price" required>
              <AmountField label="Exercise price" prefix="$" value={values.strike} error={errorOf("strike")} onChange={(value) => { setTouched((current) => ({ ...current, strike: true })); set("strike", value); }} />
              <div className="small mt-4">
                {!dateReady ? <span className="muted">Shown once the grant date is entered.</span>
                  : fmv.error !== undefined ? <span className="err-inline">Couldn't load the FMV. <button type="button" className="btn-link small" onClick={fmv.reload}>Try again</button></span>
                    : !fmv.data ? <span className="muted" role="status">Loading the FMV…</span>
                      : fmv.data.fmv ? <span className="muted">FMV {format.price(fmv.data.fmv.pricePerShare)} · presumptively valid until {formatDate(fmvValuation?.presumptivelyValidUntil ?? fmvValuation?.expirationDate)} ({fmv.data.fmv.valuationName})</span>
                        : <span className="err-inline">No presumptively valid 409A on {formatDate(grantDate)}{fallbackValuation ? ` (${fallbackValuation.name}: ${VALUATION_STATUS_LABELS[fallbackValuation.status].toLowerCase()})` : ""}</span>}
              </div>
              {memoOffered ? (
                <div className="mt-8">
                  <DocumentUpload label="Counsel memo (409A override or NSO below FMV)" kind="COUNSEL_MEMO" required value={values.counselMemo} onChange={(document) => set("counselMemo", document)} error={errorOf("counselMemo")} disabled={!editing} />
                </div>
              ) : null}
            </Question>
            <Question n={9} title="Expiration">
              <DateField label="Expiration date" value={values.expiration} error={errorOf("expiration")} hint="Default 10 years after the grant date (5 years for a 10%-plus holder's ISO)."
                onChange={(value) => { setTouched((current) => ({ ...current, expiration: true })); set("expiration", value); }} />
            </Question>
            <Question n={10} title="Terms">
              <div className="form-grid">
                <SelectField className="full" label="Exit windows" value={values.windowsMode} onChange={(value) => set("windowsMode", value as GrantValues["windowsMode"])} error={errorOf("windowsMode")}
                  options={[["inherit", `Inherit from the plan (${windowsLabel(plan?.defaultTerminationWindows ?? [])})`], ["override", "Override from the agreement"]]} />
                {values.windowsMode === "override" ? WINDOW_REASONS.map((reason) => (
                  <div className="row nowrap" key={reason}>
                    <AmountField label={TERMINATION_WINDOW_LABELS[reason]!} value={values.windows[reason].period} onChange={(value) => set("windows", { ...values.windows, [reason]: { ...values.windows[reason], period: value } })} />
                    <SelectField label={<span className="sr-only">{TERMINATION_WINDOW_LABELS[reason]} unit</span>} value={values.windows[reason].unit} onChange={(value) => set("windows", { ...values.windows, [reason]: { ...values.windows[reason], unit: value } })}
                      options={[["DAYS", "days"], ["MONTHS", "months"], ["YEARS", "years"]]} />
                  </div>
                )) : null}
                <SelectField label="Federal exemption" value={values.federal} onChange={(value) => set("federal", value as GrantValues["federal"])} error={errorOf("federal")} options={[["RULE_701", "Rule 701"], ["NON_US", "Non-US"]]} />
                {values.federal === "NON_US" ? <TextField label="Country (Non-US)" value={values.country} onChange={(value) => set("country", value)} placeholder="CA" hint="Two-letter code." error={errorOf("country")} /> : <span />}
                <TextField label="State exemption" value={values.state} onChange={(value) => set("state", value)} />
                <TextField label="Issue reason" value={values.issueReason} onChange={(value) => set("issueReason", value)} error={errorOf("issueReason")} />
                <TextField label="ID" value={values.displayId} onChange={(value) => set("displayId", value)} placeholder={optionId ? `Auto: ${optionId}` : "Auto-assigned"} hint="Auto-assigned; editable (must be unique)." error={errorOf("displayId")} />
                <div className="fld"><span className="lbl">Legends</span><div className="small muted">Defaults: none on options (set on exercise shares)</div></div>
              </div>
            </Question>
            <Question n={11} title="Executed agreement" required>
              <DocumentUpload label="Executed agreement (PDF)" kind="GRANT_AGREEMENT" required value={values.agreement} onChange={(document) => set("agreement", document)} error={errorOf("agreement")} disabled={!editing}
                hint="The PDF signed by both the holder and the company signatory." />
              <div className="mt-8">
                <CheckLine checked={values.signedByBoth} onChange={(checked) => set("signedByBoth", checked)} error={errorOf("signedByBoth")}>This PDF is signed by both the holder and the company signatory</CheckLine>
              </div>
            </Question>
          </fieldset>
          <div className="q-card">
            <h2 className="q">12. Review &amp; record</h2>
            {flow.phase === "edit" || flow.phase === "previewing" ? (
              <>
                <p className="small muted">The server checks the grant against the ledger and shows what it will record. The grant is recorded OUTSTANDING with execution status Executed. The holder sees the grant in their holder view.</p>
                <div className="row mt-8">
                  <button type="button" className="btn btn-primary" onClick={review} disabled={flow.busy}>{flow.phase === "previewing" ? "Checking…" : "Review"}</button>
                  <Link className="btn btn-ghost" to={back}>Cancel</Link>
                </div>
              </>
            ) : (
              <>
                <FlowProblemBanner problem={flow.problem} onRetry={() => void flow.commit()} onCheck={flow.canCheck ? () => void flow.check() : undefined} busy={flow.busy} />
                {flow.preview ? <CommandPreview transactions={flow.preview.transactions} changes={flow.preview.changes} names={names} /> : null}
                <WarningsToAcknowledge flow={flow as never} />
                <div className="wiz-foot">
                  <button type="button" className="btn btn-ghost" onClick={flow.edit} disabled={flow.busy || flow.locked}>Change answers</button>
                  <button type="button" className="btn btn-primary" onClick={() => void flow.commit()} disabled={flow.busy || flow.locked || !flow.acknowledgedAll}>
                    {flow.phase === "committing" ? "Recording…" : "Record grant"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <aside className="wiz-summary card" aria-label="Grant summary">
          <h3 className="mb-8">Grant summary</h3>
          <DescriptionList
            split
            rows={[
              ["Recipient", holder ? <>{holder.displayName} <span className="muted small">({RELATIONSHIP_LABELS[holder.relationship]})</span></> : DASH],
              ["Plan", plan?.name ?? DASH],
              ["Available after this grant", plan ? `${format.shares(plan.availableToGrant)} → ${availableAfter(plan.availableToGrant, quantity, format.shares)}` : DASH],
              ["Grant size", quantity ? `${format.shares(quantity)} options` : DASH],
              ["Type", values.optionType],
              ["Exercise price", strike ? format.price(strike) : DASH],
              ["FMV (409A)", fmv.data?.fmv ? `${format.price(fmv.data.fmv.pricePerShare)} · ${fmv.data.fmv.valuationName}, ${VALUATION_STATUS_LABELS[fmv.data.fmv.status].toLowerCase()}` : noValid409a ? <Badge tone="red">No presumptively valid 409A</Badge> : DASH],
              ["Vesting", templates.find((template) => template.id === values.schedule)?.name ?? (values.schedule === EXPLICIT ? "Explicit tranches" : DASH)],
              ["Vesting start", formatDate(values.vestingStart || null)],
              ["Early exercise", values.early === "yes" ? "Yes" : "No"],
              ["ISO/NSO split", iso ? <IsoSplitPreview fmv={fmvPrice} events={preview.data?.events ?? null} isoSplit={isoSplit.data ?? null} /> : "NSO"],
              ["ID", values.displayId.trim() || optionId || "Auto-assigned"],
            ]}
          />
          <div className="mt-12">
            <BlockList items={blocks} />
            {warns.length ? <div className="mt-8"><BlockList items={warns} kind="warn" /></div> : null}
          </div>
        </aside>
      </div>
    </>
  );
}

/** The plan's availability after the grant; a shortfall keeps its sign (the exact formatter shows only magnitudes). */
function availableAfter(available: string, quantity: string | null, shares: (value: string) => string): string {
  if (!quantity) return shares(available);
  const after = engine.Dec.parse(available).sub(quantity);
  return after.isNegative() ? `−${shares(after.neg().toString())}` : shares(after.toString());
}

function Question({ n, title, required, children }: { n: number; title: string; required?: boolean; children: ReactNode }) {
  return (
    <section className="q-card">
      <h2 className="q">{n}. {title} {required ? <span className="req" aria-hidden="true">*</span> : null}</h2>
      {children}
    </section>
  );
}

/** The generated tranche table (the vesting preview the server computes from the definition). */
function VestingTable({ preview, ready }: { preview: Resource<api.VestingPreviewResponse>; ready: boolean }) {
  const { format } = useWorkspace();
  if (!ready) return <p className="small muted mt-12">The generated table appears once the quantity, schedule and start date are entered.</p>;
  if (preview.error !== undefined) return <p className="err-inline mt-12">Couldn't generate the table. <button type="button" className="btn-link small" onClick={preview.reload}>Try again</button></p>;
  if (!preview.data) return <p className="small muted mt-12" role="status">Generating the table…</p>;
  const events = preview.data.events.filter((event) => event.state === "ACTIVE");
  const cliff = events.find((event) => event.kind === "CLIFF");
  const rest = events.filter((event) => event.kind !== "CLIFF").map((event) => engine.Dec.parse(event.quantity));
  const low = rest.length ? engine.Dec.min(rest[0]!, ...rest.slice(1)) : null;
  const high = rest.length ? engine.Dec.max(rest[0]!, ...rest.slice(1)) : null;
  return (
    <div className="mt-12">
      <div className="small mb-8">
        {cliff ? <>Cliff on <b>{formatDate(cliff.date)}</b> ({format.shares(cliff.quantity)}), then </> : null}
        {low && high ? `${low.eq(high) ? format.shares(low.toString()) : `${format.shares(low.toString())}/${format.shares(high.toString())}`} per tranche` : "fully vested at grant"}
        {events.length ? ` · final tranche ${formatDate(events.at(-1)!.date)}` : ""}
      </div>
      <div className="tbl-scroll" style={{ maxHeight: 180, overflow: "auto" }}>
        <table className="tbl dense" aria-label="Generated vesting table">
          <thead><tr><th scope="col">Date</th><th scope="col" className="num">Tranche</th><th scope="col" className="num">Cumulative</th></tr></thead>
          <tbody>
            {events.map((event, index) => (
              <tr key={`${event.date}-${index}`}><td>{formatDate(event.date)}{event.kind === "CLIFF" ? " · cliff" : ""}</td><td className="num">{format.shares(event.quantity)}</td><td className="num">{format.shares(event.cumulative)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The $100,000 test's first year, estimated from the generated table and the FMV: the
 * value first exercisable that year, plus what the holder's other ISO grants already use. The server computes the lots.
 */
function IsoSplitPreview({ fmv, events, isoSplit }: { fmv: string | null; events: readonly api.VestingEvent[] | null; isoSplit: api.IsoSplit | null }) {
  const { format } = useWorkspace();
  if (!fmv || !events?.length) return <>{DASH}</>;
  const byYear = new Map<number, engine.Dec>();
  for (const event of events) {
    if (event.state !== "ACTIVE") continue;
    const year = Number(event.date.slice(0, 4));
    byYear.set(year, (byYear.get(year) ?? engine.Dec.ZERO).add(event.quantity));
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const limit = engine.Dec.parse("100000");
  const used = (year: number) => engine.Dec.parse(isoSplit?.years.find((item) => item.year === year)?.isoValueUsed ?? "0");
  const valueOf = (year: number) => byYear.get(year)!.mul(fmv);
  const first = years[0]!;
  const firstTotal = valueOf(first).add(used(first));
  const later = years.slice(1).every((year) => valueOf(year).add(used(year)).lte(limit));
  return (
    <span>
      {first}: {format.money(valueOf(first).toString())} first exercisable{used(first).isPositive() ? ` (+ ${format.money(used(first).toString())} from other ISO grants)` : ""} → {firstTotal.lte(limit) ? "all ISO" : "part NSO"}
      {years.length > 1 ? `; later years ${later ? "all ISO" : "check split"}` : ""}
    </span>
  );
}
