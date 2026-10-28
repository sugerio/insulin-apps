import { engine } from "#shared";
import { ApiError } from "../../http.ts";
import { CommandDocuments } from "../documents.ts";
import { stmt } from "../statements.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import {
  assertNotSelfDealing,
  currentState,
  holderOfTarget,
  isOptionOrWarrant,
  newPlan,
  securityOr404,
  stakeholderOr404,
  violation,
} from "./common.ts";

/** The termination fields of `terminate-stakeholder`, `schedule-termination` and a stored scheduled termination. */
export interface TerminationInput {
  stakeholderId: string;
  terminationDate: string;
  terminationType: engine.TerminationType;
  vestingStopDate?: string | undefined;
  disabilityAttestation?: boolean | undefined;
  relationshipAfter: engine.Relationship;
  accelerations: { securityId: string; quantity: string; reason: string; documentId: string }[];
  deadlineExtensions: { securityId: string; newContractualDeadline: string; documentId: string }[];
  repurchaseDeadlines: { securityId: string; lastRepurchaseDate: string; documentId: string }[];
  documentIds: string[];
  note?: string | undefined;
}

export type TerminationMode =
  | { kind: "immediate" }
  /** Validated at schedule time against today's ledger, as if the date had come (the API contract). */
  | { kind: "schedule" }
  /** Due processing applies a scheduled termination: the same command, plus the SCHEDULED → APPLIED transition. */
  | { kind: "apply"; scheduledTerminationId: string; version: number; createdBy: string | null };

/** The termination fields as stored on a scheduled termination (`scheduled_terminations.request`). */
export function terminationRequest(input: TerminationInput): Record<string, unknown> {
  return {
    stakeholderId: input.stakeholderId,
    terminationDate: input.terminationDate,
    terminationType: input.terminationType,
    vestingStopDate: input.vestingStopDate ?? input.terminationDate,
    ...(input.disabilityAttestation !== undefined ? { disabilityAttestation: input.disabilityAttestation } : {}),
    relationshipAfter: input.relationshipAfter,
    accelerations: input.accelerations,
    deadlineExtensions: input.deadlineExtensions,
    repurchaseDeadlines: input.repurchaseDeadlines,
    documentIds: input.documentIds,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}

function earliest(dates: (string | null)[]): string | undefined {
  const present = dates.filter((date): date is string => date !== null).sort();
  return present[0];
}

/**
 * terminate-stakeholder (the API contract; the product rules): the termination fact, the unvested remainder of every award
 * cancelled at the vesting stop, the chosen accelerations, extensions and repurchase dates; in the same batch the
 * relationship change and scheduled-workflow transition.
 */
export async function planTermination(
  ctx: CommandContext,
  input: TerminationInput,
  mode: TerminationMode,
): Promise<{ plan: CommandPlan; documents: CommandDocuments }> {
  await assertNotSelfDealing(ctx, [input.stakeholderId]);
  const stakeholder = await stakeholderOr404(ctx, input.stakeholderId);
  const plan = newPlan(ctx, "terminate-stakeholder");
  plan.note = input.note ?? null;
  plan.codeMap = { FUTURE_EFFECTIVE_DATE: "TERMINATION_DATE_IN_FUTURE" };
  plan.ignoredEngineWarnings = [];
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  const stop = input.vestingStopDate ?? input.terminationDate;
  if (mode.kind === "immediate" && input.terminationDate > ctx.today) {
    plan.violations.push(violation("TERMINATION_DATE_IN_FUTURE", "A future termination date is scheduled instead (schedule-termination)"));
  }
  if (mode.kind === "schedule" && input.terminationDate <= ctx.today) {
    plan.violations.push(violation("TERMINATION_DATE_NOT_IN_FUTURE", "A scheduled termination is after today; record a past or today's date as a termination"));
  }
  if (stop > input.terminationDate) {
    plan.violations.push(violation("VESTING_STOP_AFTER_TERMINATION", "The vesting stop can be earlier than the termination date, never later"));
  }
  // Scheduled terminations are previewed as of their date, so vesting up to then is counted (the API contract).
  const state = currentState(ctx, mode.kind === "schedule" && input.terminationDate > ctx.today ? input.terminationDate : ctx.today);
  const standing = state.stakeholders.get(stakeholder.id);
  if (standing && (standing.terminations.length > 0 || standing.laterTerminations.length > 0)) {
    plan.violations.push(violation("ALREADY_TERMINATED", "This stakeholder's termination is already recorded"));
  }
  if (mode.kind !== "apply") {
    const scheduled = await ctx.db.prepare(
      "SELECT termination_date FROM scheduled_terminations WHERE org_id = ? AND stakeholder_id = ? AND status = 'SCHEDULED'",
    ).bind(ctx.org.id, stakeholder.id).first<{ termination_date: string }>();
    if (scheduled) {
      plan.violations.push(violation("ALREADY_TERMINATED", `A termination is scheduled for ${scheduled.termination_date}; cancel it first`));
    }
  }
  const own = (securityId: string, path: string) => {
    const security = securityOr404(state, securityId);
    if (security.identity.stakeholderId !== stakeholder.id) {
      throw new ApiError("validation_failed", "That security belongs to another stakeholder", [{ path, message: "Choose one of this stakeholder's securities" }]);
    }
    return security;
  };
  const accelerations: Record<string, engine.Dec> = {};
  input.accelerations.forEach((acceleration, index) => {
    own(acceleration.securityId, `accelerations.${index}.securityId`);
    accelerations[acceleration.securityId] = (accelerations[acceleration.securityId] ?? engine.Dec.ZERO).add(engine.Dec.parse(acceleration.quantity));
  });
  input.deadlineExtensions.forEach((extension, index) => {
    if (!isOptionOrWarrant(own(extension.securityId, `deadlineExtensions.${index}.securityId`))) {
      plan.violations.push(violation("NOT_OPTION_OR_WARRANT", "Only options and warrants have an exercise deadline to extend", { securityId: extension.securityId }));
    }
  });
  input.repurchaseDeadlines.forEach((deadline, index) => own(deadline.securityId, `repurchaseDeadlines.${index}.securityId`));

  const effects = engine.terminationPreview(state, stakeholder.id, {
    terminationDate: input.terminationDate,
    terminationType: input.terminationType,
    vestingStopDate: stop,
    disabilityAttestation: input.disabilityAttestation === true,
    accelerations,
  });
  for (const effect of effects) {
    if (effect.blockedBy === "stop_before_issue") {
      plan.violations.push(violation("VESTING_STOP_BEFORE_ISSUE", "The vesting stop is before this grant was issued", { securityId: effect.securityId }));
    }
    const requested = accelerations[effect.securityId];
    if (requested && requested.gt(effect.acceleration)) {
      plan.violations.push(violation("ACCELERATION_EXCEEDS_UNVESTED", `Accelerates ${requested} with ${effect.acceleration} unvested at the stop`, { securityId: effect.securityId }));
    }
  }

  plan.transactions.push({
    type: "X_STAKEHOLDER_TERMINATION",
    effectiveDate: input.terminationDate,
    payload: {
      stakeholder_id: stakeholder.id,
      termination_date: input.terminationDate,
      termination_type: input.terminationType,
      vesting_stop_date: stop,
      ...(input.disabilityAttestation !== undefined ? { disability_attestation: input.disabilityAttestation } : {}),
      relationship_before: stakeholder.relationship,
      relationship_after: input.relationshipAfter,
    },
  });
  await documents.requireAll([
    ...input.accelerations.map((a) => a.documentId),
    ...input.deadlineExtensions.map((d) => d.documentId),
    ...input.repurchaseDeadlines.map((r) => r.documentId),
    ...input.documentIds,
  ]);
  for (const acceleration of input.accelerations) {
    plan.transactions.push({
      type: "TX_VESTING_ACCELERATION",
      effectiveDate: stop,
      payload: {
        security_id: acceleration.securityId,
        quantity: acceleration.quantity,
        reason_text: acceleration.reason,
        x_document: documents.ref(acceleration.documentId),
      },
    });
    plan.documents.push({ documentId: acceleration.documentId, role: "EVIDENCE", target: { type: "security", id: acceleration.securityId } });
  }
  for (const effect of effects) {
    if (effect.family !== "EQUITY_COMPENSATION" || !effect.cancel.isPositive() || effect.blockedBy !== null) continue;
    plan.transactions.push({
      type: "TX_EQUITY_COMPENSATION_CANCELLATION",
      effectiveDate: stop,
      payload: {
        security_id: effect.securityId,
        quantity: effect.cancel.toString(),
        reason_text: "Termination",
        x_reason: "TERMINATION",
        x_vesting_portion: "UNVESTED",
      },
    });
  }
  for (const extension of input.deadlineExtensions) {
    plan.transactions.push({
      type: "X_SECURITY_MODIFICATION",
      effectiveDate: input.terminationDate,
      payload: {
        kind: "CONTRACTUAL_DEADLINE_EXTENSION",
        security_id: extension.securityId,
        new_contractual_deadline: extension.newContractualDeadline,
        document: documents.ref(extension.documentId),
      },
    });
    plan.documents.push({ documentId: extension.documentId, role: "EVIDENCE", target: { type: "security", id: extension.securityId } });
  }
  const recorded = new Set(input.repurchaseDeadlines.map((r) => r.securityId));
  for (const deadline of input.repurchaseDeadlines) {
    plan.transactions.push({
      type: "X_SECURITY_MODIFICATION",
      effectiveDate: input.terminationDate,
      payload: {
        kind: "REPURCHASE_DEADLINE",
        security_id: deadline.securityId,
        last_repurchase_date: deadline.lastRepurchaseDate,
        document: documents.ref(deadline.documentId),
      },
    });
    plan.documents.push({ documentId: deadline.documentId, role: "EVIDENCE", target: { type: "security", id: deadline.securityId } });
  }
  // Restricted shares keep their unvested shares, repurchaseable until a date the agreement sets: without one recorded
  // anywhere the termination blocks until it is entered (the product rules).
  for (const effect of effects) {
    if (effect.family !== "STOCK" || !effect.unvestedShares.isPositive() || recorded.has(effect.securityId)) continue;
    const security = state.securities.get(effect.securityId)!;
    const plansDefault = engine.planTermsOn(state, security.identity.stockPlanId, input.terminationDate)?.defaultRepurchaseWindow ?? null;
    if (security.lastRepurchaseDate === null && (security.repurchaseRight?.window ?? null) === null && plansDefault === null) {
      plan.violations.push(violation("REPURCHASE_DEADLINE_NOT_RECORDED", `Enter the last repurchase date of ${security.identity.displayId} from its agreement`, { securityId: effect.securityId }));
    }
  }
  for (const documentId of input.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(state, [])));

  if (mode.kind !== "schedule") {
    if (stakeholder.relationship !== input.relationshipAfter) {
      plan.workflow.push(stmt(
        "UPDATE stakeholders SET relationship = ?, version = ?, updated_at = ? WHERE org_id = ? AND id = ?",
        input.relationshipAfter, stakeholder.version + 1, ctx.now, ctx.org.id, stakeholder.id,
      ));
    }
    if (mode.kind === "apply") {
      plan.workflow.push(stmt(
        "UPDATE scheduled_terminations SET status = 'APPLIED', applied_command_id = ?, version = ?, updated_at = ? WHERE org_id = ? AND id = ?",
        plan.commandId, mode.version + 1, ctx.now, ctx.org.id, mode.scheduledTerminationId,
      ));
    }
  }
  const cancelled = plan.transactions.filter((tx) => tx.type === "TX_EQUITY_COMPENSATION_CANCELLATION").length;
  plan.audit = {
    summary: mode.kind === "apply" ? "Scheduled termination applied" : "Termination recorded",
    targetType: "stakeholder",
    targetId: stakeholder.id,
    details: {
      stakeholderId: stakeholder.id,
      terminationType: input.terminationType,
      cancelledAwards: cancelled,
      ...(mode.kind === "apply" ? { scheduledTerminationId: mode.scheduledTerminationId } : {}),
    },
  };
  return { plan, documents };
}
