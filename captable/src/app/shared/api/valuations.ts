import "./zod-config.ts";
import { z } from "zod";
import { documentRefSchema } from "./common.ts";
import { VALUATION_EVENT_KINDS, VALUATION_REPORT_VERSIONS, VALUATION_TYPES, valuationStatusSchema } from "./enums.ts";
import {
  confirmationSchema,
  decimalSchema,
  displayIdSchema,
  epochMsSchema,
  isoDateSchema,
  listSchema,
  noteSchema,
  positiveDecimalSchema,
  uuidSchema,
} from "./primitives.ts";

// Valuations (409A; the API contract). Immutable: no PATCH (trigger). A mistake is voided and recorded again; the status
// is computed for a date from the dates and the events (material event, review cleared, void).

const descriptionSchema = z.string().trim().min(1).max(2000);

/** `POST …/valuations` records a valuation for the company. */
export const recordValuationRequestSchema = z.strictObject({
  name: z.string().max(200).optional(), // default "<Mon YYYY> Valuation"
  provider: z.string().min(1).max(200),
  effectiveDate: isoDateSchema,
  expirationDate: isoDateSchema.optional(), // default effective + 12 months (an upper bound, not a guarantee)
  boardApprovalDate: isoDateSchema.optional(),
  boardConsentDocumentId: uuidSchema.optional(),
  prices: z.array(z.strictObject({ stockClassId: uuidSchema, pricePerShare: positiveDecimalSchema })).min(1), // common is required
  reportDocumentId: uuidSchema, // required for every valuation recorded in the app (CHECK)
  methodNotes: z.string().max(4000).optional(),
});
export type RecordValuationRequest = z.output<typeof recordValuationRequestSchema>;
export type RecordValuationRequestInput = z.input<typeof recordValuationRequestSchema>;

export const valuationEventSchema = z.object({
  id: uuidSchema,
  kind: z.enum(VALUATION_EVENT_KINDS),
  eventDate: isoDateSchema,
  description: z.string(),
  documentId: uuidSchema.nullable(),
  reversesEventId: uuidSchema.nullable(),
  createdBy: z.string(),
  createdAt: epochMsSchema,
});
export type ValuationEvent = z.infer<typeof valuationEventSchema>;

export const valuationSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  valuationType: z.enum(VALUATION_TYPES),
  provider: z.string().nullable(),
  effectiveDate: isoDateSchema,
  expirationDate: isoDateSchema.nullable(),
  boardApprovalDate: isoDateSchema.nullable(),
  reportVersion: z.enum(VALUATION_REPORT_VERSIONS),
  prices: z.array(z.object({ stockClassId: uuidSchema, pricePerShare: decimalSchema })),
  status: valuationStatusSchema,
  statusAsOf: isoDateSchema,
  presumptivelyValidUntil: isoDateSchema.nullable(),
  events: z.array(valuationEventSchema),
  reportDocumentId: uuidSchema.nullable(),
  importedFromPulley: z.boolean(),
});
export type Valuation = z.infer<typeof valuationSchema>;
/** `GET …/valuations`: newest effective first. */
export const valuationListSchema = listSchema(valuationSchema);
export type ValuationList = z.infer<typeof valuationListSchema>;

/** `GET …/valuations/:id`: events, prices, documents, and the grants priced with it. */
export const valuationDetailSchema = valuationSchema.extend({
  documents: z.array(documentRefSchema),
  grants: z.array(
    z.object({
      securityId: uuidSchema,
      displayId: displayIdSchema,
      stakeholderId: uuidSchema,
      grantDate: isoDateSchema,
      exercisePrice: decimalSchema,
      // The class the option is on, to compare its strike with that class's FMV; absent means the common class.
      stockClassId: uuidSchema.optional(),
    }),
  ),
});
export type ValuationDetail = z.infer<typeof valuationDetailSchema>;

/**
 * `POST …/valuations/material-events`: appends MATERIAL_EVENT to the valuation presumptively valid on the
 * date. Its status becomes review_required and new grants are blocked until a review clears it.
 */
export const materialEventRequestSchema = z.strictObject({
  eventDate: isoDateSchema,
  description: descriptionSchema,
  documentId: uuidSchema.optional(),
});
export type MaterialEventRequest = z.output<typeof materialEventRequestSchema>;

/** `POST …/valuations/:id/review-cleared`: the provider's or counsel's written confirmation is required. */
export const reviewClearedRequestSchema = z.strictObject({
  eventDate: isoDateSchema,
  description: descriptionSchema,
  documentId: uuidSchema,
});
export type ReviewClearedRequest = z.output<typeof reviewClearedRequestSchema>;

/**
 * `POST …/valuations/:id/events/:eventId/reverse`: a material-event flag raised in error, reversed once.
 * `confirmation` is the valuation's `name`, exactly as `Valuation.name` shows it (surrounding spaces ignored).
 */
export const reverseValuationEventRequestSchema = z.strictObject({ note: noteSchema, confirmation: confirmationSchema });
export type ReverseValuationEventRequest = z.output<typeof reverseValuationEventRequestSchema>;

/** `POST …/valuations/:id/void` records that a valuation was entered in error. */
export const voidValuationRequestSchema = materialEventRequestSchema;
export type VoidValuationRequest = z.output<typeof voidValuationRequestSchema>;

/** `GET …/valuations/fmv?date=&stockClassId=`: the FMV in effect; the common class when no class is named. */
export const fmvQuerySchema = z.object({ date: isoDateSchema, stockClassId: uuidSchema.optional() });
export const fmvResponseSchema = z.object({
  date: isoDateSchema,
  stockClassId: uuidSchema,
  // The presumptively valid valuation on the date, split-adjusted; null when there is none.
  fmv: z
    .object({
      valuationId: uuidSchema,
      valuationName: z.string(),
      pricePerShare: decimalSchema,
      splitAdjusted: z.boolean(),
      status: valuationStatusSchema,
    })
    .nullable(),
});
export type FmvResponse = z.infer<typeof fmvResponseSchema>;
