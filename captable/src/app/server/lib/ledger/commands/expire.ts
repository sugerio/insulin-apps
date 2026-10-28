import { engine } from "#shared";
import { notFound } from "../../http.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { assertNotSelfDealing, currentState, newPlan, violation } from "./common.ts";

/** Expiry candidates of the org on its today (the ledger rules): options past their last exercise day, warrants past expiry. */
export function expiryCandidatesToday(ctx: CommandContext): engine.ExpiryCandidate[] {
  return engine.expiryCandidates(currentState(ctx), ctx.today);
}

export interface ExpiryProposal {
  securityId: string;
  displayId: string;
  reason: engine.ExpiryCandidate["reason"];
  lastExerciseDate: string;
  effectiveDate: string;
  quantity: string;
}

export function proposalOf(ctx: CommandContext, candidate: engine.ExpiryCandidate): ExpiryProposal {
  const displayId = ctx.ledger.reference.securities.find((s) => s.id === candidate.securityId)?.displayId ?? candidate.securityId;
  return {
    securityId: candidate.securityId,
    displayId,
    reason: candidate.reason,
    lastExerciseDate: candidate.lastExerciseDate,
    effectiveDate: candidate.effectiveDate,
    quantity: candidate.quantity.toString(),
  };
}

/**
 * expire-securities (the API contract): one command per security, cancelling what is left with reason EXPIRED, effective
 * the day after the last exercise day. The engine records its `relies_on_deadline` edge on the termination or
 * extension that set the deadline, so that command can't be reversed while the expiry stands.
 */
export async function planExpiry(ctx: CommandContext, securityId: string): Promise<{ plan: CommandPlan; documents: null }> {
  const candidate = expiryCandidatesToday(ctx).find((c) => c.securityId === securityId);
  const state = currentState(ctx);
  const security = state.securities.get(securityId);
  if (!security) throw notFound("Security not found");
  // An administrator confirming a report-only run acts as a person: never on their own holdings.
  await assertNotSelfDealing(ctx, [security.identity.stakeholderId]);
  const plan = newPlan(ctx, "expire-securities");
  plan.codeMap = { LOT_CLOSED: "SECURITY_NOT_OUTSTANDING", NOT_ISSUED: "SECURITY_NOT_OUTSTANDING" };
  if (!candidate) {
    plan.violations.push(violation("NOT_EXPIRABLE", `${security.identity.displayId} is not past its last exercise day, or has nothing outstanding`, { securityId }));
    plan.transactions.push({
      type: security.identity.family === "WARRANT" ? "TX_WARRANT_CANCELLATION" : "TX_EQUITY_COMPENSATION_CANCELLATION",
      effectiveDate: ctx.today,
      payload: { security_id: securityId, quantity: security.outstanding.isPositive() ? security.outstanding.toString() : "1", reason_text: "Expired", x_reason: "EXPIRED" },
    });
    return { plan, documents: null };
  }
  plan.transactions.push({
    type: security.identity.family === "WARRANT" ? "TX_WARRANT_CANCELLATION" : "TX_EQUITY_COMPENSATION_CANCELLATION",
    effectiveDate: candidate.effectiveDate,
    payload: {
      security_id: securityId,
      quantity: candidate.quantity.toString(),
      reason_text: candidate.reason === "contractual_deadline" ? "Expired after the exercise window" : "Expired at the end of its term",
      x_reason: "EXPIRED",
    },
  });
  plan.audit = {
    summary: `${security.identity.displayId} expired`,
    targetType: "security",
    targetId: securityId,
    details: { securityId, reason: candidate.reason, lastExerciseDate: candidate.lastExerciseDate },
  };
  return { plan, documents: null };
}
