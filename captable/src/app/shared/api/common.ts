import "./zod-config.ts";
import { z } from "zod";
import { documentKindSchema, periodUnitSchema, planReturnRuleSchema, terminationWindowReasonSchema } from "./enums.ts";
import { countryCodeSchema, decimalSchema, uuidSchema } from "./primitives.ts";

// Shapes shared by several API areas.

export const addressSchema = z.strictObject({
  line1: z.string().max(200),
  line2: z.string().max(200).optional(),
  city: z.string().max(100),
  region: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: countryCodeSchema,
});
export type Address = z.infer<typeof addressSchema>;

/** A length of time; 0 is allowed (a 0-day window ends exercisability on the termination date, CL-23). */
export const periodSchema = z.strictObject({ period: decimalSchema, unit: periodUnitSchema });
export type Period = z.infer<typeof periodSchema>;

/** One exit window per termination reason. */
export const terminationWindowSchema = periodSchema.extend({ reason: terminationWindowReasonSchema });
export type TerminationWindow = z.infer<typeof terminationWindowSchema>;

/**
 * The five return-to-pool rules (the product rules; the ledger rules). The API has no default: the single default,
 * all RETURN, lives in the engine's plan-rules module and only the migration uses it.
 */
export const planReturnRulesSchema = z.strictObject({
  cancelledUnvestedAwards: planReturnRuleSchema,
  expiredVestedOptions: planReturnRuleSchema,
  repurchasedUnvestedShares: planReturnRuleSchema,
  repurchasedVestedShares: planReturnRuleSchema,
  sharesWithheldForTax: planReturnRuleSchema,
});
export type PlanReturnRules = z.infer<typeof planReturnRulesSchema>;

/** What a document link points at: exactly one target (the `document_links` exclusive arc). */
export const linkTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("security"), id: uuidSchema }),
  z.strictObject({ type: z.literal("stakeholder"), id: uuidSchema }),
  z.strictObject({ type: z.literal("stock_plan"), id: uuidSchema }),
  z.strictObject({ type: z.literal("stock_class"), id: uuidSchema }),
  z.strictObject({ type: z.literal("valuation"), id: uuidSchema }),
  z.strictObject({ type: z.literal("exercise_request"), id: uuidSchema }),
  z.strictObject({ type: z.literal("transaction"), id: uuidSchema }),
]);
export type LinkTarget = z.infer<typeof linkTargetSchema>;

/** A document named inside another object's detail view (a valuation's report, a migrated request's notice). */
export const documentRefSchema = z.object({ id: uuidSchema, filename: z.string(), kind: documentKindSchema });
export type DocumentRef = z.infer<typeof documentRefSchema>;
