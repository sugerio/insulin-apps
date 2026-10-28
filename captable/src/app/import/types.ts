import { engine } from "#shared";
import { z } from "zod";

export type ImportSourceSystem = "pulley" | "template";

export type PulleyReportKind =
  | "raw-cap-table"
  | "detailed-cap-table"
  | "stakeholders"
  | "vesting-details"
  | "exercised-options"
  | "iso-nso-details"
  | "stakeholder-transactions";

export interface UploadedImportFile { name: string; bytes: Uint8Array }
export interface SourceLocation { file: string; sheet: string; row: number; column?: string }
export interface ImportProblem { severity: "error" | "warning"; code: string; message: string; source: SourceLocation | null }
export interface DetectedImportFile { name: string; kind: PulleyReportKind | "template" | null; format: "xlsx" | "csv" | "unknown"; sheets: string[]; warnings: string[] }
export interface Sourced { source: SourceLocation }

export interface StakeholderDraft extends Sourced {
  sourceId: string;
  name: string;
  email: string | null;
  kind: "individual" | "institution";
  relationship: engine.Relationship;
  terminationDate: string | null;
  terminationType: engine.TerminationType | null;
}

export interface ShareClassDraft extends Sourced {
  sourceId: string;
  name: string;
  classType: "COMMON" | "PREFERRED" | null;
  authorized: string | null;
  outstanding: string | null;
  conversionRatio: string | null;
  originalIssuePrice: string | null;
  currency: string;
}

export interface EquityPlanDraft extends Sourced {
  sourceId: string;
  name: string;
  stockClassSourceId: string | null;
  poolSize: string | null;
  available: string | null;
  outstanding: string | null;
  effectiveDate: string | null;
  terminationWindowDays: number | null;
}

export type DraftSecurityKind = "stock" | "option" | "warrant" | "safe" | "unsupported";
export interface SecurityDraft extends Sourced {
  sourceId: string;
  displayId: string;
  kind: DraftSecurityKind;
  unsupportedType: string | null;
  stakeholderSourceId: string;
  stockClassSourceId: string | null;
  stockPlanSourceId: string | null;
  optionType: "ISO" | "NSO" | null;
  issueDate: string | null;
  issued: string | null;
  outstanding: string | null;
  exercised: string | null;
  cancelled: string | null;
  repurchased: string | null;
  repurchaseDate: string | null;
  repurchaseConsideration: string | null;
  transferred: string | null;
  unvestedCancelled: string | null;
  vested: string | null;
  vestedOutstanding: string | null;
  price: string | null;
  purchasePrice: string | null;
  currency: string;
  expirationDate: string | null;
  exerciseDeadline: string | null;
  earlyExercise: boolean | null;
  fmvAtGrant: string | null;
  status: string;
  safeType: "PRE_MONEY" | "POST_MONEY" | null;
  valuationCap: string | null;
  uncapped: boolean | null;
  discountRate: string | null;
  convertedDate: string | null;
}

export interface VestingEventDraft extends Sourced {
  sourceId: string;
  date: string;
  quantity: string | null;
  cancelled: boolean;
  milestone: string | null;
  status: string | null;
}
export interface VestingDraft extends Sourced {
  securitySourceId: string;
  grantDate: string | null;
  startDate: string | null;
  granted: string | null;
  definitionType: "EXPLICIT" | "SCHEDULE";
  schedule: { totalMonths: number; cliffMonths: number; everyMonths: number } | null;
  events: VestingEventDraft[];
}

export interface ExerciseDraft extends Sourced {
  sourceId: string;
  optionSourceId: string;
  optionDisplayId: string;
  date: string;
  quantity: string | null;
  isoQuantity: string | null;
  nsoQuantity: string | null;
  exercisePrice: string | null;
  unvestedOnExercise: string | null;
  resultingSecuritySourceId: string | null;
}
export interface CancellationDraft extends Sourced {
  sourceId: string;
  securitySourceId: string;
  date: string | null;
  quantity: string | null;
  reason: string;
  vestingPortion: "UNVESTED" | "VESTED" | null;
}
export interface IsoNsoSplitDraft extends Sourced { securitySourceId: string; grantDisplayId: string; total: string | null; iso: string | null; nso: string | null }

export interface UploadedTotals {
  company: { fullyDiluted: string | null; issued: string | null; outstanding: string | null; source: SourceLocation } | null;
  classes: Array<{ sourceId: string; name: string; outstanding: string | null; authorized: string | null; source: SourceLocation }>;
  plans: Array<{ sourceId: string; name: string; poolSize: string | null; available: string | null; outstanding: string | null; source: SourceLocation }>;
  holders: Array<{ sourceId: string; name: string; fullyDiluted: string | null; outstanding: string | null; source: SourceLocation }>;
  securities: Array<{ sourceId: string; name: string; outstanding: string | null; vested: string | null; vestedOutstanding: string | null; source: SourceLocation }>;
  detailed: {
    company: { fullyDiluted: string | null; issuedAndOutstanding: string | null; source: SourceLocation } | null;
    holders: Array<{ sourceId: string; name: string; fullyDiluted: string | null; issuedAndOutstanding: string | null; source: SourceLocation }>;
  } | null;
}

export interface ImportDraft {
  sourceSystem: ImportSourceSystem;
  companyName: string | null;
  asOfDate: string | null;
  suggestedAsOfDate: string | null;
  currency: string;
  stakeholders: StakeholderDraft[];
  shareClasses: ShareClassDraft[];
  equityPlans: EquityPlanDraft[];
  securities: SecurityDraft[];
  vesting: VestingDraft[];
  exercises: ExerciseDraft[];
  cancellations: CancellationDraft[];
  isoNsoSplits: IsoNsoSplitDraft[];
  totals: UploadedTotals | null;
  adapterProblems: ImportProblem[];
  assumptions: string[];
}

export interface PlannedSecurity {
  id: string; family: engine.SecurityFamily; subtype: engine.SecuritySubtype; stakeholderId: string;
  stockClassId: string | null; stockPlanId: string | null; displayId: string; parentSecurityId: string | null; sourceId: string;
}
export interface PlannedTransaction {
  id: string; type: engine.TransactionTypeCode; effectiveDate: string; payload: Record<string, unknown>; payloadVersion: number;
  securityId: string | null; stakeholderId: string | null; stockClassId: string | null; stockPlanId: string | null;
  valuationId: string | null; quantity: string | null; amount: string | null; currency: string | null; sourceRef: string;
}
export interface PlannedLedgerCommand {
  id: string; idempotencyKey: string; type: string; effectiveDate: string; securities: PlannedSecurity[];
  transactions: PlannedTransaction[]; dependencies: string[]; sourceId: string;
}

export type ImportVestingDefinition =
  | engine.ScheduleDefinition
  | { type: "EXPLICIT"; events: Array<{ date: string; quantity: string; sourceId?: string; kind?: "SCHEDULED" | "EXPLICIT" }> };

export type ImportReferenceRow =
  | { entity: "org_profile"; legalName: string; displayName: string; currency: string; shareUnit: string; sourceId: string }
  | { entity: "stakeholder"; id: string; displayName: string; kind: "individual" | "institution"; relationship: engine.Relationship; email: string | null; sourceId: string }
  | { entity: "stock_class"; id: string; name: string; classType: "COMMON" | "PREFERRED"; currency: string; originalIssuePrice: { amount: string; currency: string } | null; sourceId: string }
  | { entity: "stock_plan"; id: string; name: string; stockClassId: string; effectiveDate: string | null; sourceId: string }
  | { entity: "vesting_terms"; id: string; name: string; definition: ImportVestingDefinition; definitionSha256: string; sourceId: string | null }
  | { entity: "certificate"; id: string; securityId: string; certificateNumber: string; issuedDate: string; status: "ISSUED" | "CANCELLED" | "VOID"; cancelledDate: string | null; sourceId: string };

export interface ImportWritePlan {
  sourceSystem: ImportSourceSystem; asOfDate: string; orgId: string; shareUnit: string;
  referenceRows: ImportReferenceRow[]; commands: PlannedLedgerCommand[];
  sourceIds: Array<{ entity: "stakeholder" | "stock_class" | "stock_plan" | "security" | "vesting_event" | "exercise" | "cancellation"; sourceId: string }>;
}

const id = z.string().min(1);
const nullableId = id.nullable();
const isoDate = z.string().refine(engine.isIsoDate, "Expected an ISO date");
const decimalString = z.string().refine(engine.Dec.isCanonical, "Expected a canonical decimal");
const nullableDecimal = decimalString.nullable();
const sourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const importedVestingDefinitionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("SCHEDULE"), totalMonths: z.number().int().min(1).max(240), frequency: z.enum(["MONTHLY", "QUARTERLY", "ANNUALLY"]), cliff: z.strictObject({ months: z.number().int().min(1), quantityRule: z.literal("RATABLE") }).nullable(), dayRule: z.literal("SAME_DAY_CLAMPED") }),
  z.strictObject({ type: z.literal("EXPLICIT"), events: z.array(z.strictObject({ date: isoDate, quantity: decimalString, sourceId: sourceIdSchema.optional(), kind: z.enum(["SCHEDULED", "EXPLICIT"]).optional() })).min(1).max(1000) }),
]);
const referenceRowSchema = z.discriminatedUnion("entity", [
  z.strictObject({ entity: z.literal("org_profile"), legalName: id, displayName: id, currency: id, shareUnit: id, sourceId: sourceIdSchema }),
  z.strictObject({ entity: z.literal("stakeholder"), id, displayName: id, kind: z.enum(["individual", "institution"]), relationship: z.enum(["founder", "employee", "ex_employee", "officer", "board_member", "advisor", "consultant", "investor", "other"]), email: z.string().nullable(), sourceId: sourceIdSchema }),
  z.strictObject({ entity: z.literal("stock_class"), id, name: id, classType: z.enum(["COMMON", "PREFERRED"]), currency: id, originalIssuePrice: z.strictObject({ amount: decimalString, currency: id }).nullable(), sourceId: sourceIdSchema }),
  z.strictObject({ entity: z.literal("stock_plan"), id, name: id, stockClassId: id, effectiveDate: isoDate.nullable(), sourceId: sourceIdSchema }),
  z.strictObject({ entity: z.literal("vesting_terms"), id, name: id, definition: importedVestingDefinitionSchema, definitionSha256: id, sourceId: sourceIdSchema.nullable() }),
  z.strictObject({ entity: z.literal("certificate"), id, securityId: id, certificateNumber: id, issuedDate: isoDate, status: z.enum(["ISSUED", "CANCELLED", "VOID"]), cancelledDate: isoDate.nullable(), sourceId: sourceIdSchema }),
]);
export const plannedTransactionSchema = z.strictObject({
  id, type: z.custom<engine.TransactionTypeCode>(engine.isTransactionType, "Expected a ledger transaction type"), effectiveDate: isoDate, payload: z.record(z.string(), z.unknown()), payloadVersion: z.number().int().min(1),
  securityId: nullableId, stakeholderId: nullableId, stockClassId: nullableId, stockPlanId: nullableId,
  valuationId: nullableId, quantity: nullableDecimal, amount: nullableDecimal, currency: z.string().nullable(), sourceRef: sourceIdSchema,
});
export const plannedLedgerCommandSchema = z.strictObject({
  id, idempotencyKey: id, type: id, effectiveDate: isoDate,
  securities: z.array(z.strictObject({ id, family: z.enum(["STOCK", "EQUITY_COMPENSATION", "WARRANT", "CONVERTIBLE"]), subtype: id, stakeholderId: id, stockClassId: nullableId, stockPlanId: nullableId, displayId: id, parentSecurityId: nullableId, sourceId: sourceIdSchema })),
  transactions: z.array(plannedTransactionSchema).min(1), dependencies: z.array(id), sourceId: sourceIdSchema,
});
export const importWritePlanSchema = z.strictObject({
  sourceSystem: z.enum(["pulley", "template"]), asOfDate: isoDate, orgId: id, shareUnit: decimalString,
  referenceRows: z.array(referenceRowSchema), commands: z.array(plannedLedgerCommandSchema),
  sourceIds: z.array(z.strictObject({ entity: z.enum(["stakeholder", "stock_class", "stock_plan", "security", "vesting_event", "exercise", "cancellation"]), sourceId: sourceIdSchema })),
});

export interface OpeningBalancePreview { securitySourceId: string; displayId: string; date: string; reason: string; source: SourceLocation; commandId: string }
export interface ReconciliationLine { scope: "company" | "class" | "plan" | "holder" | "security"; sourceId: string | null; name: string; metric: string; uploaded: string; app: string | null; matches: boolean; source: SourceLocation }
export interface ImportTotalsPreview {
  uploaded: UploadedTotals | null;
  app: { fullyDiluted: string | null; issuedAndOutstanding: string | null; byClass: Record<string, string>; byPlan: Record<string, { outstanding: string; available: string }>; byHolder: Record<string, { fullyDiluted: string; outstanding: string }>; bySecurity: Record<string, { outstanding: string; vested: string; vestedOutstanding: string }> };
  reconciliation: ReconciliationLine[];
}
export interface ImportPreviewOptions {
  asOfDate?: string;
  today?: string;
  orgId?: string;
  shareUnit?: string;
  /** Set the company currency and the fallback for source rows that leave it blank. */
  currency?: string;
  /** Use this only when the source does not state a currency. */
  fallbackCurrency?: string;
}
export interface ImportPreview { detectedFiles: DetectedImportFile[]; draft: ImportDraft; problems: ImportProblem[]; openingBalances: OpeningBalancePreview[]; totals: ImportTotalsPreview; plan: ImportWritePlan | null; canImport: boolean }
