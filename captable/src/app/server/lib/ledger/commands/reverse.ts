import { api, engine } from "#shared";
import { notFound } from "../../http.ts";
import { conflict, invariantViolation, type Dependent } from "../errors.ts";
import { evaluatePlan } from "../evaluate.ts";
import { stmt } from "../statements.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { assertConfirmation, assertNotSelfDealing, currentState, newPlan, violation } from "./common.ts";

/** Every causal edge of the org (`command_dependencies`). */
export async function loadEdges(db: D1Database, orgId: string, dependsOn?: readonly string[]): Promise<engine.DependencyEdge[]> {
  // `dependsOn` narrows the read to the edges into those commands (their direct dependents: what blocks a reversal).
  const { results } = await (dependsOn === undefined
    ? db.prepare("SELECT command_id, depends_on_command_id, kind FROM command_dependencies WHERE org_id = ?").bind(orgId)
    : db.prepare(
      "SELECT command_id, depends_on_command_id, kind FROM command_dependencies WHERE org_id = ? AND depends_on_command_id IN (SELECT value FROM json_each(?))",
    ).bind(orgId, JSON.stringify(dependsOn))
  ).all<{ command_id: string; depends_on_command_id: string; kind: engine.DependencyKind }>();
  return results.map((row) => ({ commandId: row.command_id, dependsOnCommandId: row.depends_on_command_id, kind: row.kind }));
}

/**
 * Reversible commands: an exercise with its resulting shares, a grant, a termination
 * (an applied scheduled one included), a cancellation, Mark executed and stakeholder merge. Leaves, extensions, plan terms and expiries are
 * facts are corrected by recording them again, never by reversal; a reversal can't be reversed and imported history isn't
 * reversible in the app (their own refusals).
 */
export const REVERSIBLE_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "exercise-option",
  "grant-equity-compensation",
  "terminate-stakeholder",
  "cancel-security",
  "mark-executed",
  "merge-stakeholders",
]);

export type ReversalBlock = engine.ReversalRefusal | "not_reversible";

export interface ReversalAnalysis {
  target: engine.LedgerCommand;
  refusal: ReversalBlock | null;
  /** The standing commands to reverse first, newest first, with the strongest edge that ties each to the chain. */
  closure: { command: engine.LedgerCommand; kind: engine.DependencyKind }[];
  workflowEffects: api.ReversalPreview["workflowEffects"];
}

/**
 * What a reverse-command's typed confirmation accepts (the product rules): the label of the command's main object, the
 * first one shown being the one the UI asks for: the stakeholder of a termination, otherwise the security of its first
 * transaction (the option exercised, the grant, the lot cancelled, the grant marked executed). The command id is always
 * accepted too. Only reversible types get here (`REVERSIBLE_COMMAND_TYPES`).
 */
function confirmationLabels(ctx: CommandContext, target: engine.LedgerCommand, transactions: readonly engine.LedgerTransaction[], stakeholderNames: Map<string, string>): string[] {
  const ordered = [...transactions].sort((a, b) => a.seq - b.seq);
  const labels: string[] = [];
  const person = ordered.find((tx) => tx.type === "X_STAKEHOLDER_TERMINATION" && tx.stakeholderId !== null);
  const name = person?.stakeholderId ? stakeholderNames.get(person.stakeholderId) : undefined;
  if (name) labels.push(name);
  const merge = ordered.find((tx) => tx.type === "X_STAKEHOLDER_MERGE");
  if (merge?.type === "X_STAKEHOLDER_MERGE") {
    const mergedName = stakeholderNames.get(merge.payload.merged_stakeholder_id);
    if (mergedName) labels.push(mergedName);
  }
  const securityId = ordered.find((tx) => tx.securityId !== null)?.securityId;
  const security = securityId ? ctx.ledger.reference.securities.find((s) => s.id === securityId) : undefined;
  if (security) labels.push(security.displayId);
  labels.push(target.id);
  return labels;
}

/**
 * reverse-command (the API contract; the ledger rules): one X_REVERSAL per transaction of the target, newest first, in one batch.
 * The triggers refuse a reversal of a reversal, of migrated history, or while a dependent command stands; the engine
 * refuses one that breaks an invariant at any date. Workflow follows: a reversed termination restores the
 * relationship its payload kept, and any linked completed exercise request becomes REVERSED.
 */
export async function planReversal(
  ctx: CommandContext,
  body: { commandId: string; note: string; confirmation: string },
  options: { confirm: boolean; enforceRefusal: boolean },
): Promise<{ plan: CommandPlan; analysis: ReversalAnalysis }> {
  const target = ctx.ledger.commands.get(body.commandId);
  if (!target) throw notFound("Command not found");
  const edges = await loadEdges(ctx.db, ctx.org.id);
  const commands = ctx.ledger.reference.commands;
  const engineRefusal = engine.reversalRefusal(target.id, edges, commands);
  // The trigger's refusals come first (a reversal, already reversed, imported); then the reversible list; then dependents.
  const refusal: ReversalBlock | null = engineRefusal === "is_reversal" || engineRefusal === "already_reversed" || engineRefusal === "migrated_history"
    ? engineRefusal
    : REVERSIBLE_COMMAND_TYPES.has(target.type) ? engineRefusal : "not_reversible";
  const closureCommands = engine.dependentClosure(target.id, edges, commands);
  const chain = new Set([target.id, ...closureCommands.map((c) => c.id)]);
  const closure = closureCommands.map((command) => {
    let kind: engine.DependencyKind = "relies_on_terms";
    for (const edge of edges) {
      if (edge.commandId === command.id && chain.has(edge.dependsOnCommandId) && engine.DEPENDENCY_STRENGTH[edge.kind] > engine.DEPENDENCY_STRENGTH[kind]) kind = edge.kind;
    }
    return { command, kind };
  });
  if (options.enforceRefusal && refusal !== null) {
    if (refusal === "migrated_history") throw conflict("migrated_history", "Migrated history can't be reversed in the app; a counsel-approved import corrects it");
    if (refusal === "not_reversible") {
      throw invariantViolation([{
        code: "COMMAND_NOT_REVERSIBLE",
        message: `A ${target.type} command can't be reversed in the app: only an exercise, a grant, a termination, a cancellation, Mark executed or stakeholder merge can`,
      }]);
    }
    if (refusal === "dependents_exist") {
      const dependents: Dependent[] = closure.map(({ command }) => ({ commandId: command.id, type: command.type, createdAt: command.createdAt }));
      throw conflict("dependents_exist", "Reverse the dependent commands first, newest first", dependents);
    }
    throw conflict("state_changed", refusal === "is_reversal" ? "A reversal can't be reversed; record the facts again instead" : "This command is already reversed");
  }
  const transactions = ctx.ledger.transactions.filter((tx) => tx.commandId === target.id).sort((a, b) => b.seq - a.seq);
  const current = currentState(ctx);
  const stakeholderIds = new Set<string>();
  for (const tx of transactions) {
    if (tx.stakeholderId !== null) stakeholderIds.add(tx.stakeholderId);
    if (tx.securityId !== null) {
      const holder = current.securities.get(tx.securityId)?.identity.stakeholderId
        ?? ctx.ledger.reference.securities.find((s) => s.id === tx.securityId)?.stakeholderId;
      if (holder) stakeholderIds.add(holder);
    }
    if (tx.type === "X_STAKEHOLDER_MERGE") {
      stakeholderIds.add(tx.payload.merged_stakeholder_id);
      stakeholderIds.add(tx.payload.surviving_stakeholder_id);
    }
  }
  await assertNotSelfDealing(ctx, [...stakeholderIds]);
  const stakeholderRows = stakeholderIds.size === 0 ? [] : (await ctx.db.prepare(
    `SELECT id, display_name, relationship, issuer_assigned_id, archived_at, merged_into_id, merged_by_command_id, version
     FROM stakeholders WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))`,
  ).bind(ctx.org.id, JSON.stringify([...stakeholderIds])).all<{
    id: string; display_name: string; relationship: engine.Relationship; issuer_assigned_id: string | null;
    archived_at: number | null; merged_into_id: string | null; merged_by_command_id: string | null; version: number;
  }>()).results;
  const names = new Map(stakeholderRows.map((row) => [row.id, row.display_name]));
  if (options.confirm) assertConfirmation(body.confirmation, confirmationLabels(ctx, target, transactions, names));

  const plan = newPlan(ctx, "reverse-command");
  plan.reversesCommandId = target.id;
  plan.note = body.note;
  plan.ignoredEngineWarnings = ["PLAN_TERMS_MISSING"];
  for (const tx of transactions) {
    plan.transactions.push({ type: "X_REVERSAL", effectiveDate: ctx.today, payload: { reverses_tx_id: tx.id } });
  }
  const workflowEffects: api.ReversalPreview["workflowEffects"] = [];
  for (const tx of transactions) {
    if (tx.type !== "X_STAKEHOLDER_TERMINATION") continue;
    const row = stakeholderRows.find((r) => r.id === tx.payload.stakeholder_id);
    if (!row || row.relationship === tx.payload.relationship_before) continue;
    workflowEffects.push({ kind: "stakeholder_relationship", id: row.id, from: row.relationship, to: tx.payload.relationship_before });
    plan.workflow.push(stmt(
      "UPDATE stakeholders SET relationship = ?, version = ?, updated_at = ? WHERE org_id = ? AND id = ?",
      tx.payload.relationship_before, row.version + 1, ctx.now, ctx.org.id, row.id,
    ));
    plan.extraChanges.push({ entity: "stakeholder", id: row.id, before: { relationship: row.relationship }, after: { relationship: tx.payload.relationship_before } });
  }
  for (const tx of transactions) {
    if (tx.type !== "X_STAKEHOLDER_MERGE") continue;
    const merged = stakeholderRows.find((row) => row.id === tx.payload.merged_stakeholder_id);
    const survivor = stakeholderRows.find((row) => row.id === tx.payload.surviving_stakeholder_id);
    if (!merged) continue;
    if (merged.archived_at === null || merged.merged_into_id !== tx.payload.surviving_stakeholder_id || merged.merged_by_command_id !== target.id) {
      plan.violations.push(violation("STAKEHOLDER_UNMERGE_BLOCKED", "The merged-record pointer no longer matches this merge command"));
    }
    if (survivor && survivor.merged_into_id !== null) {
      plan.violations.push(violation("STAKEHOLDER_UNMERGE_BLOCKED", "The surviving record was later merged into another record; undo that merge first"));
    }
    if (merged.issuer_assigned_id !== null) {
      const collision = await ctx.db.prepare(
        `SELECT id FROM stakeholders WHERE org_id = ? AND id <> ? AND archived_at IS NULL AND issuer_assigned_id = ? LIMIT 1`,
      ).bind(ctx.org.id, merged.id, merged.issuer_assigned_id).first<{ id: string }>();
      if (collision) plan.violations.push(violation(
        "STAKEHOLDER_UNMERGE_BLOCKED",
        "The merged record's issuer-assigned ID is now used by an active record; change it before undoing the merge",
      ));
    }
    const { results: moves } = await ctx.db.prepare(
      `SELECT m.kind, m.row_id, m.action,
              dl.stakeholder_id AS document_holder, dl.revoked_at,
              al.stakeholder_id AS admin_holder, al.removed_at, al.email
       FROM stakeholder_merge_link_moves m
       LEFT JOIN document_links dl ON m.kind = 'document_link' AND dl.org_id = m.org_id AND dl.id = m.row_id
       LEFT JOIN admin_stakeholder_links al ON m.kind = 'admin_link' AND al.org_id = m.org_id AND al.id = m.row_id
       WHERE m.org_id = ? AND m.command_id = ? ORDER BY m.kind, m.row_id`,
    ).bind(ctx.org.id, target.id).all<{
      kind: "admin_link" | "document_link"; row_id: string; action: "moved" | "deduplicated";
      document_holder: string | null; revoked_at: number | null;
      admin_holder: string | null; removed_at: number | null; email: string | null;
    }>();
    for (const move of moves) {
      if (move.kind === "document_link") {
        if (move.revoked_at !== null) continue;
        if (move.document_holder !== tx.payload.surviving_stakeholder_id) {
          plan.violations.push(violation("STAKEHOLDER_UNMERGE_BLOCKED", `Document link ${move.row_id} no longer belongs to the surviving record`));
          continue;
        }
        plan.workflow.push(stmt(
          "UPDATE document_links SET stakeholder_id = ? WHERE org_id = ? AND id = ? AND stakeholder_id = ? AND revoked_at IS NULL",
          merged.id, ctx.org.id, move.row_id, tx.payload.surviving_stakeholder_id,
        ));
      } else if (move.action === "moved") {
        if (move.removed_at !== null) continue;
        if (move.admin_holder !== tx.payload.surviving_stakeholder_id) {
          plan.violations.push(violation("STAKEHOLDER_UNMERGE_BLOCKED", `Administrator link ${move.row_id} no longer belongs to the surviving record`));
          continue;
        }
        plan.workflow.push(stmt(
          "UPDATE admin_stakeholder_links SET stakeholder_id = ? WHERE org_id = ? AND id = ? AND stakeholder_id = ? AND removed_at IS NULL",
          merged.id, ctx.org.id, move.row_id, tx.payload.surviving_stakeholder_id,
        ));
      } else {
        const collision = move.email === null ? null : await ctx.db.prepare(
          `SELECT id FROM admin_stakeholder_links WHERE org_id = ? AND stakeholder_id = ? AND email = ? AND removed_at IS NULL LIMIT 1`,
        ).bind(ctx.org.id, merged.id, move.email).first<{ id: string }>();
        if (collision) {
          plan.violations.push(violation("STAKEHOLDER_UNMERGE_BLOCKED", `Administrator link ${move.row_id} now conflicts with another live link`));
          continue;
        }
        plan.workflow.push(stmt("UPDATE admin_stakeholder_links SET removed_at = NULL, removed_by = NULL WHERE org_id = ? AND id = ?", ctx.org.id, move.row_id));
      }
    }
    plan.workflow.push(stmt(
      `UPDATE stakeholders SET archived_at = NULL, merged_into_id = NULL, merged_at = NULL, merged_by_command_id = NULL,
         version = version + 1, updated_at = ? WHERE org_id = ? AND id = ? AND merged_by_command_id = ?`,
      ctx.now, ctx.org.id, merged.id, target.id,
    ));
    plan.workflow.push(stmt(
      "INSERT INTO batch_assertions (ok) SELECT EXISTS (SELECT 1 FROM stakeholders WHERE org_id = ? AND id = ? AND archived_at IS NULL AND merged_into_id IS NULL AND merged_by_command_id IS NULL)",
      ctx.org.id, merged.id,
    ));
    plan.extraChanges.push({
      entity: "stakeholder", id: merged.id,
      before: { archived: true, mergedIntoId: tx.payload.surviving_stakeholder_id },
      after: { archived: false, mergedIntoId: null },
    });
  }
  const { results: requests } = await ctx.db.prepare(
    "SELECT id, version FROM exercise_requests WHERE org_id = ? AND completed_command_id = ? AND status = 'EXERCISED' AND pulley_id IS NULL",
  ).bind(ctx.org.id, target.id).all<{ id: string; version: number }>();
  for (const request of requests) {
    workflowEffects.push({ kind: "exercise_request", id: request.id, from: "EXERCISED", to: "REVERSED" });
    plan.workflow.push(stmt(
      "UPDATE exercise_requests SET status = 'REVERSED', version = ?, updated_at = ? WHERE org_id = ? AND id = ?",
      request.version + 1, ctx.now, ctx.org.id, request.id,
    ));
  }
  plan.audit = {
    summary: `${target.type} reversed`,
    targetType: "command",
    targetId: target.id,
    details: { reversesCommandId: target.id, reversedType: target.type, transactionCount: transactions.length },
  };
  return { plan, analysis: { target, refusal, closure, workflowEffects } };
}

/** The reversal preview (the API contract): what reversing the command would append, block and change, with its diff hash. */
export async function reversalPreview(ctx: CommandContext, commandId: string): Promise<api.ReversalPreview> {
  const { plan, analysis } = await planReversal(ctx, { commandId, note: "Preview", confirmation: "" }, { confirm: false, enforceRefusal: false });
  const evaluation = evaluatePlan(ctx, plan);
  const reversed = new Map(ctx.ledger.transactions.map((tx) => [tx.id, tx]));
  return api.reversalPreviewSchema.parse({
    commandId: analysis.target.id,
    commandType: analysis.target.type,
    importedFromPulley: analysis.target.actorKind === "import",
    inverse: plan.transactions.map((draft) => {
      const original = reversed.get(draft.payload.reverses_tx_id as string)!;
      return { reversesTransactionId: original.id, type: original.type, effectiveDate: original.effectiveDate };
    }),
    dependents: analysis.closure.map(({ command, kind }) => ({ commandId: command.id, type: command.type, createdAt: command.createdAt, kind })),
    changes: evaluation.changes,
    workflowEffects: analysis.workflowEffects,
    violations: evaluation.violations,
    blocked: analysis.refusal !== null || evaluation.violations.length > 0,
    diffSha256: evaluation.diffSha256,
    ledgerSeq: ctx.ledger.seq,
  });
}
