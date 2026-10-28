import type { engine } from "#shared";
import type { AuditEntry } from "../audit.ts";

/**
 * Statements as data, so one batch layout serves both writers: the HTTP command handler, which runs them as its own
 * D1 batch, and the import API, which adds them to the chunk's batch through `tx.add` with their parameter count and
 * size (D1 allows at most 100 bound parameters and 100,000 bytes per statement).
 */
export interface Stmt {
  sql: string;
  params: unknown[];
}

export const MAX_STATEMENT_PARAMETERS = 100;
export const MAX_STATEMENT_BYTES = 100_000;

export function stmt(sql: string, ...params: unknown[]): Stmt {
  return { sql, params };
}

const utf8 = new TextEncoder();

/** Bytes of a statement as D1 receives it: the SQL text plus every bound text value, in UTF-8 (not UTF-16 units). */
export function statementBytes(statement: Stmt): number {
  let bytes = utf8.encode(statement.sql).byteLength;
  for (const param of statement.params) bytes += typeof param === "string" ? utf8.encode(param).byteLength : 8;
  return bytes;
}

export function prepare(db: D1Database, statement: Stmt): D1PreparedStatement {
  if (statement.params.length > MAX_STATEMENT_PARAMETERS) throw new Error("A ledger statement binds more than 100 parameters");
  if (statementBytes(statement) > MAX_STATEMENT_BYTES) throw new Error("A ledger statement exceeds 100,000 bytes");
  return db.prepare(statement.sql).bind(...statement.params);
}

export interface ReceiptValues {
  id: string;
  consoleOrganizationId: string;
  scope: string;
  actor: string;
  route: string;
  key: string;
  requestSha256: string;
  status: number;
  body: string;
  now: number;
}

export function receiptInsert(values: ReceiptValues): Stmt {
  return stmt(
    `INSERT INTO idempotency_keys
     (id, console_organization_id, scope, actor, route, idem_key, request_sha256, response_status, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values.id, values.consoleOrganizationId, values.scope, values.actor, values.route, values.key,
    values.requestSha256, values.status, values.body, values.now,
  );
}

export interface CommandValues {
  id: string;
  orgId: string;
  type: string;
  receiptId: string;
  requestSha256: string;
  actorKind: engine.ActorKind;
  actorUserId: string | null;
  authMethod: "console" | null;
  note: string | null;
  reversesCommandId: string | null;
  expectedLedgerSeq: number | null;
  declaredTxCount: number;
  firstSeq: number;
  lastSeq: number;
  result: string;
  now: number;
}

export function commandInsert(values: CommandValues): Stmt {
  return stmt(
    `INSERT INTO commands (id, org_id, type, idempotency_key_id, request_sha256, actor_kind, actor_user_id, auth_method, note,
       reverses_command_id, expected_ledger_seq, declared_tx_count, first_seq, last_seq, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values.id, values.orgId, values.type, values.receiptId, values.requestSha256, values.actorKind, values.actorUserId,
    values.authMethod, values.note, values.reversesCommandId, values.expectedLedgerSeq, values.declaredTxCount, values.firstSeq,
    values.lastSeq, values.result, values.now,
  );
}

export function securityInsert(
  orgId: string,
  security: engine.SecurityIdentity,
  extra: { now: number; pulleyId?: string | null },
): Stmt {
  return stmt(
    `INSERT INTO securities (id, org_id, family, subtype, stakeholder_id, stock_class_id, stock_plan_id, display_id,
       origin_command_id, parent_security_id, created_at, pulley_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    security.id, orgId, security.family, security.subtype, security.stakeholderId, security.stockClassId, security.stockPlanId,
    security.displayId, security.originCommandId, security.parentSecurityId, extra.now, extra.pulleyId ?? null,
  );
}

export interface VestingTermsValues {
  id: string;
  orgId: string;
  name: string;
  definition: string;
  definitionSha256: string;
  createdBy: string | null;
  pulleyId?: string | null;
  now: number;
}

export function vestingTermsInsert(values: VestingTermsValues): Stmt {
  return stmt(
    `INSERT INTO vesting_terms (id, org_id, name, is_template, definition, definition_sha256, algorithm_version, created_by, created_at, pulley_id)
     VALUES (?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`,
    values.id, values.orgId, values.name, values.definition, values.definitionSha256, values.createdBy, values.now,
    values.pulleyId ?? null,
  );
}

export function transactionInsert(row: engine.TransactionRow): Stmt {
  return stmt(
    `INSERT INTO transactions (id, org_id, seq, command_id, type, effective_date, security_id, stakeholder_id, stock_class_id,
       stock_plan_id, valuation_id, quantity, amount, currency, payload, payload_version, payload_sha256, reverses_tx_id,
       supersedes_tx_id, source, recorded_at, recorded_by, prev_hash, chain_hash, pulley_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.org_id, row.seq, row.command_id, row.type, row.effective_date, row.security_id, row.stakeholder_id,
    row.stock_class_id, row.stock_plan_id, row.valuation_id, row.quantity, row.amount, row.currency, row.payload,
    row.payload_version, row.payload_sha256, row.reverses_tx_id, row.supersedes_tx_id, row.source, row.recorded_at,
    row.recorded_by, row.prev_hash, row.chain_hash, row.pulley_ref,
  );
}

export function dependencyInsert(orgId: string, edge: engine.DependencyEdge, options: { ignore?: boolean } = {}): Stmt {
  return stmt(
    `INSERT INTO command_dependencies (org_id, command_id, depends_on_command_id, kind) VALUES (?, ?, ?, ?)`
      + (options.ignore ? " ON CONFLICT (command_id, depends_on_command_id) DO NOTHING" : ""),
    orgId, edge.commandId, edge.dependsOnCommandId, edge.kind,
  );
}

/** The same row `insertAudit` writes, as data. */
export function auditInsert(entry: AuditEntry): Stmt {
  const orgId = entry.orgId ?? null;
  return stmt(
    `INSERT INTO audit_events (occurred_at, console_organization_id, org_id, actor_kind, actor_user_id, actor_email,
       auth_method, action, target_type, target_id, result, reason, ip, user_agent, request_id, details, org_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE
       COALESCE((SELECT MAX(org_seq) + 1 FROM audit_events WHERE org_id = ?), 1) END)`,
    entry.occurredAt, entry.consoleOrganizationId ?? null, entry.orgId ?? null,
    entry.actorKind ?? "user", entry.actorUserId ?? null, entry.actorEmail ?? null,
    entry.authMethod ?? null, entry.action, entry.targetType ?? null, entry.targetId ?? null, entry.result, entry.reason ?? null,
    entry.ip ?? null, entry.userAgent ?? null, entry.requestId ?? null, entry.details ? JSON.stringify(entry.details) : null,
    orgId, orgId,
  );
}

/**
 * The seal (the ledger rules): the command wrote exactly its declared transactions and, for a reversal, every
 * transaction of the target has its X_REVERSAL in this command. A false assertion aborts the whole batch.
 */
export function sealAssertions(orgId: string, commandId: string, declared: number, reversesCommandId: string | null): Stmt[] {
  const statements = [
    stmt(
      "INSERT INTO batch_assertions (ok) SELECT COUNT(*) = ? FROM transactions WHERE org_id = ? AND command_id = ?",
      declared, orgId, commandId,
    ),
  ];
  if (reversesCommandId !== null) {
    statements.push(stmt(
      `INSERT INTO batch_assertions (ok) SELECT NOT EXISTS (
         SELECT 1 FROM transactions t WHERE t.org_id = ? AND t.command_id = ?
           AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.org_id = t.org_id AND r.command_id = ? AND r.reverses_tx_id = t.id))`,
      orgId, reversesCommandId, commandId,
    ));
  }
  return statements;
}
