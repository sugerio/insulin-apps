import { TARGET_COLUMNS, type DocumentLinkRow, type DocumentRow } from "../documents/types.ts";
import { resolvedDocumentHolders } from "../documents/visibility.ts";
import { notFound } from "../http.ts";
import type { ApiViolation } from "./errors.ts";
import { stmt } from "./statements.ts";
import type { BatchStatement, DocumentUse, LinkTargetType } from "./types.ts";

/**
 * Documents a command relies on: each is checked to exist in the org, its id and
 * content hash go into the payload so the chain covers the evidence, and the command's batch links it to what it is
 * about. Document bytes are immutable in D1; metadata and links remain auditable application rows.
 */
export class CommandDocuments {
  private readonly rows = new Map<string, DocumentRow>();
  private readonly links = new Map<string, DocumentLinkRow[]>();

  constructor(private readonly db: D1Database, private readonly orgId: string) {}

  /** The document row, or 404 for an unknown document in this org (the API contract). */
  async require(documentId: string): Promise<DocumentRow> {
    const cached = this.rows.get(documentId);
    if (cached) return cached;
    const row = await this.db.prepare("SELECT * FROM documents WHERE org_id = ? AND id = ?").bind(this.orgId, documentId).first<DocumentRow>();
    if (!row) throw notFound("Document not found");
    this.rows.set(documentId, row);
    return row;
  }

  async requireAll(documentIds: readonly string[]): Promise<void> {
    for (const id of new Set(documentIds)) await this.require(id);
  }

  /** `{id, sha256}` for a payload (engine `DocumentRef`). */
  ref(documentId: string): { id: string; sha256: string } {
    const row = this.rows.get(documentId);
    if (!row) throw new Error(`Document ${documentId} was not loaded`);
    return { id: row.id, sha256: row.sha256 };
  }

  row(documentId: string): DocumentRow | undefined {
    return this.rows.get(documentId);
  }

  private async linksOf(documentId: string): Promise<DocumentLinkRow[]> {
    const cached = this.links.get(documentId);
    if (cached) return cached;
    const { results } = await this.db.prepare(
      "SELECT * FROM document_links WHERE org_id = ? AND document_id = ? ORDER BY created_at, id",
    ).bind(this.orgId, documentId).all<DocumentLinkRow>();
    this.links.set(documentId, results);
    return results;
  }

  /**
   * Product blocks a document can raise before anything is written: archived evidence, a holder-visible document that
   * would reach a second holder, a company resource linked to one holder (the D1 triggers refuse both; checking here
   * makes the dry run show it).
   */
  async check(uses: readonly DocumentUse[], holderOf: (target: DocumentUse["target"]) => string | null): Promise<ApiViolation[]> {
    const violations: ApiViolation[] = [];
    const byDocument = new Map<string, DocumentUse[]>();
    for (const use of uses) byDocument.set(use.documentId, [...(byDocument.get(use.documentId) ?? []), use]);
    for (const [documentId, documentUses] of byDocument) {
      const row = await this.require(documentId);
      if (row.archived_at !== null) {
        violations.push({ code: "DOCUMENT_ARCHIVED", message: `${row.filename} is archived; restore it or use another document` });
      }
      const holders = new Set<string>();
      for (const use of documentUses) {
        const holder = holderOf(use.target);
        if (holder !== null) holders.add(holder);
      }
      if (holders.size === 0) continue;
      if (row.holder_published_at !== null) {
        violations.push({ code: "DOCUMENT_IS_COMPANY_RESOURCE", message: `${row.filename} is a company resource for every holder; hide it before linking it to a holder` });
        continue;
      }
      if (row.holder_visible === 1) {
        const existing = await resolvedDocumentHolders(this.db, row);
        for (const holder of holders) existing.add(holder);
        if (existing.size > 1) {
          violations.push({ code: "DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER", message: `${row.filename} is visible to a holder and can't be linked to another holder` });
        }
      }
    }
    return violations;
  }

  /**
   * The batch statements for the documents: each new link, skipped when the same live link already exists.
   */
  async statements(
    uses: readonly DocumentUse[],
    input: { now: number; actorUserId: string | null; transactionIds: readonly string[] },
  ): Promise<BatchStatement[]> {
    const statements: BatchStatement[] = [];
    const byDocument = new Map<string, DocumentUse[]>();
    for (const use of uses) byDocument.set(use.documentId, [...(byDocument.get(use.documentId) ?? []), use]);
    for (const [documentId, documentUses] of byDocument) {
      await this.require(documentId);
      const existing = await this.linksOf(documentId);
      const live = existing.filter((link) => link.revoked_at === null);
      const linkAt = input.now;
      const added: DocumentLinkRow[] = [];
      const seen = new Set<string>();
      for (const use of documentUses) {
        const target = use.target.type === "transaction_index"
          ? { type: "transaction" as LinkTargetType, id: input.transactionIds[use.target.index]! }
          : use.target;
        const column = TARGET_COLUMNS[target.type];
        const key = `${use.role}|${column}|${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (live.some((link) => link.role === use.role && link[column as keyof DocumentLinkRow] === target.id)) continue;
        const link: DocumentLinkRow = {
          id: crypto.randomUUID(),
          role: use.role,
          security_id: null,
          stakeholder_id: null,
          stock_plan_id: null,
          stock_class_id: null,
          valuation_id: null,
          exercise_request_id: null,
          transaction_id: null,
          created_by: input.actorUserId,
          created_at: linkAt,
          revoked_at: null,
          revoke_reason: null,
        };
        (link as unknown as Record<string, unknown>)[column] = target.id;
        added.push(link);
        statements.push(stmt(
          `INSERT INTO document_links (id, org_id, document_id, role, ${column}, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          link.id, this.orgId, documentId, link.role, target.id, link.created_by, link.created_at,
        ));
      }
    }
    return statements;
  }
}
