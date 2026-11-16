import type { api, engine } from "#shared";
import { CommandDocuments } from "../documents.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { assertConfirmation, assertNotSelfDealing, currentState, holderOfTarget, newPlan, securityOr404, violation } from "./common.ts";

export type MarkExecutedFields = Omit<api.MarkExecuted, "expectedLedgerSeq" | "expectedDiffSha256">;

const PARTY: Record<"holder" | "company", string> = { holder: "the holder's", company: "the company signatory's" };

/**
 * The execution status after the signatures recorded: executed when both are in. One party's signature on a grant
 * awaiting both leaves it awaiting the other's; on a grant awaiting only that party, it completes execution, which
 * is recorded as "both" with the fully signed agreement; on a grant not awaiting that party, it is refused.
 */
function nextStatus(security: engine.SecurityState, signed: api.MarkExecutedSigned): { status: engine.ExecutionStatus } | { code: string; message: string } {
  if (signed === "both") return { status: "executed" };
  const other = signed === "holder" ? "company" : "holder";
  const displayId = security.identity.displayId;
  if (security.executionStatus === "pending_both") return { status: `pending_${other}` };
  if (security.executionStatus === `pending_${signed}`) {
    return { code: "SIGNATURE_COMPLETES_EXECUTION", message: `Only ${PARTY[signed]} signature was missing: with it ${displayId} is executed, so record both signatures with the fully signed agreement` };
  }
  return { code: "SIGNATURE_NOT_PENDING", message: `${displayId} isn't awaiting ${PARTY[signed]} signature` };
}

/**
 * mark-executed (the API contract; the product rules): an execution-pending grant becomes executed once the agreement
 * signed by both parties is attached, or, awaiting both signatures, records the one party who has signed so far. It is
 * a ledger fact because execution gates exercise (a missing holder signature blocks it), so an administrator can
 * reverse it; the payload keeps the document's hash, the signature dates and the attestation. It takes effect on the
 * later signature date (or today when none is given), never before the grant's issue date nor before its current
 * execution status, so an exercise on or after that date sees the new status.
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
  const displayId = security.identity.displayId;
  if (!security.issued || security.closedBy !== null || !security.outstanding.isPositive()) {
    plan.violations.push(violation("SECURITY_NOT_OUTSTANDING", `${displayId} is not outstanding`, { securityId: security.identity.id }));
  }
  let status: engine.ExecutionStatus = "executed";
  if (!security.executionStatus.startsWith("pending")) {
    plan.violations.push(violation("NOT_EXECUTION_PENDING", `${displayId} is not execution pending`, { securityId: security.identity.id }));
  } else {
    const next = nextStatus(security, body.signed);
    if ("status" in next) status = next.status;
    else plan.violations.push(violation(next.code, next.message, { securityId: security.identity.id }));
  }
  const signed = [body.signatureDates.company, body.signatureDates.holder].filter((date): date is string => date !== undefined).sort();
  const effectiveDate = signed[signed.length - 1] ?? ctx.today;
  // A status dated before the current one would replay first and be overwritten by it (a date before the issue date is
  // the engine's SIGNATURE_DATE_BEFORE_ISSUE instead).
  const current = security.executionStatusSetBy;
  if (current !== null && effectiveDate < current.date && (security.issueDate === null || effectiveDate >= security.issueDate)) {
    plan.violations.push(violation("SIGNATURE_DATE_BEFORE_STATUS", `${displayId}'s execution status was recorded on ${current.date}; the signatures can't take effect before it`, { securityId: security.identity.id }));
  }
  await documents.require(body.executedAgreementDocumentId);
  await documents.requireAll(body.documentIds);
  plan.transactions.push({
    type: "X_EXECUTION_STATUS",
    effectiveDate,
    payload: {
      security_id: security.identity.id,
      status,
      signature_dates: {
        ...(body.signatureDates.company !== undefined ? { company: body.signatureDates.company } : {}),
        ...(body.signatureDates.holder !== undefined ? { holder: body.signatureDates.holder } : {}),
      },
      attestation: body.attestation,
      document: documents.ref(body.executedAgreementDocumentId),
    },
  });
  // Only the fully signed agreement is the grant's agreement; one signed so far is evidence.
  plan.documents.push({ documentId: body.executedAgreementDocumentId, role: body.signed === "both" ? "AGREEMENT" : "EVIDENCE", target: { type: "security", id: security.identity.id } });
  for (const documentId of body.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(state, [])));
  plan.audit = {
    summary: body.signed === "both" ? `${displayId} marked executed` : `${displayId}: ${PARTY[body.signed]} signature recorded`,
    targetType: "security",
    targetId: security.identity.id,
    details: { securityId: security.identity.id, signed: body.signed, executionStatus: status },
  };
  return { plan, documents };
}
