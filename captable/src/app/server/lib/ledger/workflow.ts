import { api, engine } from "#shared";
import { ApiError, notFound } from "../http.ts";
import { ledgerCache } from "../read/ledger.ts";
import { toPrepared } from "./batch.ts";
import { assertNotSelfDealing } from "./commands/common.ts";
import { expiryCandidatesToday, planExpiry, type ExpiryProposal } from "./commands/expire.ts";
import { planTermination, terminationRequest, type TerminationInput } from "./commands/terminate.ts";
import { classifyBatchFailure, conflict, invariantViolation, warningsUnacknowledged } from "./errors.ts";
import { evaluatePlan } from "./evaluate.ts";
import { uuidv7 } from "./ids.ts";
import { commandResult, findReceipt, loadCommandContext, requestSha256, runCommand, type ContextInput } from "./run.ts";
import { auditInsert, receiptInsert, stmt, type Stmt } from "./statements.ts";
import type { BatchStatement, CommandContext } from "./types.ts";

/**
 * Workflow commands (the API contract) that write workflow rows rather than (only) transactions: scheduling and
 * cancelling a termination, and confirming a report-only expiry run.
 */

export interface StoredResponse {
  status: number;
  body: unknown;
  replay: boolean;
}

/**
 * The head a workflow write was validated against, asserted inside its own batch (the ledger rules): a ledger command
 * committed in between aborts the batch instead of letting the write stand on a stale preview.
 */
function headAssertion(orgId: string, seq: number): Stmt {
  return stmt("INSERT INTO batch_assertions (ok) SELECT (SELECT seq FROM ledger_heads WHERE org_id = ?) IS ?", orgId, seq);
}

async function headMoved(ctx: CommandContext, seq: number): Promise<boolean> {
  const head = await ctx.db.prepare("SELECT seq FROM ledger_heads WHERE org_id = ?").bind(ctx.org.id).first<number>("seq");
  return head !== seq;
}

/**
 * Commits a workflow write in one batch with its receipt (the API contract): a same-key race returns the stored response, a
 * lost guard (a trigger or a batch assertion) is a 409. `status` is the response stored with the receipt (201 for a
 * creation).
 */
export async function commitWorkflow(
  ctx: CommandContext,
  statements: readonly BatchStatement[],
  receipt: { route: string; key: string; hash: string; body: unknown; status?: number },
  options: { expectHead?: number } = {},
): Promise<StoredResponse> {
  const scope = ctx.org.id;
  const text = JSON.stringify(receipt.body);
  const status = receipt.status ?? 200;
  const guard = options.expectHead !== undefined ? [headAssertion(scope, options.expectHead)] : [];
  try {
    await ctx.db.batch([
      receiptInsert({ id: uuidv7(ctx.now), scope, actor: ctx.actor.receiptActor, route: receipt.route, key: receipt.key, requestSha256: receipt.hash, status, body: text, now: ctx.now }),
      ...guard,
      ...statements,
    ].map((statement) => toPrepared(ctx.db, statement)));
  } catch (error) {
    const failure = classifyBatchFailure(error);
    const raced = await findReceipt(ctx.db, scope, ctx.actor.receiptActor, receipt.route, receipt.key);
    if (raced) {
      if (raced.request_sha256 !== receipt.hash) throw conflict("idempotency_key_reused", "Idempotency-Key was already used for a different request");
      return { status: raced.response_status, body: JSON.parse(raced.response_body), replay: true };
    }
    // The batch rolled back whole; name the moved head when that is what failed (read after the failure, never inferred).
    if (failure?.kind === "conflict" && options.expectHead !== undefined && await headMoved(ctx, options.expectHead)) {
      throw conflict("stale_ledger", "The ledger moved since you reviewed this; review it again");
    }
    if (failure?.kind === "conflict") throw conflict(failure.reason, failure.message);
    throw error;
  }
  return { status, body: receipt.body, replay: false };
}

/** The stored response of a retried key (same request), or 409 for the key reused with another request. */
export async function replayed(ctx: CommandContext, route: string, key: string | null, hash: string): Promise<StoredResponse | null> {
  if (key === null) return null;
  const receipt = await findReceipt(ctx.db, ctx.org.id, ctx.actor.receiptActor, route, key);
  if (!receipt) return null;
  if (receipt.request_sha256 !== hash) throw conflict("idempotency_key_reused", "Idempotency-Key was already used for a different request");
  return { status: receipt.response_status, body: JSON.parse(receipt.response_body), replay: true };
}

/**
 * schedule-termination (the API contract): stores the termination, after validating it against today's ledger as if its
 * date had come. The preview is the command on-demand due processing will run on the date and validate again.
 */
export async function scheduleTermination(
  ctx: CommandContext,
  input: TerminationInput,
  request: { route: string; path: string; body: unknown; dryRun: boolean; key: string | null; expectedLedgerSeq: number | null; expectedDiffSha256: string | null; acknowledge: readonly string[] },
): Promise<StoredResponse> {
  const hash = requestSha256(request.route, request.path, request.body);
  if (!request.dryRun) {
    const prior = await replayed(ctx, request.route, request.key, hash);
    if (prior) return prior;
  }
  const { plan } = await planTermination(ctx, input, { kind: "schedule" });
  const previewCtx: CommandContext = { ...ctx, today: input.terminationDate > ctx.today ? input.terminationDate : ctx.today };
  const evaluation = evaluatePlan(previewCtx, plan);
  if (evaluation.violations.length > 0) throw invariantViolation(evaluation.violations);
  const preview = commandResult(previewCtx, evaluation, true);
  if (request.dryRun) return { status: 200, body: api.scheduleTerminationResponseSchema.parse({ scheduledTerminationId: null, preview }), replay: false };
  if (request.expectedLedgerSeq !== null && request.expectedLedgerSeq !== ctx.ledger.seq) {
    throw conflict("stale_ledger", "The ledger moved since you reviewed this; review it again");
  }
  const acknowledged = new Set(request.acknowledge);
  const missing = evaluation.warnings.filter((warning) => !acknowledged.has(warning.code));
  if (missing.length > 0) throw warningsUnacknowledged(missing);
  if (request.expectedDiffSha256 !== null && request.expectedDiffSha256 !== evaluation.diffSha256) {
    throw conflict("state_changed", "What this termination changes differs from what you reviewed; review it again");
  }
  if (request.key === null) throw new Error("A real command needs an idempotency key");
  const id = uuidv7(ctx.now);
  const stored = terminationRequest(input);
  const text = engine.canonicalJson(stored);
  const body = api.scheduleTerminationResponseSchema.parse({ scheduledTerminationId: id, preview: { ...preview, created: { ...preview.created, scheduledTerminationIds: [id] } } });
  return commitWorkflow(ctx, [
    ...plan.workflow,
    stmt(
      `INSERT INTO scheduled_terminations (id, org_id, stakeholder_id, termination_date, termination_type, vesting_stop_date, request,
         request_sha256, status, created_by, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, 1, ?, ?)`,
      id, ctx.org.id, input.stakeholderId, input.terminationDate, input.terminationType, input.vestingStopDate ?? input.terminationDate,
      text, engine.sha256Hex(text), ctx.actor.userId, ctx.now, ctx.now,
    ),
    auditInsert({
      occurredAt: ctx.now, orgId: ctx.org.id, actorKind: ctx.actor.kind, actorUserId: ctx.actor.userId, actorEmail: ctx.actor.email,
      authMethod: ctx.actor.authMethod, action: "scheduled_termination.created", targetType: "scheduled_termination", targetId: id,
      result: "success", ip: ctx.actor.ip ?? null, userAgent: ctx.actor.userAgent ?? null, requestId: ctx.actor.requestId ?? null,
      details: { summary: `Termination scheduled for ${input.terminationDate}`, stakeholderId: input.stakeholderId, terminationDate: input.terminationDate },
    }),
  ], { route: request.route, key: request.key, hash, body }, { expectHead: request.expectedLedgerSeq ?? ctx.ledger.seq });
}

interface ScheduledRow {
  id: string;
  stakeholder_id: string;
  termination_date: string;
  termination_type: engine.TerminationType;
  vesting_stop_date: string;
  request: string;
  status: "SCHEDULED" | "APPLIED" | "CANCELLED";
  applied_command_id: string | null;
  cancelled_by: string | null;
  cancelled_at: number | null;
  cancel_note: string | null;
  created_by: string | null;
  version: number;
  created_at: number;
}

export function scheduledTerminationJson(row: ScheduledRow): api.ScheduledTermination {
  return api.scheduledTerminationSchema.parse({
    id: row.id,
    stakeholderId: row.stakeholder_id,
    terminationDate: row.termination_date,
    terminationType: row.termination_type,
    vestingStopDate: row.vesting_stop_date,
    status: row.status,
    appliedCommandId: row.applied_command_id,
    cancelledBy: row.cancelled_by,
    cancelledAt: row.cancelled_at,
    cancelNote: row.cancel_note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    version: row.version,
  });
}

/** Cancels a scheduled termination by id and version; a race with on-demand processing is safe. */
export async function cancelScheduledTermination(
  ctx: CommandContext,
  body: api.CancelScheduledTermination,
  request: { route: string; path: string; key: string },
): Promise<StoredResponse> {
  const hash = requestSha256(request.route, request.path, body);
  const prior = await replayed(ctx, request.route, request.key, hash);
  if (prior) return prior;
  const row = await ctx.db.prepare("SELECT * FROM scheduled_terminations WHERE org_id = ? AND id = ?").bind(ctx.org.id, body.scheduledTerminationId).first<ScheduledRow>();
  if (!row) throw notFound("Scheduled termination not found");
  await assertNotSelfDealing(ctx, [row.stakeholder_id]);
  if (row.version !== body.version) throw conflict("stale_version", "The scheduled termination changed since you loaded it; reload it");
  if (row.status !== "SCHEDULED") throw conflict("state_changed", row.status === "APPLIED" ? "It was already applied: reverse the applied termination instead" : "It was already cancelled");
  const updated: ScheduledRow = { ...row, status: "CANCELLED", cancelled_by: ctx.actor.userId, cancelled_at: ctx.now, cancel_note: body.note, version: row.version + 1 };
  return commitWorkflow(ctx, [
    stmt(
      `UPDATE scheduled_terminations SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancel_note = ?, version = ?, updated_at = ?
       WHERE org_id = ? AND id = ?`,
      ctx.actor.userId, ctx.now, body.note, body.version + 1, ctx.now, ctx.org.id, row.id,
    ),
    auditInsert({
      occurredAt: ctx.now, orgId: ctx.org.id, actorKind: ctx.actor.kind, actorUserId: ctx.actor.userId, actorEmail: ctx.actor.email,
      authMethod: ctx.actor.authMethod, action: "scheduled_termination.cancelled", targetType: "scheduled_termination", targetId: row.id,
      result: "success", ip: ctx.actor.ip ?? null, userAgent: ctx.actor.userAgent ?? null, requestId: ctx.actor.requestId ?? null,
      details: { summary: "Scheduled termination cancelled", stakeholderId: row.stakeholder_id },
    }),
  ], { route: request.route, key: request.key, hash, body: scheduledTerminationJson(updated) });
}

/**
 * The receipt key of one security's expiry within a confirmation: the confirmation's key and the security, so a retry
 * resumes where it stopped. Keys are at most 200 characters (CHECK), so a long confirmation key is hashed first.
 */
export function expiryKey(key: string, securityId: string): string {
  const base = key.length + 1 + securityId.length <= 200 ? key : engine.sha256Hex(key).slice(0, 40);
  return `${base}:${securityId}`;
}

interface ExpiryConfirmation {
  key: string;
  actor: string;
  requestSha256: string;
  reservedAt: number;
  /** Each confirmed security's reviewed `effectSha256`: every expiry, a resumed one included, is held to it. */
  effects: Record<string, string>;
}

interface ExpiryRunDetails {
  candidates?: ExpiryProposal[];
  confirmation?: ExpiryConfirmation;
}

/**
 * Binds the confirmation's Idempotency-Key, actor and request hash to the run before any child command commits, in one
 * conditional write guarded by an assertion: only this request may then expire the run's securities, and a retry of
 * exactly it resumes. A reservation by the same key with another body is 409 idempotency_key_reused; by another
 * request, 409 state_changed.
 */
async function reserveExpiryRun(ctx: CommandContext, runId: number, confirmation: ExpiryConfirmation): Promise<void> {
  try {
    await ctx.db.batch([
      ctx.db.prepare("UPDATE expiry_runs SET confirmation = ? WHERE id = ? AND confirmation IS NULL")
        .bind(JSON.stringify(confirmation), runId),
      ctx.db.prepare(
        `INSERT INTO batch_assertions (ok) SELECT json_extract(confirmation, '$.key') IS ? AND json_extract(confirmation, '$.actor') IS ?
           AND json_extract(confirmation, '$.requestSha256') IS ? FROM expiry_runs WHERE id = ?`,
      ).bind(confirmation.key, confirmation.actor, confirmation.requestSha256, runId),
    ]);
  } catch (error) {
    if (classifyBatchFailure(error)?.kind !== "conflict") throw error;
    const row = await ctx.db.prepare("SELECT confirmation FROM expiry_runs WHERE id = ?").bind(runId).first<{ confirmation: string | null }>();
    const existing = row?.confirmation ? (JSON.parse(row.confirmation) as ExpiryConfirmation) : null;
    throw sameConfirmer(existing, confirmation)
      ? conflict("idempotency_key_reused", "Idempotency-Key was already used for a different request")
      : conflict("state_changed", "Another confirmation of this run is under way or done");
  }
}

function sameConfirmer(existing: ExpiryConfirmation | null | undefined, confirmation: ExpiryConfirmation): boolean {
  return existing !== null && existing !== undefined && existing.key === confirmation.key && existing.actor === confirmation.actor;
}

/** The run's proposals, checked to be report-only and this org's, and the chosen securities checked to be among them. */
async function expiryRunFor(ctx: CommandContext, runId: number, securityIds: readonly string[]): Promise<ExpiryRunDetails> {
  const run = await ctx.db.prepare("SELECT id, org_id, candidates, confirmation FROM expiry_runs WHERE id = ?").bind(runId)
    .first<{ id: number; org_id: string; candidates: string; confirmation: string | null }>();
  if (!run || run.org_id !== ctx.org.id) throw notFound("Expiry run not found");
  const details: ExpiryRunDetails = {
    candidates: JSON.parse(run.candidates) as ExpiryProposal[],
    confirmation: run.confirmation ? JSON.parse(run.confirmation) as ExpiryConfirmation : undefined,
  };
  const proposed = new Set((details.candidates ?? []).map((candidate) => candidate.securityId));
  const outside = securityIds.filter((id) => !proposed.has(id));
  if (outside.length > 0) {
    throw invariantViolation(outside.map((securityId) => ({ code: "NOT_IN_EXPIRY_RUN", message: "That security isn't one of this run's proposals", securityId })));
  }
  return details;
}

/**
 * `?dryRun=true`: what confirming would do, one dry run per chosen security at the current head. The reviewer's
 * client sends back the head (`expectedLedgerSeq`) and each result's `effectSha256` (`expectedEffectSha256s`).
 */
export async function previewExpiryRun(input: ContextInput, runId: number, body: api.ConfirmExpiryRunDryRun): Promise<api.ConfirmExpiryRunResponse> {
  const ctx = await loadCommandContext(input);
  await expiryRunFor(ctx, runId, body.securityIds);
  const results: api.CommandResult[] = [];
  for (const securityId of body.securityIds) {
    const outcome = await runCommand(ctx, {
      route: "POST /api/orgs/:orgId/expiry-runs/:runId/confirm",
      path: `#${securityId}`,
      body: { runId, securityId },
      dryRun: true,
      idempotencyKey: null,
      expectedLedgerSeq: null,
      expectedDiffSha256: null,
      acknowledge: [],
      autoAcknowledge: true,
    }, (current) => planExpiry(current, securityId));
    results.push(outcome.result);
  }
  return api.confirmExpiryRunResponseSchema.parse({ runId, commands: results, expiryMode: ctx.settings.expiry.mode });
}

/**
 * Confirms a report-only expiry run: the chosen candidates are expired by this administrator, one
 * command per security (each with its own receipt, so a retry resumes), and the org can switch to automatic expiry.
 * It is bound to the dry run the administrator reviewed: the first attempt needs that head, and every expiry, a resumed
 * one included, commits only while its effect is the reviewed one.
 */
export async function confirmExpiryRun(
  input: ContextInput,
  runId: number,
  body: api.ConfirmExpiryRun,
  request: { route: string; path: string; key: string },
): Promise<StoredResponse> {
  let ctx = await loadCommandContext(input);
  const hash = requestSha256(request.route, request.path, body);
  const prior = await replayed(ctx, request.route, request.key, hash);
  if (prior) return prior;
  const details = await expiryRunFor(ctx, runId, body.securityIds);
  const confirmation: ExpiryConfirmation = {
    key: request.key, actor: ctx.actor.receiptActor, requestSha256: hash, reservedAt: ctx.now, effects: body.expectedEffectSha256s,
  };
  const reserved = details.confirmation;
  if (reserved !== undefined) {
    // Bound already: only a retry of the very same request resumes (its own children moved the head).
    if (!sameConfirmer(reserved, confirmation)) throw conflict("state_changed", "Another confirmation of this run is under way or done");
    if (reserved.requestSha256 !== hash) throw conflict("idempotency_key_reused", "Idempotency-Key was already used for a different request");
  } else {
    if (body.expectedLedgerSeq !== ctx.ledger.seq) throw conflict("stale_ledger", "The ledger moved since you reviewed this run; review it again");
    await reserveExpiryRun(ctx, runId, confirmation);
  }
  const still = new Set(expiryCandidatesToday(ctx).map((candidate) => candidate.securityId));
  const results: api.CommandResult[] = [];
  for (const securityId of body.securityIds) {
    const key = expiryKey(request.key, securityId);
    const receipt = await findReceipt(ctx.db, ctx.org.id, ctx.actor.receiptActor, request.route, key);
    if (!receipt && !still.has(securityId)) {
      throw invariantViolation([{ code: "NOT_EXPIRABLE", message: "That security is no longer past its last exercise day with something outstanding", securityId }]);
    }
    const outcome = await runCommand(ctx, {
      route: request.route,
      path: `${request.path}#${securityId}`,
      body: { runId, securityId },
      dryRun: false,
      idempotencyKey: key,
      expectedLedgerSeq: null,
      expectedDiffSha256: null,
      // Held to its reviewed effect on every attempt (the reservation binds these hashes to this request).
      expectedEffectSha256: body.expectedEffectSha256s[securityId]!,
      acknowledge: [],
      autoAcknowledge: true,
    }, (current) => planExpiry(current, securityId));
    results.push(outcome.result);
    ctx = await loadCommandContext(input);
  }
  const statements: Stmt[] = [
    stmt("UPDATE expiry_runs SET confirmed_at = ?, confirmed_by = ? WHERE id = ?", ctx.now, ctx.actor.userId, runId),
    auditInsert({
      occurredAt: ctx.now, orgId: ctx.org.id, actorKind: ctx.actor.kind, actorUserId: ctx.actor.userId, actorEmail: ctx.actor.email,
      authMethod: ctx.actor.authMethod, action: "system.expiry_run_confirmed", targetType: "expiry_run", targetId: String(runId), result: "success",
      ip: ctx.actor.ip ?? null, userAgent: ctx.actor.userAgent ?? null, requestId: ctx.actor.requestId ?? null,
      details: { summary: `Expiry run confirmed: ${results.length} expired`, expired: results.length, switchToAutomatic: body.switchToAutomatic },
    }),
  ];
  let mode = ctx.settings.expiry.mode;
  if (body.switchToAutomatic && mode !== "automatic") {
    statements.push(stmt(
      "UPDATE orgs SET settings = json_set(settings, '$.expiry', json('{\"mode\":\"automatic\"}')), version = version + 1, updated_at = ? WHERE id = ?",
      ctx.now, ctx.org.id,
    ));
    mode = "automatic";
  }
  const response = api.confirmExpiryRunResponseSchema.parse({ runId, commands: results, expiryMode: mode });
  const stored = await commitWorkflow(ctx, statements, { route: request.route, key: request.key, hash, body: response });
  ledgerCache().delete(ctx.ledger.key);
  return stored;
}

/** Used by the stakeholder and Securities Status views: the live scheduled termination of each stakeholder. */
export async function scheduledTerminations(db: D1Database, orgId: string): Promise<ScheduledRow[]> {
  const { results } = await db.prepare("SELECT * FROM scheduled_terminations WHERE org_id = ? ORDER BY termination_date, id").bind(orgId).all<ScheduledRow>();
  return results;
}

export type { ScheduledRow };
