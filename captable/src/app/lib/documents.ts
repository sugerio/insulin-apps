import { api } from "#shared";
import { documentKindLabel } from "./labels.ts";

// Documents and records: the labels, and the rules the server applies that the
// pages show before anything is sent. Who sees a document in the portal follows its links: holder-visible and linked
// to exactly one holder, that holder; holder-visible with no holder link, every holder (a company resource, published
// from the portal settings); linked to two or more holders, nobody (422 MULTIPLE_HOLDERS).

/** Kinds the contract keeps for imported records (a reconciliation report, an import archive): never a kind to choose. */
export const MIGRATION_KINDS = new Set<api.DocumentKind>(["RECONCILIATION_REPORT", "IMPORT_ARCHIVE"]);

/** The kinds an admin may give a document. */
export function kindOptions(): (readonly [api.DocumentKind, string])[] {
  return api.DOCUMENT_KINDS.filter((kind) => !MIGRATION_KINDS.has(kind)).map((kind) => [kind, documentKindLabel(kind)] as const);
}

export const LINK_ROLE_LABELS: Record<api.DocumentLinkRole, string> = {
  AGREEMENT: "Agreement",
  CONSENT: "Consent",
  NOTICE: "Notice",
  REPORT: "Report",
  EVIDENCE: "Evidence",
  CERTIFICATE: "Certificate",
  ELECTION: "Election",
  TAX_FORM: "Tax form",
  ATTACHMENT: "Attachment",
};

export const TARGET_TYPE_LABELS: Record<api.LinkTargetType, string> = {
  security: "Security",
  stakeholder: "Stakeholder",
  stock_plan: "Equity plan",
  stock_class: "Share class",
  valuation: "409A valuation",
  exercise_request: "Exercise request",
  transaction: "Transaction (a command's)",
};

/**
 * The link targets an admin can pick in the app. A transaction (what a command recorded) is picked through its
 * security's timeline; an exercise request's documents come with the request.
 */
export const PICKABLE_TARGETS: readonly api.LinkTargetType[] = ["security", "stakeholder", "stock_plan", "stock_class", "valuation", "transaction"];

/** Links still standing (revoked ones count for nothing). */
export function activeLinks(document: Pick<api.Document, "links">): api.DocumentLink[] {
  return document.links.filter((link) => link.revokedAt === null);
}

/**
 * The holders a document resolves to, as far as the browser can tell: stakeholder links, and security links through
 * the security's holder. An exercise request's holder isn't known here, so each counts as a holder of its own (the
 * server resolves them and stays the authority).
 */
export function linkedHolders(document: Pick<api.Document, "links">, holderOfSecurity: (securityId: string) => string | undefined): Set<string> {
  const holders = new Set<string>();
  for (const link of activeLinks(document)) {
    if (link.targetType === "stakeholder") holders.add(link.targetId);
    else if (link.targetType === "security") holders.add(holderOfSecurity(link.targetId) ?? `security:${link.targetId}`);
    else if (link.targetType === "exercise_request") holders.add(`request:${link.targetId}`);
  }
  return holders;
}

export type VisibilityRule =
  /** Linked to exactly one holder: admins show or hide it in that holder's portal. */
  | { kind: "holder" }
  /** No holder link: a company resource, published for every holder from the portal settings. */
  | { kind: "company" }
  /** Linked to several holders: never visible in the portal. */
  | { kind: "several"; count: number };

export function visibilityRule(holders: ReadonlySet<string>): VisibilityRule {
  if (holders.size === 0) return { kind: "company" };
  if (holders.size === 1) return { kind: "holder" };
  return { kind: "several", count: holders.size };
}

/** Who sees it in the portal now, in words. */
export function visibilityLabel(document: Pick<api.Document, "holderVisible" | "visibilityScope">): string {
  if (!document.holderVisible) return "Admins only";
  return document.visibilityScope === "all_holders" ? "Every holder (company resource)" : document.visibilityScope === "holder" ? "The linked holder" : "Admins only";
}

/** A company resource holders see now: published, not archived. The portal settings pick notices among these. */
export function isPublishedResource(document: api.Document): boolean {
  return document.archivedAt === null && document.holderVisible && document.visibilityScope === "all_holders";
}

/** Link targets that resolve to a holder: a stakeholder, a security's holder, an exercise request's holder. */
export const HOLDER_TARGETS: ReadonlySet<api.LinkTargetType> = new Set(["stakeholder", "security", "exercise_request"]);

/** A document that could become a company resource: no holder link, not archived, not a migration record. */
export function isResourceCandidate(document: api.Document): boolean {
  return document.archivedAt === null && !MIGRATION_KINDS.has(document.kind) && !activeLinks(document).some((link) => HOLDER_TARGETS.has(link.targetType));
}

/** What the portal settings use a company resource for, if anything: it is then named on the page and in reviews. */
export function portalUseOf(org: api.Org, documentId: string): string | null {
  const portal = org.settings.portal;
  const uses = [
    portal.noticeFormDocumentId === documentId ? "the notice of exercise form" : null,
    portal.privacyNoticeDocumentId === documentId ? "the privacy notice" : null,
  ].filter((use): use is string => use !== null);
  return uses.length ? uses.join(" and ") : null;
}

/** "PDF", "DOCX"…: the type column of the documents table. */
export function fileTypeLabel(document: Pick<api.Document, "filename" | "contentType">): string {
  const extension = /\.([a-z0-9]+)$/i.exec(document.filename)?.[1];
  return extension ? extension.toUpperCase() : document.contentType;
}
