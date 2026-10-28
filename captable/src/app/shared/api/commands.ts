import "./zod-config.ts";
import { z } from "zod";
import { periodSchema, planReturnRulesSchema, terminationWindowSchema } from "./common.ts";
import { checkTrancheOrder } from "./equity.ts";
import {
  ACCELERATION_KINDS,
  cancelReasonSchema,
  CHANGE_ENTITIES,
  type CommandName,
  dependencyKindSchema,
  exercisePaymentMethodSchema,
  expiryModeSchema,
  federalExemptionSchema,
  optionTypeSchema,
  type OrgAccess,
  planStatusSchema,
  relationshipSchema,
  SCHEDULED_TERMINATION_STATUSES,
  taxTreatmentSchema,
  terminationTypeSchema,
  transactionTypeSchema,
} from "./enums.ts";
import { acknowledgeSchema, violationSchema, warningSchema } from "./errors.ts";
import {
  confirmationSchema,
  decimalSchema,
  displayIdSchema,
  emailSchema,
  epochMsSchema,
  integerIdSchema,
  isoDateSchema,
  ledgerSeqSchema,
  listSchema,
  noteSchema,
  positiveDecimalSchema,
  queryBooleanSchema,
  sha256HexSchema,
  uniqueIdsSchema,
  uuidSchema,
  versionSchema,
} from "./primitives.ts";

// Commands: the ledger writes (the API contract). `POST /api/orgs/:orgId/commands/<name>[?dryRun=true]`. Each is one D1 batch;
// the engine replays the whole ledger with the new transactions, refuses any violation (422) and requires every
// warning to be acknowledged. Every command refuses an admin's own holdings (403 self_dealing), comes only from a
// console administrator and keeps the self-dealing guard.

/** `?dryRun=true` stops after the engine and returns the diff to review; it neither needs nor consumes a key. */
export const commandQuerySchema = z.object({ dryRun: queryBooleanSchema.optional() });

const envelopeShape = {
  acknowledge: acknowledgeSchema, // warning codes the person accepted
  documentIds: z.array(uuidSchema).max(20).default([]), // supporting documents linked with role EVIDENCE
  note: noteSchema.optional(), // required for reversals, overrides and extensions
};

/**
 * The envelope of a real call: the ledger seq the dry run showed and the `diffSha256` of the changes the person
 * reviewed. A moved head is 409 stale_ledger; a different recomputed diff, 409 state_changed.
 */
export const commandEnvelopeSchema = z.strictObject({
  expectedLedgerSeq: ledgerSeqSchema,
  expectedDiffSha256: sha256HexSchema,
  ...envelopeShape,
});
export type CommandEnvelope = z.output<typeof commandEnvelopeSchema>;

/** The envelope of a dry run, which is what produces `expectedLedgerSeq` and `expectedDiffSha256`. */
export const dryRunEnvelopeSchema = z.strictObject({
  expectedLedgerSeq: ledgerSeqSchema.optional(),
  expectedDiffSha256: sha256HexSchema.optional(),
  ...envelopeShape,
});

export const commandResultSchema = z.object({
  commandId: uuidSchema.nullable(), // null for a dry run
  dryRun: z.boolean(),
  ledgerSeq: ledgerSeqSchema, // the new head, or the current head for a dry run
  ledgerHeadHash: sha256HexSchema.nullable(),
  transactions: z.array(
    z.object({
      id: uuidSchema.nullable(),
      seq: z.number().int().positive().nullable(),
      type: transactionTypeSchema,
      effectiveDate: isoDateSchema,
      securityId: uuidSchema.nullable(),
      quantity: decimalSchema.nullable(),
    }),
  ),
  created: z.object({
    securityIds: z.array(uuidSchema),
    scheduledTerminationIds: z.array(uuidSchema),
    vestingTermsIds: z.array(uuidSchema),
  }),
  changes: z.array(
    z.object({
      entity: z.enum(CHANGE_ENTITIES),
      id: uuidSchema,
      before: z.record(z.string(), z.unknown()).nullable(),
      after: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
  // SHA-256 of the canonical changes and transactions without generated ids and seqs, so it is stable between the
  // dry run and the real call; the real call must send it back (expectedDiffSha256).
  diffSha256: sha256HexSchema,
  // What the command itself does: its transactions, its changes to the securities, deadlines, vesting and stakeholders
  // it touches, and the org-wide totals (pool, class totals, capital) as deltas. A bulk flow re-runs each later item's
  // dry run and asks again only when this differs from the reviewed one; the real call still sends the new `diffSha256`
  // and `ledgerSeq` (the API contract). Never sent back.
  effectSha256: sha256HexSchema,
  dependencies: z.array(z.object({ commandId: uuidSchema, kind: dependencyKindSchema })),
  /** Populated by a merge dry run when it is safely previewed but cannot be committed. */
  violations: z.array(violationSchema),
  warnings: z.array(warningSchema),
  // exercise-option only: the lots and portions the server derived for the exercise date, ISO first unless the request
  // chose its lots (with a reason). A dry run shows them; the real call sends `lots` and `resultingShares` exactly as
  // shown, and anything else is refused (LOTS_MISMATCH, RESULTING_SHARES_PORTIONS, or 409 state_changed on the diff).
  exercise: z
    .object({
      date: isoDateSchema, // the exercise date the split is for
      isoAvailable: decimalSchema, // ISO-designated options still exercisable as ISO on the date ($100K test, earlier exercises out)
      lots: z.object({ iso: decimalSchema, nso: decimalSchema }), // the ISO and NSO lots consumed
      // One resulting share lot per portion, with the display ID it will have.
      portions: z.array(z.object({
        portion: optionTypeSchema,
        quantity: decimalSchema,
        reason: z.enum(["AFTER_ISO_DEADLINE", "ISO_LIMIT", "LOT_CHOICE"]).nullable(), // why shares of an ISO grant are NSO
        displayId: z.string().min(1).max(40),
      })),
    })
    .optional(),
  stakeholderMerge: z.object({
    merged: z.object({ id: uuidSchema, displayName: z.string() }),
    survivor: z.object({ id: uuidSchema, displayName: z.string() }),
    holdings: z.object({
      survivorBefore: z.object({ securityCount: z.number().int().nonnegative(), issuedAndOutstanding: decimalSchema, fullyDiluted: decimalSchema, capitalContribution: decimalSchema }),
      mergedBefore: z.object({ securityCount: z.number().int().nonnegative(), issuedAndOutstanding: decimalSchema, fullyDiluted: decimalSchema, capitalContribution: decimalSchema }),
      survivorAfter: z.object({ securityCount: z.number().int().nonnegative(), issuedAndOutstanding: decimalSchema, fullyDiluted: decimalSchema, capitalContribution: decimalSchema }),
    }),
    addresses: z.array(z.object({
      email: z.string(), action: z.enum(["move", "deduplicate"]),
    })),
    profileDifferences: z.array(z.object({ field: z.string(), survivorValue: z.unknown(), mergedValue: z.unknown() })),
    blockingItems: z.array(z.object({ type: z.string(), id: z.string(), label: z.string() })),
    confirmation: z.string(),
  }).optional(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;

// Cross-field rules expressible from the request are 400 validation_failed here. Rules that need the
// ledger (deadlines, vesting, FMV, the ISO-first split) are the engine's 422 violations, so zod never duplicates them.
type IssueSink = { addIssue(issue: { code: "custom"; path: (string | number)[]; message: string }): void };

function uniquePortions(items: readonly { portion: string }[] | undefined, path: string, ctx: IssueSink): void {
  if (items && new Set(items.map((item) => item.portion)).size !== items.length) {
    ctx.addIssue({ code: "custom", path: [path], message: "Each portion (ISO, NSO) can appear only once" });
  }
}

// ---------------------------------------------------------------------------
// terminate-stakeholder — RW+

const terminateStakeholderShape = {
  stakeholderId: uuidSchema,
  terminationDate: isoDateSchema, // ≤ the org's today; a future date uses schedule-termination
  terminationType: terminationTypeSchema,
  vestingStopDate: isoDateSchema.optional(), // default: the termination date; may be earlier, never later
  disabilityAttestation: z.boolean().optional(), // §22(e)(3) permanent and total disability; changes only the ISO deadline
  relationshipAfter: relationshipSchema.default("ex_employee"),
  accelerations: z
    .array(z.strictObject({ securityId: uuidSchema, quantity: positiveDecimalSchema, reason: noteSchema, documentId: uuidSchema }))
    .default([]),
  // From a separation agreement, recorded with its document (the product rules).
  deadlineExtensions: z
    .array(z.strictObject({ securityId: uuidSchema, newContractualDeadline: isoDateSchema, documentId: uuidSchema }))
    .default([]),
  // Restricted share lots whose repurchase deadline Pulley didn't record (blocks until it is entered).
  repurchaseDeadlines: z
    .array(z.strictObject({ securityId: uuidSchema, lastRepurchaseDate: isoDateSchema, documentId: uuidSchema }))
    .default([]),
};
export const terminateStakeholderSchema = commandEnvelopeSchema.extend(terminateStakeholderShape);
export const terminateStakeholderDryRunSchema = dryRunEnvelopeSchema.extend(terminateStakeholderShape);
export type TerminateStakeholder = z.output<typeof terminateStakeholderSchema>;
export type TerminateStakeholderInput = z.input<typeof terminateStakeholderSchema>;

// ---------------------------------------------------------------------------
// schedule-termination — RW+ (workflow; no transaction)

/**
 * The TerminateStakeholder fields with a termination date after the org's today. `expectedLedgerSeq` is optional;
 * `expectedDiffSha256` is the reviewed preview. On-demand due processing applies the stored body on the date.
 */
export const scheduleTerminationSchema = commandEnvelopeSchema.extend({
  ...terminateStakeholderShape,
  expectedLedgerSeq: ledgerSeqSchema.optional(),
});
export const scheduleTerminationDryRunSchema = dryRunEnvelopeSchema.extend(terminateStakeholderShape);
export type ScheduleTermination = z.output<typeof scheduleTerminationSchema>;
export type ScheduleTerminationInput = z.input<typeof scheduleTerminationSchema>;
/** The preview evaluates against today's ledger; `scheduledTerminationId` is null for a dry run. */
export const scheduleTerminationResponseSchema = z.object({
  scheduledTerminationId: uuidSchema.nullable(),
  preview: commandResultSchema,
});
export type ScheduleTerminationResponse = z.infer<typeof scheduleTerminationResponseSchema>;

// ---------------------------------------------------------------------------
// cancel-scheduled-termination — write administrator (workflow)

/** A strict object with no envelope: SCHEDULED → CANCELLED, or 409 state_changed if due processing applied it first. */
export const cancelScheduledTerminationSchema = z.strictObject({
  scheduledTerminationId: uuidSchema,
  version: versionSchema,
  note: noteSchema,
});
export type CancelScheduledTermination = z.output<typeof cancelScheduledTerminationSchema>;

export const scheduledTerminationSchema = z.object({
  id: uuidSchema,
  stakeholderId: uuidSchema,
  terminationDate: isoDateSchema,
  terminationType: terminationTypeSchema,
  vestingStopDate: isoDateSchema,
  status: z.enum(SCHEDULED_TERMINATION_STATUSES),
  appliedCommandId: uuidSchema.nullable(),
  cancelledBy: z.string().nullable(),
  cancelledAt: epochMsSchema.nullable(),
  cancelNote: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: epochMsSchema,
  version: versionSchema,
});
export type ScheduledTermination = z.infer<typeof scheduledTerminationSchema>;

// ---------------------------------------------------------------------------
// exercise-option — RW+: record an exercise the holder reported (the product rules)

const exerciseOptionShape = {
  securityId: uuidSchema, // an OPTION_ISO or OPTION_NSO security
  quantity: positiveDecimalSchema, // ≤ vested and unexercised at the exercise date
  notice: z.strictObject({ documentId: uuidSchema, receivedOn: isoDateSchema }), // the signed notice, linked on commit
  payment: z.strictObject({
    amount: positiveDecimalSchema,
    receivedOn: isoDateSchema,
    method: exercisePaymentMethodSchema,
    reference: z.string().min(1).max(200),
    payerIsHolder: z.boolean().default(true),
    payerNote: z.string().max(500).optional(), // required when the payer isn't the holder
  }),
  // Computed by the server as the later of notice.receivedOn and payment.receivedOn; sent back to prove what was reviewed.
  exerciseDate: isoDateSchema,
  lots: z.array(z.strictObject({ portion: optionTypeSchema, quantity: positiveDecimalSchema })).min(1).max(2).optional(), // default ISO-first
  lotReason: noteSchema.optional(), // required when lots differ from ISO-first (checked by the engine)
  fmv: z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("valuation"), valuationId: uuidSchema }), // presumptively valid on the exercise date
    z.strictObject({ source: z.literal("manual"), pricePerShare: positiveDecimalSchema, sourceNote: noteSchema, documentId: uuidSchema }),
  ]),
  tax: z.strictObject({
    // entered by the admin, never computed (scope decision)
    treatment: taxTreatmentSchema,
    withholding: z
      .strictObject({
        federalIncome: decimalSchema,
        socialSecurity: decimalSchema,
        medicare: decimalSchema,
        state: z.array(z.strictObject({ code: z.string().regex(/^[A-Z]{2}$/), amount: decimalSchema })).max(3).default([]),
      })
      .optional(),
    zeroReason: noteSchema.optional(), // required for W2 when the NSO spread is above 0 and every withholding line is 0
    nonUsNote: noteSchema.optional(), // NON_US: "handled by local payroll in <country>"
  }),
  // One per portion. Left out, the server derives the portions (ISO first) and their display IDs; a dry run returns
  // them in `CommandResult.exercise`, and the real call sends them back exactly.
  resultingShares: z.array(z.strictObject({ portion: optionTypeSchema, displayId: z.string().min(1).max(40).optional() })).min(1).max(2).optional(),
};
function checkExerciseOption(
  body: { payment: { payerIsHolder: boolean; payerNote?: string | undefined }; lots?: { portion: string }[] | undefined; resultingShares?: { portion: string }[] | undefined },
  ctx: IssueSink,
): void {
  if (!body.payment.payerIsHolder && !body.payment.payerNote?.trim()) {
    ctx.addIssue({ code: "custom", path: ["payment", "payerNote"], message: "Say who paid when the payer isn't the holder" });
  }
  uniquePortions(body.lots, "lots", ctx);
  uniquePortions(body.resultingShares, "resultingShares", ctx);
}
export const exerciseOptionSchema = commandEnvelopeSchema.extend(exerciseOptionShape).superRefine(checkExerciseOption);
export const exerciseOptionDryRunSchema = dryRunEnvelopeSchema.extend(exerciseOptionShape).superRefine(checkExerciseOption);
export type ExerciseOption = z.output<typeof exerciseOptionSchema>;
export type ExerciseOptionInput = z.input<typeof exerciseOptionSchema>;

// ---------------------------------------------------------------------------
// grant-equity-compensation — RW+: record a signed option grant (the product rules)

const grantEquityCompensationShape = {
  stockPlanId: uuidSchema,
  stakeholderId: uuidSchema, // add a new stakeholder first (POST /stakeholders)
  quantity: positiveDecimalSchema, // ≤ the plan's available to grant (block)
  board: z.strictObject({ approvalDate: isoDateSchema, consentDocumentId: uuidSchema }), // block if missing
  grantDate: isoDateSchema.optional(), // default: the board approval date
  grantDateOverrideReason: noteSchema.optional(), // required when the grant date differs
  optionType: optionTypeSchema,
  isoAttestations: z.strictObject({ employeeAtGrant: z.literal(true), tenPercentHolder: z.boolean() }).optional(), // required for ISO
  vesting: z.strictObject({
    terms: z.union([
      z.strictObject({ templateId: uuidSchema }),
      z.strictObject({ explicit: z.array(z.strictObject({ date: isoDateSchema, quantity: positiveDecimalSchema })).min(1).max(240) }),
    ]),
    vestingStartDate: isoDateSchema,
    earlyExercisable: z.boolean(),
    accelerationTerms: z.strictObject({
      kind: z.enum(ACCELERATION_KINDS),
      percent: decimalSchema.optional(),
      months: z.number().int().min(0).max(60).optional(),
      text: z.string().max(4000).optional(),
    }),
    matchesSignedAgreement: z.literal(true), // "The generated table matches the signed agreement"
  }),
  exercisePrice: positiveDecimalSchema,
  valuationId: uuidSchema, // presumptively valid on the grant date (block; owner/admin override below)
  counselMemoDocumentId: uuidSchema.optional(), // owner/admin override of a missing valid 409A, or an NSO strike below FMV
  expirationDate: isoDateSchema, // default grant date + 10 years (5 for a 10%-holder ISO)
  terminationExerciseWindows: z.array(terminationWindowSchema).optional(), // default: the plan's, as of the grant date
  exemption: z.strictObject({
    federal: federalExemptionSchema,
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    state: z.string().max(40).optional(),
  }), // NON_US needs a country (422 NON_US_NEEDS_COUNTRY)
  legendIds: z.array(uuidSchema).default([]),
  issueReason: z.string().max(200).optional(),
  displayId: z.string().min(1).max(40).optional(), // default OPT-<next>; unique per org, never reused
  executedAgreement: z.strictObject({ documentId: uuidSchema, signedByHolderAndSignatory: z.literal(true) }), // block if missing
};
function checkGrant(
  body: {
    optionType: string;
    isoAttestations?: unknown;
    grantDate?: string | undefined;
    grantDateOverrideReason?: string | undefined;
    board: { approvalDate: string };
    vesting: { terms: { templateId: string } | { explicit: { date: string }[] } };
  },
  ctx: IssueSink,
): void {
  if ("explicit" in body.vesting.terms) checkTrancheOrder(body.vesting.terms.explicit, ctx, ["vesting", "terms", "explicit"]);
  if (body.optionType === "ISO" && body.isoAttestations === undefined) {
    ctx.addIssue({ code: "custom", path: ["isoAttestations"], message: "An ISO needs the employee and 10% holder attestations" });
  }
  if (body.grantDate !== undefined && body.grantDate !== body.board.approvalDate && body.grantDateOverrideReason === undefined) {
    ctx.addIssue({ code: "custom", path: ["grantDateOverrideReason"], message: "Say why the grant date differs from the board approval" });
  }
}
export const grantEquityCompensationSchema = commandEnvelopeSchema.extend(grantEquityCompensationShape).superRefine(checkGrant);
export const grantEquityCompensationDryRunSchema = dryRunEnvelopeSchema.extend(grantEquityCompensationShape).superRefine(checkGrant);
export type GrantEquityCompensation = z.output<typeof grantEquityCompensationSchema>;
export type GrantEquityCompensationInput = z.input<typeof grantEquityCompensationSchema>;

// ---------------------------------------------------------------------------
// cancel-security — RW+ (options and warrants only)

const cancelSecurityShape = {
  securityId: uuidSchema,
  effectiveDate: isoDateSchema, // ≤ the org's today
  quantity: positiveDecimalSchema.optional(), // default: everything outstanding
  reason: cancelReasonSchema,
  reasonText: z.string().max(500).optional(),
  documentId: uuidSchema, // required: the waiver, agreement or evidence of non-execution
  confirmation: confirmationSchema, // the typed display ID, e.g. "OPT-33" (the product rules)
};
export const cancelSecuritySchema = commandEnvelopeSchema.extend(cancelSecurityShape);
// A dry run previews before the person types the confirmation: it may leave it out (the real call checks it).
export const cancelSecurityDryRunSchema = dryRunEnvelopeSchema.extend({ ...cancelSecurityShape, confirmation: confirmationSchema.optional() });
export type CancelSecurity = z.output<typeof cancelSecuritySchema>;
export type CancelSecurityInput = z.input<typeof cancelSecuritySchema>;

// ---------------------------------------------------------------------------
// mark-executed — RW+

const markExecutedShape = {
  securityId: uuidSchema,
  executedAgreementDocumentId: uuidSchema, // signed by both parties and linked (AGREEMENT) in the same batch
  signatureDates: z.strictObject({ company: isoDateSchema.optional(), holder: isoDateSchema.optional() }),
  attestation: z.literal("This PDF bears both signatures"),
  confirmation: confirmationSchema, // the typed display ID
};
export const markExecutedSchema = commandEnvelopeSchema.extend(markExecutedShape);
export const markExecutedDryRunSchema = dryRunEnvelopeSchema.extend({ ...markExecutedShape, confirmation: confirmationSchema.optional() });
export type MarkExecuted = z.output<typeof markExecutedSchema>;
export type MarkExecutedInput = z.input<typeof markExecutedSchema>;

// ---------------------------------------------------------------------------
// record-leave-of-absence — RW+

const recordLeaveOfAbsenceShape = {
  stakeholderId: uuidSchema,
  // A leave is identified by its start date. A recorded leave's start date records that leave again: its end once known
  // (closing an open leave), or a corrected end or right to return; the later record replaces the earlier one. Another
  // start date is a new leave, which may not overlap a recorded one (LEAVE_OVERLAPS).
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullable(),
  returnGuaranteed: z.boolean(),
  documentId: uuidSchema.optional(),
};
export const recordLeaveOfAbsenceSchema = commandEnvelopeSchema.extend(recordLeaveOfAbsenceShape);
export const recordLeaveOfAbsenceDryRunSchema = dryRunEnvelopeSchema.extend(recordLeaveOfAbsenceShape);
export type RecordLeaveOfAbsence = z.output<typeof recordLeaveOfAbsenceSchema>;
export type RecordLeaveOfAbsenceInput = z.input<typeof recordLeaveOfAbsenceSchema>;

// ---------------------------------------------------------------------------
// extend-exercise-deadline — write administrator

const extendExerciseDeadlineShape = {
  securityId: uuidSchema,
  newContractualDeadline: isoDateSchema, // later than the current one, no later than expiration; the ISO deadline never moves
  documentId: uuidSchema, // separation agreement or counsel approval
  note: noteSchema,
  confirmation: confirmationSchema,
};
export const extendExerciseDeadlineSchema = commandEnvelopeSchema.extend(extendExerciseDeadlineShape);
export const extendExerciseDeadlineDryRunSchema = dryRunEnvelopeSchema.extend({ ...extendExerciseDeadlineShape, confirmation: confirmationSchema.optional() });
export type ExtendExerciseDeadline = z.output<typeof extendExerciseDeadlineSchema>;
export type ExtendExerciseDeadlineInput = z.input<typeof extendExerciseDeadlineSchema>;

// ---------------------------------------------------------------------------
// set-plan-terms — write administrator

const setPlanTermsShape = {
  stockPlanId: uuidSchema,
  effectiveDate: isoDateSchema, // changes availability only for dates on or after it; history is unchanged
  returnRules: planReturnRulesSchema, // all five, required: no defaults
  defaultTerminationWindows: z.array(terminationWindowSchema).length(6), // one per reason; 0 is allowed
  defaultRepurchaseWindow: periodSchema.nullable(),
  status: planStatusSchema,
  pourOverPlanId: uuidSchema.nullable(),
  documentId: uuidSchema, // the linked plan document or counsel's confirmation
  note: noteSchema,
};
function checkPlanTerms(body: { defaultTerminationWindows: { reason: string }[] }, ctx: IssueSink): void {
  const reasons = new Set(body.defaultTerminationWindows.map((window) => window.reason));
  if (reasons.size !== body.defaultTerminationWindows.length) {
    ctx.addIssue({ code: "custom", path: ["defaultTerminationWindows"], message: "Give one window per termination reason" });
  }
}
export const setPlanTermsSchema = commandEnvelopeSchema.extend(setPlanTermsShape).superRefine(checkPlanTerms);
export const setPlanTermsDryRunSchema = dryRunEnvelopeSchema.extend(setPlanTermsShape).superRefine(checkPlanTerms);
export type SetPlanTerms = z.output<typeof setPlanTermsSchema>;
export type SetPlanTermsInput = z.input<typeof setPlanTermsSchema>;

// ---------------------------------------------------------------------------
// merge-stakeholders — write administrator

const mergeStakeholdersShape = {
  mergedStakeholderId: uuidSchema,
  survivingStakeholderId: uuidSchema,
  reason: noteSchema,
  confirmation: confirmationSchema,
};
export const mergeStakeholdersSchema = commandEnvelopeSchema.extend(mergeStakeholdersShape);
export const mergeStakeholdersDryRunSchema = dryRunEnvelopeSchema.extend({ ...mergeStakeholdersShape, confirmation: confirmationSchema.optional() });
export type MergeStakeholders = z.output<typeof mergeStakeholdersSchema>;
export type MergeStakeholdersInput = z.input<typeof mergeStakeholdersSchema>;

// ---------------------------------------------------------------------------
// reverse-command — write administrator

/** Reverses every transaction of one command, in one batch. The preview (GET …/reversal-preview) gives the diff. */
export const reverseCommandSchema = z.strictObject({
  commandId: uuidSchema, // the command whose transactions are all reversed
  note: noteSchema, // the reason (required)
  expectedLedgerSeq: ledgerSeqSchema,
  expectedDiffSha256: sha256HexSchema, // from GET …/reversal-preview
  confirmation: confirmationSchema, // the typed ID of the main object, e.g. "OPT-33"
});
export type ReverseCommand = z.output<typeof reverseCommandSchema>;
export type ReverseCommandInput = z.input<typeof reverseCommandSchema>;

export const reversalPreviewSchema = z.object({
  commandId: uuidSchema,
  commandType: z.string(),
  importedFromPulley: z.boolean(),
  inverse: z.array(z.object({ reversesTransactionId: uuidSchema, type: transactionTypeSchema, effectiveDate: isoDateSchema })),
  // The causal closure, newest first: each one is reversed first, as its own act with its own reason.
  dependents: z.array(z.object({ commandId: uuidSchema, type: z.string(), createdAt: epochMsSchema, kind: dependencyKindSchema })),
  changes: commandResultSchema.shape.changes,
  workflowEffects: z.array(
    z.object({ kind: z.enum(["exercise_request", "stakeholder_relationship"]), id: uuidSchema, from: z.string(), to: z.string() }),
  ),
  violations: z.array(violationSchema),
  blocked: z.boolean(),
  diffSha256: sha256HexSchema,
  ledgerSeq: ledgerSeqSchema,
});
export type ReversalPreview = z.infer<typeof reversalPreviewSchema>;

// ---------------------------------------------------------------------------
// Confirming the first expiry run (report_only mode, the route policy)

/**
 * `POST /api/orgs/:orgId/expiry-runs/:runId/confirm?dryRun=true`: what confirming would do, one dry run per chosen
 * security at the current head. Each `CommandResult` carries the `ledgerSeq` and `effectSha256` the real call sends back.
 */
export const confirmExpiryRunDryRunSchema = z.strictObject({
  securityIds: uniqueIdsSchema(0, 1000),
  switchToAutomatic: z.boolean().optional(),
});

/**
 * `POST /api/orgs/:orgId/expiry-runs/:runId/confirm`: appends the confirmed cancellations as expire-securities.
 * It is bound to what the dry run showed: `expectedLedgerSeq` is the dry run's head, and `expectedEffectSha256s` holds
 * each security's `effectSha256` from it. Each expiry, a resumed one included, commits only if its effect is still the
 * reviewed one (409 `state_changed` otherwise). The siblings it confirms move the org-wide totals, so the effect, not
 * the exact diff, is what each expiry is held to.
 */
export const confirmExpiryRunSchema = z.strictObject({
  expectedLedgerSeq: ledgerSeqSchema,
  securityIds: uniqueIdsSchema(0, 1000),
  expectedEffectSha256s: z.record(uuidSchema, sha256HexSchema),
  switchToAutomatic: z.boolean(),
}).superRefine((body, ctx) => {
  const keys = Object.keys(body.expectedEffectSha256s);
  if (keys.length !== body.securityIds.length || body.securityIds.some((id) => body.expectedEffectSha256s[id] === undefined)) {
    ctx.addIssue({ code: "custom", path: ["expectedEffectSha256s"], message: "Send the reviewed effectSha256 of exactly the securities confirmed" });
  }
});
export type ConfirmExpiryRun = z.output<typeof confirmExpiryRunSchema>;
export type ConfirmExpiryRunDryRun = z.output<typeof confirmExpiryRunDryRunSchema>;

/**
 * An expiry run's state. Each day's run re-proposes every current candidate, so only the org's newest report-only run,
 * while expiry is report-only, is the one to confirm:
 * - `pending`: that run, with no confirmation started;
 * - `confirming`: that run, with a confirmation bound to it that hasn't finished (under way, or stopped: its exact retry
 *   resumes);
 * - `confirmed`;
 * - `superseded`: any other run never confirmed (a newer run exists, or the org's expiry is automatic), a stopped
 *   confirmation included.
 */
export const EXPIRY_RUN_STATES = ["pending", "confirming", "confirmed", "superseded"] as const;
export const expiryRunStateSchema = z.enum(EXPIRY_RUN_STATES);
export type ExpiryRunState = z.infer<typeof expiryRunStateSchema>;

/** `GET …/expiry-runs` items: a report-only on-demand expiry run. */
export const expiryRunSummarySchema = z.object({
  runId: integerIdSchema,
  localDate: isoDateSchema, // the company-local date due processing ran for
  startedAt: epochMsSchema,
  state: expiryRunStateSchema,
  proposalCount: z.number().int().nonnegative(),
});
export type ExpiryRunSummary = z.infer<typeof expiryRunSummarySchema>;
/** `GET …/expiry-runs`: the runs pending confirmation (`pending` or `confirming`): at most the newest run. */
export const expiryRunListSchema = listSchema(expiryRunSummarySchema);
export type ExpiryRunList = z.infer<typeof expiryRunListSchema>;

/** One security a run proposes to expire. */
export const expiryProposalSchema = z.object({
  securityId: uuidSchema,
  displayId: displayIdSchema,
  family: z.enum(["EQUITY_COMPENSATION", "WARRANT"]),
  // The holder: the stakeholder's name and e-mail.
  holder: z.object({ stakeholderId: uuidSchema, name: z.string(), email: z.string().nullable() }),
  quantity: decimalSchema, // what the run proposed to cancel
  reason: z.enum(["contractual_deadline", "expiration"]), // the exit window ended, or the term ended
  lastExerciseDate: isoDateSchema, // the deadline that passed: the last day it could be exercised
  effectiveDate: isoDateSchema, // the cancellation's date: the day after
  // What confirming would cancel today, as the confirmation's dry run computes it; null when it's no longer expirable
  // (exercised, cancelled or extended since), so confirming it would be refused (NOT_EXPIRABLE).
  confirmable: z.object({ quantity: decimalSchema, effectiveDate: isoDateSchema }).nullable(),
});
export type ExpiryProposal = z.infer<typeof expiryProposalSchema>;

/** `GET …/expiry-runs/:runId`: one run, its state and its proposals. */
export const expiryRunDetailSchema = expiryRunSummarySchema.extend({
  confirmedAt: epochMsSchema.nullable(),
  confirmedBy: z.string().nullable(), // an actor label: the e-mail masked without PII access
  confirmationStartedAt: epochMsSchema.nullable(), // when the bound confirmation started (`confirming`, `confirmed`)
  proposals: z.array(expiryProposalSchema),
});
export type ExpiryRunDetail = z.infer<typeof expiryRunDetailSchema>;
export const confirmExpiryRunResponseSchema = z.object({
  runId: integerIdSchema,
  commands: z.array(commandResultSchema),
  expiryMode: expiryModeSchema,
});
export type ConfirmExpiryRunResponse = z.infer<typeof confirmExpiryRunResponseSchema>;

// ---------------------------------------------------------------------------
// The command index (the API contract), from which the route table builds one route per command.

export interface CommandSpec {
  readonly name: CommandName;
  readonly summary: string;
  readonly section: string;
  /** Who may run it. */
  readonly access: readonly OrgAccess[];
  /** The body of a real call. */
  readonly schema: z.ZodType;
  /** The body of `?dryRun=true`, or null when the command has no dry run. */
  readonly dryRunSchema: z.ZodType | null;
  readonly response: z.ZodType;
  /** The transaction types it appends. */
  readonly transactions: readonly string[];
  readonly violations: readonly string[];
  readonly warnings: readonly string[];
  /** The command carries `expectedLedgerSeq` and `expectedDiffSha256`. */
  readonly ledgerGuard: boolean;
  /** The body carries a typed confirmation (the API and product rules). */
  readonly confirmation: boolean;
}

const RW_PLUS = ["admin_rw"] as const satisfies readonly OrgAccess[];
const SA_ONLY = RW_PLUS;
export const DOCUMENT_USE_VIOLATIONS = [
  "DOCUMENT_ARCHIVED",
  "DOCUMENT_IS_COMPANY_RESOURCE",
  "DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER",
] as const;
const TERMINATION_VIOLATIONS = [
  "ALREADY_TERMINATED",
  "TERMINATION_DATE_IN_FUTURE",
  "TERMINATION_DATE_NOT_IN_FUTURE",
  "VESTING_STOP_AFTER_TERMINATION",
  "VESTING_STOP_BEFORE_ISSUE",
  "ACCELERATION_EXCEEDS_UNVESTED",
  "REPURCHASE_DEADLINE_NOT_RECORDED",
  "EXTENSION_AFTER_EXPIRATION",
  "NOT_OPTION_OR_WARRANT",
  "FAMILY_MISMATCH",
  ...DOCUMENT_USE_VIOLATIONS,
];

export const COMMANDS = {
  "terminate-stakeholder": {
    name: "terminate-stakeholder",
    summary: "Terminate a stakeholder: cancel unvested awards at the vesting stop, record accelerations and extensions",
    section: "Ledger commands",
    access: RW_PLUS,
    schema: terminateStakeholderSchema,
    dryRunSchema: terminateStakeholderDryRunSchema,
    response: commandResultSchema,
    transactions: ["X_STAKEHOLDER_TERMINATION", "TX_EQUITY_COMPENSATION_CANCELLATION", "TX_VESTING_ACCELERATION", "X_SECURITY_MODIFICATION"],
    violations: TERMINATION_VIOLATIONS,
    warnings: [],
    ledgerGuard: true,
    confirmation: false,
  },
  "schedule-termination": {
    name: "schedule-termination",
    summary: "Schedule a future termination; on-demand due processing applies it on the date",
    section: "Ledger commands",
    access: RW_PLUS,
    schema: scheduleTerminationSchema,
    dryRunSchema: scheduleTerminationDryRunSchema,
    response: scheduleTerminationResponseSchema,
    transactions: [],
    violations: TERMINATION_VIOLATIONS.filter((code) => code !== "TERMINATION_DATE_IN_FUTURE"),
    warnings: [],
    ledgerGuard: true,
    confirmation: false,
  },
  "cancel-scheduled-termination": {
    name: "cancel-scheduled-termination",
    summary: "Cancel a scheduled termination (SCHEDULED → CANCELLED)",
    section: "Ledger commands",
    access: SA_ONLY,
    schema: cancelScheduledTerminationSchema,
    dryRunSchema: null,
    response: scheduledTerminationSchema,
    transactions: [],
    violations: [],
    warnings: [],
    ledgerGuard: false,
    confirmation: false,
  },
  "exercise-option": {
    name: "exercise-option",
    summary: "Record an exercise the holder reported (vested options only)",
    section: "Ledger commands",
    access: RW_PLUS,
    schema: exerciseOptionSchema,
    dryRunSchema: exerciseOptionDryRunSchema,
    response: commandResultSchema,
    transactions: ["TX_EQUITY_COMPENSATION_EXERCISE", "TX_STOCK_ISSUANCE"],
    violations: [
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
      ...DOCUMENT_USE_VIOLATIONS,
    ],
    warnings: ["PAYMENT_EXCEEDS_COST", "PAYER_NOT_HOLDER", "ISO_PORTION_AFTER_ISO_DEADLINE"],
    ledgerGuard: true,
    confirmation: false,
  },
  "grant-equity-compensation": {
    name: "grant-equity-compensation",
    summary: "Record a signed option grant",
    section: "Ledger commands",
    access: RW_PLUS,
    schema: grantEquityCompensationSchema,
    dryRunSchema: grantEquityCompensationDryRunSchema,
    response: commandResultSchema,
    transactions: ["TX_EQUITY_COMPENSATION_ISSUANCE", "TX_VESTING_START"],
    violations: [
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
      "DISPLAY_ID_TAKEN",
      "NON_US_NEEDS_COUNTRY",
      "NSO_PRICE_BELOW_FMV",
      ...DOCUMENT_USE_VIOLATIONS,
    ],
    warnings: ["NSO_PRICE_BELOW_FMV"],
    ledgerGuard: true,
    confirmation: false,
  },
  "cancel-security": {
    name: "cancel-security",
    summary: "Cancel an option or warrant (holder waiver, not executed, mutual agreement, forfeiture)",
    section: "Ledger commands",
    access: RW_PLUS,
    schema: cancelSecuritySchema,
    dryRunSchema: cancelSecurityDryRunSchema,
    response: commandResultSchema,
    transactions: ["TX_EQUITY_COMPENSATION_CANCELLATION", "TX_WARRANT_CANCELLATION"],
    violations: [
      "NOT_OPTION_OR_WARRANT", "SECURITY_NOT_OUTSTANDING", "EFFECTIVE_DATE_IN_FUTURE", "EXCEEDS_OUTSTANDING",
      "FAMILY_MISMATCH", ...DOCUMENT_USE_VIOLATIONS,
    ],
    warnings: [],
    ledgerGuard: true,
    confirmation: true,
  },
  "mark-executed": {
    name: "mark-executed",
    summary: "Mark a grant executed: freeze and link the agreement signed by both parties",
    section: "Ledger commands",
    access: RW_PLUS,
    schema: markExecutedSchema,
    dryRunSchema: markExecutedDryRunSchema,
    response: commandResultSchema,
    transactions: ["X_EXECUTION_STATUS"],
    violations: ["NOT_EXECUTION_PENDING", "SECURITY_NOT_OUTSTANDING", ...DOCUMENT_USE_VIOLATIONS],
    warnings: [],
    ledgerGuard: true,
    confirmation: true,
  },
  "record-leave-of-absence": {
    name: "record-leave-of-absence",
    summary: "Record a leave of absence (it moves the ISO deadline)",
    section: "Ledger commands",
    access: RW_PLUS,
    schema: recordLeaveOfAbsenceSchema,
    dryRunSchema: recordLeaveOfAbsenceDryRunSchema,
    response: commandResultSchema,
    transactions: ["X_STAKEHOLDER_LEAVE"],
    violations: ["LEAVE_DATES", "LEAVE_START_IN_FUTURE", "LEAVE_OVERLAPS", ...DOCUMENT_USE_VIOLATIONS],
    warnings: [],
    ledgerGuard: true,
    confirmation: false,
  },
  "extend-exercise-deadline": {
    name: "extend-exercise-deadline",
    summary: "Extend a contractual exercise deadline with a counsel-approved document",
    section: "Ledger commands",
    access: SA_ONLY,
    schema: extendExerciseDeadlineSchema,
    dryRunSchema: extendExerciseDeadlineDryRunSchema,
    response: commandResultSchema,
    transactions: ["X_SECURITY_MODIFICATION"],
    violations: [
      "NOT_OPTION_OR_WARRANT", "EXTENSION_SHORTENS_DEADLINE", "EXTENSION_AFTER_EXPIRATION", "FAMILY_MISMATCH",
      ...DOCUMENT_USE_VIOLATIONS,
    ],
    warnings: ["ISO_MODIFICATION_RISK"],
    ledgerGuard: true,
    confirmation: true,
  },
  "set-plan-terms": {
    name: "set-plan-terms",
    summary: "Set a plan's return-to-pool rules, exit-window defaults, status and pour-over, effective-dated",
    section: "Ledger commands",
    access: SA_ONLY,
    schema: setPlanTermsSchema,
    dryRunSchema: setPlanTermsDryRunSchema,
    response: commandResultSchema,
    transactions: ["X_STOCK_PLAN_TERMS"],
    violations: [
      "PLAN_TERMS_BEFORE_CURRENT", "EFFECTIVE_DATE_IN_FUTURE", "POUR_OVER_INVALID", ...DOCUMENT_USE_VIOLATIONS,
    ],
    warnings: [],
    ledgerGuard: true,
    confirmation: false,
  },
  "merge-stakeholders": {
    name: "merge-stakeholders",
    summary: "Merge one duplicate stakeholder identity into the surviving record",
    section: "Ledger commands",
    access: SA_ONLY,
    schema: mergeStakeholdersSchema,
    dryRunSchema: mergeStakeholdersDryRunSchema,
    response: commandResultSchema,
    transactions: ["X_STAKEHOLDER_MERGE"],
    violations: [
      "STAKEHOLDER_MERGE_SAME_RECORD", "STAKEHOLDER_ALREADY_MERGED", "STAKEHOLDER_ARCHIVED",
      "STAKEHOLDER_KIND_MISMATCH", "STAKEHOLDER_TERMINATION_CONFLICT", "STAKEHOLDER_MERGE_BLOCKED",
      "STAKEHOLDER_MERGE_NOT_NEUTRAL", "DEPENDENCY_EDGE_MISSING",
    ],
    warnings: [],
    ledgerGuard: true,
    confirmation: true,
  },
  "reverse-command": {
    name: "reverse-command",
    summary: "Reverse every transaction of one command (refused while dependents stand or for migrated history)",
    section: "Reversals",
    access: SA_ONLY,
    schema: reverseCommandSchema,
    dryRunSchema: null,
    response: commandResultSchema,
    transactions: ["X_REVERSAL"],
    // Only the command types in the reversal allowlist can be reversed.
    violations: ["COMMAND_NOT_REVERSIBLE", "STAKEHOLDER_UNMERGE_BLOCKED"],
    warnings: [],
    ledgerGuard: true,
    confirmation: true,
  },
} as const satisfies { readonly [Name in CommandName]: CommandSpec & { readonly name: Name } };
