import "./zod-config.ts";
import { z } from "zod";
import { documentRefSchema } from "./common.ts";
import { vestingEventSchema } from "./equity.ts";
import {
  AUDIT_RESULTS,
  auditActorKindSchema,
  authMethodSchema,
  capTableTabSchema,
  CERTIFICATE_STATUSES,
  commandActorKindSchema,
  dependencyKindSchema,
  ELECTION_83B_STATUSES,
  EXECUTION_MISSING_PARTIES,
  executionStatusSchema,
  EXERCISE_REQUEST_STATUSES,
  federalExemptionSchema,
  LEGEND_KINDS,
  NEEDS_ATTENTION_KINDS,
  optionTypeSchema,
  paymentMethodSchema,
  relationshipSchema,
  REPURCHASE_WINDOW_STATUSES,
  securityFamilySchema,
  securityStatusSchema,
  securitySubtypeSchema,
  SIGNATURE_METHODS,
  SIGNATURE_STATUSES,
  SIGNER_ROLES,
  STAKEHOLDER_STATUSES,
  taxTreatmentSchema,
  terminationTypeSchema,
  transactionSourceSchema,
  transactionTypeSchema,
} from "./enums.ts";
import {
  currencySchema,
  decimalSchema,
  displayIdSchema,
  epochMsSchema,
  holdingsEchoShape,
  holdingsListSchema,
  holdingsQueryShape,
  integerIdSchema,
  isoDateSchema,
  ledgerSeqSchema,
  listSchema,
  pageQueryShape,
  pageSchema,
  ratioSchema,
  sha256HexSchema,
  uuidSchema,
  versionSchema,
} from "./primitives.ts";

// Ledger and holdings reads for admins (the API contract). Percentages appear in admin views only, as exact fractions
// (`ratioSchema`); the portal schemas (src/api/portal) never carry them.

// ---------------------------------------------------------------------------
// Security and ledger shapes

/** Per-security numbers (the ledger rules), comparable field by field with Pulley's. */
export const securityNumbersSchema = z.object({
  asOf: isoDateSchema,
  asKnownAt: ledgerSeqSchema,
  issued: decimalSchema,
  outstanding: decimalSchema,
  fullyDiluted: decimalSchema,
  vested: decimalSchema,
  unvested: decimalSchema,
  vestedOutstanding: decimalSchema,
  exercised: decimalSchema,
  exercisable: decimalSchema,
  cancelled: decimalSchema,
  repurchased: decimalSchema,
  repurchaseable: decimalSchema,
  forfeited: decimalSchema,
  fullyDilutedPct: ratioSchema, // admin views only; never in portal schemas
  outstandingPct: ratioSchema,
});
export type SecurityNumbers = z.infer<typeof securityNumbersSchema>;

export const securitySchema = z.object({
  id: uuidSchema,
  family: securityFamilySchema,
  subtype: securitySubtypeSchema,
  stakeholderId: uuidSchema,
  stakeholderName: z.string(),
  stockClassId: uuidSchema.nullable(),
  stockPlanId: uuidSchema.nullable(),
  displayId: displayIdSchema,
  issueDate: isoDateSchema,
  status: securityStatusSchema,
  executionStatus: executionStatusSchema, // pending while migrated signatures are open
  parentSecurityId: uuidSchema.nullable(),
  originCommandId: uuidSchema,
  terms: z.record(z.string(), z.unknown()), // per family, from the issuance payload and later modifications
  deadlines: z
    .object({ contractual: isoDateSchema.nullable(), iso: isoDateSchema.nullable(), reason: z.string().nullable() })
    .nullable(),
  exemption: z.object({ federal: federalExemptionSchema.nullable(), country: z.string().nullable(), state: z.string().nullable() }),
  boardApprovalDate: isoDateSchema.nullable(),
  boardApprovalNotRecordedInPulley: z.boolean(),
  numbers: securityNumbersSchema.optional(),
  certificate: z
    .object({ id: uuidSchema, number: z.string(), status: z.enum(CERTIFICATE_STATUSES), documentId: uuidSchema.nullable() })
    .nullable(),
  provenance: z.object({
    importedFromPulley: z.boolean(),
    sourceFile: z.string().nullable(),
    sourceSha256: sha256HexSchema.nullable(),
    pulleyId: z.string().nullable(),
  }),
});
export type Security = z.infer<typeof securitySchema>;

export const transactionSchema = z.object({
  id: uuidSchema,
  seq: z.number().int().positive(),
  commandId: uuidSchema,
  type: transactionTypeSchema,
  effectiveDate: isoDateSchema,
  securityId: uuidSchema.nullable(),
  stakeholderId: uuidSchema.nullable(),
  valuationId: uuidSchema.nullable(),
  quantity: decimalSchema.nullable(),
  amount: decimalSchema.nullable(),
  currency: currencySchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
  payloadVersion: z.number().int().min(1),
  payloadSha256: sha256HexSchema,
  reversesTxId: uuidSchema.nullable(),
  reversedByTxId: uuidSchema.nullable(),
  source: transactionSourceSchema,
  recordedAt: epochMsSchema,
  recordedBy: z.string().nullable(),
  prevHash: sha256HexSchema,
  chainHash: sha256HexSchema,
  pulleyRef: z.string().nullable(),
});
export type Transaction = z.infer<typeof transactionSchema>;

/** `GET …/securities?family=&asOf=&asKnownAt=`: every security with its numbers (a whole list; the SPA filters). */
export const securityListQuerySchema = z.object({ family: securityFamilySchema.optional(), ...holdingsQueryShape });
export const securityListSchema = holdingsListSchema(securitySchema);
export type SecurityList = z.infer<typeof securityListSchema>;

/** `GET …/securities/:id`: terms, numbers, execution status, deadlines, lineage, certificate, legends, documents. */
export const securityDetailSchema = securitySchema.extend({
  ...holdingsEchoShape,
  lineage: z.object({
    parent: z.object({ id: uuidSchema, displayId: displayIdSchema }).nullable(),
    // Lots this one became: exercise shares, transfer and balance lots, conversion results.
    children: z.array(z.object({ id: uuidSchema, displayId: displayIdSchema, transactionType: transactionTypeSchema })),
  }),
  legends: z.array(z.object({ id: uuidSchema, name: z.string() })),
  documents: z.array(documentRefSchema),
  // The newest standing command on this lot that reverse-command accepts: a reversible type, not imported,
  // nothing standing on it. null when there is none ("Reverse last transaction" is then unavailable).
  lastReversibleCommandId: uuidSchema.nullable().optional(),
});
export type SecurityDetail = z.infer<typeof securityDetailSchema>;

/** `GET …/securities/:id/vesting?asOf=`: events with cumulative totals, accelerations and the stop. */
export const securityVestingSchema = z.object({
  ...holdingsEchoShape,
  securityId: uuidSchema,
  quantity: decimalSchema,
  vested: decimalSchema,
  unvested: decimalSchema,
  vestingStartDate: isoDateSchema.nullable(),
  vestingStopDate: isoDateSchema.nullable(), // set by a termination
  events: z.array(vestingEventSchema),
});
export type SecurityVesting = z.infer<typeof securityVestingSchema>;

/** A line of a security's timeline: a transaction (with its reversal, if any), a signature act or a document event. */
export const timelineEntrySchema = z.object({
  kind: z.enum(["transaction", "reversal", "signature", "document"]),
  at: epochMsSchema, // when it was recorded
  effectiveDate: isoDateSchema.nullable(), // the legal date, for ledger entries
  transactionId: uuidSchema.nullable(),
  commandId: uuidSchema.nullable(),
  type: z.string(), // transaction type, signature status or document event
  summary: z.string(),
  actor: z.string().nullable(), // who: a display label; "System maintenance" for on-demand maintenance
  note: z.string().nullable(), // why: a reversal's or override's reason
  securityId: uuidSchema, // the lot or a lot in its lineage
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
/** `GET …/securities/:id/timeline`: oldest first, reversals included. */
export const securityTimelineSchema = listSchema(timelineEntrySchema);

/** `GET …/securities/:id/termination-preview`: what terminating the holder on a date would do to this security. */
export const terminationPreviewQuerySchema = z.object({
  terminationDate: isoDateSchema,
  terminationType: terminationTypeSchema,
  vestingStopDate: isoDateSchema.optional(),
});
export const terminationPreviewSchema = z.object({
  securityId: uuidSchema,
  terminationDate: isoDateSchema,
  terminationType: terminationTypeSchema,
  vestingStopDate: isoDateSchema,
  vested: decimalSchema,
  unvested: decimalSchema,
  exercisable: decimalSchema,
  repurchaseable: decimalSchema,
  contractualDeadline: isoDateSchema.nullable(),
  isoDeadline: isoDateSchema.nullable(),
});
export type TerminationPreview = z.infer<typeof terminationPreviewSchema>;

/** `GET …/stakeholders/:id/iso-split`: the ISO/NSO lots of the $100K test by year (the ledger rules). */
export const isoSplitSchema = z.object({
  stakeholderId: uuidSchema,
  years: z.array(
    z.object({
      year: z.number().int(),
      isoValueUsed: decimalSchema, // Σ FMV at grant × ISO shares first exercisable in the year
      lots: z.array(
        z.object({
          securityId: uuidSchema,
          displayId: displayIdSchema,
          fmvAtGrant: decimalSchema,
          isoQuantity: decimalSchema,
          nsoQuantity: decimalSchema,
          exercisedIso: decimalSchema,
          exercisedNso: decimalSchema,
        }),
      ),
    }),
  ),
});
export type IsoSplit = z.infer<typeof isoSplitSchema>;

/** `GET …/transactions?…`: the ledger, newest seq first. */
export const transactionListQuerySchema = z.object({
  type: transactionTypeSchema.optional(),
  securityId: uuidSchema.optional(),
  stakeholderId: uuidSchema.optional(),
  from: isoDateSchema.optional(), // effective on or after
  to: isoDateSchema.optional(), // effective on or before
  source: transactionSourceSchema.optional(),
  ...pageQueryShape,
});
export const transactionPageSchema = pageSchema(transactionSchema);
export type TransactionPage = z.infer<typeof transactionPageSchema>;

/** A command as the ledger records it. */
export const commandSummarySchema = z.object({
  id: uuidSchema,
  type: z.string(),
  actorKind: commandActorKindSchema,
  actor: z.string().nullable(),
  authMethod: authMethodSchema.nullable(),
  note: z.string().nullable(),
  createdAt: epochMsSchema,
  firstSeq: z.number().int().positive(),
  lastSeq: z.number().int().positive(),
  reversesCommandId: uuidSchema.nullable(),
  reversedByCommandId: uuidSchema.nullable(),
  importedFromPulley: z.boolean(),
});
export type CommandSummary = z.infer<typeof commandSummarySchema>;

/** `GET …/transactions/:id`: payload, payload and chain hashes, prevHash, command, reversal. */
export const transactionDetailSchema = transactionSchema.extend({
  command: commandSummarySchema,
  reversal: z.object({ transactionId: uuidSchema, commandId: uuidSchema, recordedAt: epochMsSchema, note: z.string().nullable() }).nullable(),
});
export type TransactionDetail = z.infer<typeof transactionDetailSchema>;

/** `GET …/commands/:id`: a command, its transactions, dependencies, dependents and reversal. */
export const commandDetailSchema = commandSummarySchema.extend({
  transactions: z.array(transactionSchema),
  dependencies: z.array(z.object({ commandId: uuidSchema, type: z.string(), kind: dependencyKindSchema })),
  dependents: z.array(z.object({ commandId: uuidSchema, type: z.string(), kind: dependencyKindSchema, reversed: z.boolean() })),
});
export type CommandDetail = z.infer<typeof commandDetailSchema>;

// ---------------------------------------------------------------------------
// Cap table

export const capTableQuerySchema = z.object({ ...holdingsQueryShape, tab: capTableTabSchema.default("ownership") });

export const capTableResponseSchema = z.object({
  asOf: isoDateSchema,
  asKnownAt: ledgerSeqSchema,
  ledgerSeq: ledgerSeqSchema,
  ledgerHeadHash: sha256HexSchema.nullable(),
  engineVersion: z.string().min(1),
  metrics: z.object({
    issuedAndOutstanding: decimalSchema, // legal shares by class; treasury excluded
    fullyDiluted: decimalSchema, // I&O as converted + awards (incl. execution pending) + warrants + unissued pool; SAFEs excluded
    executionPendingAwards: decimalSchema, // the part of fullyDiluted that is execution pending (flagged)
    planAvailable: decimalSchema,
    capitalContribution: decimalSchema, // gross; repurchase consideration never netted
  }),
  classes: z.array(
    z.object({
      stockClassId: uuidSchema,
      name: z.string(),
      authorized: decimalSchema,
      issuedAndOutstanding: decimalSchema,
      fullyDiluted: decimalSchema,
      availableToIssue: decimalSchema,
    }),
  ),
  plans: z.array(
    z.object({
      stockPlanId: uuidSchema,
      name: z.string(),
      poolSize: decimalSchema,
      equityOutstanding: decimalSchema,
      equityRetired: decimalSchema,
      available: decimalSchema,
    }),
  ),
  ownership: z
    .array(
      z.object({
        // tab=ownership (default)
        stakeholderId: uuidSchema,
        name: z.string(),
        relationship: relationshipSchema,
        issuerAssignedId: z.string().nullable(),
        status: z.enum(STAKEHOLDER_STATUSES),
        byClass: z.record(uuidSchema, decimalSchema),
        issuedAndOutstanding: decimalSchema,
        issuedAndOutstandingPct: ratioSchema,
        planAwards: z.record(uuidSchema, decimalSchema),
        awardsOutsidePlans: decimalSchema,
        warrants: decimalSchema,
        fullyDiluted: decimalSchema,
        fullyDilutedPct: ratioSchema,
      }),
    )
    .optional(),
  availablePool: z.object({ fullyDiluted: decimalSchema, fullyDilutedPct: ratioSchema }), // the last row, "Available pool"
  totals: z.object({ issuedAndOutstanding: decimalSchema, fullyDiluted: decimalSchema }),
  rows: z.array(securitySchema).optional(), // tab=shares|options|warrants
  safes: z
    .array(
      z.object({
        securityId: uuidSchema,
        displayId: displayIdSchema,
        stakeholderId: uuidSchema,
        principal: decimalSchema,
        issueDate: isoDateSchema,
        valuationCap: decimalSchema.nullable(),
        conversionTiming: z.string().nullable(),
        discountRate: decimalSchema.nullable(),
        status: securityStatusSchema,
        convertedInto: z.array(z.object({ securityId: uuidSchema, displayId: displayIdSchema })),
      }),
    )
    .optional(), // tab=safes (converted history)
  openingBalances: z.array(z.object({ securityId: uuidSchema, date: isoDateSchema })), // "history before <date> was not provable"
});
export type CapTableResponse = z.infer<typeof capTableResponseSchema>;

// ---------------------------------------------------------------------------
// Dashboard and Securities Status

/** The admin page of the report-only expiry runs pending confirmation: `EXPIRY_RUN_TO_CONFIRM`'s link. */
export const EXPIRY_RUNS_HREF = "/expiry-runs";

/**
 * A Needs-attention line (the API contract). `EXPIRY_RUN_TO_CONFIRM` is present only while a report-only expiry run awaits
 * confirmation: its count is the number of runs pending confirmation (`GET …/expiry-runs`), its dueDate null and its
 * href `EXPIRY_RUNS_HREF`. The other kinds the Worker reports are always present, with a count of 0 when nothing needs
 * attention.
 */
export const needsAttentionSchema = z.object({
  kind: z.enum(NEEDS_ATTENTION_KINDS),
  count: z.number().int().nonnegative(),
  dueDate: isoDateSchema.nullable(),
  href: z.string().startsWith("/"),
});
export type NeedsAttention = z.infer<typeof needsAttentionSchema>;

export const dashboardResponseSchema = z.object({
  asOf: isoDateSchema,
  company: z.object({
    totalCapitalContribution: decimalSchema,
    fullyDilutedShares: decimalSchema,
    stakeholdersWithSecurities: z.number().int().nonnegative(),
  }),
  employeeEquity: z.array(
    z.object({ stockPlanId: uuidSchema, name: z.string(), granted: decimalSchema, available: decimalSchema, usedPct: ratioSchema }),
  ),
  ownershipByRelationship: z.array(z.object({ relationship: z.string(), fullyDiluted: decimalSchema, pct: ratioSchema })),
  topStakeholders: z.array(z.object({ stakeholderId: uuidSchema, name: z.string(), fullyDiluted: decimalSchema, pct: ratioSchema })),
  needsAttention: z.array(needsAttentionSchema),
  inProgress: z.record(z.string(), z.number().int().nonnegative()), // counts linking to the Securities Status sections
  recentActivity: z.array(z.object({ id: integerIdSchema, occurredAt: epochMsSchema, description: z.string(), actor: z.string() })),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

export const securitiesStatusSchema = z.object({
  executionPending: z.array(
    z.object({
      securityId: uuidSchema,
      displayId: displayIdSchema,
      stakeholderId: uuidSchema,
      issueDate: isoDateSchema,
      missing: z.enum(EXECUTION_MISSING_PARTIES),
      signatureRequestIds: z.array(uuidSchema),
    }),
  ),
  scheduledTerminations: z.array(
    z.object({
      id: uuidSchema,
      stakeholderId: uuidSchema,
      terminationDate: isoDateSchema,
      type: terminationTypeSchema,
      securitiesAffected: z.number().int().nonnegative(),
      unvestedToCancel: decimalSchema,
      version: versionSchema,
    }),
  ),
  unvestedSharesFromTerminated: z.array(
    z.object({
      securityId: uuidSchema,
      stakeholderId: uuidSchema,
      unvested: decimalSchema,
      repurchasePrice: decimalSchema.nullable(),
      lastRepurchaseDate: isoDateSchema.nullable(),
      status: z.enum(REPURCHASE_WINDOW_STATUSES),
    }),
  ),
  optionsFromTerminated: z.array(
    z.object({
      securityId: uuidSchema,
      stakeholderId: uuidSchema,
      vestedUnexercised: decimalSchema,
      contractualDeadline: isoDateSchema,
      contractualDaysLeft: z.number().int(),
      isoDeadline: isoDateSchema.nullable(),
      isoDaysLeft: z.number().int().nullable(),
    }),
  ),
  expiringWithin90Days: z.array(z.object({ securityId: uuidSchema, displayId: displayIdSchema, expirationDate: isoDateSchema })),
});
export type SecuritiesStatus = z.infer<typeof securitiesStatusSchema>;

// ---------------------------------------------------------------------------
// Exercises, imported requests and records

/** Withholding the admin entered (never computed; scope decision). */
export const withholdingSchema = z.object({
  federalIncome: decimalSchema,
  socialSecurity: decimalSchema,
  medicare: decimalSchema,
  state: z.array(z.object({ code: z.string().regex(/^[A-Z]{2}$/), amount: decimalSchema })),
});

/** `GET …/exercises?year=`: every exercise, migrated and recorded. */
export const exercisesQuerySchema = z.object({ year: z.coerce.number().int().min(1900).max(2200).optional() });
export const exerciseRecordSchema = z.object({
  transactionId: uuidSchema, // the TX_EQUITY_COMPENSATION_EXERCISE
  commandId: uuidSchema,
  exerciseDate: isoDateSchema,
  stakeholderId: uuidSchema,
  stakeholderName: z.string(),
  securityId: uuidSchema,
  grantDisplayId: displayIdSchema,
  quantity: decimalSchema,
  isoQuantity: decimalSchema,
  nsoQuantity: decimalSchema,
  exercisePrice: decimalSchema,
  cost: decimalSchema,
  paymentMethod: paymentMethodSchema.nullable(),
  paymentReference: z.string().nullable(),
  fmvPerShare: decimalSchema.nullable(),
  taxTreatment: taxTreatmentSchema.nullable(),
  withholding: withholdingSchema.nullable(),
  resultingShares: z.array(z.object({ securityId: uuidSchema, displayId: displayIdSchema, portion: optionTypeSchema })),
  // Where it came from: an exercise request (ER-n), a recorded exercise, or Pulley's history.
  source: z.object({ kind: z.enum(["request", "recorded", "migrated"]), requestNumber: z.number().int().positive().nullable() }),
  reversed: z.boolean(),
});
export type ExerciseRecord = z.infer<typeof exerciseRecordSchema>;
export const exerciseListSchema = listSchema(exerciseRecordSchema);

/** An imported exercise request retained as a read-only historical record. */
export const exerciseRequestSchema = z.object({
  id: uuidSchema,
  requestNumber: z.number().int().positive(),
  securityId: uuidSchema,
  stakeholderId: uuidSchema,
  quantity: decimalSchema,
  isoQuantity: decimalSchema,
  nsoQuantity: decimalSchema,
  exercisePrice: decimalSchema,
  fmvPerShare: decimalSchema.nullable(),
  valuationId: uuidSchema.nullable(),
  estimatedWithholding: decimalSchema.nullable(),
  totalCost: decimalSchema,
  currency: currencySchema,
  paymentMethod: paymentMethodSchema,
  status: z.enum(EXERCISE_REQUEST_STATUSES),
  pulleyStatus: z.string().nullable(), // Pulley's own status, verbatim
  paymentDueDate: isoDateSchema.nullable(),
  paymentReceivedOn: isoDateSchema.nullable(),
  exerciseDate: isoDateSchema.nullable(),
  completedCommandId: uuidSchema.nullable(),
  decidedAt: epochMsSchema.nullable(),
  cancelledAt: epochMsSchema.nullable(),
  documents: z.array(documentRefSchema),
  importedFromPulley: z.boolean(),
  createdAt: epochMsSchema,
});
export type ExerciseRequest = z.infer<typeof exerciseRequestSchema>;
export const exerciseRequestListSchema = listSchema(exerciseRequestSchema);

/** Pulley's signature state at the freeze: immutable evidence. Execution status itself comes from the ledger. */
export const signatureRequestSchema = z.object({
  id: uuidSchema,
  securityId: uuidSchema.nullable(),
  exerciseRequestId: uuidSchema.nullable(),
  documentId: uuidSchema.nullable(),
  signerRole: z.enum(SIGNER_ROLES),
  signerName: z.string().nullable(),
  signerEmail: z.string().nullable(), // masked for RO admins outside readOnlyPii
  status: z.enum(SIGNATURE_STATUSES),
  method: z.enum(SIGNATURE_METHODS).nullable(),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  evidenceSha256: sha256HexSchema.nullable(),
  signedAt: epochMsSchema.nullable(),
  resolvedAt: epochMsSchema.nullable(),
  resolutionNote: z.string().nullable(),
  importedFromPulley: z.boolean(),
  createdAt: epochMsSchema,
});
export type SignatureRequest = z.infer<typeof signatureRequestSchema>;
export const signatureRequestListSchema = listSchema(signatureRequestSchema);
export const securityFilterQuerySchema = z.object({ securityId: uuidSchema.optional() });

/** An imported certificate retained as a read-only historical record. */
export const certificateSchema = z.object({
  id: uuidSchema,
  securityId: uuidSchema,
  certificateNumber: z.string(),
  status: z.enum(CERTIFICATE_STATUSES),
  issuedDate: isoDateSchema,
  cancelledDate: isoDateSchema.nullable(),
  cancelReason: z.string().nullable(),
  documentId: uuidSchema.nullable(),
  signatories: z.array(z.object({ name: z.string(), title: z.string().nullable(), signedAt: epochMsSchema.nullable() })),
  legends: z.array(z.object({ name: z.string(), text: z.string() })),
  renderingNote: z.string().nullable(),
  importedFromPulley: z.boolean(),
});
export type Certificate = z.infer<typeof certificateSchema>;
export const certificateListSchema = listSchema(certificateSchema);

/** A legend or certificate-terms text (migrated; view only). */
export const legendSchema = z.object({
  id: uuidSchema,
  kind: z.enum(LEGEND_KINDS),
  name: z.string(),
  text: z.string(),
  archivedAt: epochMsSchema.nullable(),
  version: versionSchema,
});
export type Legend = z.infer<typeof legendSchema>;
export const legendListSchema = listSchema(legendSchema);

/** An imported 83(b) record. A change is a new record that supersedes the previous one. */
export const election83bSchema = z.object({
  id: uuidSchema,
  securityId: uuidSchema,
  status: z.enum(ELECTION_83B_STATUSES),
  transferDate: isoDateSchema.nullable(),
  dueDate: isoDateSchema.nullable(),
  filedDate: isoDateSchema.nullable(),
  proofDocumentId: uuidSchema.nullable(),
  supersedesId: uuidSchema.nullable(),
  importedFromPulley: z.boolean(),
  createdAt: epochMsSchema,
});
export type Election83b = z.infer<typeof election83bSchema>;
export const election83bListSchema = listSchema(election83bSchema);

// ---------------------------------------------------------------------------
// Audit log

/** Console and gateway user ids are opaque stable strings, not necessarily UUIDs. */
export const opaqueUserIdSchema = z.string().min(1).max(128);

/** An audit event: ids, field names and counts in `details`, never personal values (the ledger rules). */
export const auditEventSchema = z.object({
  id: integerIdSchema,
  occurredAt: epochMsSchema,
  orgId: uuidSchema.nullable(),
  actor: z.object({
    kind: auditActorKindSchema,
    userId: opaqueUserIdSchema.nullable(),
    email: z.string().nullable(), // masked for RO admins outside readOnlyPii
    authMethod: authMethodSchema.nullable(),
  }),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  result: z.enum(AUDIT_RESULTS),
  reason: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
export const auditPageSchema = pageSchema(auditEventSchema);
export type AuditPage = z.infer<typeof auditPageSchema>;

/** `GET …/audit?cursor=&limit=&action=&actorId=&targetId=&actorType=`: the org's audit log, newest first. */
export const orgAuditQuerySchema = z.object({
  action: z.string().trim().min(1).max(64).optional(),
  actorId: opaqueUserIdSchema.optional(),
  targetId: z.string().trim().min(1).max(64).optional(),
  actorType: auditActorKindSchema.optional(),
  ...pageQueryShape,
});
