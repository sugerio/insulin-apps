import { api, engine } from "#shared";
import { ApiError, notFound } from "../http.ts";
import { dec, echo, type ReadContext } from "./context.ts";
import { ActorLabels } from "./records.ts";

/**
 * Equity structure (the API contract): the class and plan rows hold identity and descriptive data; authorized shares,
 * ratios, terms, pool size and the return-to-pool rules are replayed from ledger facts.
 */

interface ClassRow {
  id: string;
  name: string;
  class_type: "COMMON" | "PREFERRED";
  default_id_prefix: string;
  par_value: string | null;
  original_issue_price: string | null;
  currency: string;
  is_certificated: number;
  board_approval_date: string | null;
  stockholder_approval_date: string | null;
  version: number;
}

const CLASS_HISTORY = new Set(["TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", "X_STOCK_CLASS_TERMS", "TX_STOCK_CLASS_SPLIT"]);

function classSummary(tx: engine.LedgerTransaction): string {
  switch (tx.type) {
    case "TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT":
      return `Authorized shares set to ${tx.payload.new_shares_authorized}`;
    case "TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT":
      return `Conversion ratio ${tx.payload.new_ratio_conversion_mechanism.ratio.numerator}:${tx.payload.new_ratio_conversion_mechanism.ratio.denominator}`;
    case "TX_STOCK_CLASS_SPLIT":
      return `Split ${tx.payload.split_ratio.numerator}:${tx.payload.split_ratio.denominator}`;
    case "X_STOCK_CLASS_TERMS":
      return "Terms recorded";
    default:
      return tx.type;
  }
}

function stockClassJson(ctx: ReadContext, state: engine.LedgerState, row: ClassRow, metrics: engine.CapTableMetrics): api.StockClass {
  const stockClass = state.classes.get(row.id);
  const numbers = metrics.classes.find((c) => c.stockClassId === row.id);
  const termsTx = [...state.applied].reverse().find((tx) => tx.type === "X_STOCK_CLASS_TERMS" && tx.payload.stock_class_id === row.id);
  const terms = stockClass?.terms;
  const ratio = stockClass?.conversionRatio ?? engine.Rational.ONE;
  return {
    id: row.id,
    name: row.name,
    classType: row.class_type,
    defaultIdPrefix: row.default_id_prefix,
    parValue: row.par_value,
    originalIssuePrice: row.original_issue_price,
    currency: row.currency,
    isCertificated: row.is_certificated === 1,
    boardApprovalDate: row.board_approval_date,
    stockholderApprovalDate: row.stockholder_approval_date,
    asOf: state.asOf,
    authorizedShares: dec(stockClass?.authorized ?? null),
    conversionRatio: { numerator: ratio.num.toString(), denominator: ratio.den.toString() },
    terms: {
      votesPerShare: dec(terms?.votesPerShare ?? engine.Dec.ONE),
      excludeFromFullyDiluted: terms?.excludeFromFullyDiluted ?? false,
      seniority: terms?.seniority ?? null,
      liquidationPreferenceMultiple: terms?.liquidationPreferenceMultiple?.toString() ?? null,
      participation: (terms?.participation ?? null) as api.StockClassTerms["participation"],
      participationCapMultiple: terms?.participationCapMultiple?.toString() ?? null,
      dividendTerms: termsTx?.type === "X_STOCK_CLASS_TERMS" ? termsTx.payload.dividend_terms : null,
      antiDilution: (terms?.antiDilution ?? null) as api.StockClassTerms["antiDilution"],
      notRecordedInPulley: terms?.notRecordedInPulley ?? [],
    },
    numbers: {
      issuedAndOutstanding: dec(numbers?.issuedAndOutstanding),
      reserved: dec(numbers?.reserved),
      availableToIssue: dec(numbers?.availableToIssue ?? null),
      fullyDiluted: dec(numbers?.fullyDiluted),
    },
    history: state.applied
      .filter((tx) => CLASS_HISTORY.has(tx.type) && (tx.payload as { stock_class_id?: string }).stock_class_id === row.id)
      .map((tx) => ({ effectiveDate: tx.effectiveDate, transactionId: tx.id, type: tx.type, summary: classSummary(tx) })),
    version: row.version,
  };
}

async function classRows(ctx: ReadContext, stockClassId?: string): Promise<ClassRow[]> {
  const { results } = await ctx.db.prepare("SELECT * FROM stock_classes WHERE org_id = ?1 AND (?2 IS NULL OR id = ?2) ORDER BY name, id")
    .bind(ctx.org.id, stockClassId ?? null).all<ClassRow>();
  return results;
}

export async function stockClassList(ctx: ReadContext, state: engine.LedgerState): Promise<api.StockClassList> {
  const metrics = engine.computeMetrics(state);
  return api.stockClassListSchema.parse({ ...echo(ctx, state), items: (await classRows(ctx)).map((row) => stockClassJson(ctx, state, row, metrics)) });
}

export async function stockClassDetail(ctx: ReadContext, state: engine.LedgerState, stockClassId: string): Promise<api.StockClassDetail> {
  const row = (await classRows(ctx, stockClassId))[0];
  if (!row) throw notFound("Stock class not found");
  return api.stockClassDetailSchema.parse({ ...stockClassJson(ctx, state, row, engine.computeMetrics(state)), ...echo(ctx, state) });
}

interface PlanRow {
  id: string;
  name: string;
  stock_class_id: string;
  board_approval_date: string | null;
  stockholder_approval_date: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  version: number;
}

const API_REASON: Record<engine.TerminationWindowReason, api.TerminationWindow["reason"]> = {
  VOLUNTARY_OTHER: "VOLUNTARY",
  VOLUNTARY_GOOD_CAUSE: "VOLUNTARY",
  VOLUNTARY_RETIREMENT: "RETIREMENT",
  INVOLUNTARY_OTHER: "INVOLUNTARY",
  INVOLUNTARY_DEATH: "DEATH",
  INVOLUNTARY_DISABILITY: "DISABILITY",
  INVOLUNTARY_WITH_CAUSE: "WITH_CAUSE",
};

/** An OCF window in the API's `TerminationWindow` terms. */
export function windowJson(window: engine.TerminationWindow): api.TerminationWindow {
  return { period: String(window.period), unit: window.period_type, reason: API_REASON[window.reason] };
}

async function planRows(ctx: ReadContext, stockPlanId?: string): Promise<PlanRow[]> {
  const { results } = await ctx.db.prepare("SELECT * FROM stock_plans WHERE org_id = ?1 AND (?2 IS NULL OR id = ?2) ORDER BY name, id")
    .bind(ctx.org.id, stockPlanId ?? null).all<PlanRow>();
  return results;
}

/**
 * A plan's view. Its rules and windows are the X_STOCK_PLAN_TERMS in force; that transaction's actor and document are
 * "who confirmed the rules, and when" (the ledger rules). A plan with no terms recorded shows the engine's single default
 * (all RETURN) as unconfirmed, against the transaction that set its pool.
 */
async function stockPlanJson(ctx: ReadContext, state: engine.LedgerState, row: PlanRow, metrics: engine.CapTableMetrics, labels: ActorLabels): Promise<api.StockPlan | null> {
  const plan = state.plans.get(row.id);
  const numbers = metrics.plans.find((p) => p.stockPlanId === row.id);
  const terms = engine.planTermsOn(state, row.id, state.asOf);
  const anchor = terms ?? plan?.poolSetBy ?? null;
  if (anchor === null) return null;
  const termsTx = terms ? state.applied.find((tx) => tx.id === terms.transactionId) : undefined;
  const documentId = termsTx?.type === "X_STOCK_PLAN_TERMS" ? (termsTx.payload.document_id ?? null) : null;
  const meta = ctx.ledger.txMeta.get(anchor.transactionId);
  return {
    id: row.id,
    name: row.name,
    stockClassId: row.stock_class_id,
    boardApprovalDate: row.board_approval_date,
    stockholderApprovalDate: row.stockholder_approval_date,
    effectiveDate: row.effective_date,
    expirationDate: row.expiration_date,
    asOf: state.asOf,
    poolSize: dec(numbers?.poolSize),
    equityOutstanding: dec(numbers?.equityOutstanding),
    equityRetired: dec(numbers?.equityRetired),
    availableToGrant: dec(numbers?.availableToGrant),
    returnRules: { ...(terms?.rules ?? engine.DEFAULT_PLAN_RETURN_RULES) },
    returnRulesConfirmation: {
      transactionId: anchor.transactionId,
      effectiveDate: anchor.date,
      confirmedBy: terms ? ((await labels.command(anchor.commandId)) ?? "Unknown") : "Not confirmed (default rules)",
      confirmedAt: terms ? (meta?.recordedAt ?? 0) : 0,
      documentId,
    },
    defaultTerminationWindows: (terms?.defaultTerminationWindows ?? []).map(windowJson),
    defaultRepurchaseWindow: terms?.defaultRepurchaseWindow ? { period: String(terms.defaultRepurchaseWindow.period), unit: terms.defaultRepurchaseWindow.period_type } : null,
    status: terms?.status ?? "active",
    pourOverPlanId: terms?.pourOverPlanId ?? null,
    amendments: state.applied
      .filter((tx) => (tx.type === "TX_STOCK_PLAN_POOL_ADJUSTMENT" || tx.type === "X_STOCK_PLAN_TERMS") && (tx.payload as { stock_plan_id?: string }).stock_plan_id === row.id)
      .map((tx) => ({
        effectiveDate: tx.effectiveDate,
        transactionId: tx.id,
        type: tx.type,
        poolSize: tx.type === "TX_STOCK_PLAN_POOL_ADJUSTMENT" ? tx.payload.shares_reserved : null,
      })),
    version: row.version,
  };
}

export async function stockPlanList(ctx: ReadContext, state: engine.LedgerState): Promise<api.StockPlanList> {
  const metrics = engine.computeMetrics(state);
  const labels = new ActorLabels(ctx);
  const items: api.StockPlan[] = [];
  for (const row of await planRows(ctx)) {
    const plan = await stockPlanJson(ctx, state, row, metrics, labels);
    if (plan) items.push(plan);
  }
  return api.stockPlanListSchema.parse({ ...echo(ctx, state), items });
}

export async function stockPlanDetail(ctx: ReadContext, state: engine.LedgerState, stockPlanId: string): Promise<api.StockPlanDetail> {
  const row = (await planRows(ctx, stockPlanId))[0];
  if (!row) throw notFound("Stock plan not found");
  const plan = await stockPlanJson(ctx, state, row, engine.computeMetrics(state), new ActorLabels(ctx));
  if (!plan) throw notFound("Stock plan not found");
  return api.stockPlanDetailSchema.parse({ ...plan, ...echo(ctx, state) });
}

export interface TermsRow {
  id: string;
  name: string;
  description: string | null;
  is_template: number;
  template_id: string | null;
  definition: string;
  definition_sha256: string;
  algorithm_version: number;
  confirmed_by: string | null;
  confirmed_at: number | null;
  pulley_id: string | null;
  created_at: number;
}

async function vestingTermsJson(ctx: ReadContext, rows: TermsRow[], state: engine.LedgerState, labels: ActorLabels): Promise<api.VestingTerms[]> {
  const usage = new Map<string, number>();
  for (const security of state.securities.values()) {
    if (security.vestingTermsId !== null) usage.set(security.vestingTermsId, (usage.get(security.vestingTermsId) ?? 0) + 1);
  }
  const items: api.VestingTerms[] = [];
  for (const row of rows) {
    items.push({
      id: row.id,
      name: row.name,
      description: row.description,
      isTemplate: row.is_template === 1,
      templateId: row.template_id,
      definition: api.vestingDefinitionSchema.parse(JSON.parse(row.definition) as unknown),
      definitionSha256: row.definition_sha256,
      algorithmVersion: row.algorithm_version,
      grantsUsing: usage.get(row.id) ?? 0,
      confirmedBy: await labels.user(row.confirmed_by),
      confirmedAt: row.confirmed_at,
      importedFromPulley: row.pulley_id !== null,
      createdAt: row.created_at,
    });
  }
  return items;
}

export async function vestingTermsList(ctx: ReadContext, state: engine.LedgerState, templatesOnly: boolean): Promise<api.VestingTermsList> {
  const { results } = await ctx.db.prepare("SELECT * FROM vesting_terms WHERE org_id = ?1 AND (?2 = 0 OR is_template = 1) AND archived_at IS NULL ORDER BY name, id")
    .bind(ctx.org.id, templatesOnly ? 1 : 0).all<TermsRow>();
  return api.vestingTermsListSchema.parse({ items: await vestingTermsJson(ctx, results, state, new ActorLabels(ctx)) });
}

export async function vestingTermsDetail(ctx: ReadContext, state: engine.LedgerState, id: string): Promise<api.VestingTerms> {
  const row = await ctx.db.prepare("SELECT * FROM vesting_terms WHERE org_id = ? AND id = ?").bind(ctx.org.id, id).first<TermsRow>();
  if (!row) throw notFound("Vesting schedule not found");
  return vestingTermsRowJson(ctx, row, state);
}

/** One vesting terms row as the API shows it (the confirmation answers with the row it leaves). */
export async function vestingTermsRowJson(ctx: ReadContext, row: TermsRow, state: engine.LedgerState): Promise<api.VestingTerms> {
  return api.vestingTermsSchema.parse((await vestingTermsJson(ctx, [row], state, new ActorLabels(ctx)))[0]);
}

/** The tranche generator for a definition, a quantity and a start date (the API contract): pure, nothing is written. */
export function previewVesting(ctx: ReadContext, body: api.VestingPreviewRequest): api.VestingPreviewResponse {
  let events: engine.VestingScheduleEvent[];
  try {
    events = engine.scheduleEvents(engine.parseVestingDefinition(body.definition), body.quantity, body.vestingStartDate, ctx.ledger.reference.shareUnit);
  } catch (error) {
    throw new ApiError("validation_failed", error instanceof Error ? error.message : "The schedule is invalid", [{ path: "definition", message: "Check the schedule" }]);
  }
  let cumulative = engine.Dec.ZERO;
  return api.vestingPreviewResponseSchema.parse({
    events: events.map((event) => {
      cumulative = cumulative.add(event.quantity);
      return { date: event.date, quantity: dec(event.quantity), cumulative: dec(cumulative), state: "ACTIVE", kind: event.kind, source: event.source };
    }),
    total: dec(cumulative),
  });
}
