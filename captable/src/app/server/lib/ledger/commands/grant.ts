import { api, engine } from "#shared";
import { ApiError, notFound } from "../../http.ts";
import { classFmvOn, loadValuations, valuationGuard } from "../../read/valuations.ts";
import { CommandDocuments } from "../documents.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import {
  assertNotSelfDealing,
  currentState,
  displayIdTaken,
  generateId,
  holderOfTarget,
  money,
  newPlan,
  nextDisplayId,
  stakeholderOr404,
  violation,
  windowsToOcf,
} from "./common.ts";

export type GrantFields = Omit<api.GrantEquityCompensation, "expectedLedgerSeq" | "expectedDiffSha256">;

interface PlanRow {
  id: string;
  name: string;
  stock_class_id: string;
  board_approval_date: string | null;
  stockholder_approval_date: string | null;
  effective_date: string | null;
  expiration_date: string | null;
}

/** Relationships that can hold an ISO: the holder must be an employee at grant (the product rules). */
const ISO_ELIGIBLE: ReadonlySet<string> = new Set(["employee", "officer", "founder"]);

/**
 * grant-equity-compensation (the API contract; the product rules): records an option grant that is already approved
 * and signed. Blocks without the board consent, the executed agreement or a presumptively valid 409A (an administrator
 * may override the 409A with a counsel memo), beyond plan availability, and on the ISO rules.
 */
export async function planGrant(ctx: CommandContext, body: GrantFields): Promise<{ plan: CommandPlan; documents: CommandDocuments }> {
  await assertNotSelfDealing(ctx, [body.stakeholderId]);
  const stakeholder = await stakeholderOr404(ctx, body.stakeholderId);
  const stockPlan = await ctx.db.prepare(
    "SELECT id, name, stock_class_id, board_approval_date, stockholder_approval_date, effective_date, expiration_date FROM stock_plans WHERE org_id = ? AND id = ?",
  ).bind(ctx.org.id, body.stockPlanId).first<PlanRow>();
  if (!stockPlan) throw notFound("Stock plan not found");
  const plan = newPlan(ctx, "grant-equity-compensation");
  plan.codeMap = { VESTING_SUM_MISMATCH: "EXPLICIT_SUM_MISMATCH", FUTURE_EFFECTIVE_DATE: "GRANT_DATE_IN_FUTURE", PLAN_TERMINATED: "PLAN_EXPIRED" };
  plan.note = body.note ?? null;
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  const state = currentState(ctx);
  const grantDate = body.grantDate ?? body.board.approvalDate;
  const iso = body.optionType === "ISO";
  const currency = ctx.org.currency;

  await documents.require(body.board.consentDocumentId);
  await documents.require(body.executedAgreement.documentId);
  if (body.counselMemoDocumentId !== undefined) await documents.require(body.counselMemoDocumentId);
  await documents.requireAll(body.documentIds);
  if (documents.row(body.board.consentDocumentId)?.archived_at !== null) {
    plan.violations.push(violation("MISSING_BOARD_CONSENT", "The signed board consent is archived; use the current document"));
  }
  if (documents.row(body.executedAgreement.documentId)?.archived_at !== null) {
    plan.violations.push(violation("MISSING_EXECUTED_AGREEMENT", "The executed agreement is archived; use the current document"));
  }

  // The 409A presumptively valid on the grant date prices the grant (Policy: we record 409As, we don't perform them).
  const valuations = await loadValuations(ctx.db, ctx.org.id);
  const chosen = valuations.find((valuation) => valuation.id === body.valuationId);
  if (!chosen) throw notFound("Valuation not found");
  // The 409A judged here must still be what the batch commits on: a valuation flagged, cleared, voided or recorded
  // in between aborts the batch (409 state_changed) instead of letting the grant stand on a stale status.
  plan.workflow.push(valuationGuard(ctx.org.id, valuations));
  // Split-adjusted (one FMV for the endpoint and this check); an administrator's override uses the chosen
  // valuation's price, adjusted the same way.
  const lookup = classFmvOn(state, valuations, grantDate, stockPlan.stock_class_id);
  const reported = chosen.prices.find((price) => price.stockClassId === stockPlan.stock_class_id)?.pricePerShare ?? null;
  const chosenPrice = reported === null ? null
    : engine.splitAdjustedPrice(engine.Dec.parse(reported), chosen.effectiveDate, grantDate, state.classes.get(stockPlan.stock_class_id)?.splits ?? []).price.toString();
  const validChoice = lookup.valid && lookup.valuation.id === chosen.id;
  const override = ctx.actor.fullAccess && body.counselMemoDocumentId !== undefined;
  if (!engine.isFinal409A(chosen)) {
    // Only a final 409A report prices a grant, with or without counsel's memo: never a draft or another type.
    plan.violations.push(violation("NO_PRESUMPTIVELY_VALID_409A", `${chosen.name} isn't a final 409A report, so it can't price a grant`));
  } else if (!validChoice && !override) {
    plan.violations.push(violation("NO_PRESUMPTIVELY_VALID_409A", `No presumptively valid 409A covers ${grantDate}`, {
      override: { role: "admin_rw", requires: ["counselMemoDocumentId"] },
    }));
  }
  if (chosenPrice === null) {
    plan.violations.push(violation("NO_PRESUMPTIVELY_VALID_409A", "That 409A has no price for the plan's class"));
  }
  const fmv = engine.Dec.parse(validChoice ? lookup.pricePerShare.toString() : (chosenPrice ?? "1"));
  const strike = engine.Dec.parse(body.exercisePrice);
  if (iso) {
    if (!ISO_ELIGIBLE.has(stakeholder.relationship)) {
      plan.violations.push(violation("ISO_NOT_EMPLOYEE", "An ISO can be granted only to an employee"));
    }
    if (body.isoAttestations?.tenPercentHolder) {
      const fiveYears = engine.addYears(grantDate, 5);
      if (strike.lt(fmv.mul("1.1")) || body.expirationDate > fiveYears) {
        plan.violations.push(violation("ISO_TEN_PERCENT_TERMS", "A 10%-holder's ISO needs a strike of at least 110% of FMV and a term of at most 5 years"));
      }
    } else if (strike.lt(fmv)) {
      plan.violations.push(violation("ISO_PRICE_BELOW_FMV", `An ISO's strike can't be below the FMV of ${fmv}`));
    }
    const starts = [stockPlan.board_approval_date ?? stockPlan.effective_date, stockPlan.stockholder_approval_date].filter((d): d is string => d !== null).sort();
    if (starts.length > 0 && grantDate > engine.addYears(starts[0]!, 10)) {
      plan.violations.push(violation("ISO_PLAN_WINDOW", "An ISO must be granted within 10 years of the plan's adoption or stockholder approval"));
    }
  } else if (strike.lt(fmv)) {
    plan.warnings.push({ code: "NSO_PRICE_BELOW_FMV", message: `The strike is below the FMV of ${fmv} (409A risk)`, details: { fmv: fmv.toString() } });
    if (body.counselMemoDocumentId === undefined) {
      plan.violations.push(violation("NSO_PRICE_BELOW_FMV", "An NSO priced below FMV needs counsel's memo", { override: { role: "admin_rw", requires: ["counselMemoDocumentId"] } }));
    }
  }
  if (stockPlan.expiration_date !== null && grantDate > stockPlan.expiration_date) {
    plan.violations.push(violation("PLAN_EXPIRED", `The plan expired on ${stockPlan.expiration_date}`));
  }
  if (body.exemption.federal === "NON_US" && body.exemption.country === undefined) {
    plan.violations.push(violation("NON_US_NEEDS_COUNTRY", "A non-US grant needs its country"));
  }
  if (body.displayId !== undefined && displayIdTaken(ctx, body.displayId)) {
    plan.violations.push(violation("DISPLAY_ID_TAKEN", `${body.displayId} is already used`));
  }
  for (const legendId of body.legendIds) {
    const legend = await ctx.db.prepare("SELECT id FROM legends WHERE org_id = ? AND id = ?").bind(ctx.org.id, legendId).first();
    if (!legend) throw notFound("Legend not found");
  }

  const securityId = generateId(ctx, plan);
  const displayId = body.displayId ?? nextDisplayId(ctx, "OPT");
  let vestingTermsId: string;
  let definitionSha: string;
  if ("templateId" in body.vesting.terms) {
    const templateId = body.vesting.terms.templateId;
    const template = ctx.ledger.reference.vestingTerms.find((terms) => terms.id === templateId);
    const row = await ctx.db.prepare("SELECT is_template FROM vesting_terms WHERE org_id = ? AND id = ?").bind(ctx.org.id, templateId).first<{ is_template: number }>();
    if (!template || !row) throw notFound("Vesting schedule not found");
    if (row.is_template !== 1) throw new ApiError("validation_failed", "Choose a vesting template", [{ path: "vesting.terms.templateId", message: "Not a template" }]);
    vestingTermsId = template.id;
    definitionSha = template.definitionSha256;
  } else {
    const definition: engine.VestingDefinition = { type: "EXPLICIT", events: body.vesting.terms.explicit.map((event) => ({ date: event.date, quantity: event.quantity })) };
    const sum = engine.Dec.sum(definition.events.map((event) => engine.Dec.parse(event.quantity)));
    if (!sum.eq(body.quantity)) plan.violations.push(violation("EXPLICIT_SUM_MISMATCH", `The tranches add up to ${sum}, not ${body.quantity}`));
    vestingTermsId = generateId(ctx, plan);
    definitionSha = engine.definitionSha256(definition);
    plan.vestingTerms.push({ id: vestingTermsId, name: `${displayId} vesting`, definition, definitionSha256: definitionSha });
    plan.created.vestingTermsIds.push(vestingTermsId);
  }
  const windows = body.terminationExerciseWindows !== undefined
    ? windowsToOcf(body.terminationExerciseWindows, "terminationExerciseWindows")
    : (engine.planTermsOn(state, stockPlan.id, grantDate)?.defaultTerminationWindows ?? []);
  const terms = engine.planTermsOn(state, stockPlan.id, grantDate);
  plan.securities.push({
    id: securityId,
    family: "EQUITY_COMPENSATION",
    subtype: iso ? "OPTION_ISO" : "OPTION_NSO",
    stakeholderId: stakeholder.id,
    stockClassId: stockPlan.stock_class_id,
    stockPlanId: stockPlan.id,
    displayId,
    originCommandId: plan.commandId,
    parentSecurityId: null,
  });
  plan.created.securityIds.push(securityId);
  const xDocuments = [
    { ...documents.ref(body.board.consentDocumentId), role: "CONSENT" },
    { ...documents.ref(body.executedAgreement.documentId), role: "AGREEMENT" },
    ...(body.counselMemoDocumentId !== undefined ? [{ ...documents.ref(body.counselMemoDocumentId), role: "COUNSEL_MEMO" }] : []),
  ];
  plan.transactions.push({
    type: "TX_EQUITY_COMPENSATION_ISSUANCE",
    effectiveDate: grantDate,
    payload: {
      security_id: securityId,
      custom_id: displayId,
      stakeholder_id: stakeholder.id,
      stock_plan_id: stockPlan.id,
      stock_class_id: stockPlan.stock_class_id,
      compensation_type: iso ? "OPTION_ISO" : "OPTION_NSO",
      quantity: body.quantity,
      exercise_price: money(body.exercisePrice, currency),
      early_exercisable: body.vesting.earlyExercisable,
      vesting_terms_id: vestingTermsId,
      expiration_date: body.expirationDate,
      termination_exercise_windows: windows,
      board_approval_date: body.board.approvalDate,
      ...(body.grantDateOverrideReason !== undefined ? { comments: [`Grant date differs from the board approval: ${body.grantDateOverrideReason}`] } : {}),
      x_definition_sha256: definitionSha,
      x_fmv: { price_per_share: money(fmv.toString(), currency), valuation_id: chosen.id, source: "VALUATION" },
      ...(terms ? { x_plan_terms_tx_id: terms.transactionId } : {}),
      ...(iso && body.isoAttestations ? { x_iso_attestations: { employee_at_grant: body.isoAttestations.employeeAtGrant, ten_percent_holder: body.isoAttestations.tenPercentHolder } } : {}),
      x_acceleration_terms: {
        kind: body.vesting.accelerationTerms.kind,
        ...(body.vesting.accelerationTerms.percent !== undefined ? { percent: body.vesting.accelerationTerms.percent } : {}),
        ...(body.vesting.accelerationTerms.months !== undefined ? { months: body.vesting.accelerationTerms.months } : {}),
        ...(body.vesting.accelerationTerms.text !== undefined ? { text: body.vesting.accelerationTerms.text } : {}),
      },
      x_exemption: {
        federal: body.exemption.federal,
        ...(body.exemption.country !== undefined ? { country: body.exemption.country } : {}),
        ...(body.exemption.state !== undefined ? { state: body.exemption.state } : {}),
      },
      ...(body.legendIds.length > 0 ? { x_legend_ids: body.legendIds } : {}),
      ...(body.issueReason !== undefined ? { x_issue_reason: body.issueReason } : {}),
      x_documents: xDocuments,
    },
  });
  plan.transactions.push({
    type: "TX_VESTING_START",
    effectiveDate: grantDate,
    payload: { security_id: securityId, x_vesting_start_date: body.vesting.vestingStartDate },
  });
  plan.documents.push(
    { documentId: body.board.consentDocumentId, role: "CONSENT", target: { type: "security", id: securityId } },
    { documentId: body.executedAgreement.documentId, role: "AGREEMENT", target: { type: "security", id: securityId } },
  );
  if (body.counselMemoDocumentId !== undefined) plan.documents.push({ documentId: body.counselMemoDocumentId, role: "EVIDENCE", target: { type: "security", id: securityId } });
  for (const documentId of body.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(state, plan.securities)));
  plan.audit = {
    summary: `${displayId} recorded`,
    targetType: "security",
    targetId: securityId,
    details: { securityId, stockPlanId: stockPlan.id, optionType: body.optionType },
  };
  return { plan, documents };
}
