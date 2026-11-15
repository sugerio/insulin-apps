import { api, engine } from "#shared";
import { ApiError } from "../../http.ts";
import { CommandDocuments } from "../documents.ts";
import type { CommandContext, CommandPlan } from "../types.ts";
import { assertConfirmation, assertNotSelfDealing, currentState, generateId, holderOfTarget, money, newPlan, nextDisplayId, securityOr404, violation } from "./common.ts";

export type RepurchaseFields = Omit<api.RecordRepurchase, "expectedLedgerSeq" | "expectedDiffSha256">;

/**
 * The issuance terms of a lot, as its payload states them: its TX_STOCK_ISSUANCE, or the issuance an opening balance
 * stands in for. Null when the ledger holds neither (the balance lot then takes the lot's price and issue date only).
 */
function issuanceTerms(ctx: CommandContext, security: engine.SecurityState): Record<string, unknown> | null {
  const issuance = security.issuance;
  if (issuance === null) return null;
  const tx = ctx.ledger.transactions.find((candidate) => candidate.id === issuance.transactionId);
  if (tx?.type === "TX_STOCK_ISSUANCE") return tx.payload as Record<string, unknown>;
  if (tx?.type === "X_MIGRATION_OPENING_BALANCE") return tx.payload.issuance ?? null;
  return null;
}

/**
 * record-repurchase (the API contract; the product rules): records a repurchase already completed and paid off-platform
 * of every unvested share of a terminated holder's restricted lot, judged on the ledger as it stood on the repurchase
 * date. The repurchase closes the lot; its vested remainder becomes a new balance lot with the lot's descriptive
 * terms and none of its economics (the capital contribution stays on the lot, the remainder has no vesting and no
 * repurchase right). After the repurchase deadline, or with none recorded, someone with full access records it on
 * counsel's authority. The app tells the holder nothing: the company's own notice already has.
 */
export async function planRepurchase(ctx: CommandContext, body: RepurchaseFields, options: { confirm: boolean }): Promise<{ plan: CommandPlan; documents: CommandDocuments }> {
  const state = currentState(ctx);
  const security = securityOr404(state, body.securityId);
  const holder = security.identity.stakeholderId;
  const displayId = security.identity.displayId;
  await assertNotSelfDealing(ctx, [holder]);
  if (options.confirm) assertConfirmation(body.confirmation, [displayId]);
  const plan = newPlan(ctx, "record-repurchase");
  plan.codeMap = {
    FUTURE_EFFECTIVE_DATE: "EFFECTIVE_DATE_IN_FUTURE",
    LOT_CLOSED: "SECURITY_NOT_OUTSTANDING",
    NOT_ISSUED: "SECURITY_NOT_OUTSTANDING",
    BEFORE_ISSUE_DATE: "SECURITY_NOT_OUTSTANDING",
    REPURCHASE_EXCEEDS_UNVESTED: "REPURCHASE_NOT_ALL_UNVESTED",
    NEGATIVE_POSITION: "REPURCHASE_NOT_ALL_UNVESTED",
  };
  plan.note = body.note ?? null;
  const documents = new CommandDocuments(ctx.db, ctx.org.id);
  const id = security.identity.id;
  const date = body.effectiveDate;
  await documents.require(body.noticeDocumentId);
  if (body.authorityDocumentId !== undefined) await documents.require(body.authorityDocumentId);
  await documents.requireAll(body.documentIds);

  if (security.identity.family !== "STOCK" || !engine.hasVestingSchedule(security)) {
    plan.violations.push(violation("NOT_RESTRICTED_STOCK", `${displayId} isn't a restricted share lot: only unvested shares under a vesting schedule are repurchased here`, { securityId: id }));
    return { plan, documents };
  }
  if (!security.issued || security.closedBy !== null || !security.outstanding.isPositive()) {
    plan.violations.push(violation("SECURITY_NOT_OUTSTANDING", `${displayId} has nothing outstanding to repurchase`, { securityId: id }));
    return { plan, documents };
  }
  if (date > ctx.today) plan.violations.push(violation("EFFECTIVE_DATE_IN_FUTURE", "A repurchase can't be dated in the future"));
  if (body.consideration.paidDate > ctx.today) {
    plan.violations.push(violation("PAID_DATE_IN_FUTURE", "The payment date can't be in the future: record a repurchase once it is paid"));
  }

  // The lot as it stood on the repurchase date: its holder's termination, its unvested shares, its deadline and the
  // plan's rules then, so later facts don't leak into the check (the engine replays the whole ledger after).
  const atDate = date < ctx.today ? currentState(ctx, date) : state;
  const lot = atDate.securities.get(id) ?? security;
  const quantity = engine.Dec.parse(body.quantity);
  const position = engine.positionAt(atDate, lot, date);
  const unvested = position.unvestedOutstanding;
  if (lot.termination === null) {
    plan.violations.push(security.termination !== null
      ? violation("REPURCHASE_BEFORE_TERMINATION", `The holder's termination is on ${security.termination.date}: a repurchase is dated on or after it`, { securityId: id })
      : violation("HOLDER_NOT_TERMINATED", "Only a terminated holder's unvested shares are repurchased: record the termination first", { securityId: id }));
  } else {
    // A lot whose agreement sets no deadline (a recorded term) is repurchased any time after the termination; only a
    // deadline that passed, or none known, needs counsel's authority.
    const { date: deadline, noDeadline } = engine.repurchaseDeadlineSource(atDate, lot);
    if ((deadline === null && !noDeadline) || (deadline !== null && date > deadline)) {
      if (!ctx.actor.fullAccess || body.authorityDocumentId === undefined) {
        plan.violations.push(violation(
          "REPURCHASE_AUTHORITY_REQUIRED",
          deadline === null
            ? `No repurchase deadline is recorded for ${displayId}: record the repurchase with counsel's authority`
            : `The repurchase right ended on ${deadline}: record the repurchase with counsel's authority`,
          { securityId: id, override: { role: "admin_rw", requires: ["authorityDocumentId"] } },
        ));
      } else if (body.authorityDocumentId === body.noticeDocumentId) {
        plan.violations.push(violation(
          "REPURCHASE_AUTHORITY_REQUIRED",
          "Counsel's authority is a document of its own, not the repurchase notice: upload it",
          { securityId: id, override: { role: "admin_rw", requires: ["authorityDocumentId"] } },
        ));
      } else if (deadline === null) {
        // The engine sees no deadline to pass; the authority is what the admin acknowledges instead.
        plan.warnings.push({ code: "REPURCHASE_WITHOUT_DEADLINE", message: `No repurchase deadline is recorded for ${displayId}: it is recorded on counsel's authority`, details: { securityId: id } });
      }
    }
  }
  if (!unvested.isPositive()) {
    plan.violations.push(violation("NO_UNVESTED_SHARES", `${displayId} has no unvested shares on ${date}`, { securityId: id }));
  } else if (!quantity.eq(unvested)) {
    plan.violations.push(violation("REPURCHASE_NOT_ALL_UNVESTED", `A repurchase takes all ${unvested} shares unvested on ${date}, not ${quantity}`, { securityId: id }));
  }
  const price = engine.Dec.parse(body.pricePerShare);
  const agreed = lot.repurchaseRight?.pricePerShare ?? null;
  if (agreed !== null && !agreed.eq(price)) {
    plan.warnings.push({
      code: "REPURCHASE_PRICE_DIFFERS",
      message: `The lot's repurchase price is ${agreed} per share; this records ${price}`,
      details: { securityId: id, recorded: agreed.toString(), entered: price.toString() },
    });
  }

  const currency = lot.currency ?? ctx.org.currency;
  const stockClassId = lot.identity.stockClassId;
  if (stockClassId === null) throw new ApiError("internal", "The share lot names no stock class");
  // The vested remainder stays with the holder as a new lot of the same command and date (the engine's balance rule).
  const remainder = position.outstanding.sub(quantity);
  let balance: { id: string; displayId: string } | null = null;
  if (remainder.isPositive()) {
    const prefixRow = await ctx.db.prepare("SELECT default_id_prefix FROM stock_classes WHERE org_id = ? AND id = ?").bind(ctx.org.id, stockClassId).first<{ default_id_prefix: string }>();
    const prefix = prefixRow?.default_id_prefix ?? (lot.identity.subtype === "PREFERRED" ? "PS" : "CS");
    balance = { id: generateId(ctx, plan), displayId: nextDisplayId(ctx, prefix) };
    plan.securities.push({
      id: balance.id,
      family: "STOCK",
      subtype: lot.identity.subtype,
      stakeholderId: holder,
      stockClassId,
      stockPlanId: lot.identity.stockPlanId,
      displayId: balance.displayId,
      originCommandId: plan.commandId,
      parentSecurityId: id,
    });
    plan.created.securityIds.push(balance.id);
  }
  plan.transactions.push({
    type: "TX_STOCK_REPURCHASE",
    effectiveDate: date,
    payload: {
      security_id: id,
      quantity: body.quantity,
      price: money(body.pricePerShare, currency),
      ...(balance !== null ? { balance_security_id: balance.id } : {}),
      x_kind: "UNVESTED",
      x_consideration: money(price.mul(quantity).toString(), currency),
      x_payment: {
        method: body.consideration.method,
        paid_date: body.consideration.paidDate,
        ...(body.consideration.reference !== undefined ? { reference: body.consideration.reference } : {}),
      },
      x_notice: documents.ref(body.noticeDocumentId),
      ...(body.authorityDocumentId !== undefined ? { x_authority_document: documents.ref(body.authorityDocumentId) } : {}),
    },
  });
  if (balance !== null) {
    // The lot's descriptive terms, stated again; not its capital contribution (the closed lot keeps it), its vesting,
    // its repurchase right or a migration-only field. Agreements stay linked to the lot itself.
    const terms = issuanceTerms(ctx, lot);
    const sharePrice = terms?.share_price ?? (lot.sharePrice !== null ? money(lot.sharePrice.toString(), currency) : null);
    if (sharePrice === null) throw new ApiError("internal", "The share lot has no price per share");
    const legends = terms?.stock_legend_ids;
    plan.transactions.push({
      type: "TX_STOCK_ISSUANCE",
      effectiveDate: date,
      payload: {
        security_id: balance.id,
        custom_id: balance.displayId,
        stakeholder_id: holder,
        stock_class_id: stockClassId,
        ...(lot.identity.stockPlanId !== null ? { stock_plan_id: lot.identity.stockPlanId } : {}),
        share_price: sharePrice,
        quantity: remainder.toString(),
        ...(Array.isArray(legends) && legends.length > 0 ? { stock_legend_ids: legends } : {}),
        ...(terms?.issuance_type !== undefined ? { issuance_type: terms.issuance_type } : {}),
        ...(terms?.board_approval_date !== undefined ? { board_approval_date: terms.board_approval_date } : {}),
        ...(terms?.x_exemption !== undefined ? { x_exemption: terms.x_exemption } : {}),
        x_holding_start_date: terms?.x_holding_start_date ?? lot.issueDate,
        x_origin: "BALANCE",
        x_source_security_id: id,
      },
    });
  }
  plan.documents.push({ documentId: body.noticeDocumentId, role: "NOTICE", target: { type: "security", id } });
  if (body.authorityDocumentId !== undefined) plan.documents.push({ documentId: body.authorityDocumentId, role: "EVIDENCE", target: { type: "security", id } });
  for (const documentId of body.documentIds) plan.documents.push({ documentId, role: "EVIDENCE", target: { type: "transaction_index", index: 0 } });
  plan.violations.push(...await documents.check(plan.documents, holderOfTarget(state, plan.securities)));
  plan.audit = {
    summary: `${displayId} repurchase recorded`,
    targetType: "security",
    targetId: id,
    details: { securityId: id, quantity: body.quantity, balanceSecurityId: balance?.id ?? null, authority: body.authorityDocumentId !== undefined },
  };
  return { plan, documents };
}
