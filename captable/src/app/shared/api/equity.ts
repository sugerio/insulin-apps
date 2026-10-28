import "./zod-config.ts";
import { z } from "zod";
import { periodSchema, planReturnRulesSchema, terminationWindowSchema } from "./common.ts";
import {
  ANTI_DILUTION_KINDS,
  PARTICIPATION_KINDS,
  planStatusSchema,
  stockClassTypeSchema,
  transactionTypeSchema,
  VESTING_EVENT_KINDS,
  VESTING_EVENT_SOURCES,
  VESTING_EVENT_STATES,
  VESTING_FREQUENCIES,
} from "./enums.ts";
import {
  currencySchema,
  decimalSchema,
  decimalUnits,
  epochMsSchema,
  holdingsEchoShape,
  holdingsListSchema,
  isoDateSchema,
  listSchema,
  positiveDecimalSchema,
  positiveIntegerStringSchema,
  queryBooleanSchema,
  sha256HexSchema,
  uuidSchema,
  versionSchema,
} from "./primitives.ts";

// Equity structure (the API contract). The rows hold identity and descriptive data; every number-moving term is a
// ledger fact replayed by the engine (the ledger rules).

// ---------------------------------------------------------------------------
// Stock classes (read-only)

export const stockClassTermsSchema = z.object({
  votesPerShare: decimalSchema,
  excludeFromFullyDiluted: z.boolean(),
  seniority: z.number().int().nullable(),
  liquidationPreferenceMultiple: decimalSchema.nullable(),
  participation: z.enum(PARTICIPATION_KINDS).nullable(),
  participationCapMultiple: decimalSchema.nullable(),
  dividendTerms: z.record(z.string(), z.unknown()).nullable(),
  antiDilution: z.enum(ANTI_DILUTION_KINDS).nullable(),
  notRecordedInPulley: z.array(z.string()), // fields Pulley lacked (e.g. participation), shown as "not recorded"
});
export type StockClassTerms = z.infer<typeof stockClassTermsSchema>;

/** A history line of a class or plan: a ledger transaction that set its terms, authorized shares or pool. */
export const termsHistoryEntrySchema = z.object({
  effectiveDate: isoDateSchema,
  transactionId: uuidSchema,
  type: transactionTypeSchema,
  summary: z.string(),
});

export const stockClassSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  classType: stockClassTypeSchema,
  defaultIdPrefix: z.string(),
  parValue: decimalSchema.nullable(),
  originalIssuePrice: decimalSchema.nullable(),
  currency: currencySchema,
  isCertificated: z.boolean(),
  boardApprovalDate: isoDateSchema.nullable(),
  stockholderApprovalDate: isoDateSchema.nullable(),
  asOf: isoDateSchema,
  authorizedShares: decimalSchema,
  // An exact ratio of two whole numbers: 1:1 is {numerator: "1", denominator: "1"}.
  conversionRatio: z.object({ numerator: positiveIntegerStringSchema, denominator: positiveIntegerStringSchema }),
  terms: stockClassTermsSchema,
  numbers: z.object({
    issuedAndOutstanding: decimalSchema,
    reserved: decimalSchema,
    availableToIssue: decimalSchema,
    fullyDiluted: decimalSchema,
  }),
  history: z.array(termsHistoryEntrySchema),
  version: versionSchema,
});
export type StockClass = z.infer<typeof stockClassSchema>;
export const stockClassListSchema = holdingsListSchema(stockClassSchema);
export type StockClassList = z.infer<typeof stockClassListSchema>;
/** `GET …/stock-classes/:id`: the class with the ledger state it was computed from (the API contract). */
export const stockClassDetailSchema = stockClassSchema.extend(holdingsEchoShape);
export type StockClassDetail = z.infer<typeof stockClassDetailSchema>;

// ---------------------------------------------------------------------------
// Stock plans

export const stockPlanSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  stockClassId: uuidSchema,
  boardApprovalDate: isoDateSchema.nullable(),
  stockholderApprovalDate: isoDateSchema.nullable(),
  effectiveDate: isoDateSchema.nullable(),
  expirationDate: isoDateSchema.nullable(),
  asOf: isoDateSchema,
  poolSize: decimalSchema, // after amendments
  equityOutstanding: decimalSchema,
  equityRetired: decimalSchema,
  availableToGrant: decimalSchema, // poolSize − outstanding − retired (the ledger rules)
  returnRules: planReturnRulesSchema,
  // The X_STOCK_PLAN_TERMS in force: its actor and document are "who confirmed the rules, and when".
  returnRulesConfirmation: z.object({
    transactionId: uuidSchema,
    effectiveDate: isoDateSchema,
    confirmedBy: z.string(),
    confirmedAt: epochMsSchema,
    documentId: uuidSchema.nullable(),
  }),
  defaultTerminationWindows: z.array(terminationWindowSchema),
  defaultRepurchaseWindow: periodSchema.nullable(),
  status: planStatusSchema,
  pourOverPlanId: uuidSchema.nullable(),
  amendments: z.array(
    z.object({ effectiveDate: isoDateSchema, transactionId: uuidSchema, type: transactionTypeSchema, poolSize: decimalSchema.nullable() }),
  ),
  version: versionSchema,
});
export type StockPlan = z.infer<typeof stockPlanSchema>;
export const stockPlanListSchema = holdingsListSchema(stockPlanSchema);
export type StockPlanList = z.infer<typeof stockPlanListSchema>;
/** `GET …/stock-plans/:id`: capacity, rules with who confirmed them, exit-window defaults and amendments. */
export const stockPlanDetailSchema = stockPlanSchema.extend(holdingsEchoShape);
export type StockPlanDetail = z.infer<typeof stockPlanDetailSchema>;

// ---------------------------------------------------------------------------
// Vesting terms

/** Months per tranche for each frequency: the period p of the tranche generator (the product rules). */
export const VESTING_PERIOD_MONTHS = {
  MONTHLY: 1,
  QUARTERLY: 3,
  ANNUALLY: 12,
} as const satisfies Record<(typeof VESTING_FREQUENCIES)[number], number>;

type IssueSink = { addIssue(issue: { code: "custom"; path: (string | number)[]; message: string }): void };

/** Explicit tranches come in date order (equal dates allowed); an out-of-order table is a transform or entry error. */
export function checkTrancheOrder(events: readonly { date: string }[], ctx: IssueSink, path: (string | number)[]): void {
  events.forEach((event, index) => {
    if (index > 0 && event.date < events[index - 1]!.date) {
      ctx.addIssue({ code: "custom", path: [...path, index, "date"], message: "List the tranches in date order" });
    }
  });
}

/**
 * The tranche generator's inputs (the product rules; the ledger rules): tranche k falls k·p months after the start, so the
 * duration is a whole number of periods, and a cliff, when there is one, is a whole number of periods no longer than
 * the duration. Migrated grants keep Pulley's events as EXPLICIT, in date order.
 */
export const vestingDefinitionSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("SCHEDULE"),
      totalMonths: z.number().int().min(1).max(240),
      frequency: z.enum(VESTING_FREQUENCIES),
      cliff: z
        .strictObject({
          months: z.number().int().min(1), // a multiple of the period, at most totalMonths
          quantityRule: z.union([z.literal("RATABLE"), z.strictObject({ explicitQuantity: positiveDecimalSchema })]),
        })
        .nullable(),
      dayRule: z.literal("SAME_DAY_CLAMPED"), // same day of month as the start, clamped to the month's last day
    })
    .superRefine((schedule, ctx) => {
      const period = VESTING_PERIOD_MONTHS[schedule.frequency];
      if (schedule.totalMonths % period !== 0) {
        ctx.addIssue({ code: "custom", path: ["totalMonths"], message: `Use a whole number of ${period}-month periods` });
      }
      if (schedule.cliff === null) return;
      if (schedule.cliff.months % period !== 0) {
        ctx.addIssue({ code: "custom", path: ["cliff", "months"], message: `Use a whole number of ${period}-month periods` });
      }
      if (schedule.cliff.months > schedule.totalMonths) {
        ctx.addIssue({ code: "custom", path: ["cliff", "months"], message: "The cliff can't be longer than the schedule" });
      }
    }),
  z
    .strictObject({
      type: z.literal("EXPLICIT"),
      events: z
        .array(z.strictObject({ date: isoDateSchema, quantity: positiveDecimalSchema, pulleyId: z.string().max(64).optional(), kind: z.enum(["SCHEDULED", "EXPLICIT"]).optional() }))
        .min(1)
        .max(1000),
    })
    .superRefine((explicit, ctx) => checkTrancheOrder(explicit.events, ctx, ["events"])),
]);
export type VestingDefinition = z.infer<typeof vestingDefinitionSchema>;

/**
 * `POST …/vesting-terms/preview`: pure, no write and no Idempotency-Key. With the quantity known, an explicit table must
 * add up to it exactly, and an explicit cliff quantity can't exceed it.
 */
export const vestingPreviewRequestSchema = z
  .strictObject({
    definition: vestingDefinitionSchema,
    quantity: positiveDecimalSchema,
    vestingStartDate: isoDateSchema,
  })
  .superRefine(({ definition, quantity }, ctx) => {
    const total = decimalUnits(quantity);
    if (definition.type === "EXPLICIT") {
      const sum = definition.events.reduce((acc, event) => acc + decimalUnits(event.quantity), 0n);
      if (sum !== total) ctx.addIssue({ code: "custom", path: ["definition", "events"], message: "The tranches must add up to the quantity" });
    } else if (definition.cliff !== null && typeof definition.cliff.quantityRule === "object") {
      if (decimalUnits(definition.cliff.quantityRule.explicitQuantity) > total) {
        ctx.addIssue({
          code: "custom",
          path: ["definition", "cliff", "quantityRule", "explicitQuantity"],
          message: "The cliff can't vest more than the quantity",
        });
      }
    }
  });
export type VestingPreviewRequest = z.output<typeof vestingPreviewRequestSchema>;
export type VestingPreviewRequestInput = z.input<typeof vestingPreviewRequestSchema>;

export const vestingEventSchema = z.object({
  date: isoDateSchema,
  quantity: decimalSchema,
  cumulative: decimalSchema,
  state: z.enum(VESTING_EVENT_STATES),
  kind: z.enum(VESTING_EVENT_KINDS),
  source: z.enum(VESTING_EVENT_SOURCES),
});
export type VestingEvent = z.infer<typeof vestingEventSchema>;
export const vestingPreviewResponseSchema = z.object({ events: z.array(vestingEventSchema), total: decimalSchema });
export type VestingPreviewResponse = z.infer<typeof vestingPreviewResponseSchema>;

/** A vesting-terms row (immutable): a template, or one grant's EXPLICIT terms. */
export const vestingTermsSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  isTemplate: z.boolean(),
  templateId: uuidSchema.nullable(),
  definition: vestingDefinitionSchema,
  definitionSha256: sha256HexSchema,
  algorithmVersion: z.number().int().min(1),
  grantsUsing: z.number().int().nonnegative(),
  confirmedBy: z.string().nullable(), // who confirmed an imported template matches the plan's schedule
  confirmedAt: epochMsSchema.nullable(),
  importedFromPulley: z.boolean(),
  createdAt: epochMsSchema,
});
export type VestingTerms = z.infer<typeof vestingTermsSchema>;
export const vestingTermsListSchema = listSchema(vestingTermsSchema);
export type VestingTermsList = z.infer<typeof vestingTermsListSchema>;

/** `GET …/vesting-terms?templates=true`: templates only; left out, every row (templates and per-grant terms). */
export const vestingTermsQuerySchema = z.object({ templates: queryBooleanSchema.optional() });

/** `POST …/vesting-terms/:id/confirm` records the administrator's confirmation once; the body is empty. */
export const emptyRequestSchema = z.strictObject({});
