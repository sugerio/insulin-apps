import "./zod-config.ts";
import { z } from "zod";
import { epochMsSchema, isoDateSchema, uuidSchema } from "./primitives.ts";

// The error envelope (the API contract). Every non-2xx JSON response is `{error: {...}}`; the client never sees SQL text.

export const API_ERROR_CODES = [
  "validation_failed", // 400  body, query or path invalid (issues[])
  "unauthenticated", // 401  no console identity
  "forbidden", // 403  role lacks the capability; reason org_inactive or org_read_only
  "self_dealing", // 403  an administrator acting on their own holdings
  "not_found", // 404  also rows of other orgs, rows a holder can't see, and non-UUID ids
  "conflict", // 409  reason: ConflictReason
  "payload_too_large", // 413
  "unsupported_media_type", // 415  type not allowed, or magic bytes don't match
  "digest_mismatch", // 422  the bytes don't match X-Content-SHA256; nothing stored
  "invariant_violation", // 422  engine or product block (violations[])
  "warnings_unacknowledged", // 422  warnings to acknowledge (warnings[])
  "unavailable", // 503  D1 unavailable or reset after its CPU limit; nothing written
  "internal", // 500
] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** The HTTP status of each error code. */
export const API_ERROR_STATUS = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  self_dealing: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  digest_mismatch: 422,
  invariant_violation: 422,
  warnings_unacknowledged: 422,
  unavailable: 503,
  internal: 500,
} as const satisfies Record<ApiErrorCode, number>;

export const CONFLICT_REASONS = [
  "stale_version", // a PATCH or transition sent an old version (the API contract)
  "stale_ledger", // the ledger head moved since the dry run
  "idempotency_key_reused", // same Idempotency-Key, different request
  "state_changed", // a concurrent write won, or the recomputed diff differs from the reviewed one
  "dependents_exist", // reverse-command while dependent commands stand (dependents[])
  "migrated_history", // reverse-command targeting an imported command (the API contract)
] as const;
export const conflictReasonSchema = z.enum(CONFLICT_REASONS);
export type ConflictReason = z.infer<typeof conflictReasonSchema>;

/** `forbidden` reasons the client acts on; others may appear and are shown as a plain refusal. */
export const FORBIDDEN_REASONS = ["org_inactive", "org_read_only"] as const;

/** A hard error from the engine or a product rule (422 invariant_violation). */
export const violationSchema = z.object({
  code: z.string().min(1), // e.g. "EXCEEDS_VESTED_UNEXERCISED", "AFTER_CONTRACTUAL_DEADLINE", "NO_PRESUMPTIVELY_VALID_409A"
  message: z.string(),
  securityId: uuidSchema.optional(),
  effectiveDate: isoDateSchema.optional(),
  // Present when a read-write administrator may override the block with the listed evidence.
  override: z.object({ role: z.literal("admin_rw"), requires: z.array(z.string()).min(1) }).optional(),
});
export type Violation = z.infer<typeof violationSchema>;

/** A business-judgement warning: the request goes through only when its code is sent back in `acknowledge`. */
export const warningSchema = z.object({
  code: z.string().min(1), // e.g. "PAYMENT_EXCEEDS_COST", "ISO_PORTION_AFTER_ISO_DEADLINE", "DUPLICATE_EMAIL"
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type Warning = z.infer<typeof warningSchema>;

/** A command that must be reversed first (409 dependents_exist), newest first. */
export const dependentCommandSchema = z.object({ commandId: uuidSchema, type: z.string(), createdAt: epochMsSchema });

const apiErrorShape = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  reason: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  violations: z.array(violationSchema).optional(),
  warnings: z.array(warningSchema).optional(),
  dependents: z.array(dependentCommandSchema).optional(), // dependents_exist
});

/**
 * The error body checks that conflicts name their reason and the 422s carry the list the client has to show.
 */
export const apiErrorBodySchema = z.object({
  error: apiErrorShape.superRefine((error, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    switch (error.code) {
      case "conflict":
        if (!conflictReasonSchema.safeParse(error.reason).success) issue("reason", "A conflict names a ConflictReason");
        if (error.reason === "dependents_exist" && !error.dependents?.length) issue("dependents", "List the dependents");
        break;
      case "invariant_violation":
        if (!error.violations?.length) issue("violations", "List the violations");
        break;
      case "warnings_unacknowledged":
        if (!error.warnings?.length) issue("warnings", "List the warnings");
        break;
      case "validation_failed":
        if (!error.issues?.length) issue("issues", "List the issues");
        break;
    }
    if (error.dependents !== undefined && error.reason !== "dependents_exist") {
      issue("dependents", "Only a dependents_exist conflict lists dependents");
    }
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** Product codes for 422 invariant_violation responses. Codes stay free strings. */
export const VIOLATION_CODES = [
  // initial company import
  "IMPORT_NOT_READY",
  "STAKEHOLDER_MERGE_NOT_NEUTRAL",
  "DEPENDENCY_EDGE_MISSING",
  "STAKEHOLDER_UNMERGE_BLOCKED",
  // terminate-stakeholder
  "ALREADY_TERMINATED",
  "TERMINATION_DATE_IN_FUTURE",
  "VESTING_STOP_AFTER_TERMINATION",
  "ACCELERATION_EXCEEDS_UNVESTED",
  "REPURCHASE_DEADLINE_NOT_RECORDED",
  "EXTENSION_AFTER_EXPIRATION",
  "TERMINATION_DATE_NOT_IN_FUTURE",
  "VESTING_STOP_BEFORE_ISSUE",
  "NOT_OPTION_OR_WARRANT",
  "FAMILY_MISMATCH",
  // exercise-option
  "EXERCISE_DATE_MISMATCH",
  "EXERCISE_DATE_IN_FUTURE",
  "AFTER_CONTRACTUAL_DEADLINE",
  "EXCEEDS_VESTED_UNEXERCISED",
  "EARLY_EXERCISE_NOT_IN_R1",
  "EXECUTION_PENDING",
  "SECURITY_NOT_OUTSTANDING",
  "PAYMENT_BELOW_COST",
  "NO_FMV_FOR_EXERCISE_DATE",
  "DISPLAY_ID_TAKEN",
  "LOTS_MISMATCH",
  "LOT_CHOICE_NEEDS_REASON",
  "NSO_LOTS_EXCEEDED",
  "RESULTING_SHARES_PORTIONS",
  "RESULTING_QUANTITY_MISMATCH",
  "PORTION_MISMATCH",
  "ZERO_WITHHOLDING_NEEDS_REASON",
  "NON_US_NOTE_REQUIRED",
  "ORPHAN_DERIVED_LOT",
  // grant-equity-compensation
  "EXCEEDS_PLAN_AVAILABLE",
  "MISSING_BOARD_CONSENT",
  "MISSING_EXECUTED_AGREEMENT",
  "NO_PRESUMPTIVELY_VALID_409A",
  "ISO_PRICE_BELOW_FMV",
  "ISO_TEN_PERCENT_TERMS",
  "ISO_NOT_EMPLOYEE",
  "ISO_PLAN_WINDOW",
  "PLAN_EXPIRED",
  "EXPLICIT_SUM_MISMATCH",
  "NON_US_NEEDS_COUNTRY",
  "NSO_PRICE_BELOW_FMV",
  "DOCUMENT_ARCHIVED",
  "DOCUMENT_IS_COMPANY_RESOURCE",
  "DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER",
  // cancellation, leave and plan terms
  "EFFECTIVE_DATE_IN_FUTURE",
  "EXCEEDS_OUTSTANDING",
  "LEAVE_DATES",
  "LEAVE_START_IN_FUTURE",
  "LEAVE_OVERLAPS",
  "EXTENSION_SHORTENS_DEADLINE",
  "PLAN_TERMS_BEFORE_CURRENT",
  "POUR_OVER_INVALID",
  // mark-executed
  "NOT_EXECUTION_PENDING",
  // reverse-command accepts only the types in the reversal allowlist.
  "COMMAND_NOT_REVERSIBLE",
  "STAKEHOLDER_MERGE_SAME_RECORD",
  "STAKEHOLDER_ALREADY_MERGED",
  "STAKEHOLDER_ARCHIVED",
  "STAKEHOLDER_KIND_MISMATCH",
  "STAKEHOLDER_TERMINATION_CONFLICT",
  "STAKEHOLDER_MERGE_BLOCKED",
  "NOT_IN_EXPIRY_RUN",
  "NOT_EXPIRABLE",
  // 409A valuations and the vesting-template confirmation
  "COMMON_PRICE_REQUIRED",
  "DUPLICATE_CLASS_PRICE",
  "EXPIRATION_NOT_AFTER_EFFECTIVE",
  "VALUATION_ON_DATE_EXISTS",
  "EVENT_DATE_IN_FUTURE",
  "NO_REVIEW_REQUIRED",
  "EVENT_NOT_REVERSIBLE",
  "NOT_AN_IMPORTED_TEMPLATE",
  // reference data and documents
  "SHARE_UNIT_FROZEN",
  "LINK_PERMANENT",
  "MULTIPLE_HOLDERS",
  "COLLECTION_CYCLE",
  "REQUIRED_STAKEHOLDER_FIELD",
  // ledger verification
  "LEDGER_HEAD_MISMATCH",
  "LEDGER_SEQUENCE_GAP",
  "LEDGER_PREVIOUS_HASH_MISMATCH",
  "LEDGER_PAYLOAD_HASH_MISMATCH",
  "LEDGER_HASH_MISMATCH",
  "COMMAND_SEAL_MISMATCH",
  "VESTING_TERMS_HASH_MISMATCH",
  // payment instructions are live portal data
  "ORG_NOT_ACTIVE",
] as const;

/** Warning codes named by the API contract. */
export const WARNING_CODES = [
  "DUPLICATE_EMAIL",
  "PAYMENT_EXCEEDS_COST",
  "PAYER_NOT_HOLDER",
  "ISO_PORTION_AFTER_ISO_DEADLINE",
  "NSO_PRICE_BELOW_FMV",
  "ISO_MODIFICATION_RISK",
] as const;

/** `acknowledge[]`: the warning codes the person accepted (the API contract). */
export const acknowledgeSchema = z.array(z.string().min(1).max(64)).max(20).default([]);
