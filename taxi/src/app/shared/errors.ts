import { z } from "zod";

// The error envelope: every non-2xx JSON answer is `{ error: { code, message, issues? } }`.

export const API_ERROR_CODES = [
  "validation_failed", // 400
  "unauthenticated", // 401
  "forbidden", // 403
  "not_found", // 404, also another organization's records
  "conflict", // 409, a stale revision or a rule about the household
  "payload_too_large", // 413
  "internal", // 500
] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const API_ERROR_STATUS = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  internal: 500,
} as const satisfies Record<ApiErrorCode, number>;

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
