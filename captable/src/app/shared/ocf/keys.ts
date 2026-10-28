import type { TransactionTypeCode } from "../engine/transaction-types.ts";

/**
 * For each OCF transaction type the ledger uses: the vendored schema that defines it (under ./schema/) and the
 * property names it allows. OCF v1.2.0 objects list every allowed property at the top level and set
 * additionalProperties: false, so these lists are exactly what a valid object may carry. Generated from the vendored
 * schemas; test/engine/ocf.test.ts re-derives them and fails on any drift.
 */
export const OCF_TRANSACTION_SCHEMAS = {
  TX_STOCK_ISSUANCE: {
    schema: "objects/transactions/issuance/StockIssuance.schema.json",
    keys: ["board_approval_date", "comments", "consideration_text", "cost_basis", "custom_id", "date", "id", "issuance_type", "quantity", "security_id", "security_law_exemptions", "share_numbers_issued", "share_price", "stakeholder_id", "stock_class_id", "stock_legend_ids", "stock_plan_id", "stockholder_approval_date", "vesting_terms_id", "vestings"],
  },
  TX_STOCK_TRANSFER: {
    schema: "objects/transactions/transfer/StockTransfer.schema.json",
    keys: ["balance_security_id", "comments", "consideration_text", "date", "id", "quantity", "resulting_security_ids", "security_id"],
  },
  TX_STOCK_CANCELLATION: {
    schema: "objects/transactions/cancellation/StockCancellation.schema.json",
    keys: ["balance_security_id", "comments", "date", "id", "quantity", "reason_text", "security_id"],
  },
  TX_STOCK_REPURCHASE: {
    schema: "objects/transactions/repurchase/StockRepurchase.schema.json",
    keys: ["balance_security_id", "comments", "consideration_text", "date", "id", "price", "quantity", "security_id"],
  },
  TX_STOCK_CONVERSION: {
    schema: "objects/transactions/conversion/StockConversion.schema.json",
    keys: ["balance_security_id", "comments", "date", "id", "quantity_converted", "resulting_security_ids", "security_id"],
  },
  TX_STOCK_REISSUANCE: {
    schema: "objects/transactions/reissuance/StockReissuance.schema.json",
    keys: ["comments", "date", "id", "reason_text", "resulting_security_ids", "security_id", "split_transaction_id"],
  },
  TX_STOCK_RETRACTION: {
    schema: "objects/transactions/retraction/StockRetraction.schema.json",
    keys: ["comments", "date", "id", "reason_text", "security_id"],
  },
  TX_STOCK_ACCEPTANCE: {
    schema: "objects/transactions/acceptance/StockAcceptance.schema.json",
    keys: ["comments", "date", "id", "security_id"],
  },
  TX_EQUITY_COMPENSATION_ISSUANCE: {
    schema: "objects/transactions/issuance/EquityCompensationIssuance.schema.json",
    keys: ["base_price", "board_approval_date", "comments", "compensation_type", "consideration_text", "custom_id", "date", "early_exercisable", "exercise_price", "expiration_date", "id", "option_grant_type", "quantity", "security_id", "security_law_exemptions", "stakeholder_id", "stock_class_id", "stock_plan_id", "stockholder_approval_date", "termination_exercise_windows", "vesting_terms_id", "vestings"],
  },
  TX_EQUITY_COMPENSATION_EXERCISE: {
    schema: "objects/transactions/exercise/EquityCompensationExercise.schema.json",
    keys: ["comments", "consideration_text", "date", "id", "quantity", "resulting_security_ids", "security_id"],
  },
  TX_EQUITY_COMPENSATION_CANCELLATION: {
    schema: "objects/transactions/cancellation/EquityCompensationCancellation.schema.json",
    keys: ["balance_security_id", "comments", "date", "id", "quantity", "reason_text", "security_id"],
  },
  TX_EQUITY_COMPENSATION_RELEASE: {
    schema: "objects/transactions/release/EquityCompensationRelease.schema.json",
    keys: ["comments", "consideration_text", "date", "id", "quantity", "release_price", "resulting_security_ids", "security_id", "settlement_date"],
  },
  TX_EQUITY_COMPENSATION_TRANSFER: {
    schema: "objects/transactions/transfer/EquityCompensationTransfer.schema.json",
    keys: ["balance_security_id", "comments", "consideration_text", "date", "id", "quantity", "resulting_security_ids", "security_id"],
  },
  TX_EQUITY_COMPENSATION_RETRACTION: {
    schema: "objects/transactions/retraction/EquityCompensationRetraction.schema.json",
    keys: ["comments", "date", "id", "reason_text", "security_id"],
  },
  TX_EQUITY_COMPENSATION_ACCEPTANCE: {
    schema: "objects/transactions/acceptance/EquityCompensationAcceptance.schema.json",
    keys: ["comments", "date", "id", "security_id"],
  },
  TX_WARRANT_ISSUANCE: {
    schema: "objects/transactions/issuance/WarrantIssuance.schema.json",
    keys: ["board_approval_date", "comments", "consideration_text", "custom_id", "date", "exercise_price", "exercise_triggers", "id", "purchase_price", "quantity", "quantity_source", "security_id", "security_law_exemptions", "stakeholder_id", "stockholder_approval_date", "vesting_terms_id", "vestings", "warrant_expiration_date"],
  },
  TX_WARRANT_EXERCISE: {
    schema: "objects/transactions/exercise/WarrantExercise.schema.json",
    keys: ["comments", "consideration_text", "date", "id", "resulting_security_ids", "security_id", "trigger_id"],
  },
  TX_WARRANT_CANCELLATION: {
    schema: "objects/transactions/cancellation/WarrantCancellation.schema.json",
    keys: ["balance_security_id", "comments", "date", "id", "quantity", "reason_text", "security_id"],
  },
  TX_WARRANT_TRANSFER: {
    schema: "objects/transactions/transfer/WarrantTransfer.schema.json",
    keys: ["balance_security_id", "comments", "consideration_text", "date", "id", "quantity", "resulting_security_ids", "security_id"],
  },
  TX_WARRANT_RETRACTION: {
    schema: "objects/transactions/retraction/WarrantRetraction.schema.json",
    keys: ["comments", "date", "id", "reason_text", "security_id"],
  },
  TX_WARRANT_ACCEPTANCE: {
    schema: "objects/transactions/acceptance/WarrantAcceptance.schema.json",
    keys: ["comments", "date", "id", "security_id"],
  },
  TX_CONVERTIBLE_ISSUANCE: {
    schema: "objects/transactions/issuance/ConvertibleIssuance.schema.json",
    keys: ["board_approval_date", "comments", "consideration_text", "conversion_triggers", "convertible_type", "custom_id", "date", "id", "investment_amount", "pro_rata", "security_id", "security_law_exemptions", "seniority", "stakeholder_id", "stockholder_approval_date"],
  },
  TX_CONVERTIBLE_CONVERSION: {
    schema: "objects/transactions/conversion/ConvertibleConversion.schema.json",
    keys: ["balance_security_id", "capitalization_definition", "comments", "date", "id", "quantity_converted", "reason_text", "resulting_security_ids", "security_id", "trigger_id"],
  },
  TX_CONVERTIBLE_CANCELLATION: {
    schema: "objects/transactions/cancellation/ConvertibleCancellation.schema.json",
    keys: ["amount", "balance_security_id", "comments", "date", "id", "reason_text", "security_id"],
  },
  TX_CONVERTIBLE_TRANSFER: {
    schema: "objects/transactions/transfer/ConvertibleTransfer.schema.json",
    keys: ["amount", "balance_security_id", "comments", "consideration_text", "date", "id", "resulting_security_ids", "security_id"],
  },
  TX_CONVERTIBLE_RETRACTION: {
    schema: "objects/transactions/retraction/ConvertibleRetraction.schema.json",
    keys: ["comments", "date", "id", "reason_text", "security_id"],
  },
  TX_CONVERTIBLE_ACCEPTANCE: {
    schema: "objects/transactions/acceptance/ConvertibleAcceptance.schema.json",
    keys: ["comments", "date", "id", "security_id"],
  },
  TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT: {
    schema: "objects/transactions/adjustment/StockClassAuthorizedSharesAdjustment.schema.json",
    keys: ["board_approval_date", "comments", "date", "id", "new_shares_authorized", "stock_class_id", "stockholder_approval_date"],
  },
  TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT: {
    schema: "objects/transactions/adjustment/StockClassConversionRatioAdjustment.schema.json",
    keys: ["comments", "date", "id", "new_ratio_conversion_mechanism", "stock_class_id"],
  },
  TX_STOCK_CLASS_SPLIT: {
    schema: "objects/transactions/split/StockClassSplit.schema.json",
    keys: ["comments", "date", "id", "split_ratio", "stock_class_id"],
  },
  TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT: {
    schema: "objects/transactions/adjustment/IssuerAuthorizedSharesAdjustment.schema.json",
    keys: ["board_approval_date", "comments", "date", "id", "issuer_id", "new_shares_authorized", "stockholder_approval_date"],
  },
  TX_STOCK_PLAN_POOL_ADJUSTMENT: {
    schema: "objects/transactions/adjustment/StockPlanPoolAdjustment.schema.json",
    keys: ["board_approval_date", "comments", "date", "id", "shares_reserved", "stock_plan_id", "stockholder_approval_date"],
  },
  TX_STOCK_PLAN_RETURN_TO_POOL: {
    schema: "objects/transactions/return_to_pool/StockPlanReturnToPool.schema.json",
    keys: ["comments", "date", "id", "quantity", "reason_text", "security_id", "stock_plan_id"],
  },
  TX_VESTING_START: {
    schema: "objects/transactions/vesting/VestingStart.schema.json",
    keys: ["comments", "date", "id", "security_id", "vesting_condition_id"],
  },
  TX_VESTING_EVENT: {
    schema: "objects/transactions/vesting/VestingEvent.schema.json",
    keys: ["comments", "date", "id", "security_id", "vesting_condition_id"],
  },
  TX_VESTING_ACCELERATION: {
    schema: "objects/transactions/vesting/VestingAcceleration.schema.json",
    keys: ["comments", "date", "id", "quantity", "reason_text", "security_id"],
  },
} as const satisfies Partial<Record<TransactionTypeCode, { schema: string; keys: readonly string[] }>>;

export type OcfTransactionType = keyof typeof OCF_TRANSACTION_SCHEMAS;
