import { addDays, addMonths, yearOf, type IsoDate } from "./dates.ts";
import { isoDeadline } from "./deadlines.ts";
import { Dec } from "./decimal.ts";
import { Rational } from "./rational.ts";
import type { LedgerState } from "./state.ts";

/**
 * Data that future compliance pages need from the ledger. The pages,
 * consents, TINs and filing live elsewhere; the engine supplies the population and the numbers.
 */

// ---------------------------------------------------------------------------
// Form 3921

export interface Form3921Record {
  taxYear: number;
  exerciseTransactionId: string;
  commandId: string;
  optionSecurityId: string;
  resultingSecurityId: string;
  stakeholderId: string;
  /** Box 1: date the option was granted. */
  grantDate: IsoDate;
  /** Box 2: date the option was exercised. */
  exerciseDate: IsoDate;
  /** Box 3: exercise price per share (exact; 12 fractional digits at most when it doesn't terminate). */
  exercisePricePerShare: Dec | null;
  /** Box 4: fair market value per share on the exercise date (the FMV the exercise snapshotted). */
  fmvPerShare: Dec | null;
  /** Box 5: shares transferred (the ISO portion). */
  shares: Dec;
  /** A holder without a US tax status: flagged for manual handling and counsel review, never excluded (the manual-review rule). */
  nonUsHolder: boolean;
}

function toPrice(value: Rational | null): Dec | null {
  if (value === null) return null;
  return value.toDecExact() ?? value.roundTo(12, "HALF_EVEN");
}

/**
 * One record per ISO portion of an unreversed exercise in the tax year, within the ISO deadline, whatever the holder's
 * residence. NSO portions (including late ISO shares recorded as NSO) never get one.
 */
export function form3921Records(state: LedgerState, taxYear: number): Form3921Record[] {
  const records: Form3921Record[] = [];
  for (const security of state.securities.values()) {
    if (security.identity.subtype !== "OPTION_ISO" || security.issueDate === null) continue;
    const stakeholder = state.stakeholders.get(security.identity.stakeholderId)?.ref;
    const nonUsHolder =
      stakeholder?.taxStatus === "non_us" ||
      (stakeholder?.countryOfResidence != null && stakeholder.countryOfResidence !== "US") ||
      security.exemption?.federal === "NON_US";
    const deadline = isoDeadline(state, security)?.date ?? null;
    for (const exercise of security.exercises) {
      if (yearOf(exercise.date) !== taxYear) continue;
      if (deadline !== null && exercise.date > deadline) continue;
      for (const portion of exercise.portions) {
        if (portion.portion !== "ISO") continue;
        records.push({
          taxYear,
          exerciseTransactionId: exercise.transactionId,
          commandId: exercise.commandId,
          optionSecurityId: security.identity.id,
          resultingSecurityId: portion.securityId,
          stakeholderId: security.identity.stakeholderId,
          grantDate: security.issueDate,
          exerciseDate: exercise.date,
          exercisePricePerShare: toPrice(exercise.exercisePrice),
          fmvPerShare: exercise.fmv,
          shares: portion.quantity,
          nonUsHolder,
        });
      }
    }
  }
  return records.sort((a, b) => (a.exerciseDate < b.exerciseDate ? -1 : a.exerciseDate > b.exerciseDate ? 1 : a.exerciseTransactionId < b.exerciseTransactionId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Rule 701

export interface Rule701Sale {
  securityId: string;
  stakeholderId: string;
  grantDate: IsoDate;
  quantity: Dec;
  /** Options at their exercise price at grant; RSUs and restricted stock at the FMV or price at grant. */
  pricePerShare: Dec;
  value: Dec;
}

export interface Rule701Window {
  start: IsoDate;
  end: IsoDate;
  sales: Rule701Sale[];
  totalValue: Dec;
  totalShares: Dec;
}

/**
 * Securities sold in the 12 months ending on `periodEnd` (the product rules): options count at grant (exercise price ×
 * shares) and stay in the window even if later cancelled; exercises aren't counted again; non-US grants (Regulation S)
 * are excluded; retracted grants never happened.
 */
export function rule701Window(state: LedgerState, periodEnd: IsoDate): Rule701Window {
  const start = addDays(addMonths(periodEnd, -12), 1);
  const sales: Rule701Sale[] = [];
  for (const security of state.securities.values()) {
    if (!security.issued || security.retracted || security.issueDate === null) continue;
    if (security.issueDate < start || security.issueDate > periodEnd) continue;
    if (security.exemption?.federal === "NON_US" || security.exemption?.federal === "REG_S") continue;
    if (security.origin !== "GRANT" && security.origin !== "RSA") continue;
    let price: Rational | null = null;
    if (security.identity.family === "EQUITY_COMPENSATION") {
      price = security.identity.subtype === "RSU" ? security.fmvAtGrant : security.exercisePriceAtGrant;
    } else if (security.identity.family === "STOCK" && security.origin === "RSA" && security.sharePrice !== null) {
      price = Rational.fromDec(security.sharePrice);
    }
    if (price === null) continue;
    const quantity = security.issuedQuantity;
    const value = Rational.fromDec(quantity).mul(price).roundTo(2, "HALF_EVEN");
    sales.push({
      securityId: security.identity.id,
      stakeholderId: security.identity.stakeholderId,
      grantDate: security.issueDate,
      quantity,
      pricePerShare: toPrice(price)!,
      value,
    });
  }
  sales.sort((a, b) => (a.grantDate < b.grantDate ? -1 : a.grantDate > b.grantDate ? 1 : a.securityId < b.securityId ? -1 : 1));
  return { start, end: periodEnd, sales, totalValue: Dec.sum(sales.map((s) => s.value)), totalShares: Dec.sum(sales.map((s) => s.quantity)) };
}

export interface Rule701Limit {
  kind: "FIXED_1M" | "TOTAL_ASSETS_15" | "CLASS_OUTSTANDING_15";
  /** Dollars for the first two, shares for the class test. */
  limit: Dec;
  used: Rational;
  ok: boolean;
}

export interface Rule701Result {
  limits: Rule701Limit[];
  /** The test that keeps the company within the rule, or null when none does. */
  governing: Rule701Limit["kind"] | null;
  ok: boolean;
  /** Above $10M in 12 months, the enhanced disclosure must go out before sale or exercise. */
  enhancedDisclosure: boolean;
}

/**
 * The greatest-of test (17 CFR 230.701(d)): $1,000,000, 15% of total assets, or 15% of the outstanding class, the last
 * two measured at the most recent balance-sheet date. The class basis (common by default, "as converted" only if
 * counsel approves) is the caller's input.
 */
export function rule701Test(window: Rule701Window, inputs: { totalAssets: Dec; classOutstanding: Dec }): Rule701Result {
  const ratio = (used: Dec, limit: Dec) => (limit.isZero() ? Rational.of(used.isZero() ? 0 : 1_000_000) : Rational.fromDec(used).div(Rational.fromDec(limit)));
  const fixed = Dec.of(1_000_000);
  const assets = inputs.totalAssets.mul("0.15").roundTo(2, "FLOOR");
  const classLimit = inputs.classOutstanding.mul("0.15").roundTo(0, "FLOOR");
  const limits: Rule701Limit[] = [
    { kind: "FIXED_1M", limit: fixed, used: ratio(window.totalValue, fixed), ok: window.totalValue.lte(fixed) },
    { kind: "TOTAL_ASSETS_15", limit: assets, used: ratio(window.totalValue, assets), ok: window.totalValue.lte(assets) },
    { kind: "CLASS_OUTSTANDING_15", limit: classLimit, used: ratio(window.totalShares, classLimit), ok: window.totalShares.lte(classLimit) },
  ];
  const order: Rule701Limit["kind"][] = ["TOTAL_ASSETS_15", "CLASS_OUTSTANDING_15", "FIXED_1M"];
  const governing = order.find((kind) => limits.find((l) => l.kind === kind)!.ok) ?? null;
  return { limits, governing, ok: governing !== null, enhancedDisclosure: window.totalValue.gt(10_000_000) };
}

/** A class's issued and outstanding shares in a state (replay as of the balance-sheet date first). */
export function classOutstanding(state: LedgerState, stockClassId: string): Dec {
  let total = Dec.ZERO;
  for (const security of state.securities.values()) {
    if (security.identity.family === "STOCK" && security.identity.stockClassId === stockClassId && security.issued && !security.retracted) {
      total = total.add(security.outstanding.clampZero());
    }
  }
  return total;
}
