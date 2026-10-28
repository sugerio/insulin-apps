import { api, engine } from "#shared";
import { ApiError, notFound } from "../http.ts";
import { dec, email, exactDecimal, maskEmail, replayed, userActorLabel, type ReadContext, type Viewer } from "./context.ts";

/**
 * The ledger's records for admins (the API contract): exercises (migrated and recorded), migrated requests, signature acts,
 * certificates, legends and terms, 83(b) records, the audit log, transactions and commands.
 */

// ---------------------------------------------------------------------------
// Actors

/** A display label for who did something: a person, system maintenance or the company's import source. */
export class ActorLabels {
  private readonly users = new Map<string, string | null>();

  constructor(private readonly ctx: ReadContext) {}

  async user(userId: string | null): Promise<string | null> {
    if (userId === null) return null;
    if (!this.users.has(userId)) {
      const row = await this.ctx.db.prepare("SELECT email, display_name FROM users WHERE id = ?").bind(userId).first<{ email: string; display_name: string | null }>();
      this.users.set(userId, row ? userActorLabel(row, this.ctx.viewer.pii) : null);
    }
    return this.users.get(userId) ?? null;
  }

  async command(commandId: string): Promise<string | null> {
    const command = this.ctx.ledger.commands.get(commandId);
    if (!command) return null;
    if (command.actorKind === "system") return "System maintenance";
    if (command.actorKind === "import") return api.importSourceLabel(this.ctx.org.import_source);
    return this.user(command.actorUserId);
  }
}

// ---------------------------------------------------------------------------
// Exercises

interface RequestLink {
  id: string;
  request_number: number;
  completed_command_id: string | null;
}

export async function exerciseRecords(ctx: ReadContext, state: engine.LedgerState, filter: { year?: number | undefined; stakeholderId?: string } = {}): Promise<api.ExerciseRecord[]> {
  const { results: requests } = await ctx.db.prepare(
    "SELECT id, request_number, completed_command_id FROM exercise_requests WHERE org_id = ? AND completed_command_id IS NOT NULL",
  ).bind(ctx.org.id).all<RequestLink>();
  const byCommand = new Map(requests.map((request) => [request.completed_command_id!, request]));
  const { results: names } = await ctx.db.prepare("SELECT id, display_name FROM stakeholders WHERE org_id = ?").bind(ctx.org.id).all<{ id: string; display_name: string }>();
  const nameOf = new Map(names.map((row) => [row.id, row.display_name]));
  const identities = new Map(ctx.ledger.reference.securities.map((security) => [security.id, security]));
  const records: api.ExerciseRecord[] = [];
  const resolvedFilter = filter.stakeholderId === undefined ? undefined : engine.resolveStakeholderId(state, filter.stakeholderId);
  const filterIsMergedRecord = filter.stakeholderId !== undefined && filter.stakeholderId !== resolvedFilter;
  for (const tx of ctx.ledger.transactions) {
    if (tx.type !== "TX_EQUITY_COMPENSATION_EXERCISE") continue;
    if (filter.year !== undefined && Number(tx.effectiveDate.slice(0, 4)) !== filter.year) continue;
    const option = identities.get(tx.payload.security_id);
    if (!option) continue;
    const optionState = state.securities.get(option.id);
    const stakeholderId = optionState?.identity.stakeholderId ?? engine.resolveStakeholderId(state, option.stakeholderId);
    if (filter.stakeholderId !== undefined && (
      filterIsMergedRecord ? option.stakeholderId !== filter.stakeholderId : stakeholderId !== resolvedFilter
    )) continue;
    const p = tx.payload;
    const quantity = engine.Dec.parse(p.quantity);
    const price = p.x_exercise_price?.amount ?? exactDecimal(optionState?.exercisePriceAtGrant ?? null) ?? "0";
    const cost = p.x_exercise_cost?.amount ?? quantity.mul(price).toString();
    const iso = engine.Dec.sum(p.x_portions.filter((portion) => portion.portion === "ISO").map((portion) => engine.Dec.parse(portion.quantity)));
    const nso = engine.Dec.sum(p.x_portions.filter((portion) => portion.portion === "NSO").map((portion) => engine.Dec.parse(portion.quantity)));
    const request = byCommand.get(tx.commandId);
    const withholding = p.x_tax?.withholding;
    records.push({
      transactionId: tx.id,
      commandId: tx.commandId,
      exerciseDate: tx.effectiveDate,
      stakeholderId,
      stakeholderName: nameOf.get(stakeholderId) ?? "",
      securityId: option.id,
      grantDisplayId: option.displayId,
      quantity: dec(quantity),
      isoQuantity: dec(iso),
      nsoQuantity: dec(nso),
      exercisePrice: price,
      cost,
      paymentMethod: p.x_payment?.method ?? null,
      paymentReference: p.x_payment?.reference ?? null,
      fmvPerShare: p.x_fmv?.price_per_share.amount ?? null,
      taxTreatment: p.x_tax?.treatment ?? null,
      withholding: withholding
        ? { federalIncome: withholding.federal_income, socialSecurity: withholding.social_security, medicare: withholding.medicare, state: withholding.state }
        : null,
      resultingShares: p.x_portions.map((portion) => ({
        securityId: portion.security_id,
        displayId: identities.get(portion.security_id)?.displayId ?? portion.security_id,
        portion: portion.portion,
      })),
      source: request
        ? { kind: "request", requestNumber: request.request_number }
        : { kind: tx.source === "import" ? "migrated" : "recorded", requestNumber: null },
      reversed: state.reversedTransactionIds.has(tx.id),
    });
  }
  return records.sort((a, b) => (a.exerciseDate < b.exerciseDate ? 1 : a.exerciseDate > b.exerciseDate ? -1 : 0));
}

// ---------------------------------------------------------------------------
// Migrated workflow records

interface ExerciseRequestRow {
  id: string;
  request_number: number;
  security_id: string;
  stakeholder_id: string;
  quantity: string;
  iso_quantity: string;
  nso_quantity: string;
  exercise_price: string;
  fmv_per_share: string | null;
  valuation_id: string | null;
  estimated_withholding: string | null;
  total_cost: string;
  currency: string;
  payment_method: api.ExerciseRequest["paymentMethod"];
  status: api.ExerciseRequest["status"];
  pulley_status: string | null;
  notice_document_id: string | null;
  payment_due_date: string | null;
  payment_received_on: string | null;
  exercise_date: string | null;
  completed_command_id: string | null;
  decided_at: number | null;
  cancelled_at: number | null;
  pulley_id: string | null;
  created_at: number;
}

async function documentRefs(ctx: ReadContext, ids: readonly string[]): Promise<Map<string, api.DocumentRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { results } = await ctx.db.prepare("SELECT id, filename, kind FROM documents WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))")
    .bind(ctx.org.id, JSON.stringify(unique)).all<{ id: string; filename: string; kind: api.DocumentRef["kind"] }>();
  return new Map(results.map((row) => [row.id, { id: row.id, filename: row.filename, kind: row.kind }]));
}

function exerciseRequestJson(row: ExerciseRequestRow, documents: Map<string, api.DocumentRef>, state: engine.LedgerState): api.ExerciseRequest {
  const notice = row.notice_document_id !== null ? documents.get(row.notice_document_id) : undefined;
  return {
    id: row.id,
    requestNumber: row.request_number,
    securityId: row.security_id,
    stakeholderId: state.securities.get(row.security_id)?.identity.stakeholderId ?? engine.resolveStakeholderId(state, row.stakeholder_id),
    quantity: row.quantity,
    isoQuantity: row.iso_quantity,
    nsoQuantity: row.nso_quantity,
    exercisePrice: row.exercise_price,
    fmvPerShare: row.fmv_per_share,
    valuationId: row.valuation_id,
    estimatedWithholding: row.estimated_withholding,
    totalCost: row.total_cost,
    currency: row.currency,
    paymentMethod: row.payment_method,
    status: row.status,
    pulleyStatus: row.pulley_status,
    paymentDueDate: row.payment_due_date,
    paymentReceivedOn: row.payment_received_on,
    exerciseDate: row.exercise_date,
    completedCommandId: row.completed_command_id,
    decidedAt: row.decided_at,
    cancelledAt: row.cancelled_at,
    documents: notice ? [notice] : [],
    importedFromPulley: row.pulley_id !== null,
    createdAt: row.created_at,
  };
}

export async function exerciseRequests(ctx: ReadContext, state: engine.LedgerState): Promise<api.ExerciseRequest[]> {
  const { results } = await ctx.db.prepare("SELECT * FROM exercise_requests WHERE org_id = ? ORDER BY request_number DESC").bind(ctx.org.id).all<ExerciseRequestRow>();
  const documents = await documentRefs(ctx, results.map((row) => row.notice_document_id).filter((id): id is string => id !== null));
  return results.map((row) => exerciseRequestJson(row, documents, state));
}

export async function exerciseRequest(ctx: ReadContext, state: engine.LedgerState, id: string): Promise<api.ExerciseRequest> {
  const row = await ctx.db.prepare("SELECT * FROM exercise_requests WHERE org_id = ? AND id = ?").bind(ctx.org.id, id).first<ExerciseRequestRow>();
  if (!row) throw notFound("Exercise request not found");
  const documents = await documentRefs(ctx, row.notice_document_id !== null ? [row.notice_document_id] : []);
  return exerciseRequestJson(row, documents, state);
}

function json(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function signatureRequests(ctx: ReadContext, securityId?: string): Promise<api.SignatureRequest[]> {
  const { results } = await ctx.db.prepare(
    `SELECT * FROM signature_requests WHERE org_id = ?1 AND (?2 IS NULL OR security_id = ?2) ORDER BY created_at, id`,
  ).bind(ctx.org.id, securityId ?? null).all<{
    id: string; security_id: string | null; exercise_request_id: string | null; document_id: string | null;
    signer_role: api.SignatureRequest["signerRole"]; signer_name: string | null; signer_email: string | null;
    status: api.SignatureRequest["status"]; method: api.SignatureRequest["method"]; evidence: string | null;
    evidence_sha256: string | null; signed_at: number | null; resolved_at: number | null; resolution_note: string | null;
    pulley_id: string | null; created_at: number;
  }>();
  return results.map((row) => {
    const evidence = json(row.evidence);
    return {
      id: row.id,
      securityId: row.security_id,
      exerciseRequestId: row.exercise_request_id,
      documentId: row.document_id,
      signerRole: row.signer_role,
      signerName: row.signer_name,
      signerEmail: row.signer_email === null ? null : email(ctx, row.signer_email),
      status: row.status,
      method: row.method,
      evidence: evidence !== null && typeof evidence === "object" && !Array.isArray(evidence) && ctx.viewer.pii ? (evidence as Record<string, unknown>) : null,
      evidenceSha256: row.evidence_sha256,
      signedAt: row.signed_at,
      resolvedAt: row.resolved_at,
      resolutionNote: row.resolution_note,
      importedFromPulley: row.pulley_id !== null,
      createdAt: row.created_at,
    };
  });
}

export async function certificates(ctx: ReadContext): Promise<api.Certificate[]> {
  const { results } = await ctx.db.prepare("SELECT * FROM certificates WHERE org_id = ? ORDER BY issued_date, certificate_number").bind(ctx.org.id).all<{
    id: string; security_id: string; certificate_number: string; status: api.Certificate["status"]; issued_date: string;
    cancelled_date: string | null; cancel_reason: string | null; document_id: string | null; signatories: string; legends: string;
    rendering_note: string | null; pulley_id: string | null;
  }>();
  return results.map((row) => {
    const signatories = json(row.signatories);
    const legends = json(row.legends);
    return {
      id: row.id,
      securityId: row.security_id,
      certificateNumber: row.certificate_number,
      status: row.status,
      issuedDate: row.issued_date,
      cancelledDate: row.cancelled_date,
      cancelReason: row.cancel_reason,
      documentId: row.document_id,
      signatories: Array.isArray(signatories)
        ? signatories.map((s: { name?: unknown; title?: unknown; signedAt?: unknown }) => ({
          name: String(s.name ?? ""),
          title: typeof s.title === "string" ? s.title : null,
          signedAt: typeof s.signedAt === "number" ? s.signedAt : null,
        }))
        : [],
      legends: Array.isArray(legends) ? legends.map((l: { name?: unknown; text?: unknown }) => ({ name: String(l.name ?? ""), text: String(l.text ?? "") })) : [],
      renderingNote: row.rendering_note,
      importedFromPulley: row.pulley_id !== null,
    };
  });
}

export async function legends(ctx: ReadContext, kind: "LEGEND" | "CERTIFICATE_TERMS"): Promise<api.Legend[]> {
  const { results } = await ctx.db.prepare("SELECT id, kind, name, text, archived_at, version FROM legends WHERE org_id = ? AND kind = ? ORDER BY name, id")
    .bind(ctx.org.id, kind).all<{ id: string; kind: api.Legend["kind"]; name: string; text: string; archived_at: number | null; version: number }>();
  return results.map((row) => ({ id: row.id, kind: row.kind, name: row.name, text: row.text, archivedAt: row.archived_at, version: row.version }));
}

export async function elections83b(ctx: ReadContext, securityId?: string): Promise<api.Election83b[]> {
  const { results } = await ctx.db.prepare(
    "SELECT * FROM election_83b_records WHERE org_id = ?1 AND (?2 IS NULL OR security_id = ?2) ORDER BY created_at, id",
  ).bind(ctx.org.id, securityId ?? null).all<{
    id: string; security_id: string; status: api.Election83b["status"]; transfer_date: string | null; due_date: string | null;
    filed_date: string | null; proof_document_id: string | null; supersedes_id: string | null; pulley_id: string | null; created_at: number;
  }>();
  return results.map((row) => ({
    id: row.id,
    securityId: row.security_id,
    status: row.status,
    transferDate: row.transfer_date,
    dueDate: row.due_date,
    filedDate: row.filed_date,
    proofDocumentId: row.proof_document_id,
    supersedesId: row.supersedes_id,
    importedFromPulley: row.pulley_id !== null,
    createdAt: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Audit log, transactions and commands: cursor pages (the API contract)

export function encodeCursor(value: number): string {
  return btoa(`v1:${value}`).replace(/=+$/, "");
}

export function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return null;
  try {
    const match = /^v1:(\d+)$/.exec(atob(cursor));
    if (match) return Number(match[1]);
  } catch {
    // An unreadable cursor is a client error, like any other bad query value.
  }
  throw new ApiError("validation_failed", "The cursor is invalid", [{ path: "cursor", message: "Use the nextCursor of a previous page" }]);
}

export interface AuditRow {
  id: number;
  occurred_at: number;
  org_id: string | null;
  actor_kind: api.AuditEvent["actor"]["kind"];
  actor_user_id: string | null;
  actor_email: string | null;
  auth_method: api.AuditEvent["actor"]["authMethod"];
  action: string;
  target_type: string | null;
  target_id: string | null;
  result: api.AuditEvent["result"];
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  details: string | null;
}

export function auditJson(viewer: Pick<Viewer, "pii" | "fullAccess">, row: AuditRow): api.AuditEvent {
  const details = json(row.details);
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    orgId: row.org_id,
    actor: {
      kind: row.actor_kind,
      userId: row.actor_user_id,
      email: row.actor_email === null ? null : viewer.pii ? row.actor_email : maskEmail(row.actor_email),
      authMethod: row.actor_kind === "user" ? "console" : null,
    },
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    result: row.result,
    reason: row.reason,
    ip: viewer.pii ? row.ip : null,
    userAgent: row.user_agent,
    details: details !== null && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : null,
  };
}

export async function auditPage(ctx: ReadContext, query: { cursor?: string; limit: number; action?: string; actorId?: string; targetId?: string; actorType?: string }): Promise<api.AuditPage> {
  const before = decodeCursor(query.cursor);
  const { results } = await ctx.db.prepare(
    `SELECT * FROM audit_events WHERE org_id = ?1 AND (?2 IS NULL OR id < ?2) AND (?3 IS NULL OR action = ?3)
       AND (?4 IS NULL OR actor_user_id = ?4) AND (?5 IS NULL OR target_id = ?5) AND (?6 IS NULL OR actor_kind = ?6)
     ORDER BY id DESC LIMIT ?7`,
  ).bind(ctx.org.id, before, query.action ?? null, query.actorId ?? null, query.targetId ?? null, query.actorType ?? null, query.limit + 1).all<AuditRow>();
  const page = results.slice(0, query.limit);
  return { items: page.map((row) => auditJson(ctx.viewer, row)), nextCursor: results.length > query.limit ? encodeCursor(page[page.length - 1]!.id) : null };
}

interface TransactionRow extends engine.TransactionRow {
  reversed_by_tx_id: string | null;
}

export function transactionJson(row: TransactionRow): api.Transaction {
  return {
    id: row.id,
    seq: row.seq,
    commandId: row.command_id,
    type: row.type,
    effectiveDate: row.effective_date,
    securityId: row.security_id,
    stakeholderId: row.stakeholder_id,
    valuationId: row.valuation_id,
    quantity: row.quantity,
    amount: row.amount,
    currency: row.currency,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    payloadVersion: row.payload_version,
    payloadSha256: row.payload_sha256,
    reversesTxId: row.reverses_tx_id,
    reversedByTxId: row.reversed_by_tx_id,
    source: row.source,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    prevHash: row.prev_hash,
    chainHash: row.chain_hash,
    pulleyRef: row.pulley_ref,
  };
}

const TRANSACTION_SELECT = `SELECT t.*, (SELECT r.id FROM transactions r WHERE r.org_id = t.org_id AND r.reverses_tx_id = t.id) AS reversed_by_tx_id FROM transactions t`;

export async function transactionPage(ctx: ReadContext, query: {
  cursor?: string; limit: number; type?: string; securityId?: string; stakeholderId?: string; from?: string; to?: string; source?: string;
}): Promise<api.TransactionPage> {
  const before = decodeCursor(query.cursor);
  const state = query.stakeholderId === undefined ? null : replayed(ctx, { asOf: ctx.today, asKnownAt: null });
  const stakeholderId = query.stakeholderId === undefined || state === null ? null : engine.resolveStakeholderId(state, query.stakeholderId);
  const { results } = await ctx.db.prepare(
    `${TRANSACTION_SELECT} WHERE t.org_id = ?1 AND (?2 IS NULL OR t.seq < ?2) AND (?3 IS NULL OR t.type = ?3)
       AND (?4 IS NULL OR t.security_id = ?4)
       AND (?5 IS NULL
         OR t.stakeholder_id IN (SELECT s.id FROM stakeholders s WHERE s.org_id = ?1 AND (s.id = ?5 OR s.merged_into_id = ?5))
         OR t.security_id IN (
           SELECT sec.id FROM securities sec JOIN stakeholders s ON s.org_id = sec.org_id AND s.id = sec.stakeholder_id
            WHERE sec.org_id = ?1 AND (s.id = ?5 OR s.merged_into_id = ?5)
         )
         OR (t.type = 'X_STAKEHOLDER_MERGE' AND (
           json_extract(t.payload, '$.merged_stakeholder_id') IN (SELECT s.id FROM stakeholders s WHERE s.org_id = ?1 AND (s.id = ?5 OR s.merged_into_id = ?5))
           OR json_extract(t.payload, '$.surviving_stakeholder_id') IN (SELECT s.id FROM stakeholders s WHERE s.org_id = ?1 AND (s.id = ?5 OR s.merged_into_id = ?5))
         )))
       AND (?6 IS NULL OR t.effective_date >= ?6) AND (?7 IS NULL OR t.effective_date <= ?7) AND (?8 IS NULL OR t.source = ?8)
     ORDER BY t.seq DESC LIMIT ?9`,
  ).bind(ctx.org.id, before, query.type ?? null, query.securityId ?? null, stakeholderId, query.from ?? null, query.to ?? null, query.source ?? null, query.limit + 1).all<TransactionRow>();
  const page = results.slice(0, query.limit);
  return { items: page.map(transactionJson), nextCursor: results.length > query.limit ? encodeCursor(page[page.length - 1]!.seq) : null };
}

async function commandSummary(ctx: ReadContext, labels: ActorLabels, commandId: string): Promise<api.CommandSummary> {
  const command = ctx.ledger.commands.get(commandId);
  if (!command) throw notFound("Command not found");
  const reversal = ctx.ledger.reference.commands.find((c) => c.reversesCommandId === commandId) ?? null;
  return {
    id: command.id,
    type: command.type,
    actorKind: command.actorKind,
    actor: await labels.command(command.id),
    authMethod: command.authMethod,
    note: command.note,
    createdAt: command.createdAt,
    firstSeq: command.firstSeq,
    lastSeq: command.lastSeq,
    reversesCommandId: command.reversesCommandId,
    reversedByCommandId: reversal?.id ?? null,
    importedFromPulley: command.actorKind === "import",
  };
}

export async function transactionDetail(ctx: ReadContext, transactionId: string): Promise<api.TransactionDetail> {
  const row = await ctx.db.prepare(`${TRANSACTION_SELECT} WHERE t.org_id = ? AND t.id = ?`).bind(ctx.org.id, transactionId).first<TransactionRow>();
  if (!row) throw notFound("Transaction not found");
  const labels = new ActorLabels(ctx);
  const command = await commandSummary(ctx, labels, row.command_id);
  let reversal: api.TransactionDetail["reversal"] = null;
  if (row.reversed_by_tx_id !== null) {
    const reverse = await ctx.db.prepare("SELECT id, command_id, recorded_at FROM transactions WHERE org_id = ? AND id = ?").bind(ctx.org.id, row.reversed_by_tx_id)
      .first<{ id: string; command_id: string; recorded_at: number }>();
    if (reverse) reversal = { transactionId: reverse.id, commandId: reverse.command_id, recordedAt: reverse.recorded_at, note: ctx.ledger.commands.get(reverse.command_id)?.note ?? null };
  }
  return api.transactionDetailSchema.parse({ ...transactionJson(row), command, reversal });
}

export async function commandDetail(ctx: ReadContext, commandId: string): Promise<api.CommandDetail> {
  const labels = new ActorLabels(ctx);
  const summary = await commandSummary(ctx, labels, commandId);
  const [transactions, dependencies, dependents] = await ctx.db.batch([
    ctx.db.prepare(`${TRANSACTION_SELECT} WHERE t.org_id = ? AND t.command_id = ? ORDER BY t.seq`).bind(ctx.org.id, commandId),
    ctx.db.prepare("SELECT depends_on_command_id AS id, kind FROM command_dependencies WHERE org_id = ? AND command_id = ?").bind(ctx.org.id, commandId),
    ctx.db.prepare("SELECT command_id AS id, kind FROM command_dependencies WHERE org_id = ? AND depends_on_command_id = ?").bind(ctx.org.id, commandId),
  ]);
  const typeOf = (id: string) => ctx.ledger.commands.get(id)?.type ?? "unknown";
  const reversed = (id: string) => ctx.ledger.reference.commands.some((c) => c.reversesCommandId === id);
  return api.commandDetailSchema.parse({
    ...summary,
    transactions: ((transactions?.results ?? []) as TransactionRow[]).map(transactionJson),
    dependencies: ((dependencies?.results ?? []) as { id: string; kind: engine.DependencyKind }[]).map((edge) => ({ commandId: edge.id, type: typeOf(edge.id), kind: edge.kind })),
    dependents: ((dependents?.results ?? []) as { id: string; kind: engine.DependencyKind }[]).map((edge) => ({ commandId: edge.id, type: typeOf(edge.id), kind: edge.kind, reversed: reversed(edge.id) })),
  });
}

/** A one-line description of an audit event for the dashboard (details.summary, else the action in words). */
export function describeAudit(row: { action: string; details: string | null }): string {
  const details = json(row.details) as { summary?: unknown } | null;
  if (details && typeof details.summary === "string" && details.summary.trim() !== "") return details.summary;
  return row.action.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
