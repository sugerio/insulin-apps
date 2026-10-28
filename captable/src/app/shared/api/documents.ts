import "./zod-config.ts";
import { z } from "zod";
import { linkTargetSchema } from "./common.ts";
import {
  COLLECTION_KINDS,
  COLLECTION_SOURCES,
  DOCUMENT_SOURCES,
  DOCUMENT_VISIBILITY_SCOPES,
  documentContentTypeSchema,
  documentKindSchema,
  documentLinkRoleSchema,
  linkTargetTypeSchema,
} from "./enums.ts";
import {
  epochMsSchema,
  listSchema,
  pageQueryShape,
  pageSchema,
  queryBooleanSchema,
  sha256HexSchema,
  uuidSchema,
  versionSchema,
} from "./primitives.ts";

// Documents and records (the API contract). Uploads are a raw body with headers (`uploadHeadersSchema` in http.ts). A
// Holders see a document only when it is holder-visible and linked to them alone, or
// a company resource (holder-visible with no holder link); one linked to two or more holders is never visible.

export const documentLinkSchema = z.object({
  id: uuidSchema,
  role: documentLinkRoleSchema,
  targetType: linkTargetTypeSchema,
  targetId: uuidSchema,
  createdAt: epochMsSchema,
  createdBy: z.string().nullable(),
  revokedAt: epochMsSchema.nullable(),
  revokeReason: z.string().nullable(),
});
export type DocumentLink = z.infer<typeof documentLinkSchema>;

export const documentSchema = z.object({
  id: uuidSchema,
  filename: z.string(),
  contentType: documentContentTypeSchema,
  byteSize: z.number().int().positive(),
  sha256: sha256HexSchema,
  kind: documentKindSchema,
  source: z.enum(DOCUMENT_SOURCES),
  holderVisible: z.boolean(),
  visibilityScope: z.enum(DOCUMENT_VISIBILITY_SCOPES),
  collectionId: uuidSchema.nullable(),
  versionLabel: z.string().nullable(),
  supersedesDocumentId: uuidSchema.nullable(),
  description: z.string().nullable(),
  sourceCreatedAt: epochMsSchema.nullable(),
  uploadedBy: z.string().nullable(),
  createdAt: epochMsSchema,
  archivedAt: epochMsSchema.nullable(),
  links: z.array(documentLinkSchema),
  importedFromPulley: z.boolean(),
  version: versionSchema,
});
export type Document = z.infer<typeof documentSchema>;

/** `GET …/documents/:id`: metadata, links and the other versions of the same document. */
export const documentDetailSchema = documentSchema.extend({
  versions: z.array(
    z.object({ id: uuidSchema, versionLabel: z.string().nullable(), createdAt: epochMsSchema, supersedesDocumentId: uuidSchema.nullable() }),
  ),
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;

/** `GET …/documents?…`: newest first. */
export const documentListQuerySchema = z
  .object({
    collectionId: uuidSchema.optional(),
    kind: documentKindSchema.optional(),
    targetType: linkTargetTypeSchema.optional(),
    targetId: uuidSchema.optional(),
    includeArchived: queryBooleanSchema.optional(),
    ...pageQueryShape,
  })
  .refine((query) => (query.targetType === undefined) === (query.targetId === undefined), "Send targetType and targetId together");
export const documentPageSchema = pageSchema(documentSchema);
export type DocumentPage = z.infer<typeof documentPageSchema>;

/**
 * `PATCH …/documents/:id`: update metadata, folder or archived state.
 */
export const patchDocumentRequestSchema = z
  .strictObject({
    version: versionSchema,
    filename: z.string().trim().min(1).max(255).optional(),
    kind: documentKindSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    versionLabel: z.string().max(40).nullable().optional(),
    collectionId: uuidSchema.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(({ version: _version, ...fields }) => Object.values(fields).some((value) => value !== undefined), "Nothing to update");
export type PatchDocumentRequest = z.output<typeof patchDocumentRequestSchema>;
export type PatchDocumentRequestInput = z.input<typeof patchDocumentRequestSchema>;

/** `POST …/documents/:id/links`: append-only. */
export const addDocumentLinkRequestSchema = z.strictObject({ role: documentLinkRoleSchema, target: linkTargetSchema });
export type AddDocumentLinkRequest = z.output<typeof addDocumentLinkRequestSchema>;

/** `POST …/documents/:id/holder-visibility`: 422 MULTIPLE_HOLDERS when it is linked to two or more holders. */
export const holderVisibilityRequestSchema = z.strictObject({ version: versionSchema, visible: z.boolean() });
export type HolderVisibilityRequest = z.output<typeof holderVisibilityRequestSchema>;

/** A folder (admins create them) or a template group (migrated, read-only). */
export const documentCollectionSchema = z.object({
  id: uuidSchema,
  kind: z.enum(COLLECTION_KINDS),
  name: z.string(),
  parentId: uuidSchema.nullable(),
  source: z.enum(COLLECTION_SOURCES),
  archivedAt: epochMsSchema.nullable(),
  createdAt: epochMsSchema,
  version: versionSchema,
});
export type DocumentCollection = z.infer<typeof documentCollectionSchema>;
export const documentCollectionListSchema = listSchema(documentCollectionSchema);

/** `POST …/collections`: a folder. */
export const createCollectionRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  parentId: uuidSchema.optional(),
});
export type CreateCollectionRequest = z.output<typeof createCollectionRequestSchema>;

/** `PATCH …/collections/:id`: folders only; template groups are read-only. */
export const patchCollectionRequestSchema = z
  .strictObject({
    version: versionSchema,
    name: z.string().trim().min(1).max(200).optional(),
    parentId: uuidSchema.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(({ version: _version, ...fields }) => Object.values(fields).some((value) => value !== undefined), "Nothing to update");
export type PatchCollectionRequest = z.output<typeof patchCollectionRequestSchema>;

/** `{reason}` for revoking a live link once. */
export const revokeLinkRequestSchema = z.strictObject({ reason: z.string().trim().min(1, "Enter a reason").max(500) });
export type RevokeLinkRequest = z.output<typeof revokeLinkRequestSchema>;
