import "../zod-config.ts";
import { z } from "zod";
import { periodSchema, terminationWindowSchema } from "../common.ts";
import { documentKindSchema, ELECTION_83B_STATUSES, optionTypeSchema, REPURCHASE_WINDOW_STATUSES, securityFamilySchema } from "../enums.ts";
import { paymentInstructionDetailsSchema } from "../orgs.ts";
import { decimalSchema, displayIdSchema, epochMsSchema, isoDateSchema, uuidSchema } from "../primitives.ts";

// The holder portal's allowlist (the API contract). Every portal response is built from these strict schemas and parsed
// before it is sent, so an unexpected key fails the request (500) instead of leaking. They carry no fully diluted
// figures, no percentages, no other holders and no org totals. Every object here is a z.strictObject: the contract
// test (test/api/portal-allowlist.test.ts) walks them and fails on any other kind of object or a forbidden key.

/** A document the holder may open: their own (`mine`) or a company resource for every holder (`company`). */
export const portalDocumentSchema = z.strictObject({
  id: uuidSchema,
  filename: z.string(),
  kind: documentKindSchema,
  createdAt: epochMsSchema,
  // An imported document: when it was uploaded where it came from (`documents.source_created_at`). Never a signing date.
  sourceCreatedAt: epochMsSchema.nullable(),
  scope: z.enum(["mine", "company"]),
});
export type PortalDocument = z.infer<typeof portalDocumentSchema>;

/** The holder's own numbers for one security; null where the family has no such number. */
export const portalSecurityNumbersSchema = z.strictObject({
  asOf: isoDateSchema,
  granted: decimalSchema.nullable(),
  outstanding: decimalSchema.nullable(),
  vested: decimalSchema.nullable(),
  unvested: decimalSchema.nullable(),
  exercised: decimalSchema.nullable(),
  exercisable: decimalSchema.nullable(),
  cancelled: decimalSchema.nullable(),
});
export type PortalSecurityNumbers = z.infer<typeof portalSecurityNumbersSchema>;

export const portalVestingEventSchema = z.strictObject({
  date: isoDateSchema,
  quantity: decimalSchema,
  cumulative: decimalSchema,
  status: z.enum(["VESTED", "UPCOMING", "STOPPED"]),
});
export type PortalVestingEvent = z.infer<typeof portalVestingEventSchema>;

/** Whose signature a security still awaits (`X_EXECUTION_STATUS`, the product rules). */
export const PORTAL_EXECUTION_PENDING = ["pending_holder", "pending_company", "pending_both"] as const;

export const portalSecuritySchema = z.strictObject({
  id: uuidSchema,
  orgId: uuidSchema,
  displayId: displayIdSchema,
  family: securityFamilySchema,
  optionType: optionTypeSchema.nullable(),
  className: z.string().nullable(),
  planName: z.string().nullable(),
  issueDate: isoDateSchema,
  // A holder never sees a retracted security: it never legally existed.
  status: z.enum(["OUTSTANDING", "EXERCISED", "CANCELLED", "EXPIRED", "REPURCHASED", "TRANSFERRED", "CONVERTED"]),
  // Awaiting signatures (the product rules): whose signature is still missing; null once executed (or none is needed).
  // Only the holder's own missing signature (pending_holder, pending_both) blocks exercise; a grant awaiting only the
  // company's countersignature is exercisable. `numbers.exercisable` already follows the rule.
  executionPending: z.enum(PORTAL_EXECUTION_PENDING).nullable(),
  exercisePrice: decimalSchema.nullable(),
  expirationDate: isoDateSchema.nullable(),
  contractualDeadline: isoDateSchema.nullable(), // shown for terminated holders
  isoDeadline: isoDateSchema.nullable(),
  numbers: portalSecurityNumbersSchema,
  vestingStartDate: isoDateSchema.nullable(), // as recorded (TX_VESTING_START); null without one
  vesting: z.array(portalVestingEventSchema),
  documents: z.array(portalDocumentSchema),
  convertedInto: z.array(z.strictObject({ displayId: displayIdSchema })).optional(), // a SAFE's converted history: the caller's own lots
});
export type PortalSecurity = z.infer<typeof portalSecuritySchema>;

// A holding's detail page (the product rules): what the overview's PortalSecurity carries, plus the family's own facts.
// `GET /api/portal/orgs/:orgId/securities/:id` answers with it, and so does the admin's preview of that page.

/** Acceleration terms (`x_acceleration_terms.kind`). */
export const PORTAL_ACCELERATION_KINDS = ["NONE", "SINGLE_TRIGGER", "DOUBLE_TRIGGER"] as const;

/**
 * An option grant: early exercise, the ISO/NSO split, the post-termination periods, board approval, acceleration and
 * the holder's exercises.
 */
export const portalOptionDetailSchema = z.strictObject({
  family: z.literal("EQUITY_COMPENSATION"),
  earlyExerciseAllowed: z.boolean(), // by the grant agreement; holder requests remain vested-only
  // The $100K test's split (the ledger rules) by the year the options first become exercisable. Empty for an NSO grant.
  isoSplit: z.array(
    z.strictObject({
      year: z.number().int(),
      firstExercisable: decimalSchema, // options of this grant that first become exercisable in the year
      valueAtGrant: decimalSchema, // firstExercisable × FMV at grant: what the $100,000 limit counts
      iso: decimalSchema,
      nso: decimalSchema,
    }),
  ),
  // One window per termination reason: the grant's override, else the plan default (the product rules).
  postTerminationPeriods: z.array(terminationWindowSchema),
  boardApprovalDate: isoDateSchema.nullable(), // null: not recorded
  // The grant's acceleration terms as recorded (kind and the agreement's own words); null: not recorded.
  acceleration: z.strictObject({ kind: z.enum(PORTAL_ACCELERATION_KINDS), text: z.string().nullable() }).nullable(),
  // The holder's own exercises of this grant, oldest first. Resulting shares are the holder's own lots, in the overview.
  exercises: z.array(
    z.strictObject({
      date: isoDateSchema,
      quantity: decimalSchema,
      iso: decimalSchema,
      nso: decimalSchema, // includes ISO-designated options exercised after the ISO deadline
      resultingShares: z.array(z.strictObject({ displayId: displayIdSchema })),
    }),
  ),
});
export type PortalOptionDetail = z.infer<typeof portalOptionDetailSchema>;

/** How a share lot is held (the product rulesshare detail). */
export const PORTAL_SHARE_FORMS = ["book_entry", "migrated_unsigned_certificate", "uncertificated"] as const;

/** The 83(b) election in force on a lot, or NOT_RECORDED: the lot vests (restricted stock) and no election is on record. */
export const PORTAL_ELECTION_83B_STATUSES = [...ELECTION_83B_STATUSES, "NOT_RECORDED"] as const;

/** A share lot: price, form, legends, holding start, 83(b), the company's repurchase right and the lot's origin. */
export const portalShareDetailSchema = z.strictObject({
  family: z.literal("STOCK"),
  pricePerShare: decimalSchema.nullable(),
  form: z.enum(PORTAL_SHARE_FORMS),
  legends: z.array(z.string()), // legend names
  holdingStartDate: isoDateSchema.nullable(), // as recorded (`x_holding_start_date`); null: not recorded
  // null: no 83(b) election applies (the lot never vested over time) and none is recorded.
  election83b: z.strictObject({ status: z.enum(PORTAL_ELECTION_83B_STATUSES), filedOn: isoDateSchema.nullable() }).nullable(),
  // Restricted stock: the company's right to buy back unvested shares; null when the lot carries none.
  repurchase: z
    .strictObject({
      price: decimalSchema.nullable(), // per share, as recorded
      window: periodSchema.nullable(), // how long after a termination the company may repurchase, as recorded
      lastDate: isoDateSchema.nullable(), // once the holder has left: the last day of the window
      status: z.enum(REPURCHASE_WINDOW_STATUSES).nullable(), // once the holder has left
    })
    .nullable(),
  // How the lot began when it wasn't issued directly. `from` names the source lot only when it was the holder's own.
  origin: z.strictObject({ kind: z.enum(["exercise", "conversion", "transfer"]), from: displayIdSchema.nullable() }).nullable(),
});
export type PortalShareDetail = z.infer<typeof portalShareDetailSchema>;

/** A warrant: everything it shows is in PortalSecurity. */
export const portalWarrantDetailSchema = z.strictObject({ family: z.literal("WARRANT") });

/** A SAFE: principal, terms as recorded, and the conversion (its resulting lots are `convertedInto`). */
export const portalSafeDetailSchema = z.strictObject({
  family: z.literal("CONVERTIBLE"),
  principal: decimalSchema,
  terms: z.strictObject({
    form: z.string().nullable(), // the SAFE form as recorded
    valuationCap: decimalSchema.nullable(), // null: uncapped
    discountRate: decimalSchema.nullable(), // the SAFE's own discount as a fraction (0.2 = 20%); null: none
  }),
  conversion: z.strictObject({ date: isoDateSchema, quantity: decimalSchema, className: z.string() }).nullable(),
});
export type PortalSafeDetail = z.infer<typeof portalSafeDetailSchema>;

export const portalSecurityDetailSchema = portalSecuritySchema
  .extend({
    detail: z.discriminatedUnion("family", [portalOptionDetailSchema, portalShareDetailSchema, portalWarrantDetailSchema, portalSafeDetailSchema]),
  })
  .refine((security) => security.detail.family === security.family, { message: "The detail must be the security's own family", path: ["detail", "family"] });
export type PortalSecurityDetail = z.infer<typeof portalSecurityDetailSchema>;

/** One matched stakeholder record of the caller, in one org. */
export const portalHoldingSchema = z.strictObject({
  orgId: uuidSchema,
  orgDisplayName: z.string(),
  stakeholderId: uuidSchema,
  stakeholderName: z.string(), // the caller's own record
  securities: z.array(portalSecuritySchema),
});
export type PortalHolding = z.infer<typeof portalHoldingSchema>;

/** `GET /api/portal/overview?asOf=`, across every matched org; also the admin's "Preview as stakeholder". */
export const portalOverviewSchema = z.strictObject({ asOf: isoDateSchema, holdings: z.array(portalHoldingSchema) });
export type PortalOverview = z.infer<typeof portalOverviewSchema>;

/** `GET /api/portal/orgs/:orgId/documents`: the caller's documents plus company resources (an array, the API contract). */
export const portalDocumentListSchema = z.array(portalDocumentSchema);
export type PortalDocumentList = z.infer<typeof portalDocumentListSchema>;

/** `GET /api/portal/orgs/:orgId/how-to-exercise`. Payment instructions are shown only here, never e-mailed. */
export const howToExerciseSchema = z.strictObject({
  text: z.string(), // settings.portal.howToExerciseText, or the default
  noticeForm: portalDocumentSchema.nullable(), // counsel's notice of exercise (a company resource)
  privacyNotice: portalDocumentSchema.nullable(), // counsel's privacy notice (settings.portal.privacyNoticeDocumentId), for the footer
  paymentInstructions: paymentInstructionDetailsSchema.nullable(),
  companyContact: z.strictObject({ name: z.string(), email: z.string() }).nullable(),
});
export type HowToExercise = z.infer<typeof howToExerciseSchema>;

/** Every portal response schema, for the allowlist contract test and the Worker's response check. */
export const PORTAL_RESPONSE_SCHEMAS = {
  portalOverview: portalOverviewSchema,
  portalSecurity: portalSecuritySchema,
  portalSecurityDetail: portalSecurityDetailSchema,
  portalDocumentList: portalDocumentListSchema,
  howToExercise: howToExerciseSchema,
} as const;
