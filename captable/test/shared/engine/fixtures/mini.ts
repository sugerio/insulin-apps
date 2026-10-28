import * as e from "../../../../src/app/shared/engine/index.ts";
import { LedgerBuilder, monthlyEvents, usd, type CommandBuilder } from "./builder.ts";
import { PLAN_RULES, WINDOWS } from "./acme.ts";

/** A tiny synthetic org for focused replay tests: common and preferred classes, one plan, three holders. */
export interface Mini {
  b: LedgerBuilder;
  common: string;
  preferred: string;
  plan: string;
  alice: string;
  bob: string;
  carol: string;
}

export function miniOrg(options: { shareUnit?: string; planTerms?: boolean; pool?: string; rules?: Partial<Record<keyof typeof PLAN_RULES, "RETURN" | "RETIRE">> } = {}): Mini {
  const b = new LedgerBuilder({ orgId: "00000000-0000-7000-8000-00000000a11c", shareUnit: options.shareUnit ?? "1" });
  const common = b.stockClass("mini:CS", "COMMON", "Common");
  const preferred = b.stockClass("mini:PS", "PREFERRED", "Preferred");
  const plan = b.plan("mini:P", common, "Plan");
  const alice = b.stakeholder("mini:alice", "employee");
  const bob = b.stakeholder("mini:bob", "investor");
  const carol = b.stakeholder("mini:carol", "employee");
  b.command("mini:setup", (c) => {
    c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2024-01-01", { stock_class_id: common, new_shares_authorized: "1000000" });
    c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2024-01-01", { stock_class_id: preferred, new_shares_authorized: "500000" });
    c.tx("TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", "2024-01-01", {
      stock_class_id: preferred,
      new_ratio_conversion_mechanism: { type: "RATIO_CONVERSION", ratio: { numerator: "1", denominator: "1" } },
    });
    if (options.planTerms !== false) {
      c.tx("X_STOCK_PLAN_TERMS", "2024-01-01", {
        stock_plan_id: plan,
        return_rules: { ...PLAN_RULES, ...options.rules },
        default_termination_windows: WINDOWS,
        default_repurchase_window: { period: 90, period_type: "DAYS" },
        status: "active",
        pour_over_plan_id: null,
      });
    }
    c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2024-01-01", { stock_plan_id: plan, shares_reserved: options.pool ?? "100000" });
  });
  return { b, common, preferred, plan, alice, bob, carol };
}

export interface StockOptions {
  classId?: string;
  planId?: string | null;
  origin?: e.IssuanceOrigin;
  source?: string;
  price?: string;
  vestingMonths?: { start: string; months: number; cliff: number };
  parent?: string | null;
  txSource?: e.TransactionSource;
}

/** Adds a stock issuance to a command; returns the lot id. */
export function addStock(m: Mini, c: CommandBuilder, label: string, holder: string, quantity: string, date: string, options: StockOptions = {}): string {
  const classId = options.classId ?? m.common;
  const lot = c.security(label, {
    family: "STOCK",
    subtype: classId === m.preferred ? "PREFERRED" : "COMMON",
    stakeholderId: holder,
    stockClassId: classId,
    stockPlanId: options.planId ?? null,
    parentSecurityId: options.parent ?? options.source ?? null,
  });
  const vesting = options.vestingMonths
    ? (() => {
        const vt = m.b.vestingTerms(`vt:${label}`, { type: "EXPLICIT", events: monthlyEvents(BigInt(quantity), options.vestingMonths.start, options.vestingMonths.months, options.vestingMonths.cliff) });
        return { vesting_terms_id: vt.id, x_definition_sha256: vt.sha };
      })()
    : {};
  c.tx("TX_STOCK_ISSUANCE", date, {
    security_id: lot,
    custom_id: label,
    stakeholder_id: holder,
    stock_class_id: classId,
    ...(options.planId ? { stock_plan_id: options.planId } : {}),
    share_price: usd(options.price ?? "1"),
    quantity,
    x_origin: options.origin ?? "PURCHASE",
    ...(options.source ? { x_source_security_id: options.source } : {}),
    ...vesting,
  });
  return lot;
}

export function issueStock(m: Mini, label: string, holder: string, quantity: string, date: string, options: StockOptions = {}): string {
  let lot = "";
  m.b.command(`issue:${label}`, (c) => {
    lot = addStock(m, c, label, holder, quantity, date, options);
  }, { source: options.txSource ?? "import" });
  return lot;
}

export interface GrantOptions {
  type?: "OPTION_ISO" | "OPTION_NSO" | "RSU";
  price?: string;
  /** Monthly vesting from `start` (default: the grant date) over `months` with a `cliff`; `null` = vested at grant. */
  vesting?: { start?: string; months: number; cliff: number } | null;
  early?: boolean;
  expiration?: string | null;
  windows?: e.TerminationWindow[];
  execution?: e.ExecutionStatus;
  planId?: string | null;
  /** FMV at grant (default: the price); null leaves it out. */
  fmv?: string | null;
  source?: e.TransactionSource;
  exemption?: e.Exemption;
}

export function grant(m: Mini, label: string, holder: string, quantity: string, date: string, options: GrantOptions = {}): string {
  let lot = "";
  const type = options.type ?? "OPTION_ISO";
  const planId = options.planId === undefined ? m.plan : options.planId;
  m.b.command(
    `grant:${label}`,
    (c) => {
      lot = c.security(label, {
        family: "EQUITY_COMPENSATION",
        subtype: type,
        stakeholderId: holder,
        stockClassId: m.common,
        stockPlanId: planId,
        parentSecurityId: null,
      });
      const vesting = options.vesting === null ? null : (options.vesting ?? { months: 48, cliff: 12 });
      const terms = vesting
        ? m.b.vestingTerms(`vt:${label}`, { type: "EXPLICIT", events: monthlyEvents(BigInt(quantity), vesting.start ?? date, vesting.months, vesting.cliff) })
        : null;
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", date, {
        security_id: lot,
        custom_id: label,
        stakeholder_id: holder,
        ...(planId ? { stock_plan_id: planId } : {}),
        stock_class_id: m.common,
        compensation_type: type,
        quantity,
        ...(type === "RSU" ? {} : { exercise_price: usd(options.price ?? "1") }),
        early_exercisable: options.early === true,
        ...(terms ? { vesting_terms_id: terms.id, x_definition_sha256: terms.sha } : {}),
        expiration_date: options.expiration === undefined ? e.addYears(date, 10) : options.expiration,
        termination_exercise_windows: options.windows ?? WINDOWS,
        ...(options.fmv === null ? {} : { x_fmv: { price_per_share: usd(options.fmv ?? options.price ?? "1"), valuation_id: null, source: "IMPORTED" } }),
        ...(options.exemption ? { x_exemption: options.exemption } : {}),
      });
      if (vesting) c.tx("TX_VESTING_START", date, { security_id: lot, x_vesting_start_date: vesting.start ?? date });
      if (options.execution) c.tx("X_EXECUTION_STATUS", date, { security_id: lot, status: options.execution });
    },
    { source: options.source ?? "import" },
  );
  return lot;
}

export function exercise(
  m: Mini,
  label: string,
  option: string,
  holder: string,
  quantity: string,
  date: string,
  options: {
    portion?: "ISO" | "NSO";
    lots?: { iso: string; nso: string };
    /** Why the shares of an ISO grant are NSO (an NSO portion of an ISO grant needs one). */
    reason?: "AFTER_ISO_DEADLINE" | "ISO_LIMIT" | "LOT_CHOICE";
    lotReason?: string;
    early?: boolean;
    source?: e.TransactionSource;
    withheld?: string;
    price?: string;
  } = {},
): { command: string; lot: string } {
  let lot = "";
  const resulting = options.withheld ? e.Dec.from(quantity).sub(options.withheld).toString() : quantity;
  const portion = options.portion ?? "ISO";
  // Lots follow the portion unless a test states them: ISO shares come from ISO lots, NSO shares from NSO lots.
  const lots = options.lots ?? (portion === "ISO" ? { iso: quantity, nso: "0" } : { iso: "0", nso: quantity });
  const command = m.b.command(
    `exercise:${label}`,
    (c) => {
      lot = c.security(label, { family: "STOCK", subtype: "COMMON", stakeholderId: holder, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: option });
      c.tx("TX_EQUITY_COMPENSATION_EXERCISE", date, {
        security_id: option,
        quantity,
        resulting_security_ids: [lot],
        x_portions: [{ portion, quantity: resulting, security_id: lot, ...(options.reason ? { reason: options.reason } : {}) }],
        x_lots_consumed: lots,
        ...(options.lotReason ? { x_lot_reason: options.lotReason } : {}),
        ...(options.early ? { x_early_exercise: true } : {}),
        ...(options.withheld ? { x_withheld_quantity: options.withheld } : {}),
        x_fmv: { price_per_share: usd("2"), valuation_id: null, source: "MANUAL", source_note: "Board determination" },
      });
      c.tx("TX_STOCK_ISSUANCE", date, {
        security_id: lot,
        custom_id: label,
        stakeholder_id: holder,
        stock_class_id: m.common,
        stock_plan_id: m.plan,
        share_price: usd(options.price ?? "1"),
        quantity: resulting,
        x_origin: "EXERCISE",
        x_source_security_id: option,
        x_portion: portion,
      });
    },
    { source: options.source ?? "app" },
  );
  return { command, lot };
}

export function cancel(m: Mini, label: string, security: string, quantity: string, date: string, reason: e.CancellationReason = "HOLDER_WAIVER", extra: Record<string, unknown> = {}): string {
  return m.b.command(
    `cancel:${label}`,
    (c) => {
      c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", date, { security_id: security, quantity, reason_text: reason, x_reason: reason, ...extra });
    },
    { source: "app" },
  );
}

export function terminate(
  m: Mini,
  label: string,
  holder: string,
  date: string,
  options: { type?: e.TerminationType; stop?: string; cancels?: [string, string][]; attestation?: boolean; source?: e.TransactionSource; extra?: Record<string, unknown> } = {},
): string {
  return m.b.command(
    `terminate:${label}`,
    (c) => {
      c.tx("X_STAKEHOLDER_TERMINATION", date, {
        stakeholder_id: holder,
        termination_date: date,
        termination_type: options.type ?? "voluntary",
        vesting_stop_date: options.stop ?? date,
        relationship_before: "employee",
        relationship_after: "ex_employee",
        ...(options.attestation !== undefined ? { disability_attestation: options.attestation } : {}),
        ...options.extra,
      });
      for (const [security, quantity] of options.cancels ?? []) {
        c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", options.stop ?? date, { security_id: security, quantity, reason_text: "Termination", x_reason: "TERMINATION" });
      }
    },
    { source: options.source ?? "app", type: "terminate-stakeholder" },
  );
}

export function codes(state: e.LedgerState, severity?: e.ViolationSeverity): string[] {
  return state.violations.filter((v) => severity === undefined || v.severity === severity).map((v) => v.code);
}
