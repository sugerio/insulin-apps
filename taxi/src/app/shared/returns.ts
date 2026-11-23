import { z } from "zod";
import { idSchema } from "./people.ts";

// What a year's returns are made of: each adult's slips and answers. Every change names the year's revision it was
// based on, like the family facts, and answers with the year (its new revision and steps).

export const revisionSchema = z.number().int().min(1);

/** An amount as printed on a slip: dollars and cents, no sign or separators. */
export const slipAmountSchema = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter an amount like 1234.56");
/**
 * A slip's boxes: box as printed (such as `14` or `16A`, or a Quebec RL slip's letter `A` or `A1`) → amount. The point or
 * dash of an RL sub-box is an underscore (box B.A is `B_A`), as a formula names it (slips.yaml).
 */
export const slipBoxesSchema = z.record(z.string().regex(/^[0-9A-Z]{1,3}(_[0-9A-Z]{1,3})?$/, "A box such as 14, 16A, A or B_A"), slipAmountSchema);

export const SLIP_STATUSES = ["unconfirmed", "confirmed"] as const;

export const slipSchema = z.strictObject({
  id: idSchema,
  personId: idSchema,
  /** A slip type of the year's rules, such as `T4`. */
  type: z.string(),
  issuer: z.string(),
  boxes: z.record(z.string(), z.string()),
  /** `unconfirmed` until someone checks it against the paper slip; any change sets it back. */
  status: z.enum(SLIP_STATUSES),
  /** `manual`: typed in. `ai`: read from an uploaded file. */
  source: z.enum(["manual", "ai"]),
  documentId: idSchema.nullable(),
  /** Boxes AI wasn't sure it read right: check these first. */
  unsure: z.array(z.string()),
  confirmedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});
export type Slip = z.infer<typeof slipSchema>;

export const slipListSchema = z.strictObject({ revision: revisionSchema, slips: z.array(slipSchema) });
export type SlipList = z.infer<typeof slipListSchema>;

export const createSlipSchema = z.strictObject({
  revision: revisionSchema,
  personId: idSchema,
  type: z.string().min(1).max(20),
  issuer: z.string().trim().min(1, "Enter who issued the slip").max(100),
  boxes: slipBoxesSchema.refine((boxes) => Object.keys(boxes).length > 0, { message: "Enter at least one box" }),
});
export type CreateSlip = z.infer<typeof createSlipSchema>;

export const updateSlipSchema = z
  .strictObject({
    revision: revisionSchema,
    /** Whose slip it is, when AI matched it to the wrong person. */
    personId: idSchema.optional(),
    issuer: z.string().trim().min(1, "Enter who issued the slip").max(100).optional(),
    boxes: slipBoxesSchema.refine((boxes) => Object.keys(boxes).length > 0, { message: "Enter at least one box" }).optional(),
  })
  .refine((value) => value.issuer !== undefined || value.boxes !== undefined || value.personId !== undefined, {
    message: "Change the person, the issuer or the boxes",
  });
export type UpdateSlip = z.infer<typeof updateSlipSchema>;

/** A change that needs nothing but the revision it is based on: removing a slip. */
export const revisionBodySchema = z.strictObject({ revision: revisionSchema });

/** Confirming slips: one adult's, or with no `personId` every adult's. */
export const confirmSlipsSchema = z.strictObject({ revision: revisionSchema, personId: idSchema.optional() });
export type ConfirmSlips = z.infer<typeof confirmSlipsSchema>;

/** An answer: money as decimal text, yes or no, a choice's option; null clears it. */
export const answerValueSchema = z.union([z.string().max(40), z.boolean(), z.null()]);
export const saveAnswersSchema = z.strictObject({
  revision: revisionSchema,
  personId: idSchema,
  answers: z.record(z.string().max(60), answerValueSchema).refine((answers) => Object.keys(answers).length > 0, { message: "Send at least one answer" }),
});
export type SaveAnswers = z.infer<typeof saveAnswersSchema>;
