import "./zod-config.ts";
import { z } from "zod";
import { documentKindSchema, documentLinkRoleSchema, linkTargetTypeSchema, uploadContentTypeSchema } from "./enums.ts";
import { sha256HexSchema, uuidSchema } from "./primitives.ts";

// Transport rules: headers and size limits shared by the server and the SPA. Header names
// are lower case here, as the Fetch API and Hono expose them.

export const HEADERS = {
  /** Every mutating `/api/*` request; one key per user intent, reused on every retry (the API contract). */
  idempotencyKey: "idempotency-key",
  /** `true` on a response replayed from its idempotency receipt. */
  idempotentReplay: "idempotent-replay",
  contentSha256: "x-content-sha256",
  filename: "x-filename",
  documentKind: "x-document-kind",
  collectionId: "x-collection-id",
  linkTarget: "x-link-target",
  linkId: "x-link-id",
  linkRole: "x-link-role",
} as const;

/** 8–200 characters; the client sends a UUIDv4 per intent. Receipts are unique per (scope, actor, route, key). */
export const idempotencyKeySchema = z.string().min(8).max(200);

export const LIMITS = {
  /** JSON bodies (the API contract). */
  jsonBodyBytes: 256 * 1024,
  /** D1-backed files are capped at 10 MiB. */
  uploadBytes: 10 * 1024 * 1024,
} as const;

/** A Content-Type header compared by its bare media type: `text/plain;charset=UTF-8` is `text/plain`. */
export function mediaTypeSchema<T extends z.ZodType<string, string>>(allowed: T) {
  return z
    .string()
    .transform((value) => value.split(";")[0]!.trim().toLowerCase())
    .pipe(allowed);
}

/** `X-Filename` carries the URL-encoded name (the API contract); this decodes it and checks the stored length (1–255). */
export const encodedFilenameSchema = z
  .string()
  .min(1)
  .max(1024)
  .transform((value, ctx) => {
    try {
      return decodeURIComponent(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "X-Filename must be URL-encoded" });
      return z.NEVER;
    }
  })
  .pipe(z.string().min(1).max(255).refine((name) => !/[\u0000-\u001f\u007f/\\]/.test(name), "No path or control characters"));

/**
 * Headers that describe a raw document upload (`POST …/documents`, `POST …/documents/:id/versions`). The three link
 * headers come together or not at all; the Worker checks the magic bytes against `content-type` (415 otherwise). The
 * Idempotency-Key is not among them: like every mutating request's, it is the request's own key (the API contract).
 */
export const uploadHeadersSchema = z
  .object({
    "content-type": mediaTypeSchema(uploadContentTypeSchema),
    [HEADERS.filename]: encodedFilenameSchema,
    [HEADERS.documentKind]: documentKindSchema,
    [HEADERS.contentSha256]: sha256HexSchema,
    [HEADERS.collectionId]: uuidSchema.optional(),
    [HEADERS.linkTarget]: linkTargetTypeSchema.optional(),
    [HEADERS.linkId]: uuidSchema.optional(),
    [HEADERS.linkRole]: documentLinkRoleSchema.optional(),
  })
  .refine((headers) => {
    const present = [headers[HEADERS.linkTarget], headers[HEADERS.linkId], headers[HEADERS.linkRole]].filter(
      (value) => value !== undefined,
    ).length;
    return present === 0 || present === 3;
  }, "Send X-Link-Target, X-Link-Id and X-Link-Role together");

// Every streamed file answer is an attachment that is never rendered, sniffed or cached. A route's FileResponse names
// one of these schemas, and the Worker checks its headers against it.
const attachmentHeaderShape = {
  "content-type": z.string().min(1),
  "content-disposition": z.string().regex(/^attachment; filename\*=UTF-8''\S+$/, "Send an attachment with an RFC 5987 filename"),
  "x-content-type-options": z.literal("nosniff"),
  "cache-control": z.literal("no-store"),
  "content-security-policy": z.literal("sandbox; default-src 'none'"),
};

/** An export (CSV, XLSX or JSON): streamed, so it carries no digest. */
export const exportResponseHeadersSchema = z.object(attachmentHeaderShape);

/** A document download also carries the stored bytes' SHA-256: `Digest: sha-256=<base64>`. */
export const downloadResponseHeadersSchema = z.object({
  ...attachmentHeaderShape,
  digest: z.string().regex(/^sha-256=[A-Za-z0-9+/]{43}=$/, "Send Digest: sha-256=<base64>"),
});
