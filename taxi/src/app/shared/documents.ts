import { z } from "zod";
import { idSchema, taxYearSchema } from "./household.ts";

// Step 2: files uploaded for a tax year, one per request, each read by AI into slips.

/** The files the app reads: PDF, PNG and JPEG, up to 10 MiB each. */
export const DOCUMENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const DOCUMENT_STATUSES = ["read", "duplicate", "not_a_slip", "failed", "not_available"] as const;

export const documentSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
  /**
   * `read`: slips were found and added, unconfirmed. `duplicate`: this file, or the same slips, are already in the year.
   * `not_a_slip`: nothing the app reads. `failed`: reading went wrong; try again. `not_available`: AI reading isn't
   * set up for the organization.
   */
  status: z.enum(DOCUMENT_STATUSES),
  message: z.string(),
  /** The slips added from it. */
  slips: z.array(z.strictObject({ id: idSchema, type: z.string(), personId: idSchema, issuer: z.string() })),
  createdAt: z.number().int(),
});
export type DocumentRecord = z.infer<typeof documentSchema>;

export const documentListSchema = z.strictObject({ documents: z.array(documentSchema) });
export type DocumentList = z.infer<typeof documentListSchema>;

export const uploadResultSchema = z.strictObject({ document: documentSchema, year: taxYearSchema });
export type UploadResult = z.infer<typeof uploadResultSchema>;
