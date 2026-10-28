export type AuditResult = "success" | "denied" | "error";
export interface AuditEntry {
  occurredAt: number;
  consoleOrganizationId?: string | null;
  orgId?: string | null;
  actorKind?: "user" | "system" | "anonymous" | "import";
  actorUserId?: string | null;
  actorEmail?: string | null;
  authMethod?: "console" | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  result: AuditResult;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  /** IDs, field names and counts only; never personal data or free text. */
  details?: Record<string, unknown> | null;
}
const COLUMNS = "occurred_at, console_organization_id, org_id, actor_kind, actor_user_id, actor_email, auth_method, action, target_type, target_id, result, reason, ip, user_agent, request_id, details";
const PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
function values(entry: AuditEntry): unknown[] {
  return [
    entry.occurredAt, entry.consoleOrganizationId ?? null, entry.orgId ?? null,
    entry.actorKind ?? "user", entry.actorUserId ?? null,
    entry.actorEmail ?? null, entry.authMethod ?? null, entry.action, entry.targetType ?? null,
    entry.targetId ?? null, entry.result, entry.reason ?? null, entry.ip ?? null,
    entry.userAgent ?? null, entry.requestId ?? null, entry.details ? JSON.stringify(entry.details) : null,
  ];
}
export function insertAudit(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  const orgId = entry.orgId ?? null;
  return db.prepare(
    `INSERT INTO audit_events (${COLUMNS}, org_seq)
     VALUES (${PLACEHOLDERS}, CASE WHEN ? IS NULL THEN NULL ELSE
       COALESCE((SELECT MAX(org_seq) + 1 FROM audit_events WHERE org_id = ?), 1) END)`,
  ).bind(...values(entry), orgId, orgId);
}
