import { bytesToBase64 } from "../encoding.ts";
import { sha256Hex } from "../crypto.ts";
import type { AuditEntry } from "../audit.ts";
import { insertAudit } from "../audit.ts";
import { userActorLabels } from "../read/context.ts";
import type { DocumentLinkRow, DocumentRow, LinkTarget } from "./types.ts";
import { TARGET_COLUMNS } from "./types.ts";

/** Resolve stored user ids to viewer-safe labels before a document leaves the Worker. */
export async function documentActorLabels(
  db: D1Database,
  documents: readonly DocumentRow[],
  links: readonly DocumentLinkRow[],
  pii: boolean,
): Promise<Map<string, string>> {
  const ids = [
    ...documents.map((row) => row.uploaded_by),
    ...links.map((row) => row.created_by),
  ];
  return userActorLabels(db, ids, pii);
}

export function documentJson(row: DocumentRow, links: DocumentLinkRow[] = [], labels: ReadonlyMap<string, string> = new Map()) {
  const holderLinked = links.some((link) => link.revoked_at === null && (link.stakeholder_id || link.security_id || link.exercise_request_id));
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    kind: row.kind,
    source: row.source,
    holderVisible: row.holder_visible === 1,
    visibilityScope: row.holder_visible === 0 ? "admins"
      : holderLinked ? "holder"
      : row.holder_published_at !== null ? "all_holders" : "admins",
    collectionId: row.collection_id,
    versionLabel: row.version_label,
    supersedesDocumentId: row.supersedes_document_id,
    description: row.description,
    sourceCreatedAt: row.source_created_at,
    uploadedBy: row.uploaded_by === null ? null : (labels.get(row.uploaded_by) ?? null),
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    links: links.flatMap((link) => {
      const target = Object.entries(TARGET_COLUMNS).find(([, column]) => link[column as keyof DocumentLinkRow]);
      if (!target) return [];
      return [{
        id: link.id,
        role: link.role,
        targetType: target[0],
        targetId: link[target[1] as keyof DocumentLinkRow],
        createdAt: link.created_at,
        createdBy: link.created_by === null ? null : (labels.get(link.created_by) ?? null),
        revokedAt: link.revoked_at,
        revokeReason: link.revoke_reason,
      }];
    }),
    importedFromPulley: row.source === "pulley",
    version: row.version,
  };
}

export async function getDocument(db: D1Database, orgId: string, documentId: string): Promise<DocumentRow | null> {
  return db.prepare("SELECT * FROM documents WHERE org_id = ? AND id = ?").bind(orgId, documentId).first<DocumentRow>();
}

export async function getLinks(db: D1Database, orgId: string, documentId: string): Promise<DocumentLinkRow[]> {
  const { results } = await db.prepare(
    "SELECT * FROM document_links WHERE org_id = ? AND document_id = ? ORDER BY created_at, id",
  ).bind(orgId, documentId).all<DocumentLinkRow>();
  return results;
}

export async function getLinksForDocuments(
  db: D1Database, orgId: string, documentIds: readonly string[],
): Promise<Map<string, DocumentLinkRow[]>> {
  const grouped = new Map<string, DocumentLinkRow[]>();
  for (const id of documentIds) grouped.set(id, []);
  if (documentIds.length === 0) return grouped;
  const { results } = await db.prepare(
    `SELECT * FROM document_links WHERE org_id = ?
      AND document_id IN (SELECT value FROM json_each(?)) ORDER BY document_id, created_at, id`,
  ).bind(orgId, JSON.stringify(documentIds)).all<DocumentLinkRow & { document_id: string }>();
  for (const link of results) grouped.get(link.document_id)?.push(link);
  return grouped;
}

export function linkInsert(
  db: D1Database,
  values: { id: string; orgId: string; documentId: string; role: string; target: LinkTarget; userId: string; now: number },
): D1PreparedStatement {
  const column = TARGET_COLUMNS[values.target.type];
  return db.prepare(
    `INSERT INTO document_links (id, org_id, document_id, role, ${column}, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(values.id, values.orgId, values.documentId, values.role, values.target.id, values.userId, values.now);
}

export function idempotencyInsert(
  db: D1Database,
  values: { id: string; consoleOrganizationId: string; scope: string; actor: string; route: string; key: string; requestHash: string; status: number; body: string; now: number },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO idempotency_keys
      (id, console_organization_id, scope, actor, route, idem_key, request_sha256, response_status, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(values.id, values.consoleOrganizationId, values.scope, values.actor, values.route, values.key,
    values.requestHash, values.status, values.body, values.now);
}

export interface IdempotencyRow { request_sha256: string; response_status: number; response_body: string; }
export function findIdempotency(
  db: D1Database, consoleOrganizationId: string, scope: string, actor: string, route: string, key: string,
): Promise<IdempotencyRow | null> {
  return db.prepare(
    `SELECT request_sha256, response_status, response_body FROM idempotency_keys
     WHERE console_organization_id = ? AND scope = ? AND actor = ? AND route = ? AND idem_key = ?`,
  ).bind(consoleOrganizationId, scope, actor, route, key).first<IdempotencyRow>();
}

export async function requestHash(method: string, path: string, parts: unknown[]): Promise<string> {
  return sha256Hex(JSON.stringify([method, path, ...parts]));
}

export function auditStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return insertAudit(db, entry);
}

export function digestHeader(hex: string): string {
  const bytes = new Uint8Array(hex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
  return `sha-256=${bytesToBase64(bytes)}`;
}
