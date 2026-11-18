import { z } from "zod";
import { idSchema, taxYearSchema } from "./household.ts";
import { SLIP_STATUSES } from "./returns.ts";

// Step 2: files uploaded for a tax year, one per request, each read by AI into slips.

/** The files the app reads: PDF, PNG and JPEG, up to 10 MiB each. */
export const DOCUMENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const DOCUMENT_STATUSES = ["read", "not_a_slip", "failed", "not_available"] as const;
/** What reading a file gave: a saved file's status, or `duplicate` for one that wasn't saved. */
export const READ_STATUSES = [...DOCUMENT_STATUSES, "duplicate"] as const;

export const documentSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
  /**
   * `read`: slips were found and added, unconfirmed. `not_a_slip`: nothing the app reads. `failed`: reading went
   * wrong; read it again. `not_available`: AI reading isn't set up for the organization.
   */
  status: z.enum(DOCUMENT_STATUSES),
  message: z.string(),
  /** Whose return it was uploaded in; null for a file uploaded before returns were per person. */
  personId: idSchema.nullable(),
  /** The slips read from it, each with the adult it is on (which may be the other adult of the year). Deleting the file deletes them. */
  slips: z.array(z.strictObject({ id: idSchema, type: z.string(), personId: idSchema, issuer: z.string(), status: z.enum(SLIP_STATUSES) })),
  createdAt: z.number().int(),
});
export type DocumentRecord = z.infer<typeof documentSchema>;

export const documentListSchema = z.strictObject({ documents: z.array(documentSchema) });
export type DocumentList = z.infer<typeof documentListSchema>;

/**
 * What uploading (or reading again) gave. `duplicate`: the same file, or the same slips, are already in the year, and
 * nothing was saved (`document` is null). Otherwise `document` is the file as saved, with the same status.
 */
export const readResultSchema = z.strictObject({
  status: z.enum(READ_STATUSES),
  message: z.string(),
  document: documentSchema.nullable(),
  year: taxYearSchema,
});
export type ReadResult = z.infer<typeof readResultSchema>;
