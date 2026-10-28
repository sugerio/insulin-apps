import { api, engine } from "#shared";
import { CommandDocuments } from "../documents.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { assertConfirmation, assertNotSelfDealing, currentState, holderOfTarget, isOptionOrWarrant, newPlan, securityOr404, violation } from "./common.ts";

export type CancelFields = Omit<api.CancelSecurity, "expectedLedgerSeq" | "expectedDiffSha256">;

const REASON_TEXT: Record<api.CancelSecurity["reason"], string> = {
  HOLDER_WAIVER: "Holder waiver",
  NOT_EXECUTED: "Not executed",
  MUTUAL_AGREEMENT: "Mutual agreement",
  FORFEITURE_UNDER_AGREEMENT: "Forfeiture under the agreement",
};

/**
 * cancel-security (the API contract; the product rules): options and warrants only, with a typed reason and its document;
 * the quantity defaults to everything outstanding. Shares are never cancelled, and a data error is reversed instead.
 */
export async function planCancel(ctx: CommandContext, body: CancelFields, options: { confirm: boolean }): Promise<{ plan: CommandPlan; documents: CommandDocuments }> {
  const state = currentState(ctx);
  const security = securityOr404(state, body.securityId);
  await assertNotSelfDealing(ctx, [security.identity.stakeholderId]);
  if (options.confirm) assertConfirmation(body.confirmation, [security.identity.displayId]);
  const plan = newPlan(ctx, "cancel-security");
  plan.codeMap = {
    FUTURE_EFFECTIVE_DATE: "EFFECTIVE_DATE_IN_FUTURE",
    LOT_CLOSED: "SECURITY_NOT_OUTSTANDING",
    NOT_ISSUED: "SECURITY_NOT_OUTSTANDING",
    NEGATIVE_POSITION: "EXCEEDS_OUTSTANDING",
  };
  plan.note = body.note ?? null;
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  const family = security.identity.family;
  if (!isOptionOrWarrant(security)) {
    plan.violations.push(violation("NOT_OPTION_OR_WARRANT", "Only options and warrants are cancelled; reverse a wrongly recorded share instead", { securityId: security.identity.id }));
  }
  if (!security.issued || security.closedBy !== null || !security.outstanding.isPositive()) {
    plan.violations.push(violation("SECURITY_NOT_OUTSTANDING", `${security.identity.displayId} has nothing outstanding to cancel`, { securityId: security.identity.id }));
  }
  if (body.effectiveDate > ctx.today) plan.violations.push(violation("EFFECTIVE_DATE_IN_FUTURE", "A cancellation can't be dated in the future"));
  const quantity = body.quantity ?? (security.outstanding.isPositive() ? security.outstanding.toString() : "1");
  if (engine.Dec.parse(quantity).gt(security.outstanding)) {
    plan.violations.push(violation("EXCEEDS_OUTSTANDING", `Cancels ${quantity} of ${security.outstanding} outstanding`, { securityId: security.identity.id }));
  }
  await documents.require(body.documentId);
  await documents.requireAll(body.documentIds);
  const reasonText = body.reasonText !== undefined && body.reasonText.trim() !== "" ? body.reasonText.trim() : REASON_TEXT[body.reason];
  plan.transactions.push({
    type: family === "WARRANT" ? "TX_WARRANT_CANCELLATION" : "TX_EQUITY_COMPENSATION_CANCELLATION",
    effectiveDate: body.effectiveDate,
    payload: {
      security_id: security.identity.id,
      quantity,
      reason_text: reasonText,
      x_reason: body.reason,
      x_document: documents.ref(body.documentId),
    },
  });
  plan.documents.push({ documentId: body.documentId, role: "EVIDENCE", target: { type: "security", id: security.identity.id } });
  for (const documentId of body.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(state, [])));
  plan.audit = {
    summary: `${security.identity.displayId} cancelled`,
    targetType: "security",
    targetId: security.identity.id,
    details: { securityId: security.identity.id, reason: body.reason },
  };
  return { plan, documents };
}
