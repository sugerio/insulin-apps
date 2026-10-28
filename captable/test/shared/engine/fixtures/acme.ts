import * as e from "../../../../src/app/shared/engine/index.ts";
import { LedgerBuilder, monthlyEvents, usd, uuid, type CommandBuilder } from "./builder.ts";

/**
 * The synthetic "Acme Robotics, Inc." dataset of the approved demo (analysis/demo-script.md §3; all names, ids and
 * numbers are fictional), as a migrated ledger: every migrated grant carries Pulley-style EXPLICIT vest events built
 * by an independent cumulative-floor oracle (`monthlyEvents`), not by the engine's generator. Stakeholders are labelled
 * S01–S40 as in the script; nothing here names a person.
 */

export const WINDOWS: e.TerminationWindow[] = [
  { reason: "VOLUNTARY_OTHER", period: 3, period_type: "MONTHS" },
  { reason: "INVOLUNTARY_OTHER", period: 3, period_type: "MONTHS" },
  { reason: "INVOLUNTARY_WITH_CAUSE", period: 0, period_type: "DAYS" },
  { reason: "INVOLUNTARY_DEATH", period: 12, period_type: "MONTHS" },
  { reason: "INVOLUNTARY_DISABILITY", period: 12, period_type: "MONTHS" },
  { reason: "VOLUNTARY_RETIREMENT", period: 3, period_type: "MONTHS" },
];

export const PLAN_RULES = {
  cancelled_unvested_awards: "RETURN",
  expired_vested_options: "RETURN",
  repurchased_unvested_shares: "RETURN",
  repurchased_vested_shares: "RETIRE",
  shares_withheld_for_tax: "RETIRE",
} as const;

const RELATIONSHIPS: [string, e.Relationship][] = [
  ...["S01", "S02", "S03"].map((s) => [s, "founder"] as [string, e.Relationship]),
  ...Array.from({ length: 16 }, (_, i) => [`S${String(i + 4).padStart(2, "0")}`, "employee"] as [string, e.Relationship]),
  ...Array.from({ length: 8 }, (_, i) => [`S${String(i + 20).padStart(2, "0")}`, "ex_employee"] as [string, e.Relationship]),
  ...["S28", "S29", "S30"].map((s) => [s, "advisor"] as [string, e.Relationship]),
  ...Array.from({ length: 9 }, (_, i) => [`S${String(i + 31).padStart(2, "0")}`, "investor"] as [string, e.Relationship]),
  ["S40", "other"],
];

export const VALUATIONS: e.ValuationRecord[] = [
  ["V1", "2023-02-10", "2024-02-10", "0.1"],
  ["V2", "2023-10-20", "2024-10-20", "0.18"],
  ["V3", "2024-07-01", "2025-07-01", "0.31"],
  ["V4", "2025-03-15", "2026-03-15", "0.44"],
  ["V5", "2025-11-05", "2026-11-05", "0.95"],
].map(([label, effectiveDate, expirationDate, price]) => ({
  id: uuid(label!),
  valuationType: "409A" as const,
  reportVersion: "FINAL" as const,
  effectiveDate: effectiveDate!,
  expirationDate: expirationDate!,
  prices: [{ stockClassId: uuid("class:CS"), pricePerShare: price! }],
  events: [],
}));

type Schedule = "VS-1" | "VS-2" | "VS-3" | "VS-5" | "VS-6";

/** Demo-script §3.9: id, holder, grant date, type, granted, strike, schedule, vesting start, execution, country. */
const OPTIONS: [string, string, string, "ISO" | "NSO", number, string, Schedule, string, e.ExecutionStatus?, string?][] = [
  ["OPT-1", "S04", "2023-04-14", "ISO", 300000, "0.1", "VS-1", "2023-03-01"],
  ["OPT-2", "S05", "2023-04-14", "ISO", 150000, "0.1", "VS-1", "2023-04-03"],
  ["OPT-3", "S20", "2023-04-14", "ISO", 120000, "0.1", "VS-1", "2023-04-03"],
  ["OPT-4", "S28", "2023-04-14", "NSO", 40000, "0.1", "VS-3", "2023-04-14"],
  ["OPT-5", "S25", "2023-04-14", "ISO", 80000, "0.1", "VS-1", "2023-04-17"],
  ["OPT-6", "S06", "2023-08-18", "ISO", 100000, "0.1", "VS-1", "2023-08-18"],
  ["OPT-7", "S07", "2023-08-18", "ISO", 100000, "0.1", "VS-1", "2023-08-18"],
  ["OPT-8", "S22", "2023-08-18", "ISO", 90000, "0.1", "VS-1", "2023-08-18"],
  ["OPT-9", "S29", "2023-08-18", "NSO", 50000, "0.1", "VS-3", "2023-08-18"],
  ["OPT-10", "S08", "2023-12-08", "ISO", 80000, "0.18", "VS-1", "2023-12-08"],
  ["OPT-11", "S09", "2023-12-08", "ISO", 200000, "0.18", "VS-1", "2023-12-08"],
  ["OPT-12", "S10", "2023-12-08", "ISO", 60000, "0.18", "VS-1", "2023-12-08"],
  ["OPT-13", "S11", "2024-03-15", "ISO", 60000, "0.18", "VS-1", "2024-03-15"],
  ["OPT-14", "S12", "2024-03-15", "ISO", 120000, "0.18", "VS-1", "2024-03-15"],
  ["OPT-15", "S23", "2024-03-15", "ISO", 96000, "0.18", "VS-1", "2024-03-01"],
  ["OPT-16", "S04", "2024-03-15", "ISO", 100000, "0.18", "VS-1", "2024-03-15"],
  ["OPT-17", "S24", "2024-08-15", "ISO", 72000, "0.31", "VS-1", "2024-08-15"],
  ["OPT-18", "S14", "2024-08-15", "ISO", 90000, "0.31", "VS-1", "2024-08-15"],
  ["OPT-19", "S15", "2024-08-15", "ISO", 40000, "0.31", "VS-1", "2024-08-15"],
  ["OPT-20", "S21", "2024-08-15", "ISO", 120000, "0.31", "VS-1", "2024-08-01"],
  ["OPT-21", "S16", "2024-12-13", "NSO", 70000, "0.31", "VS-1", "2024-12-13", undefined, "CA"],
  ["OPT-22", "S05", "2024-12-13", "ISO", 60000, "0.31", "VS-1", "2024-12-13"],
  ["OPT-23", "S26", "2024-12-13", "NSO", 48000, "0.31", "VS-1", "2024-12-13"],
  ["OPT-24", "S17", "2025-04-18", "ISO", 80000, "0.44", "VS-1", "2025-04-18"],
  ["OPT-25", "S18", "2025-04-18", "NSO", 60000, "0.44", "VS-1", "2025-04-18", undefined, "SE"],
  ["OPT-26", "S27", "2025-04-18", "NSO", 60000, "0.44", "VS-1", "2025-04-18"],
  ["OPT-27", "S30", "2025-04-18", "NSO", 30000, "0.44", "VS-5", "2025-04-18"],
  ["OPT-28", "S06", "2025-04-18", "ISO", 40000, "0.44", "VS-1", "2025-04-18"],
  ["OPT-29", "S19", "2025-07-18", "ISO", 70000, "0.44", "VS-1", "2025-07-18"],
  ["OPT-30", "S10", "2025-07-18", "ISO", 30000, "0.44", "VS-1", "2025-07-18"],
  ["OPT-31", "S12", "2025-07-18", "ISO", 50000, "0.44", "VS-6", "2025-07-18"],
  ["OPT-32", "S28", "2025-07-18", "NSO", 20000, "0.44", "VS-2", "2025-07-18"],
  ["OPT-33", "S13", "2025-11-20", "ISO", 400000, "0.95", "VS-1", "2025-11-17"],
  ["OPT-34", "S01", "2025-11-20", "NSO", 300000, "0.95", "VS-2", "2025-11-20"],
  ["OPT-35", "S02", "2025-11-20", "NSO", 250000, "0.95", "VS-2", "2025-11-20"],
  ["OPT-36", "S09", "2025-11-20", "ISO", 80000, "0.95", "VS-1", "2025-11-20"],
  ["OPT-37", "S04", "2025-11-20", "ISO", 120000, "0.95", "VS-1", "2025-11-20"],
  ["OPT-38", "S03", "2025-11-20", "NSO", 150000, "0.95", "VS-2", "2025-11-20"],
  ["OPT-39", "S05", "2026-02-20", "ISO", 50000, "0.95", "VS-1", "2026-02-20"],
  ["OPT-40", "S07", "2026-02-20", "ISO", 40000, "0.95", "VS-1", "2026-02-20"],
  ["OPT-41", "S08", "2026-02-20", "ISO", 30000, "0.95", "VS-1", "2026-02-20"],
  ["OPT-42", "S11", "2026-02-20", "ISO", 25000, "0.95", "VS-1", "2026-02-20"],
  ["OPT-43", "S14", "2026-02-20", "ISO", 35000, "0.95", "VS-1", "2026-02-20"],
  ["OPT-44", "S15", "2026-05-15", "ISO", 20000, "0.95", "VS-1", "2026-05-15"],
  ["OPT-45", "S16", "2026-05-15", "NSO", 30000, "0.95", "VS-1", "2026-05-15", undefined, "CA"],
  ["OPT-46", "S17", "2026-05-15", "ISO", 25000, "0.95", "VS-1", "2026-05-15"],
  ["OPT-47", "S29", "2026-05-15", "NSO", 30000, "0.95", "VS-1", "2026-05-15"],
  ["OPT-48", "S19", "2026-05-15", "ISO", 20000, "0.95", "VS-1", "2026-05-15"],
  ["OPT-49", "S18", "2026-09-04", "NSO", 20000, "0.95", "VS-1", "2026-09-04", "pending_both", "SE"],
  ["OPT-50", "S12", "2026-09-04", "ISO", 40000, "0.95", "VS-1", "2026-09-04", "pending_company"],
  ["OPT-51", "S06", "2026-09-04", "ISO", 30000, "0.95", "VS-1", "2026-09-04", "pending_company"],
  ["OPT-52", "S10", "2026-09-04", "ISO", 15000, "0.95", "VS-1", "2026-09-04"],
  ["OPT-53", "S07", "2026-09-04", "ISO", 20000, "0.95", "VS-1", "2026-09-04", "pending_company"],
  ["OPT-54", "S14", "2026-09-04", "ISO", 15000, "0.95", "VS-1", "2026-09-04"],
  ["OPT-55", "S11", "2026-09-04", "ISO", 10000, "0.95", "VS-1", "2026-09-04", "pending_company"],
  ["OPT-56", "S08", "2026-09-04", "ISO", 10000, "0.95", "VS-1", "2026-09-04", "pending_company"],
];

const EARLY = new Set(["OPT-17", "OPT-39", "OPT-40", "OPT-41"]);

/** Demo-script §3.10: id, holder, principal, issue date, converted into, conversion price, shares. */
const SAFES: [string, string, string, string, string, string, string][] = [
  ["SAFE-1", "S34", "250000", "2021-05-03", "PS-1", "0.48", "520833"],
  ["SAFE-2", "S36", "50000", "2021-05-10", "PS-2", "0.48", "104166"],
  ["SAFE-3", "S37", "25000", "2021-06-01", "PS-3", "0.48", "52083"],
  ["SAFE-4", "S35", "300000", "2022-04-12", "PS-4", "0.64", "468750"],
  ["SAFE-5", "S37", "25000", "2022-04-20", "PS-5", "0.64", "39062"],
  ["SAFE-6", "S31", "500000", "2022-07-01", "PS-6", "0.64", "781250"],
  ["SAFE-7", "S34", "150320", "2022-09-15", "PS-7", "0.64", "234875"],
  ["SAFE-8", "S33", "199680", "2022-11-30", "PS-8", "0.64", "312000"],
  ["SAFE-9", "S33", "750000", "2024-03-01", "PA2-1", "1.95", "384615"],
  ["SAFE-10", "S38", "100000", "2024-05-15", "PA2-2", "1.95", "51282"],
  ["SAFE-11", "S39", "1000000", "2024-11-20", "PA2-3", "1.95", "512820"],
  ["SAFE-12", "S35", "150000", "2025-02-10", "PA2-4", "1.95", "76923"],
];

export interface Acme {
  b: LedgerBuilder;
  id: (label: string) => string;
  cls: { CS: string; PS: string; PA1: string; PA2: string };
  plan: string;
}

function valuationFor(date: string): string {
  let id = VALUATIONS[0]!.id;
  for (const v of VALUATIONS) if (v.effectiveDate <= date) id = v.id;
  return id;
}

function scheduleEvents(schedule: Schedule, quantity: number, start: string, label: string): { date: string; quantity: string; pulleyId: string }[] {
  const total = BigInt(quantity);
  let events: { date: string; quantity: string }[];
  switch (schedule) {
    case "VS-1":
      events = monthlyEvents(total, start, 48, 12);
      break;
    case "VS-2":
      events = monthlyEvents(total, start, 48, 0);
      break;
    case "VS-3":
      events = monthlyEvents(total, start, 24, 0);
      break;
    case "VS-5":
      events = [{ date: start, quantity: total.toString() }];
      break;
    case "VS-6": {
      // Back-weighted 10/20/30/40 annual tranches, cumulative floor, the last absorbing the remainder.
      let previous = 0n;
      let percent = 0n;
      events = [10n, 20n, 30n, 40n].map((p, i) => {
        percent += p;
        const cumulative = i === 3 ? total : (total * percent) / 100n;
        const quantity = cumulative - previous;
        previous = cumulative;
        return { date: e.addMonths(start, 12 * (i + 1)), quantity: quantity.toString() };
      });
      break;
    }
  }
  return events.map((event, i) => ({ ...event, pulleyId: `pv-${label}-${i + 1}` }));
}

export function buildAcme(): Acme {
  const b = new LedgerBuilder();
  const id = (label: string) => uuid(label);
  for (const [label, relationship] of RELATIONSHIPS) {
    const extra: Partial<e.StakeholderRef> = label === "S16" ? { countryOfResidence: "CA" } : label === "S18" ? { countryOfResidence: "SE" } : { countryOfResidence: "US" };
    b.stakeholder(label, relationship, extra);
  }
  const cls = {
    CS: b.stockClass("class:CS", "COMMON", "Common Stock"),
    PS: b.stockClass("class:PS", "PREFERRED", "Series Seed Preferred"),
    PA1: b.stockClass("class:PA1", "PREFERRED", "Series A-1 Preferred"),
    PA2: b.stockClass("class:PA2", "PREFERRED", "Series A-2 Preferred"),
  };
  const plan = b.plan("plan:P1", cls.CS, "2023 Equity Incentive Plan");

  b.command("incorporation", (c) => {
    c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2021-02-15", { stock_class_id: cls.CS, new_shares_authorized: "20000000" });
  });
  b.command("founders", (c) => {
    for (const [label, holder, quantity] of [
      ["CS-1", "S01", 4000000],
      ["CS-2", "S02", 3500000],
      ["CS-3", "S03", 2000000],
    ] as const) {
      const lot = c.security(label, { family: "STOCK", subtype: "COMMON", stakeholderId: id(holder), stockClassId: cls.CS, stockPlanId: null, parentSecurityId: null });
      const vt = b.vestingTerms(`vt:${label}`, { type: "EXPLICIT", events: scheduleEvents("VS-1", quantity, "2021-02-15", label) });
      c.tx("TX_STOCK_ISSUANCE", "2021-02-15", {
        security_id: lot,
        custom_id: label,
        stakeholder_id: id(holder),
        stock_class_id: cls.CS,
        share_price: usd("0.0001"),
        quantity: String(quantity),
        issuance_type: "FOUNDERS_STOCK",
        vesting_terms_id: vt.id,
        x_definition_sha256: vt.sha,
        x_origin: "FOUNDERS_STOCK",
      });
      c.tx("TX_VESTING_START", "2021-02-15", { security_id: lot, x_vesting_start_date: "2021-02-15" });
    }
  });
  for (const [label, holder, principal, date] of SAFES) {
    b.command(`safe:${label}`, (c) => {
      const safe = c.security(label, { family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: id(holder), stockClassId: null, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_CONVERTIBLE_ISSUANCE", date, {
        security_id: safe,
        custom_id: label,
        stakeholder_id: id(holder),
        investment_amount: usd(principal),
        convertible_type: "SAFE",
        x_funds_received_on: date,
      });
    });
  }
  b.command("plan:adopt", (c) => {
    c.tx("X_STOCK_PLAN_TERMS", "2023-01-20", {
      stock_plan_id: plan,
      return_rules: PLAN_RULES,
      default_termination_windows: WINDOWS,
      default_repurchase_window: { period: 90, period_type: "DAYS" },
      status: "active",
      pour_over_plan_id: null,
    });
    c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2023-01-20", { stock_plan_id: plan, shares_reserved: "2000000", board_approval_date: "2023-01-20", stockholder_approval_date: "2023-01-25" });
  });
  b.command("seed:classes", (c) => {
    c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2023-03-28", { stock_class_id: cls.PS, new_shares_authorized: "5200000" });
    c.tx("TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", "2023-03-28", {
      stock_class_id: cls.PS,
      new_ratio_conversion_mechanism: { type: "RATIO_CONVERSION", ratio: { numerator: "1", denominator: "1" } },
    });
  });
  const convert = (safeLabel: string, holder: string, lotLabel: string, classId: string, date: string, price: string, shares: string) => {
    b.command(`conversion:${safeLabel}`, (c) => {
      const lot = c.security(lotLabel, { family: "STOCK", subtype: "PREFERRED", stakeholderId: id(holder), stockClassId: classId, stockPlanId: null, parentSecurityId: id(safeLabel) });
      c.tx("TX_CONVERTIBLE_CONVERSION", date, { security_id: id(safeLabel), resulting_security_ids: [lot], reason_text: "Equity financing", x_conversion_price: usd(price) });
      c.tx("TX_STOCK_ISSUANCE", date, {
        security_id: lot,
        custom_id: lotLabel,
        stakeholder_id: id(holder),
        stock_class_id: classId,
        share_price: usd(price),
        quantity: shares,
        x_origin: "CONVERSION",
        x_source_security_id: id(safeLabel),
      });
    });
  };
  const purchase = (c: CommandBuilder, lotLabel: string, holder: string, classId: string, date: string, price: string, quantity: string) => {
    const lot = c.security(lotLabel, { family: "STOCK", subtype: "PREFERRED", stakeholderId: id(holder), stockClassId: classId, stockPlanId: null, parentSecurityId: null });
    c.tx("TX_STOCK_ISSUANCE", date, {
      security_id: lot,
      custom_id: lotLabel,
      stakeholder_id: id(holder),
      stock_class_id: classId,
      share_price: usd(price),
      quantity,
      x_origin: "PURCHASE",
    });
  };
  for (const [safe, holder, , , lot, price, shares] of SAFES.slice(0, 8)) convert(safe, holder, lot, cls.PS, "2023-03-31", price, shares);
  b.command("seed:purchase", (c) => {
    purchase(c, "PS-9", "S31", cls.PS, "2023-03-31", "0.8", "2500000");
    purchase(c, "PS-10", "S38", cls.PS, "2023-03-31", "0.8", "125000");
  });

  const grant = ([label, holder, date, type, quantity, strike, schedule, start, execution, country]: (typeof OPTIONS)[number]) => {
    b.command(`grant:${label}`, (c) => {
      const lot = c.security(label, {
        family: "EQUITY_COMPENSATION",
        subtype: type === "ISO" ? "OPTION_ISO" : "OPTION_NSO",
        stakeholderId: id(holder),
        stockClassId: cls.CS,
        stockPlanId: plan,
        parentSecurityId: null,
      });
      const vt = b.vestingTerms(`vt:${label}`, { type: "EXPLICIT", events: scheduleEvents(schedule, quantity, start, label) });
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", date, {
        security_id: lot,
        custom_id: label,
        stakeholder_id: id(holder),
        stock_plan_id: plan,
        stock_class_id: cls.CS,
        compensation_type: type === "ISO" ? "OPTION_ISO" : "OPTION_NSO",
        quantity: String(quantity),
        exercise_price: usd(strike),
        early_exercisable: EARLY.has(label),
        vesting_terms_id: vt.id,
        expiration_date: e.addYears(date, 10),
        termination_exercise_windows: WINDOWS,
        board_approval_date: date,
        x_definition_sha256: vt.sha,
        x_fmv: { price_per_share: usd(strike), valuation_id: valuationFor(date), source: "IMPORTED" },
        x_exemption: country ? { federal: "NON_US", country } : { federal: "RULE_701" },
      });
      c.tx("TX_VESTING_START", date, { security_id: lot, x_vesting_start_date: start });
      if (execution) c.tx("X_EXECUTION_STATUS", date, { security_id: lot, status: execution });
    });
  };
  const exercise = (option: string, holder: string, lotLabel: string, date: string, quantity: string, portion: "ISO" | "NSO", strike: string, fmv: string, extra: { early?: boolean; source?: e.TransactionSource } = {}) => {
    b.command(
      `exercise:${option}`,
      (c) => {
        const lot = c.security(lotLabel, { family: "STOCK", subtype: "COMMON", stakeholderId: id(holder), stockClassId: cls.CS, stockPlanId: plan, parentSecurityId: id(option) });
        c.tx("TX_EQUITY_COMPENSATION_EXERCISE", date, {
          security_id: id(option),
          quantity,
          resulting_security_ids: [lot],
          x_exercise_price: usd(strike),
          x_exercise_cost: usd(e.Dec.from(quantity).mul(strike).toString()),
          x_fmv: { price_per_share: usd(fmv), valuation_id: valuationFor(date), source: "IMPORTED" },
          x_portions: [{ portion, quantity, security_id: lot }],
          x_lots_consumed: portion === "ISO" ? { iso: quantity, nso: "0" } : { iso: "0", nso: quantity },
          ...(extra.early ? { x_early_exercise: true } : {}),
        });
        const restricted =
          extra.early === true
            ? (() => {
                const vt = b.vestingTerms(`vt:${lotLabel}`, { type: "EXPLICIT", events: scheduleEvents("VS-1", Number(quantity), "2024-08-15", lotLabel) });
                return {
                  vesting_terms_id: vt.id,
                  x_definition_sha256: vt.sha,
                  x_repurchase_right: { price_per_share: usd(strike), window: { period: 90, period_type: "DAYS" as const } },
                };
              })()
            : {};
        c.tx("TX_STOCK_ISSUANCE", date, {
          security_id: lot,
          custom_id: lotLabel,
          stakeholder_id: id(holder),
          stock_class_id: cls.CS,
          stock_plan_id: plan,
          share_price: usd(strike),
          quantity,
          x_origin: "EXERCISE",
          x_source_security_id: id(option),
          x_portion: portion,
          ...restricted,
        });
        if (extra.early) c.tx("TX_VESTING_START", date, { security_id: lot, x_vesting_start_date: "2024-08-15" });
      },
      { source: extra.source ?? "import" },
    );
  };
  const terminate = (
    holder: string,
    date: string,
    type: e.TerminationType,
    cancels: [string, string][],
    extra: { accelerations?: [string, string][]; extension?: [string, string]; source?: e.TransactionSource } = {},
  ) => {
    b.command(
      `terminate:${holder}`,
      (c) => {
        c.tx("X_STAKEHOLDER_TERMINATION", date, {
          stakeholder_id: id(holder),
          termination_date: date,
          termination_type: type,
          vesting_stop_date: date,
          relationship_before: "employee",
          relationship_after: "ex_employee",
        });
        for (const [option, quantity] of extra.accelerations ?? []) {
          c.tx("TX_VESTING_ACCELERATION", date, { security_id: id(option), quantity, reason_text: "Termination: three tranches accelerated" });
        }
        for (const [option, quantity] of cancels) {
          c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", date, { security_id: id(option), quantity, reason_text: "Termination", x_reason: "TERMINATION" });
        }
        if (extra.extension) {
          c.tx("X_SECURITY_MODIFICATION", date, {
            kind: "CONTRACTUAL_DEADLINE_EXTENSION",
            security_id: id(extra.extension[0]),
            new_contractual_deadline: extra.extension[1],
          });
        }
      },
      { source: extra.source ?? "import", type: "terminate-stakeholder" },
    );
  };
  const expire = (option: string, date: string, quantity: string) => {
    b.command(`expire:${option}`, (c) => {
      c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", date, { security_id: id(option), quantity, reason_text: "Expired after the exercise window", x_reason: "EXPIRED" });
    });
  };

  // History in effective order (the replay sorts anyway; same-day order follows these calls).
  for (const option of OPTIONS.filter((o) => o[2] < "2023-12-31")) grant(option);
  terminate("S25", "2023-12-31", "voluntary", [["OPT-5", "80000"]]);
  for (const option of OPTIONS.filter((o) => o[2] >= "2023-12-31" && o[2] <= "2024-03-15")) grant(option);
  b.command("plan:amendment-1", (c) => {
    c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2024-06-12", { stock_plan_id: plan, shares_reserved: "3000000", board_approval_date: "2024-06-12", stockholder_approval_date: "2024-06-14" });
  });
  for (const option of OPTIONS.filter((o) => o[2] === "2024-08-15")) grant(option);
  exercise("OPT-17", "S24", "CS-4", "2024-09-01", "72000", "ISO", "0.31", "0.31", { early: true });
  terminate("S22", "2024-10-31", "voluntary", [["OPT-8", "63750"]]);
  for (const option of OPTIONS.filter((o) => o[2] === "2024-12-13")) grant(option);
  expire("OPT-8", "2025-02-01", "26250");
  b.command("warrant:WAR-1", (c) => {
    const war = c.security("WAR-1", { family: "WARRANT", subtype: "WARRANT", stakeholderId: id("S40"), stockClassId: cls.CS, stockPlanId: null, parentSecurityId: null });
    c.tx("TX_WARRANT_ISSUANCE", "2025-04-01", {
      security_id: war,
      custom_id: "WAR-1",
      stakeholder_id: id("S40"),
      quantity: "60000",
      exercise_price: usd("0.44"),
      purchase_price: usd("0"),
      warrant_expiration_date: "2035-04-01",
      x_exercise_provisions: "Cash or net exercise",
    });
  });
  for (const option of OPTIONS.filter((o) => o[2] === "2025-04-18" || o[2] === "2025-07-18")) grant(option);
  terminate("S20", "2025-06-30", "voluntary", [["OPT-3", "47500"]], { accelerations: [["OPT-3", "7500"]] });
  exercise("OPT-3", "S20", "CS-5", "2025-08-20", "60000", "ISO", "0.1", "0.44");
  b.command("series-a:classes", (c) => {
    c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2025-09-26", { stock_class_id: cls.CS, new_shares_authorized: "30000000" });
    for (const [classId, authorized] of [
      [cls.PA1, "4200000"],
      [cls.PA2, "1050000"],
    ] as const) {
      c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2025-09-26", { stock_class_id: classId, new_shares_authorized: authorized });
      c.tx("TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", "2025-09-26", {
        stock_class_id: classId,
        new_ratio_conversion_mechanism: { type: "RATIO_CONVERSION", ratio: { numerator: "1", denominator: "1" } },
      });
    }
  });
  b.command("series-a:purchase", (c) => {
    purchase(c, "PA1-1", "S32", cls.PA1, "2025-09-30", "2.6", "3076923");
    purchase(c, "PA1-2", "S31", cls.PA1, "2025-09-30", "2.6", "576923");
    purchase(c, "PA1-3", "S33", cls.PA1, "2025-09-30", "2.6", "384615");
  });
  for (const [safe, holder, , , lot, price, shares] of SAFES.slice(8)) convert(safe, holder, lot, cls.PA2, "2025-09-30", price, shares);
  expire("OPT-3", "2025-10-01", "12500");
  b.command("plan:amendment-2", (c) => {
    c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2025-10-15", { stock_plan_id: plan, shares_reserved: "4500000", board_approval_date: "2025-10-15", stockholder_approval_date: "2025-10-17" });
  });
  b.command("warrant:WAR-2", (c) => {
    const war = c.security("WAR-2", { family: "WARRANT", subtype: "WARRANT", stakeholderId: id("S33"), stockClassId: cls.PA1, stockPlanId: null, parentSecurityId: null });
    c.tx("TX_WARRANT_ISSUANCE", "2025-10-15", {
      security_id: war,
      custom_id: "WAR-2",
      stakeholder_id: id("S33"),
      quantity: "50000",
      exercise_price: usd("2.6"),
      purchase_price: usd("0"),
      warrant_expiration_date: "2032-10-15",
      x_exercise_provisions: "Cash only",
    });
  });
  for (const option of OPTIONS.filter((o) => o[2] === "2025-11-20")) grant(option);
  terminate("S23", "2025-12-31", "voluntary", [["OPT-15", "54000"]]);
  for (const option of OPTIONS.filter((o) => o[2] === "2026-02-20")) grant(option);
  exercise("OPT-15", "S23", "CS-6", "2026-02-10", "42000", "ISO", "0.18", "0.95");
  exercise("OPT-1", "S04", "CS-7", "2026-03-20", "50000", "ISO", "0.1", "0.95");
  for (const option of OPTIONS.filter((o) => o[2] === "2026-05-15")) grant(option);
  terminate("S26", "2026-07-31", "voluntary", [["OPT-23", "29000"]]);
  exercise("OPT-23", "S26", "CS-8", "2026-08-12", "19000", "NSO", "0.31", "0.95");
  terminate("S21", "2026-08-31", "involuntary", [["OPT-20", "60000"]], { extension: ["OPT-20", "2027-02-28"] });
  for (const option of OPTIONS.filter((o) => o[2] === "2026-09-04")) grant(option);
  terminate("S24", "2026-09-15", "voluntary", []);
  terminate("S27", "2026-10-01", "voluntary", [["OPT-26", "38750"]], { source: "app" });
  return { b, id, cls, plan };
}

// ---------------------------------------------------------------------------
// The complete synthetic lifecycle: grant, exercise, termination, cancellation and conversion commands.

export function p4MarkExecuted(acme: Acme): string {
  return acme.b.command(
    "mark-executed:OPT-50",
    (c) => {
      c.tx("X_EXECUTION_STATUS", "2026-10-20", {
        security_id: acme.id("OPT-50"),
        status: "executed",
        signature_dates: { company: "2026-10-20" },
        attestation: "This PDF bears both signatures",
        document: { id: uuid("doc:OPT-50-signed"), sha256: e.sha256Hex("OPT-50 signed agreement") },
      });
    },
    { source: "app", type: "mark-executed" },
  );
}

export const VS_1: e.VestingDefinition = { type: "SCHEDULE", totalMonths: 48, frequency: "MONTHLY", cliff: { months: 12, quantityRule: "RATABLE" }, dayRule: "SAME_DAY_CLAMPED" };

export function p5GrantNewHire(acme: Acme): string {
  const { b, id, cls, plan } = acme;
  b.stakeholder("S41", "employee", { countryOfResidence: "US" });
  // A new grant references the SCHEDULE template itself; the engine's generator expands it.
  const created = b.vestingTerms("vt:VS-1", VS_1);
  const template = { id: created.id, definitionSha256: created.sha };
  return b.command(
    "grant:OPT-57",
    (c) => {
      const lot = c.security("OPT-57", { family: "EQUITY_COMPENSATION", subtype: "OPTION_ISO", stakeholderId: id("S41"), stockClassId: cls.CS, stockPlanId: plan, parentSecurityId: null });
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", "2026-10-20", {
        security_id: lot,
        custom_id: "OPT-57",
        stakeholder_id: id("S41"),
        stock_plan_id: plan,
        stock_class_id: cls.CS,
        compensation_type: "OPTION_ISO",
        quantity: "40000",
        exercise_price: usd("0.95"),
        early_exercisable: false,
        vesting_terms_id: template.id,
        expiration_date: "2036-10-20",
        termination_exercise_windows: WINDOWS,
        board_approval_date: "2026-10-20",
        x_definition_sha256: template.definitionSha256,
        x_fmv: { price_per_share: usd("0.95"), valuation_id: uuid("V5"), source: "VALUATION" },
        x_iso_attestations: { employee_at_grant: true, ten_percent_holder: false },
        x_exemption: { federal: "RULE_701" },
      });
      c.tx("TX_VESTING_START", "2026-10-20", { security_id: lot, x_vesting_start_date: "2026-10-19" });
    },
    { source: "app", type: "grant-equity-compensation" },
  );
}

export function p6TerminateEmployee(acme: Acme): string {
  const { b, id } = acme;
  return b.command(
    "terminate:S10",
    (c) => {
      c.tx("X_STAKEHOLDER_TERMINATION", "2026-10-21", {
        stakeholder_id: id("S10"),
        termination_date: "2026-10-21",
        termination_type: "voluntary",
        vesting_stop_date: "2026-10-21",
        relationship_before: "employee",
        relationship_after: "ex_employee",
      });
      for (const [option, quantity] of [
        ["OPT-12", "17500"],
        ["OPT-30", "20625"],
        ["OPT-52", "15000"],
      ] as const) {
        c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", "2026-10-21", { security_id: id(option), quantity, reason_text: "Termination", x_reason: "TERMINATION" });
      }
    },
    { source: "app", type: "terminate-stakeholder" },
  );
}

export function recordExercise(acme: Acme, label: string, option: string, holder: string, lotLabel: string, quantity: string, portion: "ISO" | "NSO", strike: string, date = "2026-10-20"): string {
  const { b, id, cls, plan } = acme;
  return b.command(
    label,
    (c) => {
      const lot = c.security(lotLabel, { family: "STOCK", subtype: "COMMON", stakeholderId: id(holder), stockClassId: cls.CS, stockPlanId: plan, parentSecurityId: id(option) });
      c.tx("TX_EQUITY_COMPENSATION_EXERCISE", date, {
        security_id: id(option),
        quantity,
        resulting_security_ids: [lot],
        x_exercise_price: usd(strike),
        x_exercise_cost: usd(e.Dec.from(quantity).mul(strike).toString()),
        x_fmv: { price_per_share: usd("0.95"), valuation_id: uuid("V5"), source: "VALUATION" },
        x_portions: [{ portion, quantity, security_id: lot }],
        x_lots_consumed: portion === "ISO" ? { iso: quantity, nso: "0" } : { iso: "0", nso: quantity },
        x_payment: { amount: usd(e.Dec.from(quantity).mul(strike).toString()), received_on: date, method: "ACH", reference: `EX-${option}`, payer_is_holder: true },
        x_tax: { treatment: portion === "ISO" ? "W2" : "FORM_1099_NEC" },
      });
      c.tx("TX_STOCK_ISSUANCE", date, {
        security_id: lot,
        custom_id: lotLabel,
        stakeholder_id: id(holder),
        stock_class_id: cls.CS,
        stock_plan_id: plan,
        share_price: usd(strike),
        quantity,
        x_origin: "EXERCISE",
        x_source_security_id: id(option),
        x_portion: portion,
      });
    },
    { source: "app", type: "exercise-option" },
  );
}

export function p8ExerciseFormerEmployee(acme: Acme): string {
  return recordExercise(acme, "exercise:P8", "OPT-20", "S21", "CS-9", "30000", "ISO", "0.31");
}

export function p9ExerciseAdvisor(acme: Acme): string {
  return recordExercise(acme, "exercise:P9", "OPT-9", "S29", "CS-10", "10000", "NSO", "0.1");
}

export function p10CancelThenReverse(acme: Acme): { cancel: string; reversal: string } {
  const cancel = acme.b.command(
    "cancel:OPT-56",
    (c) => {
      c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", "2026-10-21", {
        security_id: acme.id("OPT-56"),
        quantity: "10000",
        reason_text: "Holder declined to sign",
        x_reason: "NOT_EXECUTED",
      });
    },
    { source: "app", type: "cancel-security" },
  );
  const reversal = acme.b.reverse(cancel, "2026-10-21");
  return { cancel, reversal };
}

/** The complete synthetic lifecycle on top of the start state. */
export function runRecommendedR1(acme: Acme): void {
  p4MarkExecuted(acme);
  p5GrantNewHire(acme);
  p6TerminateEmployee(acme);
  p8ExerciseFormerEmployee(acme);
  p9ExerciseAdvisor(acme);
  p10CancelThenReverse(acme);
}
