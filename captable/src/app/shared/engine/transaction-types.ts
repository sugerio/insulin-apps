/**
 * The transaction types of the ledger: OCF v1.2.0 object types (TX_…) and the app's extensions (X_…). This
 * list mirrors the `transaction_types` seed in migrations/0001 row for row; a test compares them, so a type can't be
 * added to one without the other.
 */

export type TransactionFamily =
  | "STOCK"
  | "EQUITY_COMPENSATION"
  | "WARRANT"
  | "CONVERTIBLE"
  | "STOCK_CLASS"
  | "ISSUER"
  | "STOCK_PLAN"
  | "VESTING"
  | "STAKEHOLDER"
  | "LEDGER"
  | "MIGRATION";

export const TRANSACTION_TYPES = [
  { code: "TX_STOCK_ISSUANCE", family: "STOCK", isOcf: true, description: "Shares issued (purchase, founders, RSA, or the result of an exercise, conversion, transfer or release)" },
  { code: "TX_STOCK_TRANSFER", family: "STOCK", isOcf: true, description: "Shares move to one or more holders; resulting lots and an optional balance lot" },
  { code: "TX_STOCK_CANCELLATION", family: "STOCK", isOcf: true, description: "Shares cancelled (all or part; optional balance lot)" },
  { code: "TX_STOCK_REPURCHASE", family: "STOCK", isOcf: true, description: "Company buys back shares (a forfeiture is a repurchase at 0)" },
  { code: "TX_STOCK_CONVERSION", family: "STOCK", isOcf: true, description: "Shares converted or reclassified into another class" },
  { code: "TX_STOCK_REISSUANCE", family: "STOCK", isOcf: true, description: "Lot re-issued (e.g. lost certificate replaced)" },
  { code: "TX_STOCK_RETRACTION", family: "STOCK", isOcf: true, description: "Issuance retracted: it never legally happened" },
  { code: "TX_STOCK_ACCEPTANCE", family: "STOCK", isOcf: true, description: "Holder accepted the shares or certificate" },
  { code: "TX_EQUITY_COMPENSATION_ISSUANCE", family: "EQUITY_COMPENSATION", isOcf: true, description: "Option (ISO/NSO), RSU or SAR granted" },
  { code: "TX_EQUITY_COMPENSATION_EXERCISE", family: "EQUITY_COMPENSATION", isOcf: true, description: "Option exercised into shares (resulting stock issuances)" },
  { code: "TX_EQUITY_COMPENSATION_CANCELLATION", family: "EQUITY_COMPENSATION", isOcf: true, description: "Award cancelled in whole or part (termination, expiry, forfeiture, waiver)" },
  { code: "TX_EQUITY_COMPENSATION_RELEASE", family: "EQUITY_COMPENSATION", isOcf: true, description: "RSUs settled into shares (net of withholding)" },
  { code: "TX_EQUITY_COMPENSATION_TRANSFER", family: "EQUITY_COMPENSATION", isOcf: true, description: "Award transferred (e.g. on death or to a trust)" },
  { code: "TX_EQUITY_COMPENSATION_RETRACTION", family: "EQUITY_COMPENSATION", isOcf: true, description: "Grant retracted: it never legally happened" },
  { code: "TX_EQUITY_COMPENSATION_ACCEPTANCE", family: "EQUITY_COMPENSATION", isOcf: true, description: "Holder accepted the grant" },
  { code: "TX_WARRANT_ISSUANCE", family: "WARRANT", isOcf: true, description: "Warrant issued" },
  { code: "TX_WARRANT_EXERCISE", family: "WARRANT", isOcf: true, description: "Warrant exercised into shares" },
  { code: "TX_WARRANT_CANCELLATION", family: "WARRANT", isOcf: true, description: "Warrant cancelled or expired" },
  { code: "TX_WARRANT_TRANSFER", family: "WARRANT", isOcf: true, description: "Warrant transferred" },
  { code: "TX_WARRANT_RETRACTION", family: "WARRANT", isOcf: true, description: "Warrant retracted" },
  { code: "TX_WARRANT_ACCEPTANCE", family: "WARRANT", isOcf: true, description: "Holder accepted the warrant" },
  { code: "TX_CONVERTIBLE_ISSUANCE", family: "CONVERTIBLE", isOcf: true, description: "SAFE or convertible note issued" },
  { code: "TX_CONVERTIBLE_CONVERSION", family: "CONVERTIBLE", isOcf: true, description: "SAFE or note converted into shares" },
  { code: "TX_CONVERTIBLE_CANCELLATION", family: "CONVERTIBLE", isOcf: true, description: "SAFE or note cancelled (repaid, terminated)" },
  { code: "TX_CONVERTIBLE_TRANSFER", family: "CONVERTIBLE", isOcf: true, description: "SAFE or note transferred (all or part)" },
  { code: "TX_CONVERTIBLE_RETRACTION", family: "CONVERTIBLE", isOcf: true, description: "SAFE or note retracted" },
  { code: "TX_CONVERTIBLE_ACCEPTANCE", family: "CONVERTIBLE", isOcf: true, description: "Holder accepted the SAFE or note" },
  { code: "TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", family: "STOCK_CLASS", isOcf: true, description: "Authorized shares of a class set (initial or charter amendment)" },
  { code: "TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", family: "STOCK_CLASS", isOcf: true, description: "Conversion ratio of a preferred class changed" },
  { code: "TX_STOCK_CLASS_SPLIT", family: "STOCK_CLASS", isOcf: true, description: "Split of a class: scales issued instruments only; authorized shares change only by an explicit adjustment" },
  { code: "TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT", family: "ISSUER", isOcf: true, description: "Total authorized shares of the company set" },
  { code: "TX_STOCK_PLAN_POOL_ADJUSTMENT", family: "STOCK_PLAN", isOcf: true, description: "Shares reserved under a plan set (initial or amendment)" },
  { code: "TX_STOCK_PLAN_RETURN_TO_POOL", family: "STOCK_PLAN", isOcf: true, description: "Shares explicitly returned to a plan pool" },
  { code: "TX_VESTING_START", family: "VESTING", isOcf: true, description: "Vesting commencement recorded for a security" },
  { code: "TX_VESTING_EVENT", family: "VESTING", isOcf: true, description: "A vesting condition was met for a security" },
  { code: "TX_VESTING_ACCELERATION", family: "VESTING", isOcf: true, description: "Vesting accelerated by a quantity" },
  { code: "X_STOCK_CLASS_TERMS", family: "STOCK_CLASS", isOcf: false, description: "Effective-dated economic terms of a class: votes per share, exclusion from FD, preference, participation, seniority, dividends, anti-dilution" },
  { code: "X_STOCK_PLAN_TERMS", family: "STOCK_PLAN", isOcf: false, description: "Effective-dated plan terms: the five return-to-pool rules, default exit windows, default repurchase window, status and pour-over" },
  { code: "X_EQUITY_COMPENSATION_REPRICING", family: "EQUITY_COMPENSATION", isOcf: false, description: "Exercise price changed; represented as a ledger extension because OCF v1.2.0 has no repricing object type" },
  { code: "X_VESTING_PAUSE", family: "VESTING", isOcf: false, description: "Vesting paused from an effective date" },
  { code: "X_VESTING_RESUME", family: "VESTING", isOcf: false, description: "Paused vesting resumed from an effective date" },
  { code: "X_STAKEHOLDER_TERMINATION", family: "STAKEHOLDER", isOcf: false, description: "Service ended: type, termination date, vesting stop date, ISO-deadline attestations (OCF relationship change on export)" },
  { code: "X_STAKEHOLDER_LEAVE", family: "STAKEHOLDER", isOcf: false, description: "Leave of absence (start, end, right to return) for the ISO deadline" },
  { code: "X_STAKEHOLDER_MERGE", family: "STAKEHOLDER", isOcf: false, description: "Identity fact: one duplicate stakeholder record is the same person as the surviving record" },
  { code: "X_EXECUTION_STATUS", family: "LEDGER", isOcf: false, description: "Execution status of a security (executed, pending: company, holder or both, not required) with its evidence; gates exercise; Mark executed appends one" },
  { code: "X_SECURITY_MODIFICATION", family: "LEDGER", isOcf: false, description: "Legal modification of terms other than price, e.g. a counsel-approved extension of the contractual exercise deadline" },
  { code: "X_REVERSAL", family: "LEDGER", isOcf: false, description: "Voids one transaction of a command; a reverse-command appends one per transaction of the target command" },
  { code: "X_CORRECTION", family: "LEDGER", isOcf: false, description: "Clerical correction that replaces an earlier payload while preserving both records" },
  { code: "X_MIGRATION_OPENING_BALANCE", family: "MIGRATION", isOcf: false, description: "Opening position for an imported lot when earlier transaction history is unavailable; evidence is the source snapshot" },
] as const satisfies readonly { code: string; family: TransactionFamily; isOcf: boolean; description: string }[];

export type TransactionTypeCode = (typeof TRANSACTION_TYPES)[number]["code"];
export type TransactionTypeInfo = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_CODES: readonly TransactionTypeCode[] = TRANSACTION_TYPES.map((t) => t.code);

const BY_CODE = new Map<string, TransactionTypeInfo>(TRANSACTION_TYPES.map((t) => [t.code, t]));

export function isTransactionType(code: unknown): code is TransactionTypeCode {
  return typeof code === "string" && BY_CODE.has(code);
}

export function transactionTypeInfo(code: TransactionTypeCode): TransactionTypeInfo {
  return BY_CODE.get(code)!;
}

/** The security family whose lots a TX_ type acts on, or null for class, plan, stakeholder and ledger types. */
export function securityFamilyOf(code: TransactionTypeCode): "STOCK" | "EQUITY_COMPENSATION" | "WARRANT" | "CONVERTIBLE" | null {
  const family = transactionTypeInfo(code).family;
  return family === "STOCK" || family === "EQUITY_COMPENSATION" || family === "WARRANT" || family === "CONVERTIBLE" ? family : null;
}
