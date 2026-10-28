import "./zod-config.ts";
import { z } from "zod";
import { isIsoDate } from "./dates.ts";
import { CANONICAL_DECIMAL, MAX_DECIMAL_LENGTH } from "./decimal.ts";

/**
 * The zod primitives of ledger payloads. They follow the API contract(the same regexes as the API's `Dec`, `IsoDate` and
 * `Uuid`) under engine-specific names, so the package index can expose the API's schemas and the engine side by side.
 */

/** Canonical non-negative decimal text, the storage form (the ledger rules; the CHECK on every decimal column). */
export const DecimalString = z.string().max(MAX_DECIMAL_LENGTH).regex(CANONICAL_DECIMAL, "Expected a canonical decimal");
export const PositiveDecimalString = DecimalString.refine((value) => value !== "0", "Must be greater than 0");
export const IsoDateString = z.string().refine(isIsoDate, "Expected a date (YYYY-MM-DD)");
export const UuidString = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "Expected a UUID");
export const Sha256HexString = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase hex SHA-256");
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 code");

/** OCF `Monetary`. */
export const Monetary = z.strictObject({ amount: DecimalString, currency: CurrencyCode });
export type Monetary = z.infer<typeof Monetary>;

/** OCF `Ratio` (a split or conversion ratio, numerator:denominator). */
export const RatioSchema = z.strictObject({ numerator: PositiveDecimalString, denominator: PositiveDecimalString });
export type RatioValue = z.infer<typeof RatioSchema>;

/** OCF `SecurityExemption`. */
export const SecurityExemption = z.strictObject({ description: z.string().min(1).max(200), jurisdiction: z.string().min(1).max(64) });

/** OCF `TerminationWindowType`. Our six termination types map onto these (`terminationWindowReason`). */
export const TerminationWindowReason = z.enum([
  "VOLUNTARY_OTHER",
  "VOLUNTARY_GOOD_CAUSE",
  "VOLUNTARY_RETIREMENT",
  "INVOLUNTARY_OTHER",
  "INVOLUNTARY_DEATH",
  "INVOLUNTARY_DISABILITY",
  "INVOLUNTARY_WITH_CAUSE",
]);
export type TerminationWindowReason = z.infer<typeof TerminationWindowReason>;

/** OCF `PeriodType`. The API's QUARTERS are written as 3 × MONTHS. */
export const OcfPeriodType = z.enum(["DAYS", "MONTHS", "YEARS"]);
export type OcfPeriodType = z.infer<typeof OcfPeriodType>;

/** OCF `TerminationWindow`. A 0-day window is valid (with cause, CL-23). */
export const TerminationWindowSchema = z.strictObject({
  reason: TerminationWindowReason,
  period: z.number().int().min(0).max(1200),
  period_type: OcfPeriodType,
});
export type TerminationWindow = z.infer<typeof TerminationWindowSchema>;

export const PeriodSchema = z.strictObject({ period: z.number().int().min(0).max(1200), period_type: OcfPeriodType });
export type Period = z.infer<typeof PeriodSchema>;

/** Where a migrated fact came from (the ledger and migration rules), covered by the payload hash. */
export const Evidence = z.strictObject({
  run: z.string().min(1).max(200),
  file: z.string().min(1).max(500),
  pointer: z.string().max(500),
  sha256: Sha256HexString,
  kind: z.string().min(1).max(64).optional(),
});
export const EvidenceList = z.array(Evidence).min(1).max(50);
export type Evidence = z.infer<typeof Evidence>;

/** A frozen document a payload relies on, by id and content hash, so the chain covers the evidence. */
export const DocumentRef = z.strictObject({ id: UuidString, sha256: Sha256HexString });
export type DocumentRef = z.infer<typeof DocumentRef>;

export const Relationship = z.enum([
  "founder",
  "employee",
  "ex_employee",
  "officer",
  "board_member",
  "advisor",
  "consultant",
  "investor",
  "other",
]);
export type Relationship = z.infer<typeof Relationship>;

export const TerminationType = z.enum(["voluntary", "involuntary", "with_cause", "death", "disability", "retirement"]);
export type TerminationType = z.infer<typeof TerminationType>;

export const ExecutionStatus = z.enum(["executed", "pending_company", "pending_holder", "pending_both", "not_required"]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const FederalExemption = z.enum(["RULE_701", "SECTION_4A2", "REG_D_506B", "REG_D_506C", "REG_S", "NON_US", "NONE", "OTHER"]);
export type FederalExemption = z.infer<typeof FederalExemption>;

export const Exemption = z.strictObject({
  federal: FederalExemption,
  country: z.string().length(2).optional(),
  state: z.string().max(40).optional(),
});
export type Exemption = z.infer<typeof Exemption>;

export const PaymentMethod = z.enum(["ACH", "WIRE", "CHECK", "CASH", "MANUAL_UNSPECIFIED", "OTHER"]);
export const TaxTreatment = z.enum(["W2", "FORM_1099_NEC", "NON_US"]);
export const OptionPortion = z.enum(["ISO", "NSO"]);
export type OptionPortion = z.infer<typeof OptionPortion>;
