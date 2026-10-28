import type { api } from "#shared";
import { CommandDocuments } from "../documents.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { assertNotSelfDealing, currentState, holderOfTarget, newPlan, stakeholderOr404, violation } from "./common.ts";

export type LeaveFields = Omit<api.RecordLeaveOfAbsence, "expectedLedgerSeq" | "expectedDiffSha256">;

/**
 * record-leave-of-absence (the API contract): a ledger fact because it moves the ISO deadline. A leave longer than three
 * months without a guaranteed return ends employment for the ISO test on the day after the third month.
 *
 * A leave is identified by its start date: the start date of a recorded leave records that leave again, with its end
 * once known (closing an open leave) or a corrected end or right to return, and the engine keeps the later record. A
 * new leave may not overlap another one (LEAVE_OVERLAPS).
 */
export async function planLeave(ctx: CommandContext, body: LeaveFields): Promise<{ plan: CommandPlan; documents: CommandDocuments }> {
  await assertNotSelfDealing(ctx, [body.stakeholderId]);
  const stakeholder = await stakeholderOr404(ctx, body.stakeholderId);
  const plan = newPlan(ctx, "record-leave-of-absence");
  plan.codeMap = { FUTURE_EFFECTIVE_DATE: "LEAVE_START_IN_FUTURE" };
  plan.note = body.note ?? null;
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  if (body.endDate !== null && body.endDate < body.startDate) plan.violations.push(violation("LEAVE_DATES", "A leave can't end before it starts"));
  if (body.startDate > ctx.today) plan.violations.push(violation("LEAVE_START_IN_FUTURE", "Record a leave once it has started"));
  // Spans are [start, end), an open leave runs on: another leave may start the day this one ends, never inside it.
  const end = body.endDate ?? "9999-12-31";
  for (const other of currentState(ctx).stakeholders.get(stakeholder.id)?.leaves ?? []) {
    if (other.startDate === body.startDate) continue;
    if (body.startDate < (other.endDate ?? "9999-12-31") && other.startDate < end) {
      plan.violations.push(violation(
        "LEAVE_OVERLAPS",
        other.endDate === null
          ? `The leave that started on ${other.startDate} is still open: to record its end, send its start date`
          : `The leave from ${other.startDate} to ${other.endDate} overlaps this one`,
        { effectiveDate: other.startDate },
      ));
    }
  }
  if (body.documentId !== undefined) await documents.require(body.documentId);
  await documents.requireAll(body.documentIds);
  plan.transactions.push({
    type: "X_STAKEHOLDER_LEAVE",
    effectiveDate: body.startDate,
    payload: {
      stakeholder_id: stakeholder.id,
      start_date: body.startDate,
      end_date: body.endDate,
      return_guaranteed: body.returnGuaranteed,
      ...(body.documentId !== undefined ? { document_id: body.documentId } : {}),
    },
  });
  if (body.documentId !== undefined) plan.documents.push({ documentId: body.documentId, role: "EVIDENCE", target: { type: "stakeholder", id: stakeholder.id } });
  for (const documentId of body.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(currentState(ctx), [])));
  plan.audit = { summary: "Leave of absence recorded", targetType: "stakeholder", targetId: stakeholder.id, details: { stakeholderId: stakeholder.id } };
  return { plan, documents };
}
