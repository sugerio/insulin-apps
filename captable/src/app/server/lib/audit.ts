export type AuditResult = "success" | "denied" | "error";
export interface AuditEntry {
  occurredAt: number;
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
const COLUMNS = "occurred_at, org_id, actor_kind, actor_user_id, actor_email, auth_method, action, target_type, target_id, result, reason, ip, user_agent, request_id, details";
const PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
function values(entry: AuditEntry): unknown[] {
  return [
    entry.occurredAt, entry.orgId ?? null, entry.actorKind ?? "user", entry.actorUserId ?? null,
    entry.actorEmail ?? null, entry.authMethod ?? null, entry.action, entry.targetType ?? null,
    entry.targetId ?? null, entry.result, entry.reason ?? null, entry.ip ?? null,
    entry.userAgent ?? null, entry.requestId ?? null, entry.details ? JSON.stringify(entry.details) : null,
  ];
}
export function insertAudit(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db.prepare(`INSERT INTO audit_events (${COLUMNS}) VALUES (${PLACEHOLDERS})`).bind(...values(entry));
}
