import type { api } from "#shared";
import { CommandDocuments } from "../documents.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { assertConfirmation, assertNotSelfDealing, currentState, holderOfTarget, newPlan, securityOr404, violation } from "./common.ts";

export type MarkExecutedFields = Omit<api.MarkExecuted, "expectedLedgerSeq" | "expectedDiffSha256">;

/**
 * mark-executed (the API contract; the product rules): an execution-pending grant becomes executed once the agreement
 * signed by both parties is attached. It is a ledger fact because execution gates exercise, so an administrator can
 * reverse it; the payload keeps the document's hash, the signature dates and the attestation. It takes effect on the
 * later signature date (or today when none is given), so an exercise on or after that date is no longer blocked.
 */
export async function planMarkExecuted(ctx: CommandContext, body: MarkExecutedFields, options: { confirm: boolean }): Promise<{ plan: CommandPlan; documents: CommandDocuments }> {
  const state = currentState(ctx);
  const security = securityOr404(state, body.securityId);
  await assertNotSelfDealing(ctx, [security.identity.stakeholderId]);
  if (options.confirm) assertConfirmation(body.confirmation, [security.identity.displayId]);
  const plan = newPlan(ctx, "mark-executed");
  plan.codeMap = { FUTURE_EFFECTIVE_DATE: "SIGNATURE_DATE_IN_FUTURE", LOT_CLOSED: "SECURITY_NOT_OUTSTANDING", NOT_ISSUED: "SECURITY_NOT_OUTSTANDING", BEFORE_ISSUE_DATE: "SIGNATURE_DATE_BEFORE_ISSUE" };
  plan.note = body.note ?? null;
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  if (!security.issued || security.closedBy !== null || !security.outstanding.isPositive()) {
    plan.violations.push(violation("SECURITY_NOT_OUTSTANDING", `${security.identity.displayId} is not outstanding`, { securityId: security.identity.id }));
  }
  if (!security.executionStatus.startsWith("pending")) {
    plan.violations.push(violation("NOT_EXECUTION_PENDING", `${security.identity.displayId} is not execution pending`, { securityId: security.identity.id }));
  }
  const signed = [body.signatureDates.company, body.signatureDates.holder].filter((date): date is string => date !== undefined).sort();
  const effectiveDate = signed[signed.length - 1] ?? ctx.today;
  await documents.require(body.executedAgreementDocumentId);
  await documents.requireAll(body.documentIds);
  plan.transactions.push({
    type: "X_EXECUTION_STATUS",
    effectiveDate,
    payload: {
      security_id: security.identity.id,
      status: "executed",
      signature_dates: {
        ...(body.signatureDates.company !== undefined ? { company: body.signatureDates.company } : {}),
        ...(body.signatureDates.holder !== undefined ? { holder: body.signatureDates.holder } : {}),
      },
      attestation: body.attestation,
      document: documents.ref(body.executedAgreementDocumentId),
    },
  });
  plan.documents.push({ documentId: body.executedAgreementDocumentId, role: "AGREEMENT", target: { type: "security", id: security.identity.id } });
  for (const documentId of body.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(state, [])));
  plan.audit = {
    summary: `${security.identity.displayId} marked executed`,
    targetType: "security",
    targetId: security.identity.id,
    details: { securityId: security.identity.id },
  };
  return { plan, documents };
}
