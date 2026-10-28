import type { TransactionTypeCode } from "../../../../src/app/shared/engine/index.ts";
import { uuid } from "./builder.ts";

/** A minimal valid version-1 payload for every transaction type (synthetic ids). */
const S = uuid("sample:security");
const R = uuid("sample:resulting");
const B = uuid("sample:balance");
const H = uuid("sample:holder");
const C = uuid("sample:class");
const P = uuid("sample:plan");
const T = uuid("sample:tx");
const ORG = uuid("org:acme");
const money = (amount: string) => ({ amount, currency: "USD" });

export const SAMPLE_PAYLOADS: Record<TransactionTypeCode, Record<string, unknown>> = {
  TX_STOCK_ISSUANCE: { security_id: S, custom_id: "CS-1", stakeholder_id: H, stock_class_id: C, share_price: money("0.0001"), quantity: "100", x_origin: "PURCHASE" },
  TX_STOCK_TRANSFER: { security_id: S, quantity: "10", resulting_security_ids: [R], balance_security_id: B, x_reason: "SECONDARY_SALE" },
  TX_STOCK_CANCELLATION: { security_id: S, quantity: "10", reason_text: "Recorded in error at issuance" },
  TX_STOCK_REPURCHASE: { security_id: S, quantity: "10", price: money("0.31"), x_kind: "UNVESTED" },
  TX_STOCK_CONVERSION: { security_id: S, quantity_converted: "10", resulting_security_ids: [R] },
  TX_STOCK_REISSUANCE: { security_id: S, resulting_security_ids: [R], reason_text: "Lost certificate" },
  TX_STOCK_RETRACTION: { security_id: S, reason_text: "Never issued" },
  TX_STOCK_ACCEPTANCE: { security_id: S },
  TX_EQUITY_COMPENSATION_ISSUANCE: {
    security_id: S,
    custom_id: "OPT-1",
    stakeholder_id: H,
    stock_plan_id: P,
    compensation_type: "OPTION_ISO",
    quantity: "1000",
    exercise_price: money("0.95"),
    expiration_date: "2036-10-20",
    termination_exercise_windows: [{ reason: "VOLUNTARY_OTHER", period: 3, period_type: "MONTHS" }],
  },
  TX_EQUITY_COMPENSATION_EXERCISE: {
    security_id: S,
    quantity: "10",
    resulting_security_ids: [R],
    x_portions: [{ portion: "ISO", quantity: "10", security_id: R }],
    x_lots_consumed: { iso: "10", nso: "0" },
  },
  TX_EQUITY_COMPENSATION_CANCELLATION: { security_id: S, quantity: "10", reason_text: "Termination", x_reason: "TERMINATION" },
  TX_EQUITY_COMPENSATION_RELEASE: { security_id: S, quantity: "10", settlement_date: "2026-10-20", release_price: money("0.95"), resulting_security_ids: [R] },
  TX_EQUITY_COMPENSATION_TRANSFER: { security_id: S, quantity: "10", resulting_security_ids: [R] },
  TX_EQUITY_COMPENSATION_RETRACTION: { security_id: S, reason_text: "Never granted" },
  TX_EQUITY_COMPENSATION_ACCEPTANCE: { security_id: S },
  TX_WARRANT_ISSUANCE: { security_id: S, custom_id: "WAR-1", stakeholder_id: H, quantity: "100", exercise_price: money("0.44"), purchase_price: money("0") },
  TX_WARRANT_EXERCISE: { security_id: S, resulting_security_ids: [R], x_quantity: "10" },
  TX_WARRANT_CANCELLATION: { security_id: S, quantity: "10", reason_text: "Expired", x_reason: "EXPIRED" },
  TX_WARRANT_TRANSFER: { security_id: S, quantity: "10", resulting_security_ids: [R] },
  TX_WARRANT_RETRACTION: { security_id: S, reason_text: "Never issued" },
  TX_WARRANT_ACCEPTANCE: { security_id: S },
  TX_CONVERTIBLE_ISSUANCE: { security_id: S, custom_id: "SAFE-1", stakeholder_id: H, investment_amount: money("250000"), convertible_type: "SAFE" },
  TX_CONVERTIBLE_CONVERSION: { security_id: S, resulting_security_ids: [R], x_conversion_price: money("0.48") },
  TX_CONVERTIBLE_CANCELLATION: { security_id: S, amount: money("1000"), reason_text: "Repaid" },
  TX_CONVERTIBLE_TRANSFER: { security_id: S, amount: money("1000"), resulting_security_ids: [R] },
  TX_CONVERTIBLE_RETRACTION: { security_id: S, reason_text: "Never issued" },
  TX_CONVERTIBLE_ACCEPTANCE: { security_id: S },
  TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT: { stock_class_id: C, new_shares_authorized: "30000000" },
  TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT: {
    stock_class_id: C,
    new_ratio_conversion_mechanism: { type: "RATIO_CONVERSION", ratio: { numerator: "1", denominator: "1" } },
  },
  TX_STOCK_CLASS_SPLIT: { stock_class_id: C, split_ratio: { numerator: "2", denominator: "1" } },
  TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT: { issuer_id: ORG, new_shares_authorized: "40000000" },
  TX_STOCK_PLAN_POOL_ADJUSTMENT: { stock_plan_id: P, shares_reserved: "4500000" },
  TX_STOCK_PLAN_RETURN_TO_POOL: { stock_plan_id: P, quantity: "10", reason_text: "Board returned retired shares" },
  TX_VESTING_START: { security_id: S, x_vesting_start_date: "2026-10-19" },
  TX_VESTING_EVENT: { security_id: S, vesting_condition_id: "milestone-1", x_quantity: "10" },
  TX_VESTING_ACCELERATION: { security_id: S, quantity: "10", reason_text: "Termination — accelerated" },
  X_STOCK_CLASS_TERMS: {
    stock_class_id: C,
    votes_per_share: "1",
    exclude_from_fully_diluted: false,
    seniority: 1,
    liquidation_preference_multiple: "1",
    participation: "NON_PARTICIPATING",
    participation_cap_multiple: null,
    dividend_terms: null,
    anti_dilution: "BROAD_BASED_WEIGHTED_AVERAGE",
    not_recorded_in_pulley: ["participation"],
  },
  X_STOCK_PLAN_TERMS: {
    stock_plan_id: P,
    return_rules: {
      cancelled_unvested_awards: "RETURN",
      expired_vested_options: "RETURN",
      repurchased_unvested_shares: "RETURN",
      repurchased_vested_shares: "RETIRE",
      shares_withheld_for_tax: "RETIRE",
    },
    default_termination_windows: [{ reason: "VOLUNTARY_OTHER", period: 3, period_type: "MONTHS" }],
    default_repurchase_window: { period: 90, period_type: "DAYS" },
    status: "active",
    pour_over_plan_id: null,
  },
  X_EQUITY_COMPENSATION_REPRICING: { security_id: S, new_exercise_price: money("0.5") },
  X_VESTING_PAUSE: { security_id: S },
  X_VESTING_RESUME: { security_id: S },
  X_STAKEHOLDER_TERMINATION: {
    stakeholder_id: H,
    termination_date: "2026-10-21",
    termination_type: "voluntary",
    vesting_stop_date: "2026-10-21",
    relationship_before: "employee",
    relationship_after: "ex_employee",
  },
  X_STAKEHOLDER_LEAVE: { stakeholder_id: H, start_date: "2026-01-01", end_date: null, return_guaranteed: false },
  X_STAKEHOLDER_MERGE: { merged_stakeholder_id: H, surviving_stakeholder_id: uuid("sample:survivor"), reason: "Duplicate import record" },
  X_EXECUTION_STATUS: { security_id: S, status: "executed" },
  X_SECURITY_MODIFICATION: { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: S, new_contractual_deadline: "2027-02-28" },
  X_REVERSAL: { reverses_tx_id: T },
  X_CORRECTION: { supersedes_tx_id: T, replacement_payload: { security_id: S }, reason: "Clerical error in the reason text" },
  X_MIGRATION_OPENING_BALANCE: {
    security_id: S,
    outstanding: "100",
    x_evidence: [{ run: "r04", file: "cap_table_raw_2022-01-01.xlsx", pointer: "Securities!A2", sha256: "0".repeat(64) }],
  },
};
