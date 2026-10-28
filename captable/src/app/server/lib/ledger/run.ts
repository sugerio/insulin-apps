import { api, engine } from "#shared";
import { insertAudit } from "../audit.ts";
import type { AppConfig } from "../config.ts";
import { log, notFound } from "../http.ts";
import { ledgerCache, loadLedger } from "../read/ledger.ts";
import { getOrgRow, orgLocalDate, orgSettings, type OwnedOrgRow } from "../read/org.ts";
import { commandBatch, toPrepared } from "./batch.ts";
import type { CommandDocuments } from "./documents.ts";
import { classifyBatchFailure, conflict, extendedCode, invariantViolation, LedgerError, warningsUnacknowledged } from "./errors.ts";
import { evaluatePlan, type Evaluation } from "./evaluate.ts";
import { uuidv7 } from "./ids.ts";
import type { Actor, CommandContext, CommandPlan } from "./types.ts";

/**
 * Running a command end to end (the ledger rules): the receipt check, the builder's plan, the engine's verdict, the
 * guards a real call must pass (head, violations, warnings, reviewed diff), and the one batch that records it all.
 */

export interface ContextInput {
  db: D1Database;
  now: number;
  config: AppConfig | null;
  orgId: string;
  actor: Actor;
  source: engine.TransactionSource;
}

export async function loadCommandContext(input: ContextInput): Promise<CommandContext> {
  const org = await getOrgRow(input.db, input.orgId);
  if (!org || org.console_organization_id === null) throw notFound("Organization not found");
  const ownedOrg: OwnedOrgRow = { ...org, console_organization_id: org.console_organization_id };
  const ledger = await loadLedger(input.db, input.orgId);
  if (!ledger) throw notFound("Organization not found");
  return {
    db: input.db,
    config: input.config,
    deps: { now: () => input.now },
    org: ownedOrg,
    settings: orgSettings(ownedOrg.settings),
    ledger,
    now: input.now,
    today: orgLocalDate(org.timezone, input.now),
    actor: input.actor,
    source: input.source,
  };
}

export interface CommandRequest {
  /** The receipt's route: the method and the route template (the ledger rules). */
  route: string;
  /** The concrete path, part of the request hash. */
  path: string;
  /** The parsed body: its canonical JSON is the rest of the request hash. */
  body: unknown;
  dryRun: boolean;
  idempotencyKey: string | null;
  expectedLedgerSeq: number | null;
  expectedDiffSha256: string | null;
  /**
   * A confirmed item of a reviewed batch (the expiry run's confirmation): the `effectSha256` its dry run showed. It
   * commits only while its effect is still that one (409 `state_changed` otherwise).
   */
  expectedEffectSha256?: string | null;
  acknowledge: readonly string[];
  /** System and import commands record their warnings instead of asking anyone to acknowledge them. */
  autoAcknowledge?: boolean;
}

export interface CommandOutcome {
  result: api.CommandResult;
  /** A stored response for a retried key (header `Idempotent-Replay: true`). */
  replay: { status: number; body: string } | null;
  evaluation: Evaluation | null;
}

interface ReceiptRow {
  id: string;
  request_sha256: string;
  response_status: number;
  response_body: string;
}

export async function findReceipt(
  db: D1Database,
  consoleOrganizationId: string,
  scope: string,
  actor: string,
  route: string,
  key: string,
): Promise<ReceiptRow | null> {
  return db.prepare(
    `SELECT id, request_sha256, response_status, response_body FROM idempotency_keys
     WHERE console_organization_id = ? AND scope = ? AND actor = ? AND route = ? AND idem_key = ?`,
  ).bind(consoleOrganizationId, scope, actor, route, key).first<ReceiptRow>();
}

/** SHA-256 over the method, the concrete path and the canonical body (the ledger rules). */
export function requestSha256(route: string, path: string, body: unknown): string {
  const method = route.split(" ")[0] ?? "POST";
  return engine.sha256Hex(engine.canonicalJson({ method, path, body }));
}

function compareReceipt(receipt: ReceiptRow, hash: string): { status: number; body: string } {
  if (receipt.request_sha256 !== hash) throw conflict("idempotency_key_reused", "Idempotency-Key was already used for a different request");
  return { status: receipt.response_status, body: receipt.response_body };
}

/** The receipt column holds at most 64 KiB (CHECK): a huge vesting table is summarized rather than failing the batch. */
const RECEIPT_LIMIT = 65_000;

function fitReceipt(result: api.CommandResult): api.CommandResult {
  if (JSON.stringify(result).length <= RECEIPT_LIMIT) return result;
  return {
    ...result,
    changes: result.changes.map((change) =>
      change.entity === "vesting" && change.after && Array.isArray(change.after.events)
        ? { ...change, after: { events: [], eventCount: (change.after.events as unknown[]).length } }
        : change,
    ),
  };
}

export function commandResult(ctx: CommandContext, evaluation: Evaluation, dryRun: boolean): api.CommandResult {
  const plan = evaluation.plan;
  return api.commandResultSchema.parse({
    commandId: dryRun ? null : plan.commandId,
    dryRun,
    ledgerSeq: dryRun ? ctx.ledger.seq : evaluation.lastSeq,
    ledgerHeadHash: dryRun ? ctx.ledger.headHash : evaluation.headHash,
    transactions: evaluation.transactions.map((tx) => ({
      id: dryRun ? null : tx.id,
      seq: dryRun ? null : tx.seq,
      type: tx.type,
      effectiveDate: tx.effectiveDate,
      securityId: tx.securityId,
      quantity: tx.quantity,
    })),
    created: plan.created,
    changes: evaluation.changes,
    diffSha256: evaluation.diffSha256,
    effectSha256: evaluation.effectSha256,
    dependencies: evaluation.dependencies.map((edge) => ({ commandId: edge.dependsOnCommandId, kind: edge.kind })),
    violations: evaluation.violations,
    warnings: evaluation.warnings,
    ...(plan.exercise !== undefined ? { exercise: plan.exercise } : {}),
    ...(plan.stakeholderMerge !== undefined ? { stakeholderMerge: plan.stakeholderMerge } : {}),
  });
}

async function auditRejection(ctx: CommandContext, name: string, error: LedgerError): Promise<void> {
  try {
    await insertAudit(ctx.db, {
      occurredAt: ctx.now,
      orgId: ctx.org.id,
      actorKind: ctx.actor.kind,
      actorUserId: ctx.actor.userId,
      actorEmail: ctx.actor.email,
      authMethod: ctx.actor.authMethod,
      action: "command.rejected",
      targetType: "command",
      result: "denied",
      reason: error.extra.reason ?? error.code,
      ip: ctx.actor.ip ?? null,
      userAgent: ctx.actor.userAgent ?? null,
      requestId: ctx.actor.requestId ?? null,
      details: {
        command: name,
        code: error.code,
        violations: (error.extra.violations ?? []).map((violation) => violation.code),
        warnings: (error.extra.warnings ?? []).map((warning) => warning.code),
      },
    }).run();
  } catch (failure) {
    log("audit_write_failed", { action: "command.rejected", message: (failure as Error).name });
  }
}

/**
 * Runs a command. A dry run stops after the engine (command processing step 7). A real call replays a matching receipt,
 * then requires the head the person reviewed, no violation, every warning acknowledged and the same diff, and commits
 * one batch; a lost race rolls back whole and maps to 409 (or the stored response for a same-key duplicate).
 */
export async function runCommand(
  ctx: CommandContext,
  request: CommandRequest,
  build: (ctx: CommandContext) => Promise<{ plan: CommandPlan; documents: CommandDocuments | null }>,
): Promise<CommandOutcome> {
  const scope = ctx.org.id;
  const hash = requestSha256(request.route, request.path, request.body);
  if (!request.dryRun && request.idempotencyKey !== null) {
    const receipt = await findReceipt(
      ctx.db, ctx.org.console_organization_id, scope, ctx.actor.receiptActor, request.route, request.idempotencyKey,
    );
    if (receipt) return { result: JSON.parse(receipt.response_body) as api.CommandResult, replay: compareReceipt(receipt, hash), evaluation: null };
  }
  const { plan, documents } = await build(ctx);
  const evaluation = evaluatePlan(ctx, plan);
  const reject = async (error: LedgerError): Promise<never> => {
    if (!request.dryRun) await auditRejection(ctx, plan.name, error);
    throw error;
  };
  if (!request.dryRun && request.expectedLedgerSeq !== null && request.expectedLedgerSeq !== ctx.ledger.seq) {
    await reject(conflict("stale_ledger", "The ledger moved since you reviewed this; review it again"));
  }
  const previewBlockedMerge = request.dryRun && plan.name === "merge-stakeholders";
  if (evaluation.violations.length > 0 && !previewBlockedMerge) await reject(invariantViolation(evaluation.violations));
  const result = commandResult(ctx, evaluation, request.dryRun);
  if (request.dryRun) return { result, replay: null, evaluation };
  const acknowledged = new Set(request.acknowledge);
  const unacknowledged = request.autoAcknowledge ? [] : evaluation.warnings.filter((warning) => !acknowledged.has(warning.code));
  if (unacknowledged.length > 0) await reject(warningsUnacknowledged(unacknowledged));
  if (request.expectedDiffSha256 !== null && request.expectedDiffSha256 !== evaluation.diffSha256) {
    await reject(conflict("state_changed", "What this command changes differs from what you reviewed; review it again"));
  }
  if (request.expectedEffectSha256 != null && request.expectedEffectSha256 !== evaluation.effectSha256) {
    await reject(conflict("state_changed", "What this command does differs from what you reviewed; review it again"));
  }
  if (request.idempotencyKey === null) throw new Error("A real command needs an idempotency key");
  const stored = fitReceipt(result);
  const body = JSON.stringify(stored);
  const batch = await commandBatch(ctx, evaluation, {
    receipt: {
      id: uuidv7(ctx.now),
      consoleOrganizationId: ctx.org.console_organization_id,
      scope,
      actor: ctx.actor.receiptActor,
      route: request.route,
      key: request.idempotencyKey,
      requestSha256: hash,
      status: 200,
      body,
      now: ctx.now,
    },
    expectedLedgerSeq: request.expectedLedgerSeq,
    commandResult: {
      created: plan.created,
      warnings: evaluation.warnings.map((warning) => warning.code),
      acknowledged: request.autoAcknowledge ? evaluation.warnings.map((warning) => warning.code) : [...acknowledged],
    },
    documents,
  });
  try {
    await ctx.db.batch(batch.statements.map((statement) => toPrepared(ctx.db, statement)));
  } catch (error) {
    const failure = classifyBatchFailure(error);
    if (failure?.kind === "idempotency" || failure === null) {
      // A concurrent duplicate with the same key committed first: answer with its stored response.
      const raced = await findReceipt(
        ctx.db, ctx.org.console_organization_id, scope, ctx.actor.receiptActor, request.route, request.idempotencyKey,
      );
      if (raced) return { result: JSON.parse(raced.response_body) as api.CommandResult, replay: compareReceipt(raced, hash), evaluation: null };
    }
    if (failure === null || failure.kind === "idempotency") {
      log("ledger_batch_failed", { command: plan.name, orgId: ctx.org.id, extended: extendedCode(error) });
      throw error;
    }
    if (failure.kind === "unavailable") await reject(new LedgerError("unavailable", failure.message));
    if (failure.kind === "violation") await reject(invariantViolation([{ code: failure.code, message: failure.message }]));
    if (failure.kind === "conflict") await reject(conflict(failure.reason, failure.message));
    throw error;
  }
  ledgerCache().delete(ctx.ledger.key);
  return { result: stored, replay: null, evaluation };
}
