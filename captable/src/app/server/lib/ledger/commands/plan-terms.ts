import { api, engine } from "#shared";
import { notFound } from "../../http.ts";
import { CommandDocuments } from "../documents.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { currentState, holderOfTarget, newPlan, periodToOcf, violation, windowsToOcf } from "./common.ts";

export type PlanTermsFields = Omit<api.SetPlanTerms, "expectedLedgerSeq" | "expectedDiffSha256">;

/**
 * set-plan-terms: the five return-to-pool rules (all explicit, no default), the default exit
 * windows, the repurchase window, status and pour-over, effective-dated. Terms change forward only (the ledger rules): a new
 * entry can't be dated before the terms already in force, so no earlier as-of answer changes.
 */
export async function planSetPlanTerms(ctx: CommandContext, body: PlanTermsFields): Promise<{ plan: CommandPlan; documents: CommandDocuments }> {
  const state = currentState(ctx);
  const stockPlan = state.plans.get(body.stockPlanId);
  if (!stockPlan) throw notFound("Stock plan not found");
  const plan = newPlan(ctx, "set-plan-terms");
  plan.codeMap = { FUTURE_EFFECTIVE_DATE: "EFFECTIVE_DATE_IN_FUTURE" };
  plan.note = body.note;
  plan.ignoredEngineWarnings = ["PLAN_TERMS_MISSING"];
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  const latest = stockPlan.termsHistory[stockPlan.termsHistory.length - 1];
  const known = ctx.ledger.transactions
    .filter((tx) => tx.type === "X_STOCK_PLAN_TERMS" && tx.stockPlanId === stockPlan.ref.id && !state.reversedTransactionIds.has(tx.id))
    .map((tx) => tx.effectiveDate)
    .sort();
  const lastDate = known[known.length - 1] ?? latest?.date ?? null;
  if (lastDate !== null && body.effectiveDate < lastDate) {
    plan.violations.push(violation("PLAN_TERMS_BEFORE_CURRENT", `Plan terms change forward only: date them on or after ${lastDate}`));
  }
  if (body.effectiveDate > ctx.today) plan.violations.push(violation("EFFECTIVE_DATE_IN_FUTURE", "Plan terms can't take effect in the future"));
  if (body.pourOverPlanId !== null && (body.pourOverPlanId === stockPlan.ref.id || !state.plans.has(body.pourOverPlanId))) {
    plan.violations.push(violation("POUR_OVER_INVALID", "The pour-over plan must be another plan of this org"));
  }
  await documents.require(body.documentId);
  await documents.requireAll(body.documentIds);
  plan.transactions.push({
    type: "X_STOCK_PLAN_TERMS",
    effectiveDate: body.effectiveDate,
    payload: {
      stock_plan_id: stockPlan.ref.id,
      return_rules: engine.rulesToPayload(body.returnRules),
      default_termination_windows: windowsToOcf(body.defaultTerminationWindows, "defaultTerminationWindows"),
      default_repurchase_window: periodToOcf(body.defaultRepurchaseWindow, "defaultRepurchaseWindow"),
      status: body.status,
      pour_over_plan_id: body.pourOverPlanId,
      document_id: body.documentId,
      note: body.note,
    },
  });
  plan.documents.push({ documentId: body.documentId, role: "EVIDENCE", target: { type: "stock_plan", id: stockPlan.ref.id } });
  for (const documentId of body.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(state, [])));
  plan.audit = { summary: `${stockPlan.ref.name} terms set`, targetType: "stock_plan", targetId: stockPlan.ref.id, details: { stockPlanId: stockPlan.ref.id, effectiveDate: body.effectiveDate } };
  return { plan, documents };
}
