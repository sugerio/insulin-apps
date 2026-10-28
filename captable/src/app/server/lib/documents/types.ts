export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const DOCUMENT_KINDS = [
  "GRANT_AGREEMENT", "STOCK_PURCHASE_AGREEMENT", "SAFE_AGREEMENT", "WARRANT_AGREEMENT",
  "NOTICE_OF_EXERCISE", "ELECTION_83B", "BOARD_CONSENT", "STOCKHOLDER_CONSENT", "PLAN_DOCUMENT", "CHARTER",
  "VALUATION_REPORT", "VALUATION_SUPPORT", "COUNSEL_MEMO", "SEPARATION_AGREEMENT", "PAYMENT_RECORD", "CERTIFICATE",
  "TEMPLATE", "STATEMENT", "FORM_3921", "RECONCILIATION_REPORT", "IMPORT_ARCHIVE", "OTHER",
] as const;

export type DocumentKind = typeof DOCUMENT_KINDS[number];

export const DOCUMENT_LINK_ROLES = [
  "AGREEMENT", "CONSENT", "NOTICE", "REPORT", "EVIDENCE", "CERTIFICATE", "ELECTION", "TAX_FORM", "ATTACHMENT",
] as const;

export type DocumentLinkRole = typeof DOCUMENT_LINK_ROLES[number];
export type LinkTargetType =
  | "security" | "stakeholder" | "stock_plan" | "stock_class"
  | "valuation" | "exercise_request" | "transaction";

export interface LinkTarget { type: LinkTargetType; id: string; }

export interface DocumentRow {
  id: string;
  org_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  kind: DocumentKind;
  source: "upload" | "generated" | "pulley";
  holder_visible: number;
  holder_published_at: number | null;
  holder_published_by: string | null;
  collection_id: string | null;
  version_label: string | null;
  supersedes_document_id: string | null;
  description: string | null;
  source_created_at: number | null;
  uploaded_by: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  version: number;
}

export interface DocumentLinkRow {
  id: string;
  role: DocumentLinkRole;
  security_id: string | null;
  stakeholder_id: string | null;
  stock_plan_id: string | null;
  stock_class_id: string | null;
  valuation_id: string | null;
  exercise_request_id: string | null;
  transaction_id: string | null;
  created_by: string | null;
  created_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
}

export const TARGET_COLUMNS: Record<LinkTargetType, string> = {
  security: "security_id",
  stakeholder: "stakeholder_id",
  stock_plan: "stock_plan_id",
  stock_class: "stock_class_id",
  valuation: "valuation_id",
  exercise_request: "exercise_request_id",
  transaction: "transaction_id",
};

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export function isDocumentLinkRole(value: string): value is DocumentLinkRole {
  return (DOCUMENT_LINK_ROLES as readonly string[]).includes(value);
}

export function isLinkTarget(value: unknown): value is LinkTarget {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.type === "string" && Object.hasOwn(TARGET_COLUMNS, candidate.type)
    && typeof candidate.id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate.id);
}
