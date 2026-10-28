import { api, engine } from "#shared";
import { ApiError } from "../http.ts";
import { holdingsView, replayed, type ReadContext } from "../read/context.ts";
import { READ_HANDLERS, type ReadInput } from "../read/handlers.ts";
import { auditJson } from "../read/records.ts";
import { securityVesting } from "../read/securities.ts";
import type { XlsxCell, XlsxSheet } from "./xlsx.ts";
import { xlsxDate, xlsxDecimal } from "./xlsx.ts";

export interface BuiltReport {
  asOf: string | null;
  asKnownAt: number | null;
  ledgerSeq: number;
  ledgerHeadHash: string | null;
  engineVersion: string;
  sheets: XlsxSheet[];
  /** JSON keeps exact rational percentages where XLSX/CSV display a six-decimal percentage. */
  jsonSheets?: JsonReportSheet[];
  rowCount: number;
}

export interface ReportParameters {
  asOf?: string;
  asKnownAt?: number;
  from?: string;
  to?: string;
}

type Security = api.Security;
type JsonCell = string | number | boolean | null;
type JsonReportSheet = { name: string; columns: string[]; rows: JsonCell[][] };

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_REPORT_ROWS = 50_000;

function sheet(name: string, columns: readonly string[], rows: XlsxCell[][]): XlsxSheet {
  return { name, columns: columns.map((header) => ({ header })), rows };
}

function decimal(value: unknown): XlsxCell {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`Invalid report decimal: ${String(value)}`);
  return xlsxDecimal(value);
}

function date(value: unknown): XlsxCell {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !DATE.test(value)) throw new Error(`Invalid report date: ${String(value)}`);
  return xlsxDate(value);
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function money(terms: Record<string, unknown>, key: string): XlsxCell {
  return decimal(field(terms, key, "amount"));
}

function exportPercent(ratio: string): XlsxCell {
  return xlsxDecimal(engine.Rational.from(ratio).mul(engine.Rational.from(100)).roundTo(6, "HALF_EVEN").toString());
}

function exactExportPercent(ratio: string): string {
  return engine.Rational.from(ratio).mul(engine.Rational.from(100)).toJSON();
}

function assertRowLimit(count: number): void {
  if (count > MAX_REPORT_ROWS) {
    throw new ApiError("payload_too_large", `Report exceeds the ${MAX_REPORT_ROWS.toLocaleString("en-US")} row export limit`);
  }
}

function redactionNote(width: number): XlsxCell[] {
  return ["PII redacted — personal e-mail, phone, address, and country fields were masked or omitted", ...Array<XlsxCell>(Math.max(0, width - 1)).fill("")];
}

async function read<T>(ctx: ReadContext, id: string, input: Partial<ReadInput> = {}): Promise<T> {
  const handler = READ_HANDLERS[id];
  if (!handler) throw new Error(`Missing read model ${id}`);
  return handler(ctx, { params: input.params ?? {}, query: input.query ?? {}, body: input.body }) as Promise<T>;
}

async function allPages<T>(
  ctx: ReadContext,
  id: string,
  query: Record<string, unknown>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read<{ items: T[]; nextCursor: string | null }>(ctx, id, { query: { ...query, cursor, limit: 100 } });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

function echo(value: { asOf: string; asKnownAt: number; ledgerSeq: number; ledgerHeadHash: string | null; engineVersion: string }) {
  return {
    asOf: value.asOf,
    asKnownAt: value.asKnownAt,
    ledgerSeq: value.ledgerSeq,
    ledgerHeadHash: value.ledgerHeadHash,
    engineVersion: value.engineVersion,
  };
}

const OWNERSHIP_FIXED = ["External ID", "Stakeholder", "Stakeholder Type"] as const;
const OWNERSHIP_TAIL = [
  "Issued and Outstanding", "Issued and Outstanding %", "Awards Outside a Plan", "Warrants", "Fully Diluted", "Fully Diluted %",
] as const;

async function capTableReport(ctx: ReadContext, query: ReportParameters): Promise<BuiltReport> {
  const q = { asOf: query.asOf, asKnownAt: query.asKnownAt };
  const state = replayed(ctx, holdingsView(ctx, q));
  const ownership = await read<api.CapTableResponse>(ctx, "getCapTable", { query: q });
  const [shares, options, safes, warrants, stakeholders, vestingTerms] = await Promise.all([
    read<api.CapTableResponse>(ctx, "getCapTable", { query: { ...q, tab: "shares" } }),
    read<api.CapTableResponse>(ctx, "getCapTable", { query: { ...q, tab: "options" } }),
    read<api.CapTableResponse>(ctx, "getCapTable", { query: { ...q, tab: "safes" } }),
    read<api.CapTableResponse>(ctx, "getCapTable", { query: { ...q, tab: "warrants" } }),
    read<api.StakeholderList>(ctx, "listStakeholders", { query: { asOf: query.asOf } }),
    read<api.VestingTermsList>(ctx, "listVestingTerms", { query: {} }),
  ]);
  const classNames = new Map(ownership.classes.map((item) => [item.stockClassId, item.name]));
  const planNames = new Map(ownership.plans.map((item) => [item.stockPlanId, item.name]));
  const classTypes = new Map(ctx.ledger.reference.stockClasses.map((item) => [item.id, item.classType]));
  const vestingNames = new Map(vestingTerms.items.map((item) => [item.id, item.name]));
  // The product rules fixes common before preferred; preserve the engine order within each type.
  const orderedClasses = [...ownership.classes].sort((left, right) => {
    const leftCommon = classTypes.get(left.stockClassId) === "COMMON" ? 0 : 1;
    const rightCommon = classTypes.get(right.stockClassId) === "COMMON" ? 0 : 1;
    return leftCommon - rightCommon;
  });
  const ownershipColumns = [
    ...OWNERSHIP_FIXED,
    ...orderedClasses.map((item) => item.name),
    OWNERSHIP_TAIL[0], OWNERSHIP_TAIL[1],
    ...ownership.plans.map((item) => item.name),
    ...OWNERSHIP_TAIL.slice(2),
  ];
  const ownershipRows: XlsxCell[][] = (ownership.ownership ?? []).map((row) => [
    row.issuerAssignedId ?? "", row.name, row.relationship,
    ...orderedClasses.map((item) => decimal(row.byClass[item.stockClassId] ?? "0")),
    decimal(row.issuedAndOutstanding), exportPercent(row.issuedAndOutstandingPct),
    ...ownership.plans.map((item) => decimal(row.planAwards[item.stockPlanId] ?? "0")),
    decimal(row.awardsOutsidePlans), decimal(row.warrants), decimal(row.fullyDiluted), exportPercent(row.fullyDilutedPct),
  ]);
  ownershipRows.push([
    "", "Totals", "", ...orderedClasses.map((item) => decimal(item.issuedAndOutstanding)),
    decimal(ownership.totals.issuedAndOutstanding), "", ...ownership.plans.map((item) => decimal(item.equityOutstanding)),
    decimal(engine.Dec.sum((ownership.ownership ?? []).map((item) => engine.Dec.parse(item.awardsOutsidePlans))).toString()),
    decimal(engine.Dec.sum((ownership.ownership ?? []).map((item) => engine.Dec.parse(item.warrants))).toString()),
    decimal(ownership.totals.fullyDiluted), "",
  ]);
  ownershipRows.push([
    "", "Available pool", "", ...orderedClasses.map(() => ""), "", "", ...ownership.plans.map(() => ""),
    "", "", decimal(ownership.availablePool.fullyDiluted), exportPercent(ownership.availablePool.fullyDilutedPct),
  ]);

  const common = (security: Security): XlsxCell[] => [
    security.certificate?.number ?? security.displayId,
    security.stakeholderName,
    security.stockClassId === null ? "" : (classNames.get(security.stockClassId) ?? security.stockClassId),
    date(security.issueDate),
    decimal(security.numbers?.fullyDiluted),
    security.numbers ? exportPercent(security.numbers.fullyDilutedPct) : "",
    money(security.terms, "share_price"),
    money(security.terms, "exercise_price"),
  ];
  const shareColumns = [
    "Certificate", "Stakeholder", "Share Class", "Issued On", "Fully Diluted", "Ownership", "Price / Share", "Exercise Price",
    "Quantity", "Capital Contribution", "Vesting", "Status", "Board Approval Date", "Exemption", "Legends", "Certificate Status", "Source",
  ];
  const allSecurities = [...(shares.rows ?? []), ...(options.rows ?? []), ...(warrants.rows ?? [])];
  const displayIds = new Map(allSecurities.map((security) => [security.id, security.displayId]));
  for (const safe of safes.safes ?? []) displayIds.set(safe.securityId, safe.displayId);
  const source = (security: Security): string => {
    const origin = text(field(security.terms, "x_origin")).toUpperCase();
    const sourceId = field(security.terms, "x_source_security_id");
    const sourceDisplay = typeof sourceId === "string" ? (displayIds.get(sourceId) ?? sourceId) : "";
    if (origin === "EXERCISE") return `exercise of ${sourceDisplay}`.trim();
    if (origin === "CONVERSION") return `conversion of ${sourceDisplay}`.trim();
    if (origin === "TRANSFER") return `transfer from ${sourceDisplay}`.trim();
    return "issued";
  };
  const shareRows = (shares.rows ?? []).map((security) => [
    ...common(security), decimal(security.numbers?.issued), money(security.terms, "x_capital_contribution"),
    typeof field(security.terms, "vesting_terms_id") === "string"
      ? (vestingNames.get(field(security.terms, "vesting_terms_id") as string) ?? text(field(security.terms, "vesting_terms_id"))) : "",
    security.status,
    security.boardApprovalDate ? date(security.boardApprovalDate) : security.boardApprovalNotRecordedInPulley ? `not recorded in ${api.importSourceName(ctx.org.import_source)}` : "",
    security.exemption.federal ?? "", text(field(security.terms, "x_legends")),
    security.certificate && security.provenance.importedFromPulley ? "unsigned PDF (imported)" : "uncertificated",
    source(security),
  ]);
  const optionColumns = [
    "Certificate", "Stakeholder", "Share Class", "Issued On", "Fully Diluted", "Ownership", "Price / Share", "Exercise Price",
    "Plan", "Type", "Granted", "Vested", "Unvested", "Exercised", "Cancelled", "Outstanding", "Expiration", "Status",
    "Execution Status", "Federal Exemption", "ISO/NSO Split", "Contractual Deadline", "ISO Deadline", "Early Exercise Allowed",
  ];
  const isoSplits = new Map<string, engine.IsoGrantSplit>();
  for (const stakeholderId of new Set((options.rows ?? []).map((security) => security.stakeholderId))) {
    for (const split of engine.isoSplit(state, stakeholderId)) isoSplits.set(split.securityId, split);
  }
  const optionRows = (options.rows ?? []).map((security) => {
    const split = isoSplits.get(security.id);
    const splitText = security.subtype === "OPTION_NSO" ? `NSO ${security.numbers?.issued ?? "0"}` : split
      ? [`ISO ${split.iso}`, `NSO ${split.nso}`, split.unclassified.isPositive() ? `Unclassified ${split.unclassified}` : ""].filter(Boolean).join("; ")
      : "Unclassified";
    return [
    ...common(security), security.stockPlanId === null ? "" : (planNames.get(security.stockPlanId) ?? security.stockPlanId),
    security.subtype === "OPTION_ISO" ? "ISO" : security.subtype === "OPTION_NSO" ? "NSO" : security.subtype,
    decimal(security.numbers?.issued), decimal(security.numbers?.vested), decimal(security.numbers?.unvested),
    decimal(security.numbers?.exercised), decimal(security.numbers?.cancelled), decimal(security.numbers?.outstanding),
    date(field(security.terms, "expiration_date")), security.status, security.executionStatus, security.exemption.federal ?? "",
    splitText, date(security.deadlines?.contractual), date(security.deadlines?.iso), field(security.terms, "early_exercisable") === true,
    ];
  });
  const safeColumns = [
    "Certificate", "Stakeholder", "Principal", "Issued On", "Valuation Cap", "Conversion Type", "Discount", "Status", "Converted Into", "Conversion Price",
  ];
  const names = new Map(stakeholders.items.map((holder) => [holder.id, holder.displayName]));
  const safeRows = (safes.safes ?? []).map((item) => [
    item.displayId, names.get(item.stakeholderId) ?? item.stakeholderId, decimal(item.principal), date(item.issueDate), decimal(item.valuationCap),
    item.conversionTiming ?? "", decimal(item.discountRate), item.status, item.convertedInto.map((lot) => lot.displayId).join("; "), "per closing memo",
  ]);
  const warrantColumns = [
    "Certificate", "Stakeholder", "Share Class", "Issued On", "Fully Diluted", "Ownership", "Price / Share", "Exercise Price",
    "Quantity", "Exercised", "Outstanding", "Expiration", "Status",
  ];
  const warrantRows = (warrants.rows ?? []).map((security) => [
    ...common(security), decimal(security.numbers?.issued), decimal(security.numbers?.exercised), decimal(security.numbers?.outstanding),
    date(field(security.terms, "warrant_expiration_date")), security.status,
  ]);
  const planRows = ownership.plans.map((plan) => [plan.name, decimal(plan.poolSize), decimal(plan.equityOutstanding), decimal(plan.equityRetired), decimal(plan.available)]);
  const sheets = [
    sheet("Ownership", ownershipColumns, ownershipRows), sheet("Shares", shareColumns, shareRows),
    sheet("Options", optionColumns, optionRows), sheet("SAFEs", safeColumns, safeRows),
    sheet("Warrants", warrantColumns, warrantRows),
    sheet("Plan Availability", ["Plan", "Size", "Outstanding", "Retired", "Available"], planRows),
  ];
  const jsonSheets = primitiveSheets(sheets);
  const issuedPct = 4 + orderedClasses.length;
  const fullyDilutedPct = 8 + orderedClasses.length + ownership.plans.length;
  (ownership.ownership ?? []).forEach((row, index) => {
    jsonSheets[0]!.rows[index]![issuedPct] = exactExportPercent(row.issuedAndOutstandingPct);
    jsonSheets[0]!.rows[index]![fullyDilutedPct] = exactExportPercent(row.fullyDilutedPct);
  });
  jsonSheets[0]!.rows.at(-1)![fullyDilutedPct] = exactExportPercent(ownership.availablePool.fullyDilutedPct);
  (shares.rows ?? []).forEach((security, index) => { jsonSheets[1]!.rows[index]![5] = security.numbers ? exactExportPercent(security.numbers.fullyDilutedPct) : null; });
  (options.rows ?? []).forEach((security, index) => { jsonSheets[2]!.rows[index]![5] = security.numbers ? exactExportPercent(security.numbers.fullyDilutedPct) : null; });
  (warrants.rows ?? []).forEach((security, index) => { jsonSheets[4]!.rows[index]![5] = security.numbers ? exactExportPercent(security.numbers.fullyDilutedPct) : null; });
  return { ...echo(ownership), sheets, jsonSheets, rowCount: sheets.reduce((sum, item) => sum + item.rows.length, 0) };
}

const RAW_COLUMNS = [
  "ID", "Instrument", "Holder ID", "Holder Name", "Class", "Plan", "Status", "Execution Status", "Issue Date", "Quantity",
  "Outstanding", "Vested", "Unvested", "Exercised", "Cancelled", "Price", "Exercise Price", "Capital Contribution", "Currency",
  "Vesting Schedule", "Commencement", "Cliff", "Acceleration Terms", "Expiration", "Voluntary Exit Window", "Involuntary Exit Window",
  "With Cause Exit Window", "Death Exit Window", "Disability Exit Window", "Retirement Exit Window", "Contractual Deadline", "ISO Deadline",
  "Federal Exemption", "Country", "State Exemption", "Board Approval Date", "Legends", "Holding Start Date", "Rule 144 Date",
  "Early Exercise Allowed", "Source or Parent Security", "Converted Into", "Transferred From", "Certificate Status", "83(b) Status",
  "Source Object Type", "Source SHA-256", "Source ID", "Created At", "Updated At",
] as const;

function windowValue(terms: Record<string, unknown>, reason: string): string {
  const windows = field(terms, "termination_exercise_windows");
  if (!Array.isArray(windows)) return "";
  const window = windows.find((item) => field(item, "reason") === reason);
  if (!window) return "";
  return `${text(field(window, "period"))} ${text(field(window, "period_type"))}`.trim();
}

async function rawCapTableReport(ctx: ReadContext, query: ReportParameters): Promise<BuiltReport> {
  const q = { asOf: query.asOf, asKnownAt: query.asKnownAt };
  const [securities, classes, plans, vestingTerms, elections] = await Promise.all([
    read<api.SecurityList>(ctx, "listSecurities", { query: q }),
    read<api.StockClassList>(ctx, "listStockClasses", { query: q }),
    read<api.StockPlanList>(ctx, "listStockPlans", { query: q }),
    read<api.VestingTermsList>(ctx, "listVestingTerms", { query: {} }),
    read<{ items: api.Election83b[] }>(ctx, "listElections83b", { query: {} }),
  ]);
  const classNames = new Map(classes.items.map((item) => [item.id, item.name]));
  const planNames = new Map(plans.items.map((item) => [item.id, item.name]));
  const termNames = new Map(vestingTerms.items.map((item) => [item.id, item]));
  const election = new Map(elections.items.map((item) => [item.securityId, item.status]));
  const txBySecurity = new Map<string, engine.LedgerTransaction[]>();
  const visibleTransactions = ctx.ledger.transactions.filter((tx) => tx.effectiveDate <= securities.asOf && tx.seq <= securities.asKnownAt);
  for (const tx of visibleTransactions) {
    if (tx.securityId === null) continue;
    txBySecurity.set(tx.securityId, [...(txBySecurity.get(tx.securityId) ?? []), tx]);
  }
  const display = new Map(securities.items.map((item) => [item.id, item.displayId]));
  const convertedBySecurity = new Map<string, string[]>();
  for (const tx of visibleTransactions) {
    if (tx.type !== "TX_CONVERTIBLE_CONVERSION") continue;
    const sourceId = field(tx.payload, "security_id");
    const resulting = field(tx.payload, "resulting_security_ids");
    if (typeof sourceId === "string" && Array.isArray(resulting)) {
      convertedBySecurity.set(sourceId, resulting.filter((id): id is string => typeof id === "string"));
    }
  }
  const rows: XlsxCell[][] = [];
  for (const security of securities.items) {
    const terms = security.terms;
    const vestingId = field(terms, "vesting_terms_id");
    const vesting = typeof vestingId === "string" ? termNames.get(vestingId) : undefined;
    const timeline = txBySecurity.get(security.id) ?? [];
    const vestingStart = timeline.find((tx) => tx.type === "TX_VESTING_START");
    const recorded = timeline.map((tx) => ctx.ledger.txMeta.get(tx.id)?.recordedAt).filter((value): value is number => value !== undefined);
    const created = recorded.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
    const updated = recorded.reduce((max, value) => Math.max(max, value), 0);
    const sourceId = (field(terms, "x_source_security_id") as string | undefined) ?? security.parentSecurityId ?? undefined;
    const converted = (convertedBySecurity.get(security.id) ?? []).map((id) => display.get(id) ?? id).join("; ");
    const origin = text(field(terms, "x_origin"));
    const transferred = origin === "TRANSFER" && sourceId ? (display.get(sourceId) ?? sourceId) : "";
    rows.push([
      security.displayId, security.subtype, security.stakeholderId, security.stakeholderName,
      security.stockClassId ? (classNames.get(security.stockClassId) ?? security.stockClassId) : "",
      security.stockPlanId ? (planNames.get(security.stockPlanId) ?? security.stockPlanId) : "",
      security.status, security.executionStatus, date(security.issueDate), decimal(security.numbers?.issued), decimal(security.numbers?.outstanding),
      decimal(security.numbers?.vested), decimal(security.numbers?.unvested), decimal(security.numbers?.exercised), decimal(security.numbers?.cancelled),
      money(terms, "share_price") || money(terms, "purchase_price") || money(terms, "investment_amount"), money(terms, "exercise_price"),
      money(terms, "x_capital_contribution"), text(field(terms, "share_price", "currency") ?? field(terms, "exercise_price", "currency") ?? field(terms, "investment_amount", "currency")),
      vesting?.name ?? "", date(field(vestingStart?.payload, "x_vesting_start_date")), vesting ? text(field(vesting.definition, "cliff")) : "", text(field(terms, "x_acceleration_terms")),
      date(field(terms, "expiration_date") ?? field(terms, "warrant_expiration_date")),
      windowValue(terms, "VOLUNTARY_OTHER"), windowValue(terms, "INVOLUNTARY_OTHER"), windowValue(terms, "INVOLUNTARY_WITH_CAUSE"), windowValue(terms, "INVOLUNTARY_DEATH"),
      windowValue(terms, "INVOLUNTARY_DISABILITY"), windowValue(terms, "VOLUNTARY_RETIREMENT"), date(security.deadlines?.contractual), date(security.deadlines?.iso),
      security.exemption.federal ?? "", security.exemption.country ?? "", security.exemption.state ?? "",
      security.boardApprovalDate ? date(security.boardApprovalDate) : security.boardApprovalNotRecordedInPulley ? `not recorded in ${api.importSourceName(ctx.org.import_source)}` : "",
      text(field(terms, "x_legends") ?? field(terms, "x_legend_ids") ?? field(terms, "stock_legend_ids")),
      date(field(terms, "x_holding_start_date")), date(field(terms, "x_rule_144_date")), field(terms, "early_exercisable") === true,
      sourceId ? (display.get(sourceId) ?? sourceId) : origin, converted, transferred, security.certificate?.status ?? "uncertificated",
      election.get(security.id) ?? "",
      security.provenance.importedFromPulley ? (security.family === "CONVERTIBLE" ? "convertible" : "security") : "",
      security.provenance.sourceSha256 ?? "",
      security.provenance.pulleyId ? api.displaySourceId(security.provenance.pulleyId) : "", Number.isFinite(created) ? new Date(created).toISOString() : "", updated > 0 ? new Date(updated).toISOString() : "",
    ]);
  }
  const result = sheet("Raw Cap Table", RAW_COLUMNS, rows);
  return { ...echo(securities), sheets: [result], rowCount: rows.length };
}

const STAKEHOLDER_COLUMNS = [
  "ID", "Name", "Type", "Relationships", "E-mails", "Phone", "Address", "Country of Tax Residence", "Hire Date",
  "Termination Date", "Termination Type", "Status", "External ID", "FD Shares", "FD %",
] as const;

async function stakeholderReport(ctx: ReadContext, query: ReportParameters): Promise<BuiltReport> {
  const result = await read<api.StakeholderList>(ctx, "listStakeholders", { query: { asOf: query.asOf } });
  const rows = result.items.map((holder): XlsxCell[] => {
    const terminating = holder.scheduledTermination !== null;
    const terminated = holder.termination !== null;
    const address = holder.address ? [holder.address.line1, holder.address.line2, holder.address.city, holder.address.region, holder.address.postalCode, holder.address.country].filter(Boolean).join(", ") : "";
    return [
      holder.id, holder.displayName, holder.kind, holder.relationship, holder.emails.map((item) => item.email).join("; "), holder.phone ?? "", address,
      ctx.viewer.pii ? (holder.countryOfResidence ?? "") : "", date(holder.hireDate), date(holder.termination?.date), holder.termination?.type ?? "",
      terminated ? "terminated" : terminating ? "terminating" : "active", holder.issuerAssignedId ?? "", decimal(holder.totals?.fullyDiluted),
      holder.totals ? exportPercent(holder.totals.fullyDilutedPct) : "",
    ];
  });
  const jsonSheets = primitiveSheets([sheet("Stakeholders", STAKEHOLDER_COLUMNS, rows)]);
  const rowCount = rows.length;
  if (!ctx.viewer.pii) rows.push(redactionNote(STAKEHOLDER_COLUMNS.length));
  const sheets = [sheet("Stakeholders", STAKEHOLDER_COLUMNS, rows)];
  result.items.forEach((holder, index) => {
    jsonSheets[0]!.rows[index]![14] = holder.totals ? exactExportPercent(holder.totals.fullyDilutedPct) : null;
  });
  return { ...echo(result), sheets, jsonSheets, rowCount };
}

const VESTING_COLUMNS = ["Holder", "Security", "Event Date", "Quantity", "Cumulative", "Status", "Source", "Schedule", "Acceleration Flag"] as const;

async function vestingReport(ctx: ReadContext, query: ReportParameters): Promise<BuiltReport> {
  const q = { asOf: query.asOf, asKnownAt: query.asKnownAt };
  const state = replayed(ctx, holdingsView(ctx, q));
  const [securities, terms] = await Promise.all([
    read<api.SecurityList>(ctx, "listSecurities", { query: q }),
    read<api.VestingTermsList>(ctx, "listVestingTerms", { query: {} }),
  ]);
  const termNames = new Map(terms.items.map((item) => [item.id, item.name]));
  const rows: XlsxCell[][] = [];
  for (const security of securities.items) {
    if (field(security.terms, "vesting_terms_id") === undefined) continue;
    const vesting = securityVesting(ctx, state, security.id);
    const termId = field(security.terms, "vesting_terms_id");
    for (const event of vesting.events) {
      rows.push([
        security.stakeholderName, security.displayId, date(event.date), decimal(event.quantity), decimal(event.cumulative),
        event.state === "CANCELLED" ? "cancelled" : event.date <= securities.asOf ? "vested" : "unvested",
        event.source === "pulley" ? api.importSourceName(ctx.org.import_source) : "generator", typeof termId === "string" ? (termNames.get(termId) ?? termId) : "",
        event.kind === "ACCELERATION",
      ]);
      assertRowLimit(rows.length);
    }
  }
  return { ...echo(securities), sheets: [sheet("Vesting Details", VESTING_COLUMNS, rows)], rowCount: rows.length };
}

const EXERCISE_COLUMNS = [
  "Exercise Date", "Holder", "Holder Status", "Option ID", "ISO Qty", "NSO Qty", "Late-ISO Reclassification", "Strike", "FMV at Exercise", "FMV Source",
  "Cost", "Spread (NSO)", "Tax Treatment", "Country", "Federal Withholding", "Social Security Withholding", "Medicare Withholding",
  "State Withholding", "State Code", "Payment Method", "Reference", "Resulting Share IDs", "Source", "Recorded By",
] as const;

async function exerciseReport(ctx: ReadContext, query: ReportParameters): Promise<BuiltReport> {
  const [exercises, stakeholders, transactions] = await Promise.all([
    read<{ items: api.ExerciseRecord[] }>(ctx, "listExercises", { query: {} }),
    read<api.StakeholderList>(ctx, "listStakeholders", { query: {} }),
    allPages<api.Transaction>(ctx, "listTransactions", { type: "TX_EQUITY_COMPENSATION_EXERCISE" }),
  ]);
  const holders = new Map(stakeholders.items.map((item) => [item.id, item]));
  const txById = new Map(transactions.map((item) => [item.id, item]));
  const commands = new Map<string, string>();
  const filtered = exercises.items.filter((item) => !item.reversed && (!query.from || item.exerciseDate >= query.from) && (!query.to || item.exerciseDate <= query.to));
  for (const item of filtered) {
    if (commands.has(item.commandId)) continue;
    const command = await read<api.CommandDetail>(ctx, "getCommand", { params: { id: item.commandId } });
    commands.set(item.commandId, command.actor ?? (command.actorKind === "import" ? api.importSourceLabel(ctx.org.import_source) : command.actorKind));
  }
  const rows = filtered.map((item): XlsxCell[] => {
    const holder = holders.get(item.stakeholderId);
    const state = item.withholding?.state ?? [];
    const transaction = txById.get(item.transactionId);
    const portions = field(transaction?.payload, "x_portions");
    const lateIso = Array.isArray(portions) && portions.some((portion) => field(portion, "portion") === "NSO" && field(portion, "reason") === "AFTER_ISO_DEADLINE");
    const fmvSource = text(field(transaction?.payload, "x_fmv", "source"));
    const spread = item.fmvPerShare === null ? null : engine.Dec.parse(item.fmvPerShare).sub(item.exercisePrice)
      .mul(item.nsoQuantity).clampZero().roundTo(12, "HALF_EVEN").toString();
    return [
      date(item.exerciseDate), item.stakeholderName, holder?.termination ? "former" : "current", item.grantDisplayId,
      decimal(item.isoQuantity), decimal(item.nsoQuantity), lateIso, decimal(item.exercisePrice), decimal(item.fmvPerShare), fmvSource,
      decimal(item.cost), decimal(spread), item.taxTreatment ?? "", ctx.viewer.pii ? (holder?.countryOfResidence ?? "") : "", decimal(item.withholding?.federalIncome),
      decimal(item.withholding?.socialSecurity), decimal(item.withholding?.medicare), state.map((entry) => entry.amount).join("; "),
      state.map((entry) => entry.code).join("; "), item.paymentMethod ?? "", item.paymentReference ?? "",
      item.resultingShares.map((share) => share.displayId).join("; "),
      item.source.kind === "request" ? `request ER-${item.source.requestNumber}` : item.source.kind, commands.get(item.commandId) ?? "",
    ];
  });
  const jsonSheets = primitiveSheets([sheet("Exercise History", EXERCISE_COLUMNS, rows)]);
  const rowCount = rows.length;
  if (!ctx.viewer.pii) rows.push(redactionNote(EXERCISE_COLUMNS.length));
  return {
    asOf: null, asKnownAt: null, ledgerSeq: ctx.ledger.seq, ledgerHeadHash: ctx.ledger.headHash, engineVersion: engine.ENGINE_VERSION,
    sheets: [sheet("Exercise History", EXERCISE_COLUMNS, rows)], jsonSheets, rowCount,
  };
}

const AUDIT_COLUMNS = ["Time", "Local Date", "Actor", "Actor Type", "Role", "Command ID", "Object", "Action", "Field", "Old", "New", "Reason"] as const;
interface AuditDatabaseRow {
  id: number;
  occurred_at: number;
  org_id: string | null;
  actor_kind: api.AuditEvent["actor"]["kind"];
  actor_user_id: string | null;
  actor_email: string | null;
  auth_method: api.AuditEvent["actor"]["authMethod"];
  action: string;
  target_type: string | null;
  target_id: string | null;
  result: api.AuditEvent["result"];
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  details: string | null;
}

export const AUDIT_PAGE_SQL = `SELECT * FROM audit_events
  WHERE org_id = ?1 AND occurred_at = ?3 AND occurred_at >= ?2 AND id <= ?4
  UNION ALL
  SELECT * FROM audit_events
  WHERE org_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3
  ORDER BY occurred_at DESC, id DESC LIMIT 201`;
export const AUDIT_FIRST_CURSOR_ID = Number.MAX_SAFE_INTEGER;

function nextDate(value: string): string {
  const instant = new Date(`${value}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

function formattedDate(formatter: Intl.DateTimeFormat, timestamp: number): string {
  const parts = formatter.formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** First UTC millisecond whose local calendar date is `date` (DST-safe, including 23/25-hour days). */
function localDateStart(formatter: Intl.DateTimeFormat, dateValue: string): number {
  const center = Date.parse(`${dateValue}T00:00:00Z`);
  let low = center - 36 * 3_600_000;
  let high = center + 36 * 3_600_000;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (formattedDate(formatter, middle) < dateValue) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function auditReport(ctx: ReadContext, query: ReportParameters): Promise<BuiltReport> {
  const formatter = dateFormatter(ctx.org.timezone);
  const start = query.from ? localDateStart(formatter, query.from) : 0;
  const end = query.to ? localDateStart(formatter, nextDate(query.to)) : 8_640_000_000_000_000;
  const rows: XlsxCell[][] = [];
  let beforeOccurredAt = end - 1;
  let beforeId = AUDIT_FIRST_CURSOR_ID;
  let hasMore: boolean;
  do {
    // The composite cursor matches audit_events_org_occurred, including when many events share one millisecond.
    const response: D1Result<AuditDatabaseRow> = await ctx.db.prepare(
      AUDIT_PAGE_SQL,
    ).bind(ctx.org.id, start, beforeOccurredAt, beforeId).all<AuditDatabaseRow>();
    const results: AuditDatabaseRow[] = response.results;
    const page = results.slice(0, 200);
    for (const row of page) {
      const event = auditJson(ctx.viewer, row);
      const occurredOn = formattedDate(formatter, event.occurredAt);
      // Keep the calendar check next to the UTC bounds so unusual zone transitions fail closed at the requested dates.
      if ((query.from && occurredOn < query.from) || (query.to && occurredOn > query.to)) continue;
      rows.push([
        new Date(event.occurredAt).toISOString(), occurredOn,
        event.actor.email ?? event.actor.userId ?? event.actor.kind, event.actor.kind,
        text(field(event.details, "role")), text(field(event.details, "commandId")), [event.targetType, event.targetId].filter(Boolean).join(":"),
        event.action, text(field(event.details, "field")), text(field(event.details, "old")), text(field(event.details, "new")), event.reason ?? "",
      ]);
      assertRowLimit(rows.length);
    }
    hasMore = results.length > 200;
    if (hasMore) {
      const cursor = page[page.length - 1]!;
      beforeOccurredAt = cursor.occurred_at;
      beforeId = cursor.id - 1;
    }
  } while (hasMore);
  const rowCount = rows.length;
  if (!ctx.viewer.pii) rows.push(redactionNote(AUDIT_COLUMNS.length));
  return {
    asOf: null, asKnownAt: null, ledgerSeq: ctx.ledger.seq, ledgerHeadHash: ctx.ledger.headHash, engineVersion: engine.ENGINE_VERSION,
    sheets: [sheet("Audit Log", AUDIT_COLUMNS, rows)], rowCount,
  };
}

export async function buildReport(ctx: ReadContext, key: api.ReportKey, query: ReportParameters): Promise<BuiltReport> {
  const report = await (async () => {
    switch (key) {
      case "cap-table": return capTableReport(ctx, query);
      case "raw-cap-table": return rawCapTableReport(ctx, query);
      case "stakeholders": return stakeholderReport(ctx, query);
      case "vesting-details": return vestingReport(ctx, query);
      case "exercise-history": return exerciseReport(ctx, query);
      case "audit-log": return auditReport(ctx, query);
    }
  })();
  assertRowLimit(report.rowCount);
  return report;
}

function primitiveSheets(sheets: readonly XlsxSheet[]): JsonReportSheet[] {
  return sheets.map((item) => ({
    name: item.name,
    columns: item.columns.map((column) => column.header),
    rows: item.rows.map((row) => row.map((cell) => cell && typeof cell === "object" ? cell.value : (cell ?? null))),
  }));
}

export function reportJsonSheets(report: BuiltReport): JsonReportSheet[] {
  return report.jsonSheets ?? primitiveSheets(report.sheets);
}
