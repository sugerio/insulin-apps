import { api, engine } from "#shared";
import { CommandDocuments } from "../documents.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { assertConfirmation, assertNotSelfDealing, currentState, holderOfTarget, isOptionOrWarrant, newPlan, securityOr404, violation } from "./common.ts";

export type ExtendFields = Omit<api.ExtendExerciseDeadline, "expectedLedgerSeq" | "expectedDiffSha256">;

/**
 * extend-exercise-deadline: a counsel-approved extension of the contractual deadline,
 * recorded today. It must lengthen the deadline and stay within the expiration date; the ISO deadline never moves,
 * so an ISO grant gets the modification-risk warning for counsel.
 */
export async function planExtension(ctx: CommandContext, body: ExtendFields, options: { confirm: boolean }): Promise<{ plan: CommandPlan; documents: CommandDocuments }> {
  const state = currentState(ctx);
  const security = securityOr404(state, body.securityId);
  await assertNotSelfDealing(ctx, [security.identity.stakeholderId]);
  if (options.confirm) assertConfirmation(body.confirmation, [security.identity.displayId]);
  const plan = newPlan(ctx, "extend-exercise-deadline");
  plan.codeMap = { LOT_CLOSED: "SECURITY_NOT_OUTSTANDING", NOT_ISSUED: "SECURITY_NOT_OUTSTANDING" };
  plan.note = body.note;
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  if (!isOptionOrWarrant(security)) {
    plan.violations.push(violation("NOT_OPTION_OR_WARRANT", "Only options and warrants have an exercise deadline", { securityId: security.identity.id }));
  }
  const current = engine.contractualDeadline(security);
  if (current !== null && body.newContractualDeadline <= current.date) {
    plan.violations.push(violation("EXTENSION_SHORTENS_DEADLINE", `The new deadline must be after the current one (${current.date})`, { securityId: security.identity.id }));
  }
  if (security.expirationDate !== null && body.newContractualDeadline > security.expirationDate) {
    plan.violations.push(violation("EXTENSION_AFTER_EXPIRATION", `The new deadline can't be after the expiration date (${security.expirationDate})`, { securityId: security.identity.id }));
  }
  if (security.identity.subtype === "OPTION_ISO") {
    plan.warnings.push({ code: "ISO_MODIFICATION_RISK", message: "Extending an ISO's exercise window may modify the ISO; counsel decides", details: { securityId: security.identity.id } });
  }
  await documents.require(body.documentId);
  await documents.requireAll(body.documentIds);
  plan.transactions.push({
    type: "X_SECURITY_MODIFICATION",
    effectiveDate: ctx.today,
    payload: {
      kind: "CONTRACTUAL_DEADLINE_EXTENSION",
      security_id: security.identity.id,
      new_contractual_deadline: body.newContractualDeadline,
      document: documents.ref(body.documentId),
      note: body.note,
    },
  });
  plan.documents.push({ documentId: body.documentId, role: "EVIDENCE", target: { type: "security", id: security.identity.id } });
  for (const documentId of body.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(state, [])));
  plan.audit = {
    summary: `${security.identity.displayId} exercise deadline extended`,
    targetType: "security",
    targetId: security.identity.id,
    details: { securityId: security.identity.id, newContractualDeadline: body.newContractualDeadline },
  };
  return { plan, documents };
}
