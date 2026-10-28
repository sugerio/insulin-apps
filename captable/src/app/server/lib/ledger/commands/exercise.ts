import { api, engine } from "#shared";
import { ApiError } from "../../http.ts";
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
  securityOr404,
  violation,
} from "./common.ts";

/** The body of a real call or a dry run: the envelope's guards are the runner's business. */
export type ExerciseFields = Omit<api.ExerciseOption, "expectedLedgerSeq" | "expectedDiffSha256">;

/** An exact decimal for a split-adjusted price, or null when it doesn't terminate within the storage bound. */
function priceText(price: engine.Rational | null): string | null {
  if (price === null) return null;
  const exact = price.toDecExact();
  return exact !== null && engine.Dec.isCanonical(exact.toString()) ? exact.toString() : null;
}

/**
 * exercise-option (the API contract; the product rules): records a holder-reported exercise as the exercise and one
 * share issuance per ISO or NSO portion. The exercise date is the later of the signed notice and full payment; ISO
 * lots go first, and ISO shares exercised after the ISO deadline are recorded as NSO with that reason.
 */
export async function planExercise(ctx: CommandContext, body: ExerciseFields): Promise<{ plan: CommandPlan; documents: CommandDocuments }> {
  const state = currentState(ctx);
  const option = securityOr404(state, body.securityId);
  await assertNotSelfDealing(ctx, [option.identity.stakeholderId]);
  if (option.identity.family !== "EQUITY_COMPENSATION" || (option.identity.subtype !== "OPTION_ISO" && option.identity.subtype !== "OPTION_NSO")) {
    throw new ApiError("validation_failed", "Only options are exercised here", [{ path: "securityId", message: "Choose an ISO or NSO option" }]);
  }
  const plan = newPlan(ctx, "exercise-option");
  plan.codeMap = { FUTURE_EFFECTIVE_DATE: "EXERCISE_DATE_IN_FUTURE", LOT_CLOSED: "SECURITY_NOT_OUTSTANDING", NOT_ISSUED: "SECURITY_NOT_OUTSTANDING" };
  plan.note = body.note ?? null;
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  const computedDate = body.notice.receivedOn > body.payment.receivedOn ? body.notice.receivedOn : body.payment.receivedOn;
  if (body.exerciseDate !== computedDate) {
    plan.violations.push(violation("EXERCISE_DATE_MISMATCH", `The exercise date is ${computedDate}: the later of the notice and the full payment`));
  }
  const date = computedDate;
  if (date > ctx.today) plan.violations.push(violation("EXERCISE_DATE_IN_FUTURE", "The exercise date can't be in the future"));
  if (!option.issued || !option.outstanding.isPositive() || option.closedBy !== null) {
    plan.violations.push(violation("SECURITY_NOT_OUTSTANDING", `${option.identity.displayId} is not outstanding`, { securityId: option.identity.id }));
  }
  const quantity = engine.Dec.parse(body.quantity);
  // Positions on the exercise date: replayed as of it, so later facts don't leak into the check.
  const atDate = date < ctx.today ? currentState(ctx, date) : state;
  const optionAtDate = atDate.securities.get(option.identity.id) ?? option;
  const position = engine.positionAt(atDate, optionAtDate, date);
  if (quantity.gt(position.vestedOutstanding)) {
    plan.violations.push(
      optionAtDate.earlyExercisable
        ? violation("EARLY_EXERCISE_NOT_IN_R1", "Early exercise of unvested options can be recorded starting Jan 15, 2027", { securityId: option.identity.id })
        : violation("EXCEEDS_VESTED_UNEXERCISED", `Exercises ${quantity} with ${position.vestedOutstanding} vested and unexercised on ${date}`, { securityId: option.identity.id }),
    );
  }
  const strike = optionAtDate.exercisePrice ?? option.exercisePrice;
  const strikeText = priceText(strike);
  if (strikeText === null) throw new ApiError("internal", "The option's exercise price can't be recorded exactly");
  const currency = option.currency ?? ctx.org.currency;
  const cost = quantity.mul(strikeText);
  const paid = engine.Dec.parse(body.payment.amount);
  if (paid.lt(cost)) plan.violations.push(violation("PAYMENT_BELOW_COST", `The payment is below the exercise cost of ${cost}`));
  if (paid.gt(cost)) plan.warnings.push({ code: "PAYMENT_EXCEEDS_COST", message: `The payment exceeds the cost by ${paid.sub(cost)}; refund it off-platform`, details: { excess: paid.sub(cost).toString() } });
  if (!body.payment.payerIsHolder) plan.warnings.push({ code: "PAYER_NOT_HOLDER", message: "Someone other than the holder paid" });

  // FMV at the exercise date: the presumptively valid 409A, or a manual FMV with its source (the product rules).
  const deliveredClass = option.identity.stockClassId ?? (option.identity.stockPlanId ? state.plans.get(option.identity.stockPlanId)?.ref.stockClassId ?? null : null);
  if (deliveredClass === null) throw new ApiError("internal", "The option delivers no stock class");
  let fmv: Record<string, unknown>;
  let fmvPrice: engine.Dec | null = null;
  await documents.require(body.notice.documentId);
  if (body.fmv.source === "valuation") {
    const valuations = await loadValuations(ctx.db, ctx.org.id);
    const chosen = valuations.find((valuation) => valuation.id === (body.fmv as { valuationId: string }).valuationId);
    if (!chosen) throw new ApiError("not_found", "Valuation not found");
    // The FMV snapshot must come from the valuations as they are when the batch commits (409 state_changed otherwise).
    plan.workflow.push(valuationGuard(ctx.org.id, valuations));
    const lookup = classFmvOn(state, valuations, date, deliveredClass);
    if (!lookup.valid || lookup.valuation.id !== chosen.id) {
      plan.violations.push(violation("NO_FMV_FOR_EXERCISE_DATE", "That 409A isn't presumptively valid on the exercise date: enter the FMV with its source"));
      const price = chosen.prices.find((p) => p.stockClassId === deliveredClass)?.pricePerShare ?? "0";
      fmv = { price_per_share: money(price === "0" ? "1" : price, currency), valuation_id: chosen.id, source: "VALUATION" };
    } else {
      fmvPrice = lookup.pricePerShare;
      fmv = { price_per_share: money(lookup.pricePerShare.toString(), currency), valuation_id: chosen.id, source: "VALUATION" };
    }
  } else {
    await documents.require(body.fmv.documentId);
    fmvPrice = engine.Dec.parse(body.fmv.pricePerShare);
    fmv = { price_per_share: money(body.fmv.pricePerShare, currency), valuation_id: null, source: "MANUAL", source_note: body.fmv.sourceNote, document_id: body.fmv.documentId };
    plan.documents.push({ documentId: body.fmv.documentId, role: "EVIDENCE", target: { type: "security", id: option.identity.id } });
  }

  // Lots and portions (the ledger rules): ISO lots first unless the admin chose others with a reason; ISO shares after the
  // ISO deadline are NSO with that reason, NSO lots of an ISO grant are NSO for the $100K limit.
  const iso = option.identity.subtype === "OPTION_ISO";
  const available = engine.isoLotsAvailable(atDate, optionAtDate, date);
  let lotsIso: engine.Dec;
  let lotsNso: engine.Dec;
  if (body.lots) {
    lotsIso = engine.Dec.sum(body.lots.filter((lot) => lot.portion === "ISO").map((lot) => engine.Dec.parse(lot.quantity)));
    lotsNso = engine.Dec.sum(body.lots.filter((lot) => lot.portion === "NSO").map((lot) => engine.Dec.parse(lot.quantity)));
    if (!lotsIso.add(lotsNso).eq(quantity)) plan.violations.push(violation("LOTS_MISMATCH", "The lots must add up to the quantity"));
  } else if (iso) {
    lotsIso = engine.Dec.min(quantity, available.iso);
    lotsNso = quantity.sub(lotsIso);
  } else {
    lotsIso = engine.Dec.ZERO;
    lotsNso = quantity;
  }
  const isoDeadline = iso ? engine.isoDeadline(atDate, optionAtDate) : null;
  const afterIsoDeadline = isoDeadline !== null && isoDeadline.date !== null && date > isoDeadline.date;
  const portions: { portion: "ISO" | "NSO"; quantity: engine.Dec; reason?: "AFTER_ISO_DEADLINE" | "ISO_LIMIT" | "LOT_CHOICE" }[] = [];
  if (!iso) {
    portions.push({ portion: "NSO", quantity });
  } else if (afterIsoDeadline) {
    portions.push({ portion: "NSO", quantity, reason: "AFTER_ISO_DEADLINE" });
    if (lotsIso.isPositive()) {
      plan.warnings.push({
        code: "ISO_PORTION_AFTER_ISO_DEADLINE",
        message: `Exercised after the ISO deadline (${isoDeadline!.date}): ${lotsIso} ISO-designated shares are recorded as NSO and excluded from Form 3921`,
        details: { isoDeadline: isoDeadline!.date, isoDesignated: lotsIso.toString() },
      });
    }
  } else {
    if (lotsIso.isPositive()) portions.push({ portion: "ISO", quantity: lotsIso });
    if (lotsNso.isPositive()) {
      const isoFirst = engine.Dec.min(quantity, available.iso);
      portions.push({ portion: "NSO", quantity: lotsNso, reason: lotsIso.lt(isoFirst) ? "LOT_CHOICE" : "ISO_LIMIT" });
    }
  }
  // Left out, the resulting shares are the derived portions with generated display IDs (the dry run shows them in
  // `CommandResult.exercise`); sent, they must name exactly those portions.
  const requested = new Map((body.resultingShares ?? []).map((share) => [share.portion, share]));
  const expected = new Set(portions.map((portion) => portion.portion));
  if (body.resultingShares !== undefined && (requested.size !== expected.size || [...expected].some((portion) => !requested.has(portion)))) {
    plan.violations.push(violation(
      "RESULTING_SHARES_PORTIONS",
      `The exercise results in ${[...expected].join(" and ")} shares: send one resulting share per portion`,
      { securityId: option.identity.id },
    ));
  }
  const holder = option.identity.stakeholderId;
  const classRef = state.classes.get(deliveredClass)!.ref;
  const prefixRow = await ctx.db.prepare("SELECT default_id_prefix FROM stock_classes WHERE org_id = ? AND id = ?").bind(ctx.org.id, deliveredClass).first<{ default_id_prefix: string }>();
  const prefix = prefixRow?.default_id_prefix ?? (classRef.classType === "COMMON" ? "CS" : "PS");
  const taken = new Set<string>();
  const resulting = portions.map((portion) => {
    const id = generateId(ctx, plan);
    let displayId = requested.get(portion.portion)?.displayId;
    if (displayId !== undefined && (displayIdTaken(ctx, displayId) || taken.has(displayId))) {
      plan.violations.push(violation("DISPLAY_ID_TAKEN", `${displayId} is already used`));
    }
    displayId ??= nextDisplayId(ctx, prefix, taken);
    taken.add(displayId);
    return { ...portion, id, displayId };
  });
  plan.exercise = {
    date,
    isoAvailable: (iso ? available.iso : engine.Dec.ZERO).toString(),
    lots: { iso: lotsIso.toString(), nso: lotsNso.toString() },
    portions: resulting.map((lot) => ({ portion: lot.portion, quantity: lot.quantity.toString(), reason: lot.reason ?? null, displayId: lot.displayId })),
  };
  for (const lot of resulting) {
    plan.securities.push({
      id: lot.id,
      family: "STOCK",
      subtype: classRef.classType === "COMMON" ? "COMMON" : "PREFERRED",
      stakeholderId: holder,
      stockClassId: deliveredClass,
      stockPlanId: option.identity.stockPlanId,
      displayId: lot.displayId,
      originCommandId: plan.commandId,
      parentSecurityId: option.identity.id,
    });
    plan.created.securityIds.push(lot.id);
  }
  // Withholding is entered, not computed (scope decision); a W-2 NSO spread with nothing withheld needs its reason.
  const spread = fmvPrice !== null ? fmvPrice.sub(strikeText) : engine.Dec.ZERO;
  const nsoShares = engine.Dec.sum(resulting.filter((lot) => lot.portion === "NSO").map((lot) => lot.quantity));
  const withholding = body.tax.withholding;
  const withheldTotal = withholding
    ? engine.Dec.parse(withholding.federalIncome).add(withholding.socialSecurity).add(withholding.medicare).add(engine.Dec.sum(withholding.state.map((s) => engine.Dec.parse(s.amount))))
    : engine.Dec.ZERO;
  if (body.tax.treatment === "W2" && spread.isPositive() && nsoShares.isPositive() && withheldTotal.isZero() && body.tax.zeroReason === undefined) {
    plan.violations.push(violation("ZERO_WITHHOLDING_NEEDS_REASON", "Say why nothing was withheld on a W-2 NSO spread above zero"));
  }
  if (body.tax.treatment === "NON_US" && body.tax.nonUsNote === undefined) {
    plan.violations.push(violation("NON_US_NOTE_REQUIRED", "Note how local payroll handles this non-US exercise"));
  }
  plan.transactions.push({
    type: "TX_EQUITY_COMPENSATION_EXERCISE",
    effectiveDate: date,
    payload: {
      security_id: option.identity.id,
      quantity: body.quantity,
      resulting_security_ids: resulting.map((lot) => lot.id),
      x_exercise_price: money(strikeText, currency),
      x_exercise_cost: money(cost.toString(), currency),
      x_fmv: fmv,
      x_portions: resulting.map((lot) => ({
        portion: lot.portion,
        quantity: lot.quantity.toString(),
        security_id: lot.id,
        ...(lot.reason !== undefined ? { reason: lot.reason } : {}),
      })),
      x_lots_consumed: { iso: lotsIso.toString(), nso: lotsNso.toString() },
      ...(body.lotReason !== undefined ? { x_lot_reason: body.lotReason } : {}),
      x_notice: { document_id: body.notice.documentId, received_on: body.notice.receivedOn },
      x_payment: {
        amount: money(body.payment.amount, currency),
        received_on: body.payment.receivedOn,
        method: body.payment.method,
        reference: body.payment.reference,
        payer_is_holder: body.payment.payerIsHolder,
        ...(body.payment.payerNote !== undefined ? { payer_note: body.payment.payerNote } : {}),
      },
      x_tax: {
        treatment: body.tax.treatment,
        ...(withholding
          ? { withholding: { federal_income: withholding.federalIncome, social_security: withholding.socialSecurity, medicare: withholding.medicare, state: withholding.state } }
          : {}),
        ...(body.tax.zeroReason !== undefined ? { zero_reason: body.tax.zeroReason } : {}),
        ...(body.tax.nonUsNote !== undefined ? { non_us_note: body.tax.nonUsNote } : {}),
      },
    },
  });
  for (const lot of resulting) {
    plan.transactions.push({
      type: "TX_STOCK_ISSUANCE",
      effectiveDate: date,
      payload: {
        security_id: lot.id,
        custom_id: lot.displayId,
        stakeholder_id: holder,
        stock_class_id: deliveredClass,
        ...(option.identity.stockPlanId !== null ? { stock_plan_id: option.identity.stockPlanId } : {}),
        share_price: money(strikeText, currency),
        quantity: lot.quantity.toString(),
        x_origin: "EXERCISE",
        x_source_security_id: option.identity.id,
        x_portion: lot.portion,
      },
    });
  }
  plan.documents.push({ documentId: body.notice.documentId, role: "NOTICE", target: { type: "security", id: option.identity.id } });
  await documents.requireAll(body.documentIds);
  for (const documentId of body.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(state, plan.securities)));

  plan.audit = {
    summary: `${option.identity.displayId} exercise recorded`,
    targetType: "security",
    targetId: option.identity.id,
    details: { securityId: option.identity.id, resultingSecurityIds: resulting.map((lot) => lot.id), portions: resulting.map((lot) => lot.portion) },
  };
  return { plan, documents };
}
