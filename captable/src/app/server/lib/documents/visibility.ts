import type { DocumentKind, DocumentRow } from "./types.ts";

const INTERNAL_DOCUMENT_KINDS = new Set<DocumentKind>(["RECONCILIATION_REPORT", "IMPORT_ARCHIVE"]);

/** Resolves only live relationships that terminate at a holder. Non-holder links never grant portal access. */
export async function resolvedDocumentHoldersByDocument(
  db: D1Database,
  orgId: string,
  documentIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(documentIds)];
  const byDocument = new Map(ids.map((id) => [id, new Set<string>()]));
  if (ids.length === 0) return byDocument;
  const { results } = await db.prepare(
    `SELECT DISTINCT document_id, holder_id FROM (
       SELECT h.document_id, COALESCE(st.merged_into_id, h.holder_id) AS holder_id FROM (
         SELECT l.document_id, l.stakeholder_id AS holder_id FROM document_links l
          WHERE l.org_id = ?1 AND l.document_id IN (SELECT value FROM json_each(?2))
            AND l.revoked_at IS NULL AND l.stakeholder_id IS NOT NULL
         UNION ALL
         SELECT l.document_id, s.stakeholder_id FROM document_links l
          JOIN securities s ON s.org_id = l.org_id AND s.id = l.security_id
          WHERE l.org_id = ?1 AND l.document_id IN (SELECT value FROM json_each(?2)) AND l.revoked_at IS NULL
         UNION ALL
         SELECT l.document_id, r.stakeholder_id FROM document_links l
          JOIN exercise_requests r ON r.org_id = l.org_id AND r.id = l.exercise_request_id
          WHERE l.org_id = ?1 AND l.document_id IN (SELECT value FROM json_each(?2)) AND l.revoked_at IS NULL
       ) h LEFT JOIN stakeholders st ON st.org_id = ?1 AND st.id = h.holder_id
       WHERE h.holder_id IS NOT NULL
     )`,
  ).bind(orgId, JSON.stringify(ids)).all<{ document_id: string; holder_id: string }>();
  for (const item of results) byDocument.get(item.document_id)?.add(item.holder_id);
  return byDocument;
}

/** The single-row form remains for writes and downloads; lists use the set-based resolver above. */
export async function resolvedDocumentHolders(db: D1Database, row: Pick<DocumentRow, "org_id" | "id">): Promise<Set<string>> {
  return (await resolvedDocumentHoldersByDocument(db, row.org_id, [row.id])).get(row.id)!;
}

/** The single default-deny authorization function used by both holder list and download. */
export function evaluateHolderDocumentAccess(
  row: DocumentRow,
  resolvedHolders: ReadonlySet<string>,
  ownIds: ReadonlySet<string>,
): "mine" | "company" | null {
  if (row.holder_visible !== 1 || row.archived_at !== null || INTERNAL_DOCUMENT_KINDS.has(row.kind)) return null;
  if (resolvedHolders.size === 1) return [...resolvedHolders].some((id) => ownIds.has(id)) ? "mine" : null;
  if (resolvedHolders.size === 0 && row.holder_published_at !== null && row.holder_published_by !== null) return "company";
  return null;
}

/** A document as a holder sees it in the portal (`PortalDocument`). */
export interface HolderDocument {
  id: string;
  filename: string;
  kind: DocumentKind;
  createdAt: number;
  scope: "mine" | "company";
}

/**
 * The holder visibility policy over a `documents d` row: shown to holders, not archived, and never a migration-only
 * document kind. Imported grant agreements and certificates are ordinary documents here. The ownership half (one holder, or a published
 * company resource) is `evaluateHolderDocumentAccess`. Every holder-facing document query applies both.
 */
export const HOLDER_VISIBLE_DOCUMENT_SQL = "d.holder_visible = 1 AND d.archived_at IS NULL AND d.kind NOT IN ('RECONCILIATION_REPORT', 'IMPORT_ARCHIVE')";

/**
 * The documents a holder sees in one org, newest first: those that resolve to them alone (`mine`) and the published
 * company resources (`company`), never migration evidence, an archived document or one hidden from holders. The portal
 * list, the admin's preview of it and the company resources the portal designates (the notice of exercise, the privacy
 * notice) all read through here, so they can't drift. `documentId` narrows it to one document.
 */
export async function listHolderDocuments(
  db: D1Database,
  orgId: string,
  ownIds: ReadonlySet<string>,
  options: { documentId?: string } = {},
): Promise<HolderDocument[]> {
  const { results } = await db.prepare(
    `SELECT d.* FROM documents d WHERE d.org_id = ?1 AND (?2 IS NULL OR d.id = ?2) AND ${HOLDER_VISIBLE_DOCUMENT_SQL}
     ORDER BY d.created_at DESC, d.id DESC`,
  ).bind(orgId, options.documentId ?? null).all<DocumentRow>();
  const holders = await resolvedDocumentHoldersByDocument(db, orgId, results.map((row) => row.id));
  const visible: HolderDocument[] = [];
  for (const row of results) {
    const scope = evaluateHolderDocumentAccess(row, holders.get(row.id)!, ownIds);
    if (scope) visible.push({ id: row.id, filename: row.filename, kind: row.kind, createdAt: row.created_at, scope });
  }
  return visible;
}

export async function isCompanyResource(db: D1Database, orgId: string, documentId: string): Promise<boolean> {
  const listed = await listHolderDocuments(db, orgId, new Set(), { documentId });
  return listed.some((document) => document.id === documentId && document.scope === "company");
}

/** Re-checks a designated company resource inside the same D1 batch as the org settings write. */
export function companyResourceAssertion(
  db: D1Database,
  orgId: string,
  documentId: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO batch_assertions (ok)
     SELECT EXISTS (
       SELECT 1 FROM documents d WHERE d.org_id = ?1 AND d.id = ?2 AND ${HOLDER_VISIBLE_DOCUMENT_SQL}
         AND d.holder_published_at IS NOT NULL AND d.holder_published_by IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM document_links l WHERE l.org_id = d.org_id AND l.document_id = d.id
             AND l.revoked_at IS NULL AND (
               l.stakeholder_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM securities s WHERE s.org_id = l.org_id AND s.id = l.security_id)
               OR EXISTS (SELECT 1 FROM exercise_requests r WHERE r.org_id = l.org_id AND r.id = l.exercise_request_id)
             )
         )
     )`,
  ).bind(orgId, documentId);
}
