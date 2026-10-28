import { api } from "#shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { insertAudit } from "../lib/audit.ts";
import {
  auditStatement, digestHeader, documentActorLabels, documentJson, findIdempotency, getDocument, getLinks,
  getLinksForDocuments, idempotencyInsert, linkInsert, requestHash,
} from "../lib/documents/model.ts";
import { DocumentStore } from "../lib/documents/store.ts";
import {
  isDocumentKind, isDocumentLinkRole, isLinkTarget, TARGET_COLUMNS,
  type DocumentKind, type DocumentLinkRole, type DocumentLinkRow, type DocumentRow, type LinkTarget,
} from "../lib/documents/types.ts";
import { bufferUpload, UnsupportedDocumentTypeError } from "../lib/documents/upload.ts";
import { evaluateHolderDocumentAccess, listHolderDocuments, resolvedDocumentHolders } from "../lib/documents/visibility.ts";
import { BodyTooLargeError, ApiError, clientIp, forbidden, notFound, readJson, userAgent } from "../lib/http.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const patchBody = z.strictObject({
  version: z.number().int().positive(), filename: z.string().min(1).max(255).optional(),
  kind: z.string().optional(), description: z.string().max(2000).nullable().optional(),
  versionLabel: z.string().max(40).nullable().optional(), collectionId: uuid.nullable().optional(),
  archived: z.boolean().optional(),
});
const visibilityBody = z.strictObject({ version: z.number().int().positive(), visible: z.boolean() });
const linkBody = api.addDocumentLinkRequestSchema;
const revokeBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });
const collectionBody = z.strictObject({ name: z.string().trim().min(1).max(200), parentId: uuid.nullable().optional() });
const collectionPatchBody = z.strictObject({
  version: z.number().int().positive(), name: z.string().trim().min(1).max(200).optional(),
  parentId: uuid.nullable().optional(), archived: z.boolean().optional(),
});
const portalDocument = z.strictObject({
  id: uuid, filename: z.string(), kind: z.enum([
    "GRANT_AGREEMENT", "STOCK_PURCHASE_AGREEMENT", "SAFE_AGREEMENT", "WARRANT_AGREEMENT",
    "NOTICE_OF_EXERCISE", "ELECTION_83B", "BOARD_CONSENT", "STOCKHOLDER_CONSENT", "PLAN_DOCUMENT", "CHARTER",
    "VALUATION_REPORT", "VALUATION_SUPPORT", "COUNSEL_MEMO", "SEPARATION_AGREEMENT", "PAYMENT_RECORD", "CERTIFICATE",
    "TEMPLATE", "STATEMENT", "FORM_3921", "RECONCILIATION_REPORT", "IMPORT_ARCHIVE", "OTHER",
  ]), createdAt: z.number(), scope: z.enum(["mine", "company"]),
});
const DEFAULT_VISIBLE_KINDS = new Set<DocumentKind>([
  "GRANT_AGREEMENT", "STOCK_PURCHASE_AGREEMENT", "NOTICE_OF_EXERCISE", "CERTIFICATE",
]);
const TARGET_TABLES: Record<keyof typeof TARGET_COLUMNS, string> = {
  security: "securities", stakeholder: "stakeholders", stock_plan: "stock_plans", stock_class: "stock_classes",
  valuation: "valuations", exercise_request: "exercise_requests", transaction: "transactions",
};

function requiredHeader(c: Context<AppEnv>, name: string): string {
  const value = c.req.header(name);
  if (!value) throw new ApiError("validation_failed", `${name} is required`);
  return value;
}

function idempotencyKey(c: Context<AppEnv>): string {
  const value = requiredHeader(c, "Idempotency-Key");
  if (value.length < 8 || value.length > 200) throw new ApiError("validation_failed", "Idempotency-Key must be 8–200 characters");
  return value;
}

function audit(c: Context<AppEnv>, action: string, result: "success" | "denied" | "error", now: number, targetId?: string) {
  const auth = c.get("auth");
  return {
    occurredAt: now, orgId: c.req.param("orgId") ?? null, actorUserId: auth.user.id, actorEmail: auth.user.email,
    authMethod: auth.authMethod, action, targetType: "document", targetId: targetId ?? null, result,
    ip: clientIp(c), userAgent: userAgent(c), requestId: c.req.header("CF-Ray") ?? null,
  } as const;
}

async function deny(c: Context<AppEnv>, deps: AppDeps, reason: string, message: string): Promise<never> {
  await insertAudit(c.env.DB, {
    ...audit(c, "access.denied", "denied", deps.now(), c.req.param("id")), reason,
    details: { method: c.req.method, path: c.req.path },
  }).run();
  const clientReason = (api.FORBIDDEN_REASONS as readonly string[]).includes(reason) ? reason : undefined;
  throw new ApiError("forbidden", message, undefined, clientReason ? { reason: clientReason } : undefined);
}

async function adminGrant(c: Context<AppEnv>, deps: AppDeps, orgId: string, write: boolean) {
  const grant = c.get("auth").orgAccess.get(orgId);
  if (!grant) return deny(c, deps, "org_access_required", "You do not have access to this organization");
  if (write && grant.access === "admin_ro") {
    return deny(c, deps, "write_access_required", "Read-only administrators cannot change documents");
  }
  if (write) {
    const org = await c.env.DB.prepare("SELECT status FROM orgs WHERE id = ?").bind(orgId).first<{ status: string }>();
    if (!org || org.status !== "active") return deny(c, deps, "org_inactive", api.inactiveOrgMessage(org?.status));
  }
  return grant;
}

function validateFilename(filename: string): string {
  if (filename.length < 1 || filename.length > 255 || /[\u0000-\u001f/\\]/.test(filename)) {
    throw new ApiError("validation_failed", "Filename is invalid");
  }
  return filename;
}

function parseFilename(value: string): string {
  try { return validateFilename(decodeURIComponent(value)); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("validation_failed", "X-Filename is not valid URL-encoded text");
  }
}

function parseOptionalLink(c: Context<AppEnv>): { id: string; role: DocumentLinkRole; target: LinkTarget } | null {
  const targetType = c.req.header("X-Link-Target");
  const targetId = c.req.header("X-Link-Id");
  const role = c.req.header("X-Link-Role");
  if (!targetType && !targetId && !role) return null;
  const target = { type: targetType, id: targetId };
  if (!isLinkTarget(target)) throw new ApiError("validation_failed", "X-Link-Target is invalid");
  if (!role || !isDocumentLinkRole(role)) throw new ApiError("validation_failed", "X-Link-Role is invalid");
  return { id: crypto.randomUUID(), role, target };
}

function uploadError(error: unknown): never {
  if (error instanceof BodyTooLargeError) throw new ApiError("payload_too_large", "Documents cannot exceed 10 MiB");
  if (error instanceof UnsupportedDocumentTypeError) throw new ApiError("unsupported_media_type", error.message);
  throw error;
}

interface Mutation {
  consoleOrganizationId: string;
  scope: string;
  actor: string;
  route: string;
  key: string;
  hash: string;
  now: number;
}

function response(body: string, status: number, replay = false): Response {
  return new Response(status === 204 ? null : body, {
    status, headers: { "Content-Type": "application/json", ...(replay ? { "Idempotent-Replay": "true" } : {}) },
  });
}

async function beginMutation(
  c: Context<AppEnv>, deps: AppDeps, scope: string, route: string, parts: unknown[],
): Promise<Mutation | Response> {
  const key = idempotencyKey(c);
  const auth = c.get("auth");
  const actor = auth.user.id;
  const hash = await requestHash(c.req.method, c.req.path, parts);
  const previous = await findIdempotency(c.env.DB, auth.consoleOrganizationId, scope, actor, route, key);
  if (previous) {
    if (previous.request_sha256 !== hash) {
      throw new ApiError("conflict", "Idempotency-Key was already used for a different request", undefined, {
        reason: "idempotency_key_reused",
      });
    }
    return response(previous.response_body, previous.response_status, true);
  }
  return { consoleOrganizationId: auth.consoleOrganizationId, scope, actor, route, key, hash, now: deps.now() };
}

async function commitMutation(
  c: Context<AppEnv>, mutation: Mutation, statements: D1PreparedStatement[], status: number, body: string,
): Promise<Response> {
  const receipt = idempotencyInsert(c.env.DB, {
    id: crypto.randomUUID(), consoleOrganizationId: mutation.consoleOrganizationId,
    scope: mutation.scope, actor: mutation.actor, route: mutation.route,
    key: mutation.key, requestHash: mutation.hash, status, body, now: mutation.now,
  });
  try { await c.env.DB.batch([...statements, receipt]); }
  catch (error) {
    const raced = await findIdempotency(
      c.env.DB, mutation.consoleOrganizationId, mutation.scope, mutation.actor, mutation.route, mutation.key,
    );
    if (raced?.request_sha256 === mutation.hash) return response(raced.response_body, raced.response_status, true);
    if (raced) throw new ApiError("conflict", "Idempotency-Key was already used for a different request", undefined, {
      reason: "idempotency_key_reused",
    });
    throw error;
  }
  return response(body, status);
}

async function targetExists(db: D1Database, orgId: string, target: LinkTarget): Promise<boolean> {
  const table = TARGET_TABLES[target.type];
  return await db.prepare(`SELECT 1 FROM ${table} WHERE org_id = ? AND id = ?`).bind(orgId, target.id).first() !== null;
}

async function targetHolder(db: D1Database, orgId: string, target: LinkTarget): Promise<string | null> {
  if (target.type === "stakeholder") {
    return (await db.prepare("SELECT id FROM stakeholders WHERE org_id = ? AND id = ?").bind(orgId, target.id)
      .first<{ id: string }>())?.id ?? null;
  }
  if (target.type === "security") {
    return (await db.prepare("SELECT stakeholder_id FROM securities WHERE org_id = ? AND id = ?").bind(orgId, target.id)
      .first<{ stakeholder_id: string }>())?.stakeholder_id ?? null;
  }
  if (target.type === "exercise_request") {
    return (await db.prepare("SELECT stakeholder_id FROM exercise_requests WHERE org_id = ? AND id = ?").bind(orgId, target.id)
      .first<{ stakeholder_id: string }>())?.stakeholder_id ?? null;
  }
  return null;
}

function encodeCursor(row: DocumentRow): string {
  return btoa(JSON.stringify([row.created_at, row.id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(value: string | undefined): [number, string] | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    if (!Array.isArray(decoded) || !Number.isSafeInteger(decoded[0]) || !uuid.safeParse(decoded[1]).success) throw new Error();
    return [decoded[0], decoded[1]];
  } catch { throw new ApiError("validation_failed", "cursor is invalid"); }
}

async function uploadDocument(c: Context<AppEnv>, deps: AppDeps, supersedesDocumentId: string | null): Promise<Response> {
  const orgId = c.req.param("orgId")!;
  const grant = await adminGrant(c, deps, orgId, true);
  const auth = c.get("auth");
  const filename = parseFilename(requiredHeader(c, "X-Filename"));
  const kindHeader = requiredHeader(c, "X-Document-Kind");
  if (!isDocumentKind(kindHeader)) throw new ApiError("validation_failed", "X-Document-Kind is invalid");
  const expectedSha = requiredHeader(c, "X-Content-SHA256");
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new ApiError("validation_failed", "X-Content-SHA256 must be lowercase hexadecimal");
  const collectionId = c.req.header("X-Collection-Id") ?? null;
  if (collectionId && !uuid.safeParse(collectionId).success) throw new ApiError("validation_failed", "X-Collection-Id is invalid");
  const optionalLink = parseOptionalLink(c);
  const route = supersedesDocumentId
    ? "POST /api/orgs/:orgId/documents/:id/versions" : "POST /api/orgs/:orgId/documents";
  const linkHash = optionalLink ? {
    role: optionalLink.role, target: optionalLink.target,
  } : null;
  const started = await beginMutation(c, deps, orgId, route, [expectedSha, filename, kindHeader, collectionId, linkHash]);
  if (started instanceof Response) return started;
  if (supersedesDocumentId && !await getDocument(c.env.DB, orgId, supersedesDocumentId)) throw notFound("Document not found");
  if (collectionId && !await c.env.DB.prepare("SELECT 1 FROM document_collections WHERE org_id = ? AND id = ?")
    .bind(orgId, collectionId).first()) throw notFound("Collection not found");
  if (optionalLink && !await targetExists(c.env.DB, orgId, optionalLink.target)) throw notFound("Link target not found");

  let upload;
  try { upload = await bufferUpload(c.req.raw); }
  catch (error) { uploadError(error); }
  if (upload.sha256Hex !== expectedSha) throw new ApiError("digest_mismatch", "The document checksum does not match");
  const documentId = crypto.randomUUID();
  const now = started.now;

  const linkedHolder = optionalLink ? await targetHolder(c.env.DB, orgId, optionalLink.target) : null;
  const defaultVisible = linkedHolder !== null && DEFAULT_VISIBLE_KINDS.has(kindHeader);
  const row: DocumentRow = {
    id: documentId, org_id: orgId, filename,
    content_type: upload.contentType, byte_size: upload.bytes.byteLength, sha256: upload.sha256Hex,
    kind: kindHeader, source: "upload", holder_visible: defaultVisible ? 1 : 0,
    holder_published_at: null, holder_published_by: null, collection_id: collectionId,
    version_label: null, supersedes_document_id: supersedesDocumentId, description: null,
    source_created_at: null, uploaded_by: auth.user.id, created_at: now, updated_at: now,
    archived_at: null, version: 1,
  };
  const links: DocumentLinkRow[] = optionalLink ? [{
    id: optionalLink.id, role: optionalLink.role, security_id: null, stakeholder_id: null, stock_plan_id: null,
    stock_class_id: null, valuation_id: null, exercise_request_id: null, transaction_id: null,
    created_by: auth.user.id, created_at: now, revoked_at: null, revoke_reason: null,
    [TARGET_COLUMNS[optionalLink.target.type]]: optionalLink.target.id,
  } as DocumentLinkRow] : [];
  const labels = await documentActorLabels(c.env.DB, [row], links, grant.pii);
  const body = JSON.stringify(documentJson(row, links, labels));
  const store = new DocumentStore(c.env.DB);
  await store.stage(auth.consoleOrganizationId, orgId, documentId, upload.bytes, now);
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO batch_assertions (ok) SELECT EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = 'active')",
    ).bind(orgId),
    c.env.DB.prepare(
      `INSERT INTO documents
       (id, org_id, filename, content_type, byte_size, sha256, kind, source, holder_visible,
        collection_id, supersedes_document_id, uploaded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?)`,
    ).bind(documentId, orgId, filename, upload.contentType, upload.bytes.byteLength, upload.sha256Hex, kindHeader,
      defaultVisible ? 1 : 0, collectionId, supersedesDocumentId, auth.user.id, now, now),
  ];
  statements.push(...store.finalizeStatements(
    auth.consoleOrganizationId, orgId, documentId, upload.bytes.byteLength, now,
  ));
  if (optionalLink) statements.push(linkInsert(c.env.DB, {
    id: optionalLink.id, orgId, documentId, role: optionalLink.role, target: optionalLink.target, userId: auth.user.id, now,
  }));
  statements.push(auditStatement(c.env.DB, {
    ...audit(c, supersedesDocumentId ? "document.version.upload" : "document.upload", "success", now, documentId),
    details: { byteSize: upload.bytes.byteLength, kind: kindHeader, supersedesDocumentId },
  }));
  return commitMutation(c, started, statements, 201, body);
}

function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

async function download(c: Context<AppEnv>, deps: AppDeps, row: DocumentRow): Promise<Response> {
  const store = new DocumentStore(c.env.DB);
  if (!await store.complete(row.org_id, row.id, row.byte_size)) throw notFound("Document bytes are unavailable");
  const headers = {
    "Content-Type": row.content_type, "Content-Length": String(row.byte_size),
    "Content-Disposition": contentDisposition(row.filename), "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store", "Content-Security-Policy": "sandbox; default-src 'none'", "Digest": digestHeader(row.sha256),
  };
  if (c.req.method === "HEAD") return new Response(null, { headers });
  const now = deps.now();
  await insertAudit(c.env.DB, {
    ...audit(c, "document.download", "success", now, row.id), orgId: row.org_id, details: { byteSize: row.byte_size },
  }).run();
  return new Response(store.stream(row.org_id, row.id, row.byte_size), { headers });
}

export function documentRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();

  routes.post("/documents", (c) => uploadDocument(c, deps, null));
  routes.post("/documents/:id/versions", async (c) => {
    if (!uuid.safeParse(c.req.param("id")!).success) throw notFound();
    return uploadDocument(c, deps, c.req.param("id")!);
  });

  routes.get("/documents", async (c) => {
    const orgId = c.req.param("orgId")!;
    const grant = await adminGrant(c, deps, orgId, false);
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("validation_failed", "limit must be 1–200");
    const cursor = decodeCursor(c.req.query("cursor"));
    const includeArchived = c.req.query("includeArchived") === "true";
    const collectionId = c.req.query("collectionId");
    const kind = c.req.query("kind");
    const targetType = c.req.query("targetType");
    const targetId = c.req.query("targetId");
    if (collectionId && !uuid.safeParse(collectionId).success) throw new ApiError("validation_failed", "collectionId is invalid");
    if (kind && !isDocumentKind(kind)) throw new ApiError("validation_failed", "kind is invalid");
    if ((targetType === undefined) !== (targetId === undefined) || (targetId && !uuid.safeParse(targetId).success)
      || (targetType && !Object.hasOwn(TARGET_COLUMNS, targetType))) {
      throw new ApiError("validation_failed", "targetType and targetId must be valid and supplied together");
    }
    const conditions = ["d.org_id = ?", "(? = 1 OR d.archived_at IS NULL)"];
    const bindings: unknown[] = [orgId, includeArchived ? 1 : 0];
    if (collectionId) { conditions.push("d.collection_id = ?"); bindings.push(collectionId); }
    if (kind) { conditions.push("d.kind = ?"); bindings.push(kind); }
    if (cursor) {
      conditions.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
      bindings.push(cursor[0], cursor[0], cursor[1]);
    }
    if (targetType && targetId) {
      if (targetType === "stakeholder") {
        conditions.push(`EXISTS (SELECT 1 FROM document_links fl WHERE fl.org_id = d.org_id AND fl.document_id = d.id
          AND fl.revoked_at IS NULL AND fl.stakeholder_id IN (
            SELECT id FROM stakeholders WHERE org_id = d.org_id AND (id = ? OR merged_into_id = ?)
          ))`);
        bindings.push(targetId, targetId);
      } else {
        conditions.push(`EXISTS (SELECT 1 FROM document_links fl WHERE fl.org_id = d.org_id AND fl.document_id = d.id
          AND fl.revoked_at IS NULL AND fl.${TARGET_COLUMNS[targetType as keyof typeof TARGET_COLUMNS]} = ?)`);
        bindings.push(targetId);
      }
    }
    const sql = `SELECT d.* FROM documents d WHERE ${conditions.join(" AND ")}
      ORDER BY d.created_at DESC, d.id DESC LIMIT ?`;
    const { results } = await c.env.DB.prepare(sql).bind(...bindings, limit + 1).all<DocumentRow>();
    const page = results.slice(0, limit);
    const links = await getLinksForDocuments(c.env.DB, orgId, page.map((row) => row.id));
    const allLinks = [...links.values()].flat();
    const labels = await documentActorLabels(c.env.DB, page, allLinks, grant.pii);
    return c.json({
      items: page.map((row) => documentJson(row, links.get(row.id), labels)),
      nextCursor: results.length > limit ? encodeCursor(page[page.length - 1]!) : null,
    });
  });

  routes.get("/documents/:id", async (c) => {
    const orgId = c.req.param("orgId")!;
    const grant = await adminGrant(c, deps, orgId, false);
    const row = await getDocument(c.env.DB, orgId, c.req.param("id")!);
    if (!row) throw notFound("Document not found");
    const { results: versions } = await c.env.DB.prepare(
      `WITH RECURSIVE chain(id) AS (SELECT ? UNION ALL SELECT d.id FROM documents d JOIN chain c ON d.supersedes_document_id = c.id
       WHERE d.org_id = ?) SELECT id, version_label AS versionLabel, created_at AS createdAt,
       supersedes_document_id AS supersedesDocumentId FROM documents
       WHERE org_id = ? AND (id IN (SELECT id FROM chain) OR supersedes_document_id = ?) ORDER BY created_at, id`,
    ).bind(row.id, orgId, orgId, row.id).all();
    const links = await getLinks(c.env.DB, orgId, row.id);
    const labels = await documentActorLabels(c.env.DB, [row], links, grant.pii);
    return c.json({ ...documentJson(row, links, labels), versions });
  });

  routes.patch("/documents/:id", async (c) => {
    const orgId = c.req.param("orgId")!;
    const grant = await adminGrant(c, deps, orgId, true);
    const body = await readJson(c, patchBody);
    if (body.filename !== undefined) validateFilename(body.filename);
    if (body.kind !== undefined && !isDocumentKind(body.kind)) throw new ApiError("validation_failed", "kind is invalid");
    const started = await beginMutation(c, deps, orgId, "PATCH /api/orgs/:orgId/documents/:id", [body]);
    if (started instanceof Response) return started;
    const row = await getDocument(c.env.DB, orgId, c.req.param("id")!);
    if (!row) throw notFound("Document not found");
    if (body.collectionId && !await c.env.DB.prepare("SELECT 1 FROM document_collections WHERE org_id = ? AND id = ?")
      .bind(orgId, body.collectionId).first()) throw notFound("Collection not found");
    const now = started.now;
    const changedFields = Object.keys(body).filter((key) => key !== "version");
    const updated = { ...row,
      filename: body.filename ?? row.filename, kind: (body.kind ?? row.kind) as DocumentKind,
      description: body.description === undefined ? row.description : body.description,
      version_label: body.versionLabel === undefined ? row.version_label : body.versionLabel,
      collection_id: body.collectionId === undefined ? row.collection_id : body.collectionId,
      archived_at: body.archived === undefined ? row.archived_at : body.archived ? row.archived_at ?? now : null,
      version: body.version + 1, updated_at: now,
    };
    const links = await getLinks(c.env.DB, orgId, row.id);
    const labels = await documentActorLabels(c.env.DB, [updated], links, grant.pii);
    const responseBody = JSON.stringify(documentJson(updated, links, labels));
    try {
      return await commitMutation(c, started, [
        c.env.DB.prepare(
          `UPDATE documents SET filename = ?, kind = ?, description = ?, version_label = ?, collection_id = ?,
             archived_at = ?, version = ? + 1, updated_at = ? WHERE org_id = ? AND id = ?`,
        ).bind(updated.filename, updated.kind, updated.description, updated.version_label, updated.collection_id,
          updated.archived_at, body.version, now, orgId, row.id),
        auditStatement(c.env.DB, { ...audit(c, "document.update", "success", now, row.id), details: { changedFields } }),
      ], 200, responseBody);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("stale version")) throw new ApiError("conflict", "Document version is stale", undefined, { reason: "stale_version" });
      throw error;
    }
  });

  routes.post("/documents/:id/links", async (c) => {
    const orgId = c.req.param("orgId")!;
    const grant = await adminGrant(c, deps, orgId, true);
    const body = await readJson(c, linkBody);
    if (!isDocumentLinkRole(body.role) || !isLinkTarget(body.target)) throw new ApiError("validation_failed", "Link role or target is invalid");
    const started = await beginMutation(c, deps, orgId, "POST /api/orgs/:orgId/documents/:id/links", [body]);
    if (started instanceof Response) return started;
    const document = await getDocument(c.env.DB, orgId, c.req.param("id")!);
    if (!document) throw notFound("Document not found");
    if (!await targetExists(c.env.DB, orgId, body.target)) throw notFound("Link target not found");
    const now = started.now;
    const id = crypto.randomUUID();
    const existingLinks = await getLinks(c.env.DB, orgId, document.id);
    const newLink: DocumentLinkRow = {
      id, role: body.role, security_id: null, stakeholder_id: null, stock_plan_id: null, stock_class_id: null,
      valuation_id: null, exercise_request_id: null, transaction_id: null,
      created_by: c.get("auth").user.id, created_at: now, revoked_at: null, revoke_reason: null,
      [TARGET_COLUMNS[body.target.type]]: body.target.id,
    } as DocumentLinkRow;
    const labels = await documentActorLabels(c.env.DB, [document], [...existingLinks, newLink], grant.pii);
    try {
      return await commitMutation(c, started, [
        linkInsert(c.env.DB, { id, orgId, documentId: document.id, role: body.role, target: body.target, userId: c.get("auth").user.id, now }),
        auditStatement(c.env.DB, audit(c, "document.link", "success", now, document.id)),
      ], 200, JSON.stringify(documentJson(document, [...existingLinks, newLink], labels)));
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("second holder") || message.includes("several holders")) throw new ApiError(
        "invariant_violation", "A holder-visible document cannot be linked to multiple holders", undefined,
        { violations: [{ code: "MULTIPLE_HOLDERS", message: "A holder-visible document cannot be linked to multiple holders" }] },
      );
      if (message.includes("hide a company resource")) throw new ApiError(
        "invariant_violation", "Hide the company resource before linking it to a holder", undefined,
        { violations: [{
          code: "DOCUMENT_IS_COMPANY_RESOURCE",
          message: "A company resource must be hidden before it can be linked to one holder",
        }] },
      );
      throw error;
    }
  });

  routes.post("/documents/:id/links/:linkId/revoke", async (c) => {
    const orgId = c.req.param("orgId")!;
    const grant = await adminGrant(c, deps, orgId, true);
    const body = await readJson(c, revokeBody);
    const started = await beginMutation(c, deps, orgId, "POST /api/orgs/:orgId/documents/:id/links/:linkId/revoke", [body]);
    if (started instanceof Response) return started;
    const link = await c.env.DB.prepare(
      "SELECT revoked_at FROM document_links WHERE org_id = ? AND document_id = ? AND id = ?",
    ).bind(orgId, c.req.param("id")!, c.req.param("linkId")!).first<{ revoked_at: number | null }>();
    if (!link) throw notFound("Document link not found");
    if (link.revoked_at !== null) throw new ApiError(
      "invariant_violation", "Document link was already revoked", undefined,
      { violations: [{ code: "LINK_PERMANENT", message: "A document link can only be revoked once" }] },
    );
    const document = await getDocument(c.env.DB, orgId, c.req.param("id")!);
    if (!document) throw notFound("Document not found");
    const links = await getLinks(c.env.DB, orgId, document.id);
    const updatedLinks = links.map((row) => row.id === c.req.param("linkId")
      ? { ...row, revoked_at: started.now, revoke_reason: body.reason }
      : row);
    const lastHolderPathRevoked = document.holder_visible === 1 && document.holder_published_at === null
      && !updatedLinks.some((row) => row.revoked_at === null
        && (row.stakeholder_id !== null || row.security_id !== null || row.exercise_request_id !== null));
    const updatedDocument = lastHolderPathRevoked
      ? { ...document, holder_visible: 0, version: document.version + 1, updated_at: started.now }
      : document;
    const labels = await documentActorLabels(c.env.DB, [updatedDocument], updatedLinks, grant.pii);
    try {
      return await commitMutation(c, started, [
        c.env.DB.prepare(
          `UPDATE document_links SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
           WHERE org_id = ? AND document_id = ? AND id = ? AND revoked_at IS NULL`,
        ).bind(started.now, c.get("auth").user.id, body.reason, orgId, c.req.param("id")!, c.req.param("linkId")!),
        c.env.DB.prepare(
          `INSERT INTO batch_assertions (ok)
           SELECT holder_visible = ? AND version = ? AND updated_at = ? FROM documents WHERE org_id = ? AND id = ?`,
        ).bind(updatedDocument.holder_visible, updatedDocument.version, updatedDocument.updated_at, orgId, document.id),
        auditStatement(c.env.DB, audit(c, "document.link.revoke", "success", started.now, c.req.param("id")!)),
      ], 200, JSON.stringify(documentJson(updatedDocument, updatedLinks, labels)));
    } catch (error) {
      if ((error as Error).message.includes("batch assertion failed")) throw new ApiError(
        "conflict", "Document changed while the link was being revoked; retry", undefined, { reason: "state_changed" },
      );
      throw error;
    }
  });

  routes.post("/documents/:id/holder-visibility", async (c) => {
    const orgId = c.req.param("orgId")!;
    const grant = await adminGrant(c, deps, orgId, true);
    const body = await readJson(c, visibilityBody);
    const started = await beginMutation(c, deps, orgId, "POST /api/orgs/:orgId/documents/:id/holder-visibility", [body]);
    if (started instanceof Response) return started;
    const row = await getDocument(c.env.DB, orgId, c.req.param("id")!);
    if (!row) throw notFound("Document not found");
    const links = await getLinks(c.env.DB, orgId, row.id);
    const labels = await documentActorLabels(c.env.DB, [row], links, grant.pii);
    const linkedHolders = await resolvedDocumentHolders(c.env.DB, row);
    const companyPublish = body.visible && linkedHolders.size === 0;
    const publishedAt = companyPublish ? started.now : null;
    const publishedBy = companyPublish ? c.get("auth").user.id : null;
    const updated = { ...row, holder_visible: body.visible ? 1 : 0, holder_published_at: publishedAt,
      holder_published_by: publishedBy, version: body.version + 1, updated_at: started.now };
    const statements: D1PreparedStatement[] = [];
    if (body.visible) {
      const expected = companyPublish ? 0 : 1;
      statements.push(c.env.DB.prepare(
        `INSERT INTO batch_assertions (ok) SELECT (SELECT COUNT(DISTINCT COALESCE(st.merged_into_id, h.holder_id)) FROM (
           SELECT stakeholder_id AS holder_id FROM document_links WHERE org_id = ?1 AND document_id = ?2 AND revoked_at IS NULL AND stakeholder_id IS NOT NULL
           UNION ALL SELECT s.stakeholder_id FROM document_links l JOIN securities s ON s.org_id = l.org_id AND s.id = l.security_id
             WHERE l.org_id = ?1 AND l.document_id = ?2 AND l.revoked_at IS NULL
           UNION ALL SELECT r.stakeholder_id FROM document_links l JOIN exercise_requests r ON r.org_id = l.org_id AND r.id = l.exercise_request_id
             WHERE l.org_id = ?1 AND l.document_id = ?2 AND l.revoked_at IS NULL
         ) h LEFT JOIN stakeholders st ON st.org_id = ?1 AND st.id = h.holder_id) = ?3`,
      ).bind(orgId, row.id, expected));
    }
    statements.push(
      c.env.DB.prepare(
        `UPDATE documents SET holder_visible = ?, holder_published_at = ?, holder_published_by = ?,
         version = ? + 1, updated_at = ? WHERE org_id = ? AND id = ?`,
      ).bind(body.visible ? 1 : 0, publishedAt, publishedBy, body.version, started.now, orgId, row.id),
      auditStatement(c.env.DB, audit(c, "document.visibility", "success", started.now, row.id)),
    );
    try { return await commitMutation(c, started, statements, 200, JSON.stringify(documentJson(updated, links, labels))); }
    catch (error) {
      const message = (error as Error).message;
      if (message.includes("batch assertion") || message.includes("several holders")) throw new ApiError(
        "invariant_violation", "Document visibility changed concurrently or resolves to multiple holders", undefined,
        { violations: [{ code: "MULTIPLE_HOLDERS", message: "A holder-visible document must resolve to exactly one holder" }] },
      );
      if (message.includes("stale version")) throw new ApiError("conflict", "Document version is stale", undefined, { reason: "stale_version" });
      throw error;
    }
  });

  routes.get("/documents/:id/download", async (c) => {
    const orgId = c.req.param("orgId")!;
    const grant = await adminGrant(c, deps, orgId, false);
    const row = await getDocument(c.env.DB, orgId, c.req.param("id")!);
    if (!row) throw notFound("Document not found");
    if (grant.access === "admin_ro" && !grant.pii) return deny(c, deps, "pii_access_required", "This document may contain personal data");
    return download(c, deps, row);
  });

  routes.get("/collections", async (c) => {
    const orgId = c.req.param("orgId")!;
    const grant = await adminGrant(c, deps, orgId, false);
    const { results } = await c.env.DB.prepare(
      `SELECT id, kind, name, parent_id AS parentId, source, archived_at AS archivedAt, version, created_at AS createdAt
       FROM document_collections WHERE org_id = ? ORDER BY name`,
    ).bind(orgId).all();
    return c.json({ items: results });
  });

  routes.post("/collections", async (c) => {
    const orgId = c.req.param("orgId")!;
    await adminGrant(c, deps, orgId, true);
    const body = await readJson(c, collectionBody);
    const started = await beginMutation(c, deps, orgId, "POST /api/orgs/:orgId/collections", [body]);
    if (started instanceof Response) return started;
    if (body.parentId && !await c.env.DB.prepare("SELECT 1 FROM document_collections WHERE org_id = ? AND id = ?")
      .bind(orgId, body.parentId).first()) throw notFound("Parent collection not found");
    const id = crypto.randomUUID();
    const result = {
      id, kind: "FOLDER", name: body.name, parentId: body.parentId ?? null,
      source: "app", archivedAt: null, createdAt: started.now, version: 1,
    };
    return commitMutation(c, started, [
      c.env.DB.prepare(
        `INSERT INTO document_collections (id, org_id, kind, name, parent_id, source, created_at, updated_at)
         VALUES (?, ?, 'FOLDER', ?, ?, 'app', ?, ?)`,
      ).bind(id, orgId, body.name, body.parentId ?? null, started.now, started.now),
      auditStatement(c.env.DB, { ...audit(c, "document.collection.create", "success", started.now), targetType: "document_collection", targetId: id }),
    ], 201, JSON.stringify(result));
  });

  routes.patch("/collections/:id", async (c) => {
    const orgId = c.req.param("orgId")!;
    await adminGrant(c, deps, orgId, true);
    const body = await readJson(c, collectionPatchBody);
    const started = await beginMutation(c, deps, orgId, "PATCH /api/orgs/:orgId/collections/:id", [body]);
    if (started instanceof Response) return started;
    const row = await c.env.DB.prepare("SELECT * FROM document_collections WHERE org_id = ? AND id = ?")
      .bind(orgId, c.req.param("id")!).first<Record<string, unknown>>();
    if (!row) throw notFound("Collection not found");
    if (row.source !== "app" || row.kind !== "FOLDER") throw forbidden("Migrated template groups are read-only");
    if (body.parentId && !await c.env.DB.prepare("SELECT 1 FROM document_collections WHERE org_id = ? AND id = ?")
      .bind(orgId, body.parentId).first()) throw notFound("Parent collection not found");
    const result = {
      id: c.req.param("id")!, kind: row.kind, name: body.name ?? row.name,
      parentId: body.parentId === undefined ? row.parent_id : body.parentId,
      source: row.source,
      archivedAt: body.archived === undefined ? row.archived_at : body.archived ? row.archived_at ?? started.now : null,
      createdAt: row.created_at,
      version: body.version + 1,
    };
    try {
      return await commitMutation(c, started, [
        c.env.DB.prepare(
          `INSERT INTO batch_assertions (ok) WITH RECURSIVE descendants(id) AS (
             SELECT id FROM document_collections WHERE org_id = ? AND parent_id = ?
             UNION ALL SELECT c.id FROM document_collections c JOIN descendants d ON c.parent_id = d.id WHERE c.org_id = ?)
           SELECT ? IS NULL OR (? <> ? AND ? NOT IN (SELECT id FROM descendants))`,
        ).bind(orgId, c.req.param("id")!, orgId, result.parentId, result.parentId, c.req.param("id")!, result.parentId),
        c.env.DB.prepare(
          `UPDATE document_collections SET name = ?, parent_id = ?, archived_at = ?, version = ? + 1, updated_at = ?
           WHERE org_id = ? AND id = ?`,
        ).bind(result.name, result.parentId, result.archivedAt, body.version, started.now, orgId, c.req.param("id")!),
        auditStatement(c.env.DB, { ...audit(c, "document.collection.update", "success", started.now), targetType: "document_collection", targetId: c.req.param("id")! }),
      ], 200, JSON.stringify(result));
    } catch (error) {
      if ((error as Error).message.includes("batch assertion")) throw new ApiError(
        "invariant_violation", "Collection parent would create a cycle", undefined,
        { violations: [{ code: "COLLECTION_CYCLE", message: "Collection parent would create a cycle" }] },
      );
      if ((error as Error).message.includes("stale version")) throw new ApiError("conflict", "Collection version is stale", undefined, { reason: "stale_version" });
      throw error;
    }
  });
  return routes;
}

function holderIds(c: Context<AppEnv>, orgId: string): Set<string> | null {
  const matches = c.get("auth").portalMatches.filter((match) => match.orgId === orgId);
  return matches.length === 0 ? null : new Set(matches.map((match) => match.stakeholderId));
}

export function portalDocumentRoutes(deps: AppDeps) {
  const routes = new Hono<AppEnv>();
  routes.get("/orgs/:orgId/documents", async (c) => {
    if (!c.get("config").portalEnabled) throw notFound();
    const orgId = c.req.param("orgId")!;
    const ownIds = holderIds(c, orgId);
    if (!ownIds) throw notFound();
    return c.json(z.array(portalDocument).parse(await listHolderDocuments(c.env.DB, orgId, ownIds)));
  });

  routes.get("/documents/:id/download", async (c) => {
    if (!c.get("config").portalEnabled) throw notFound();
    const orgIds = [...new Set(c.get("auth").portalMatches.map((match) => match.orgId))];
    const row = await c.env.DB.prepare(
      `SELECT * FROM documents WHERE id = ? AND org_id IN (SELECT value FROM json_each(?))`,
    ).bind(c.req.param("id")!, JSON.stringify(orgIds)).first<DocumentRow>();
    if (!row) throw notFound();
    const ownIds = holderIds(c, row.org_id);
    if (!ownIds) throw notFound();
    const holders = await resolvedDocumentHolders(c.env.DB, row);
    if (!evaluateHolderDocumentAccess(row, holders, ownIds)) throw notFound();
    return download(c, deps, row);
  });
  return routes;
}
