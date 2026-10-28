import "./zod-config.ts";
import { z } from "zod";
import { EngineError } from "./errors.ts";
import {
  DecimalString,
  DocumentRef,
  EvidenceList,
  ExecutionStatus,
  Exemption,
  IsoDateString,
  Monetary,
  OptionPortion,
  PaymentMethod,
  PeriodSchema,
  PositiveDecimalString,
  RatioSchema,
  Relationship,
  SecurityExemption,
  Sha256HexString,
  TaxTreatment,
  TerminationType,
  TerminationWindowSchema,
  UuidString,
} from "./schemas.ts";
import type { TransactionTypeCode } from "./transaction-types.ts";

/**
 * Payload schemas, version 1, for every transaction type (the ledger rules: "a canonical JSON payload validated per type
 * and version").
 *
 * - TX_ types use OCF v1.2.0 property names where OCF has one (snake_case). Columns that every row already carries —
 *   the transaction id, its type and its effective date — aren't repeated in the payload; an OCF export must add
 *   them back as `id`, `object_type` and `date`.
 * - App extensions on TX_ types are `x_`-prefixed and excluded from the OCF key check. App-defined X_ types use
 *   plain snake_case keys; `x_evidence` is common to every type for imported provenance.
 * - Every object is strict: an unknown key fails, so nothing unvalidated reaches the hash chain.
 * - Schemas never fill defaults: the stored text is what was hashed, and the parsed object must mean the same.
 */

/** The lots a transaction results in: each listed once, so no lot can be counted twice towards a total (I2, I4). */
const Ids = z
  .array(UuidString)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Each resulting lot is listed once" });
const Comments = z.array(z.string().max(2000)).max(20);
const Text = z.string().min(1).max(2000);
const ShortText = z.string().min(1).max(200);
const x_evidence = EvidenceList.optional();

/**
 * A lot-splitting transaction names its source, its resulting lots and its balance lot: three different roles, so no
 * lot may fill two of them (a balance lot also listed as resulting would be counted twice, I2).
 */
function distinctLots(p: { security_id: string; resulting_security_ids: readonly string[]; balance_security_id?: string | undefined }): boolean {
  if (p.resulting_security_ids.includes(p.security_id)) return false;
  return p.balance_security_id === undefined || (p.balance_security_id !== p.security_id && !p.resulting_security_ids.includes(p.balance_security_id));
}

const DISTINCT_LOTS = { message: "The source, resulting and balance lots are all different lots" };

/** A cancellation or repurchase that leaves a balance lot: the balance is a new lot, never the source itself. */
function balanceApart(p: { security_id: string; balance_security_id?: string | undefined }): boolean {
  return p.balance_security_id === undefined || p.balance_security_id !== p.security_id;
}

const BALANCE_APART = { message: "The balance lot is a new lot, not the source", path: ["balance_security_id"] };

/**
 * Fields only a migrated issuance carries (the migration rules). They record what Pulley held, so an app
 * transaction may not use them: a new grant states its board approval date and its legends by id
 * (ledger.decodeTransaction enforces this with the row's source).
 */
export const MIGRATION_ONLY_KEYS = ["x_board_approval_not_recorded_in_pulley", "x_debt_cancelled", "x_legends"] as const;

/** A legend as it read on the lot when it was imported (the legend templates are imported separately). */
const LegendSnapshot = z.strictObject({
  legend_id: UuidString,
  name: ShortText,
  text: z.string().min(1).max(20000),
});

const migratedIssuanceFields = {
  /** The import source had no board approval date for the lot. */
  x_board_approval_not_recorded_in_pulley: z.literal(true).optional(),
  /** The legends on the lot, as snapshots: the text is evidence and never changes with the template. */
  x_legends: z.array(LegendSnapshot).min(1).max(20).optional(),
};

function boardApprovalRule(p: { board_approval_date?: string | undefined; x_board_approval_not_recorded_in_pulley?: true | undefined }): boolean {
  return p.board_approval_date === undefined || p.x_board_approval_not_recorded_in_pulley === undefined;
}

const BOARD_APPROVAL_MESSAGE = { message: "A board approval date and 'not recorded in the import' exclude each other", path: ["x_board_approval_not_recorded_in_pulley"] };

/** How a stock (or award, warrant, convertible) lot came about; drives capital contribution and lineage checks. */
export const IssuanceOrigin = z.enum([
  "PURCHASE",
  "FOUNDERS_STOCK",
  "RSA",
  "EXERCISE",
  "CONVERSION",
  "TRANSFER",
  "BALANCE",
  "REISSUANCE",
  "RELEASE",
]);
export type IssuanceOrigin = z.infer<typeof IssuanceOrigin>;

/** Origins of a derived award, warrant or convertible lot (a fresh one is a GRANT). */
export const DerivedOrigin = z.enum(["GRANT", "TRANSFER", "BALANCE"]);

const SOURCED_ORIGINS = new Set(["EXERCISE", "CONVERSION", "TRANSFER", "BALANCE", "REISSUANCE", "RELEASE"]);

function vestingHashRule(payload: { vesting_terms_id?: string | undefined; x_definition_sha256?: string | undefined }): boolean {
  return (payload.vesting_terms_id === undefined) === (payload.x_definition_sha256 === undefined);
}

const VESTING_HASH_MESSAGE = "vesting_terms_id and x_definition_sha256 come together (the chain covers the definition)";

export const TransferReason = z.enum([
  "SECONDARY_SALE",
  "TRANSFER_TO_AFFILIATE",
  "GIFT",
  "ESTATE",
  "DEATH",
  "DIVORCE",
  "DONATION",
  "OTHER",
]);

export const CancellationReason = z.enum([
  "TERMINATION",
  "EXPIRED",
  "HOLDER_WAIVER",
  "NOT_EXECUTED",
  "MUTUAL_AGREEMENT",
  "FORFEITURE_UNDER_AGREEMENT",
  "OTHER",
]);
export type CancellationReason = z.infer<typeof CancellationReason>;

const RepurchaseRight = z.strictObject({
  price_per_share: Monetary.nullable(),
  window: PeriodSchema.nullable(),
  terms_text: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// STOCK

export const StockIssuancePayload = z
  .strictObject({
    security_id: UuidString,
    custom_id: ShortText,
    stakeholder_id: UuidString,
    stock_class_id: UuidString,
    stock_plan_id: UuidString.optional(),
    share_price: Monetary,
    quantity: PositiveDecimalString,
    cost_basis: Monetary.optional(),
    vesting_terms_id: UuidString.optional(),
    stock_legend_ids: z.array(UuidString).max(20).optional(),
    issuance_type: z.enum(["RSA", "FOUNDERS_STOCK"]).optional(),
    board_approval_date: IsoDateString.optional(),
    stockholder_approval_date: IsoDateString.optional(),
    consideration_text: z.string().max(2000).optional(),
    security_law_exemptions: z.array(SecurityExemption).max(10).optional(),
    comments: Comments.optional(),
    x_origin: IssuanceOrigin,
    x_source_security_id: UuidString.optional(),
    x_portion: OptionPortion.optional(),
    x_capital_contribution: Monetary.optional(),
    x_definition_sha256: Sha256HexString.optional(),
    x_repurchase_right: RepurchaseRight.optional(),
    x_holding_start_date: IsoDateString.optional(),
    x_exemption: Exemption.optional(),
    x_issue_reason: z.string().max(200).optional(),
    ...migratedIssuanceFields,
    /** Migrated: debt cancelled for the shares (converted SAFEs), as recorded in Pulley, never recomputed. */
    x_debt_cancelled: Monetary.optional(),
    x_evidence,
  })
  .refine(vestingHashRule, VESTING_HASH_MESSAGE)
  .refine(boardApprovalRule, BOARD_APPROVAL_MESSAGE)
  .refine((p) => SOURCED_ORIGINS.has(p.x_origin) === (p.x_source_security_id !== undefined), {
    message: "x_source_security_id is required exactly for derived lots (exercise, conversion, transfer, balance, reissuance, release)",
  })
  .refine((p) => p.x_portion === undefined || p.x_origin === "EXERCISE", { message: "x_portion applies to exercise shares only" });

export const StockTransferPayload = z
  .strictObject({
    security_id: UuidString,
    quantity: PositiveDecimalString,
    resulting_security_ids: Ids,
    balance_security_id: UuidString.optional(),
    consideration_text: z.string().max(2000).optional(),
    comments: Comments.optional(),
    x_reason: TransferReason.optional(),
    x_price_per_share: Monetary.optional(),
    x_evidence,
  })
  .refine(distinctLots, DISTINCT_LOTS);

export const StockCancellationPayload = z
  .strictObject({
    security_id: UuidString,
    quantity: PositiveDecimalString,
    reason_text: Text,
    balance_security_id: UuidString.optional(),
    comments: Comments.optional(),
    x_evidence,
  })
  .refine(balanceApart, BALANCE_APART);

export const StockRepurchasePayload = z
  .strictObject({
    security_id: UuidString,
    quantity: PositiveDecimalString,
    price: Monetary,
    consideration_text: z.string().max(2000).optional(),
    balance_security_id: UuidString.optional(),
    comments: Comments.optional(),
    /** UNVESTED: the company's repurchase right after termination; VESTED: a buyback (the product rules). */
    x_kind: z.enum(["UNVESTED", "VESTED"]),
    x_consideration: Monetary.optional(),
    x_evidence,
  })
  .refine(balanceApart, BALANCE_APART);

export const StockConversionPayload = z
  .strictObject({
    security_id: UuidString,
    quantity_converted: PositiveDecimalString,
    resulting_security_ids: Ids,
    balance_security_id: UuidString.optional(),
    comments: Comments.optional(),
    /** Overrides the class's conversion ratio, e.g. for a reclassification between series. */
    x_ratio: RatioSchema.optional(),
    x_evidence,
  })
  .refine(distinctLots, DISTINCT_LOTS);

export const StockReissuancePayload = z
  .strictObject({
    security_id: UuidString,
    resulting_security_ids: Ids,
    reason_text: z.string().max(2000).optional(),
    split_transaction_id: UuidString.optional(),
    comments: Comments.optional(),
    x_evidence,
  })
  .refine(distinctLots, DISTINCT_LOTS);

const RetractionPayload = z.strictObject({ security_id: UuidString, reason_text: Text, comments: Comments.optional(), x_evidence });
const AcceptancePayload = z.strictObject({ security_id: UuidString, comments: Comments.optional(), x_evidence });

// ---------------------------------------------------------------------------
// EQUITY_COMPENSATION

export const CompensationType = z.enum(["OPTION_ISO", "OPTION_NSO", "RSU", "CSAR", "SSAR"]);
export type CompensationType = z.infer<typeof CompensationType>;

const FmvSnapshot = z.strictObject({
  price_per_share: Monetary,
  valuation_id: UuidString.nullable(),
  source: z.enum(["VALUATION", "MANUAL", "IMPORTED"]),
  source_note: z.string().max(2000).optional(),
  document_id: UuidString.optional(),
});

const AccelerationTerms = z.strictObject({
  kind: z.enum(["NONE", "SINGLE_TRIGGER", "DOUBLE_TRIGGER"]),
  percent: DecimalString.optional(),
  months: z.number().int().min(0).max(60).optional(),
  text: z.string().max(4000).optional(),
});

export const EquityCompensationIssuancePayload = z
  .strictObject({
    security_id: UuidString,
    custom_id: ShortText,
    stakeholder_id: UuidString,
    stock_plan_id: UuidString.optional(),
    stock_class_id: UuidString.optional(),
    compensation_type: CompensationType,
    quantity: PositiveDecimalString,
    exercise_price: Monetary.optional(),
    base_price: Monetary.optional(),
    early_exercisable: z.boolean().optional(),
    vesting_terms_id: UuidString.optional(),
    expiration_date: IsoDateString.nullable(),
    termination_exercise_windows: z.array(TerminationWindowSchema).max(7),
    board_approval_date: IsoDateString.optional(),
    stockholder_approval_date: IsoDateString.optional(),
    consideration_text: z.string().max(2000).optional(),
    security_law_exemptions: z.array(SecurityExemption).max(10).optional(),
    comments: Comments.optional(),
    x_origin: DerivedOrigin.optional(),
    x_source_security_id: UuidString.optional(),
    x_definition_sha256: Sha256HexString.optional(),
    x_fmv: FmvSnapshot.optional(),
    x_plan_terms_tx_id: UuidString.optional(),
    x_iso_attestations: z.strictObject({ employee_at_grant: z.boolean(), ten_percent_holder: z.boolean() }).optional(),
    x_acceleration_terms: AccelerationTerms.optional(),
    x_exemption: Exemption.optional(),
    x_legend_ids: z.array(UuidString).max(20).optional(),
    x_issue_reason: z.string().max(200).optional(),
    x_documents: z.array(DocumentRef.extend({ role: z.string().min(1).max(32) })).max(20).optional(),
    ...migratedIssuanceFields,
    x_evidence,
  })
  .refine(vestingHashRule, VESTING_HASH_MESSAGE)
  .refine(boardApprovalRule, BOARD_APPROVAL_MESSAGE)
  .refine((p) => !p.compensation_type.startsWith("OPTION_") || p.exercise_price !== undefined, {
    message: "An option needs an exercise price",
  })
  .refine((p) => !p.compensation_type.endsWith("SAR") || p.base_price !== undefined, { message: "A SAR needs a base price" })
  .refine((p) => (p.x_origin === "TRANSFER" || p.x_origin === "BALANCE") === (p.x_source_security_id !== undefined), {
    message: "x_source_security_id is required exactly for transferred and balance lots",
  });

const ExercisePortion = z
  .strictObject({
    portion: OptionPortion,
    quantity: PositiveDecimalString,
    security_id: UuidString,
    /** Why shares of an ISO grant are NSO: after the ISO deadline, over the $100K limit, or the admin's lot choice. */
    reason: z.enum(["AFTER_ISO_DEADLINE", "ISO_LIMIT", "LOT_CHOICE"]).optional(),
  })
  .refine((p) => p.portion === "NSO" || p.reason === undefined, { message: "Only an NSO portion carries a reason" });

const Withholding = z.strictObject({
  federal_income: DecimalString,
  social_security: DecimalString,
  medicare: DecimalString,
  state: z.array(z.strictObject({ code: z.string().regex(/^[A-Z]{2}$/), amount: DecimalString })).max(3),
});

export const EquityCompensationExercisePayload = z
  .strictObject({
    security_id: UuidString,
    quantity: PositiveDecimalString,
    resulting_security_ids: Ids,
    consideration_text: z.string().max(2000).optional(),
    comments: Comments.optional(),
    x_exercise_price: Monetary.optional(),
    x_exercise_cost: Monetary.optional(),
    x_fmv: FmvSnapshot.optional(),
    /**
     * Required: one per resulting share lot, its tax portion (late ISO shares are NSO, the ledger rules). Form 3921 reads the
     * ISO portions, so an exercise can't leave them out.
     */
    x_portions: z.array(ExercisePortion).min(1).max(2),
    /** Required: the ISO and NSO lots consumed, frozen at exercise (the ledger rules). ISO + NSO = quantity (I4). */
    x_lots_consumed: z.strictObject({ iso: DecimalString, nso: DecimalString }),
    x_lot_reason: z.string().max(2000).optional(),
    /** Net exercise: shares withheld for the price or tax (the fifth return-to-pool rule). */
    x_withheld_quantity: PositiveDecimalString.optional(),
    x_early_exercise: z.boolean().optional(),
    x_notice: z.strictObject({ document_id: UuidString, received_on: IsoDateString }).optional(),
    x_payment: z
      .strictObject({
        amount: Monetary,
        received_on: IsoDateString,
        method: PaymentMethod,
        reference: z.string().min(1).max(200),
        payer_is_holder: z.boolean(),
        payer_note: z.string().max(500).optional(),
      })
      .optional(),
    x_tax: z
      .strictObject({
        treatment: TaxTreatment,
        withholding: Withholding.optional(),
        zero_reason: z.string().max(2000).optional(),
        non_us_note: z.string().max(2000).optional(),
      })
      .optional(),
    x_evidence,
  })
  .refine(distinctLots, DISTINCT_LOTS)
  .refine((p) => new Set(p.x_portions.map((x) => x.portion)).size === p.x_portions.length, {
    message: "At most one ISO and one NSO portion",
    path: ["x_portions"],
  })
  .refine(
    (p) => {
      const named = p.x_portions.map((x) => x.security_id);
      return new Set(named).size === named.length && named.length === p.resulting_security_ids.length && named.every((id) => p.resulting_security_ids.includes(id));
    },
    { message: "Each resulting lot has exactly one portion, and each portion names one resulting lot", path: ["x_portions"] },
  );

export const EquityCompensationCancellationPayload = z
  .strictObject({
    security_id: UuidString,
    quantity: PositiveDecimalString,
    reason_text: Text,
    balance_security_id: UuidString.optional(),
    comments: Comments.optional(),
    x_reason: CancellationReason,
    /** Which part is cancelled when the engine shouldn't decide (unvested first, or vested first for EXPIRED). */
    x_vesting_portion: z.enum(["UNVESTED", "VESTED"]).optional(),
    x_document: DocumentRef.optional(),
    x_evidence,
  })
  .refine(balanceApart, BALANCE_APART);

export const EquityCompensationReleasePayload = z
  .strictObject({
    security_id: UuidString,
    quantity: PositiveDecimalString,
    settlement_date: IsoDateString,
    release_price: Monetary,
    resulting_security_ids: Ids,
    consideration_text: z.string().max(2000).optional(),
    comments: Comments.optional(),
    x_withheld_quantity: PositiveDecimalString.optional(),
    x_evidence,
  })
  .refine(distinctLots, DISTINCT_LOTS);

const TransferPayload = z
  .strictObject({
    security_id: UuidString,
    quantity: PositiveDecimalString,
    resulting_security_ids: Ids,
    balance_security_id: UuidString.optional(),
    consideration_text: z.string().max(2000).optional(),
    comments: Comments.optional(),
    x_reason: TransferReason.optional(),
    x_evidence,
  })
  .refine(distinctLots, DISTINCT_LOTS);

// ---------------------------------------------------------------------------
// WARRANT

export const WarrantIssuancePayload = z
  .strictObject({
    security_id: UuidString,
    custom_id: ShortText,
    stakeholder_id: UuidString,
    quantity: PositiveDecimalString,
    exercise_price: Monetary.optional(),
    purchase_price: Monetary,
    warrant_expiration_date: IsoDateString.optional(),
    vesting_terms_id: UuidString.optional(),
    exercise_triggers: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
    quantity_source: z.enum(["HUMAN_ESTIMATED", "MACHINE_ESTIMATED", "UNSPECIFIED", "INSTRUMENT_FIXED", "INSTRUMENT_MAX", "INSTRUMENT_MIN"]).optional(),
    board_approval_date: IsoDateString.optional(),
    stockholder_approval_date: IsoDateString.optional(),
    consideration_text: z.string().max(2000).optional(),
    security_law_exemptions: z.array(SecurityExemption).max(10).optional(),
    comments: Comments.optional(),
    x_origin: DerivedOrigin.optional(),
    x_source_security_id: UuidString.optional(),
    x_definition_sha256: Sha256HexString.optional(),
    x_exercise_provisions: z.string().max(4000).optional(),
    x_capital_contribution: Monetary.optional(),
    x_exemption: Exemption.optional(),
    ...migratedIssuanceFields,
    /** Migrated: debt cancelled for the warrant, as recorded in Pulley, never recomputed. */
    x_debt_cancelled: Monetary.optional(),
    x_evidence,
  })
  .refine(vestingHashRule, VESTING_HASH_MESSAGE)
  .refine(boardApprovalRule, BOARD_APPROVAL_MESSAGE)
  .refine((p) => (p.x_origin === "TRANSFER" || p.x_origin === "BALANCE") === (p.x_source_security_id !== undefined), {
    message: "x_source_security_id is required exactly for transferred and balance lots",
  });

export const WarrantExercisePayload = z
  .strictObject({
    security_id: UuidString,
    resulting_security_ids: Ids,
    trigger_id: z.string().max(200).optional(),
    consideration_text: z.string().max(2000).optional(),
    comments: Comments.optional(),
    /** Warrant shares surrendered; OCF v1.2.0 has no quantity on a warrant exercise. Net exercise yields fewer shares. */
    x_quantity: PositiveDecimalString,
    x_net_exercise: z.boolean().optional(),
    x_exercise_cost: Monetary.optional(),
    x_evidence,
  })
  .refine(distinctLots, DISTINCT_LOTS);

export const WarrantCancellationPayload = z
  .strictObject({
    security_id: UuidString,
    quantity: PositiveDecimalString,
    reason_text: Text,
    balance_security_id: UuidString.optional(),
    comments: Comments.optional(),
    x_reason: CancellationReason,
    x_document: DocumentRef.optional(),
    x_evidence,
  })
  .refine(balanceApart, BALANCE_APART);

// ---------------------------------------------------------------------------
// CONVERTIBLE

export const ConvertibleIssuancePayload = z
  .strictObject({
    security_id: UuidString,
    custom_id: ShortText,
    stakeholder_id: UuidString,
    investment_amount: Monetary.refine((m) => m.amount !== "0", "The principal must be greater than 0"),
    convertible_type: z.enum(["NOTE", "SAFE", "CONVERTIBLE_SECURITY"]),
    conversion_triggers: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
    pro_rata: DecimalString.optional(),
    seniority: z.number().int().min(0).max(100).optional(),
    board_approval_date: IsoDateString.optional(),
    stockholder_approval_date: IsoDateString.optional(),
    consideration_text: z.string().max(2000).optional(),
    security_law_exemptions: z.array(SecurityExemption).max(10).optional(),
    comments: Comments.optional(),
    x_origin: DerivedOrigin.optional(),
    x_source_security_id: UuidString.optional(),
    /** The SAFE as recorded (the product rules); nothing is recomputed from it. */
    x_safe_terms: z
      .strictObject({
        form: z.string().max(200).optional(),
        conversion_timing: z.enum(["PRE_MONEY", "POST_MONEY"]).nullable().optional(),
        valuation_cap: Monetary.nullable().optional(),
        uncapped: z.boolean().optional(),
        discount_rate: DecimalString.nullable().optional(),
        mfn: z.boolean().optional(),
        mfn_date: IsoDateString.nullable().optional(),
        pro_rata: z.boolean().optional(),
      })
      .optional(),
    x_funds_received_on: IsoDateString.optional(),
    x_exemption: Exemption.optional(),
    x_board_approval_not_recorded_in_pulley: migratedIssuanceFields.x_board_approval_not_recorded_in_pulley,
    x_evidence,
  })
  .refine(boardApprovalRule, BOARD_APPROVAL_MESSAGE)
  .refine((p) => (p.x_origin === "TRANSFER" || p.x_origin === "BALANCE") === (p.x_source_security_id !== undefined), {
    message: "x_source_security_id is required exactly for transferred and balance lots",
  });

export const ConvertibleConversionPayload = z
  .strictObject({
    security_id: UuidString,
    resulting_security_ids: Ids,
    reason_text: z.string().max(2000).optional(),
    trigger_id: z.string().max(200).optional(),
    /** The principal converted; absent means all of it. */
    quantity_converted: PositiveDecimalString.optional(),
    balance_security_id: UuidString.optional(),
    comments: Comments.optional(),
    /** Per the closing memo (the product rules): recorded, never recomputed. */
    x_conversion_price: Monetary.optional(),
    x_evidence,
  })
  .refine(distinctLots, DISTINCT_LOTS);

export const ConvertibleCancellationPayload = z
  .strictObject({
    security_id: UuidString,
    amount: Monetary.refine((m) => m.amount !== "0", "The amount must be greater than 0"),
    reason_text: Text,
    balance_security_id: UuidString.optional(),
    comments: Comments.optional(),
    x_evidence,
  })
  .refine(balanceApart, BALANCE_APART);

export const ConvertibleTransferPayload = z
  .strictObject({
    security_id: UuidString,
    amount: Monetary.refine((m) => m.amount !== "0", "The amount must be greater than 0"),
    resulting_security_ids: Ids,
    balance_security_id: UuidString.optional(),
    consideration_text: z.string().max(2000).optional(),
    comments: Comments.optional(),
    x_reason: TransferReason.optional(),
    x_evidence,
  })
  .refine(distinctLots, DISTINCT_LOTS);

// ---------------------------------------------------------------------------
// STOCK_CLASS, ISSUER, STOCK_PLAN

export const StockClassAuthorizedSharesAdjustmentPayload = z.strictObject({
  stock_class_id: UuidString,
  new_shares_authorized: DecimalString,
  board_approval_date: IsoDateString.optional(),
  stockholder_approval_date: IsoDateString.optional(),
  comments: Comments.optional(),
  x_document: DocumentRef.optional(),
  x_evidence,
});

export const StockClassConversionRatioAdjustmentPayload = z.strictObject({
  stock_class_id: UuidString,
  new_ratio_conversion_mechanism: z.strictObject({
    type: z.literal("RATIO_CONVERSION"),
    ratio: RatioSchema,
    conversion_price: Monetary.optional(),
    rounding_type: z.enum(["CEILING", "FLOOR", "NORMAL"]).optional(),
  }),
  comments: Comments.optional(),
  /** The class it converts into; defaults to the org's only common class. */
  x_converts_to_stock_class_id: UuidString.optional(),
  x_document: DocumentRef.optional(),
  x_evidence,
});

export const StockClassSplitPayload = z.strictObject({
  stock_class_id: UuidString,
  split_ratio: RatioSchema,
  comments: Comments.optional(),
  /** Fractional shares after the split (the ledger rules: round down with cash in lieu by default). */
  x_fractional_policy: z.enum(["ROUND_DOWN_CASH_IN_LIEU"]).optional(),
  x_document: DocumentRef.optional(),
  x_evidence,
});

export const IssuerAuthorizedSharesAdjustmentPayload = z.strictObject({
  issuer_id: UuidString,
  new_shares_authorized: DecimalString,
  board_approval_date: IsoDateString.optional(),
  stockholder_approval_date: IsoDateString.optional(),
  comments: Comments.optional(),
  x_document: DocumentRef.optional(),
  x_evidence,
});

export const StockPlanPoolAdjustmentPayload = z.strictObject({
  stock_plan_id: UuidString,
  /** The new pool size (a total, not a delta). */
  shares_reserved: DecimalString,
  board_approval_date: IsoDateString.optional(),
  stockholder_approval_date: IsoDateString.optional(),
  comments: Comments.optional(),
  x_document: DocumentRef.optional(),
  x_evidence,
});

export const StockPlanReturnToPoolPayload = z.strictObject({
  stock_plan_id: UuidString,
  quantity: PositiveDecimalString,
  reason_text: Text,
  security_id: UuidString.optional(),
  comments: Comments.optional(),
  x_evidence,
});

// ---------------------------------------------------------------------------
// VESTING

export const VestingStartPayload = z.strictObject({
  security_id: UuidString,
  vesting_condition_id: z.string().max(200).optional(),
  comments: Comments.optional(),
  /**
   * The vesting commencement date. It may precede the grant date (P5's new hire), while the transaction itself is
   * effective on the grant date, so I10 ("never before the lot's issue date") holds.
   */
  x_vesting_start_date: IsoDateString,
  x_evidence,
});

export const VestingEventPayload = z.strictObject({
  security_id: UuidString,
  vesting_condition_id: z.string().min(1).max(200),
  comments: Comments.optional(),
  x_quantity: PositiveDecimalString,
  x_evidence,
});

export const VestingAccelerationPayload = z.strictObject({
  security_id: UuidString,
  quantity: PositiveDecimalString,
  reason_text: Text,
  comments: Comments.optional(),
  /** Migrated: Pulley's explicit events already contain this acceleration, so replay doesn't add it twice. */
  x_explicit_already_applied: z.boolean().optional(),
  x_document: DocumentRef.optional(),
  x_evidence,
});

// ---------------------------------------------------------------------------
// X_ extensions

export const ReturnRule = z.enum(["RETURN", "RETIRE"]);

export const StockClassTermsPayload = z.strictObject({
  stock_class_id: UuidString,
  votes_per_share: DecimalString,
  exclude_from_fully_diluted: z.boolean(),
  seniority: z.number().int().min(0).max(100).nullable(),
  liquidation_preference_multiple: DecimalString.nullable(),
  participation: z.enum(["NON_PARTICIPATING", "PARTICIPATING", "CAPPED"]).nullable(),
  participation_cap_multiple: DecimalString.nullable(),
  dividend_terms: z.record(z.string(), z.unknown()).nullable(),
  anti_dilution: z.enum(["NONE", "BROAD_BASED_WEIGHTED_AVERAGE", "NARROW_BASED_WEIGHTED_AVERAGE", "FULL_RATCHET"]).nullable(),
  not_recorded_in_pulley: z.array(z.string().max(64)).max(20),
  document_id: UuidString.nullable().optional(),
  x_evidence,
});

export const StockPlanTermsPayload = z.strictObject({
  stock_plan_id: UuidString,
  return_rules: z.strictObject({
    cancelled_unvested_awards: ReturnRule,
    expired_vested_options: ReturnRule,
    repurchased_unvested_shares: ReturnRule,
    repurchased_vested_shares: ReturnRule,
    shares_withheld_for_tax: ReturnRule,
  }),
  default_termination_windows: z.array(TerminationWindowSchema).max(7),
  default_repurchase_window: PeriodSchema.nullable(),
  status: z.enum(["active", "terminated"]),
  pour_over_plan_id: UuidString.nullable(),
  document_id: UuidString.nullable().optional(),
  note: z.string().max(2000).optional(),
  x_evidence,
});

export const RepricingPayload = z.strictObject({
  security_id: UuidString,
  new_exercise_price: Monetary,
  document_id: UuidString.optional(),
  x_evidence,
});

export const VestingPausePayload = z.strictObject({ security_id: UuidString, reason: z.string().max(2000).optional(), x_evidence });
export const VestingResumePayload = z.strictObject({ security_id: UuidString, x_evidence });

export const StakeholderTerminationPayload = z.strictObject({
  stakeholder_id: UuidString,
  /** Equals the transaction's effective date (checked when rows are parsed). */
  termination_date: IsoDateString,
  termination_type: TerminationType,
  vesting_stop_date: IsoDateString,
  /** §22(e)(3) permanent and total disability; changes only the ISO deadline. */
  disability_attestation: z.boolean().optional(),
  /** Kept so a reversal restores it (migrations/0001 `stakeholders.relationship`). */
  relationship_before: Relationship,
  relationship_after: Relationship,
  /** Per-security exceptions (migration): another stop date, or Pulley's exact cancelled event ids. */
  securities: z
    .array(
      z.strictObject({
        security_id: UuidString,
        vesting_stop_date: IsoDateString.optional(),
        cancelled_vesting_event_ids: z.array(z.string().min(1).max(100)).max(1000).optional(),
      }),
    )
    .max(500)
    .optional(),
  /** Migrated: only the listed cancelled event ids stop, not every event after the stop. */
  explicit_already_applied: z.boolean().optional(),
  x_evidence,
});

export const StakeholderLeavePayload = z.strictObject({
  stakeholder_id: UuidString,
  start_date: IsoDateString,
  end_date: IsoDateString.nullable(),
  return_guaranteed: z.boolean(),
  document_id: UuidString.optional(),
  x_evidence,
});

export const StakeholderMergePayload = z.strictObject({
  merged_stakeholder_id: UuidString,
  surviving_stakeholder_id: UuidString,
  reason: Text,
  x_evidence,
});

export const ExecutionStatusPayload = z.strictObject({
  security_id: UuidString,
  status: ExecutionStatus,
  signature_dates: z.strictObject({ company: IsoDateString.optional(), holder: IsoDateString.optional() }).optional(),
  attestation: z.string().max(200).optional(),
  document: DocumentRef.optional(),
  x_evidence,
});

export const SecurityModificationPayload = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("CONTRACTUAL_DEADLINE_EXTENSION"),
    security_id: UuidString,
    new_contractual_deadline: IsoDateString,
    document: DocumentRef.optional(),
    note: z.string().max(2000).optional(),
    x_evidence,
  }),
  z.strictObject({
    kind: z.literal("REPURCHASE_DEADLINE"),
    security_id: UuidString,
    last_repurchase_date: IsoDateString,
    document: DocumentRef.optional(),
    x_evidence,
  }),
]);

export const ReversalPayload = z.strictObject({ reverses_tx_id: UuidString, x_evidence });

export const CorrectionPayload = z.strictObject({
  supersedes_tx_id: UuidString,
  /** The corrected payload, validated against the superseded transaction's type when replayed. */
  replacement_payload: z.record(z.string(), z.unknown()),
  effective_date: IsoDateString.optional(),
  reason: Text,
  x_evidence,
});

export const OpeningBalancePayload = z.strictObject({
  security_id: UuidString,
  /** The lot's outstanding quantity (shares, options, warrant shares) or principal (convertibles) on the date. */
  outstanding: DecimalString,
  issued: DecimalString.optional(),
  exercised: DecimalString.optional(),
  cancelled: DecimalString.optional(),
  /** The lot's terms, as its family's issuance payload, when the ledger has no issuance for it (the ledger rules). */
  issuance: z.record(z.string(), z.unknown()).optional(),
  x_evidence: EvidenceList,
});

// ---------------------------------------------------------------------------

export const PAYLOAD_SCHEMAS = {
  TX_STOCK_ISSUANCE: StockIssuancePayload,
  TX_STOCK_TRANSFER: StockTransferPayload,
  TX_STOCK_CANCELLATION: StockCancellationPayload,
  TX_STOCK_REPURCHASE: StockRepurchasePayload,
  TX_STOCK_CONVERSION: StockConversionPayload,
  TX_STOCK_REISSUANCE: StockReissuancePayload,
  TX_STOCK_RETRACTION: RetractionPayload,
  TX_STOCK_ACCEPTANCE: AcceptancePayload,
  TX_EQUITY_COMPENSATION_ISSUANCE: EquityCompensationIssuancePayload,
  TX_EQUITY_COMPENSATION_EXERCISE: EquityCompensationExercisePayload,
  TX_EQUITY_COMPENSATION_CANCELLATION: EquityCompensationCancellationPayload,
  TX_EQUITY_COMPENSATION_RELEASE: EquityCompensationReleasePayload,
  TX_EQUITY_COMPENSATION_TRANSFER: TransferPayload,
  TX_EQUITY_COMPENSATION_RETRACTION: RetractionPayload,
  TX_EQUITY_COMPENSATION_ACCEPTANCE: AcceptancePayload,
  TX_WARRANT_ISSUANCE: WarrantIssuancePayload,
  TX_WARRANT_EXERCISE: WarrantExercisePayload,
  TX_WARRANT_CANCELLATION: WarrantCancellationPayload,
  TX_WARRANT_TRANSFER: TransferPayload,
  TX_WARRANT_RETRACTION: RetractionPayload,
  TX_WARRANT_ACCEPTANCE: AcceptancePayload,
  TX_CONVERTIBLE_ISSUANCE: ConvertibleIssuancePayload,
  TX_CONVERTIBLE_CONVERSION: ConvertibleConversionPayload,
  TX_CONVERTIBLE_CANCELLATION: ConvertibleCancellationPayload,
  TX_CONVERTIBLE_TRANSFER: ConvertibleTransferPayload,
  TX_CONVERTIBLE_RETRACTION: RetractionPayload,
  TX_CONVERTIBLE_ACCEPTANCE: AcceptancePayload,
  TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT: StockClassAuthorizedSharesAdjustmentPayload,
  TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT: StockClassConversionRatioAdjustmentPayload,
  TX_STOCK_CLASS_SPLIT: StockClassSplitPayload,
  TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT: IssuerAuthorizedSharesAdjustmentPayload,
  TX_STOCK_PLAN_POOL_ADJUSTMENT: StockPlanPoolAdjustmentPayload,
  TX_STOCK_PLAN_RETURN_TO_POOL: StockPlanReturnToPoolPayload,
  TX_VESTING_START: VestingStartPayload,
  TX_VESTING_EVENT: VestingEventPayload,
  TX_VESTING_ACCELERATION: VestingAccelerationPayload,
  X_STOCK_CLASS_TERMS: StockClassTermsPayload,
  X_STOCK_PLAN_TERMS: StockPlanTermsPayload,
  X_EQUITY_COMPENSATION_REPRICING: RepricingPayload,
  X_VESTING_PAUSE: VestingPausePayload,
  X_VESTING_RESUME: VestingResumePayload,
  X_STAKEHOLDER_TERMINATION: StakeholderTerminationPayload,
  X_STAKEHOLDER_LEAVE: StakeholderLeavePayload,
  X_STAKEHOLDER_MERGE: StakeholderMergePayload,
  X_EXECUTION_STATUS: ExecutionStatusPayload,
  X_SECURITY_MODIFICATION: SecurityModificationPayload,
  X_REVERSAL: ReversalPayload,
  X_CORRECTION: CorrectionPayload,
  X_MIGRATION_OPENING_BALANCE: OpeningBalancePayload,
} as const satisfies Record<TransactionTypeCode, z.ZodType>;

export type PayloadOf<T extends TransactionTypeCode> = z.infer<(typeof PAYLOAD_SCHEMAS)[T]>;

/** The current payload version of every type; a breaking schema change adds version 2 beside version 1. */
export const PAYLOAD_VERSION = 1;

/** Validates a payload for (type, version); throws EngineError with the zod issues. */
export function parsePayload<T extends TransactionTypeCode>(type: T, payload: unknown, version = PAYLOAD_VERSION): PayloadOf<T> {
  if (version !== PAYLOAD_VERSION) throw new EngineError("PAYLOAD_VERSION", `${type}: unknown payload version ${version}`);
  const schema = PAYLOAD_SCHEMAS[type] as z.ZodType;
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(payload)"}: ${issue.message}`).join("; ");
    throw new EngineError("PAYLOAD_INVALID", `${type}: ${issues}`);
  }
  return result.data as PayloadOf<T>;
}
