import type { CommandDocuments } from "./documents.ts";
import type { Evaluation } from "./evaluate.ts";
import {
  auditInsert,
  commandInsert,
  dependencyInsert,
  prepare,
  receiptInsert,
  sealAssertions,
  securityInsert,
  transactionInsert,
  vestingTermsInsert,
  type ReceiptValues,
  type Stmt,
} from "./statements.ts";
import type { BatchStatement, CommandContext } from "./types.ts";
import { engine } from "#shared";

/**
 * The batch layout of a command (command processing step 5), in order: receipt → command (claims the seqs) → security
 * identities and vesting rows → transactions (sequence and chain triggers advance the head) → dependencies →
 * workflow transitions → document links → audit → the seal. D1 runs a batch as one SQL
 * transaction, so any failing statement, trigger or assertion rolls all of it back.
 */
export interface BatchOptions {
  receipt: ReceiptValues;
  expectedLedgerSeq: number | null;
  /** `commands.result`: created ids and acknowledged warnings. */
  commandResult: Record<string, unknown>;
  documents: CommandDocuments | null;
}

export interface CommandBatch {
  statements: BatchStatement[];
}

export function isStmt(statement: BatchStatement): statement is Stmt {
  return typeof (statement as Stmt).sql === "string" && Array.isArray((statement as Stmt).params);
}

export function toPrepared(db: D1Database, statement: BatchStatement): D1PreparedStatement {
  return isStmt(statement) ? prepare(db, statement) : statement;
}

export async function commandBatch(ctx: CommandContext, evaluation: Evaluation, options: BatchOptions): Promise<CommandBatch> {
  const plan = evaluation.plan;
  const orgId = ctx.org.id;
  const statements: BatchStatement[] = [receiptInsert(options.receipt)];
  statements.push(commandInsert({
    id: plan.commandId,
    orgId,
    type: plan.name,
    receiptId: options.receipt.id,
    requestSha256: options.receipt.requestSha256,
    actorKind: ctx.actor.kind,
    actorUserId: ctx.actor.kind === "user" ? ctx.actor.userId : null,
    authMethod: ctx.actor.authMethod,
    note: plan.note,
    reversesCommandId: plan.reversesCommandId,
    expectedLedgerSeq: options.expectedLedgerSeq,
    declaredTxCount: evaluation.rows.length,
    firstSeq: evaluation.firstSeq,
    lastSeq: evaluation.lastSeq,
    result: JSON.stringify(options.commandResult),
    now: ctx.now,
  }));
  for (const security of plan.securities) {
    statements.push(securityInsert(orgId, security, {
      now: ctx.now,
      pulleyId: plan.securityProvenance?.get(security.id)?.pulleyId ?? null,
    }));
  }
  for (const terms of plan.vestingTerms) {
    statements.push(vestingTermsInsert({
      id: terms.id,
      orgId,
      name: terms.name,
      definition: engine.canonicalJson(terms.definition),
      definitionSha256: terms.definitionSha256,
      createdBy: ctx.actor.userId,
      now: ctx.now,
    }));
  }
  for (const row of evaluation.rows) statements.push(transactionInsert(row));
  for (const edge of evaluation.dependencies) statements.push(dependencyInsert(orgId, edge));
  statements.push(...plan.workflow);
  if (options.documents && plan.documents.length > 0) {
    statements.push(...await options.documents.statements(plan.documents, {
      now: ctx.now,
      actorUserId: ctx.actor.userId,
      transactionIds: evaluation.transactions.map((tx) => tx.id),
    }));
  }
  statements.push(auditInsert({
    occurredAt: ctx.now,
    orgId,
    actorKind: ctx.actor.kind,
    actorUserId: ctx.actor.userId,
    actorEmail: ctx.actor.email,
    authMethod: ctx.actor.authMethod,
    action: `command.${plan.name}`,
    targetType: plan.audit.targetType,
    targetId: plan.audit.targetId,
    result: "success",
    ip: ctx.actor.ip ?? null,
    userAgent: ctx.actor.userAgent ?? null,
    requestId: ctx.actor.requestId ?? null,
    details: {
      summary: plan.audit.summary,
      commandId: plan.commandId,
      firstSeq: evaluation.firstSeq,
      lastSeq: evaluation.lastSeq,
      transactionCount: evaluation.rows.length,
      ...plan.audit.details,
    },
  }));
  statements.push(...sealAssertions(orgId, plan.commandId, evaluation.rows.length, plan.reversesCommandId));
  return { statements };
}
