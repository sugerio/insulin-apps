import { addDays, addMonths, addPeriod, minDate, type IsoDate } from "./dates.ts";
import { Dec } from "./decimal.ts";
import { hasVestingSchedule, positionAt, vestingInputsFor } from "./positions.ts";
import type { OcfPeriodType, Period, TerminationType, TerminationWindow, TerminationWindowReason } from "./schemas.ts";
import type { LeaveRecord, LedgerState, PlanTermsState, SecurityState, StakeholderState, TxRef } from "./state.ts";
import { vestedAt } from "./vesting.ts";

/**
 * Exercisability, deadlines and expiry (the ledger and product rules"Exit windows").
 *
 * - Contractual deadline = termination date + the window for the termination type (the grant's, else the plan's
 *   default as of the grant date), capped at expiration. An extension replaces it from its date.
 * - ISO deadline = end of employment for the ISO test + 3 months (12 with the §22(e)(3) disability attestation, none
 *   after death), never later than the contractual deadline the termination set or expiration. A later extension of
 *   the contractual deadline never moves it. A
 *   leave longer than 3 months without a guaranteed return ends employment for the test on the day after the third
 *   month.
 * - The last exercise day is the earlier of the contractual deadline and the expiration date; expiry cancels the day
 *   after it.
 */

/** The OCF window reason for each termination type (OCF `TerminationWindowType`). */
export const WINDOW_REASON_FOR_TERMINATION: Readonly<Record<TerminationType, TerminationWindowReason>> = Object.freeze({
  voluntary: "VOLUNTARY_OTHER",
  involuntary: "INVOLUNTARY_OTHER",
  with_cause: "INVOLUNTARY_WITH_CAUSE",
  death: "INVOLUNTARY_DEATH",
  disability: "INVOLUNTARY_DISABILITY",
  retirement: "VOLUNTARY_RETIREMENT",
});

/** The API's `TerminationWindow` reasons in OCF terms. */
export const API_WINDOW_REASON: Readonly<Record<"VOLUNTARY" | "INVOLUNTARY" | "WITH_CAUSE" | "DEATH" | "DISABILITY" | "RETIREMENT", TerminationWindowReason>> =
  Object.freeze({
    VOLUNTARY: "VOLUNTARY_OTHER",
    INVOLUNTARY: "INVOLUNTARY_OTHER",
    WITH_CAUSE: "INVOLUNTARY_WITH_CAUSE",
    DEATH: "INVOLUNTARY_DEATH",
    DISABILITY: "INVOLUNTARY_DISABILITY",
    RETIREMENT: "VOLUNTARY_RETIREMENT",
  });

/**
 * An API window ({period, unit, reason}) in the payload's OCF form. QUARTERS become 3 × MONTHS; a fractional period
 * is refused (a window is a whole number of units).
 */
export function terminationWindowFromApi(window: {
  period: string;
  unit: "DAYS" | "MONTHS" | "QUARTERS" | "YEARS";
  reason: keyof typeof API_WINDOW_REASON;
}): TerminationWindow {
  const period = Dec.from(window.period);
  if (!period.isInteger() || period.isNegative() || period.gt(1200)) throw new RangeError(`Invalid window period ${window.period}`);
  const count = Number(period.mantissa);
  const unit: OcfPeriodType = window.unit === "QUARTERS" ? "MONTHS" : window.unit;
  return { reason: API_WINDOW_REASON[window.reason], period: window.unit === "QUARTERS" ? count * 3 : count, period_type: unit };
}

export function windowEnd(date: IsoDate, window: Pick<TerminationWindow, "period" | "period_type"> | Period): IsoDate {
  return addPeriod(date, window.period, window.period_type);
}

/** The plan terms in force on a date (the last X_STOCK_PLAN_TERMS effective on or before it). */
export function planTermsOn(state: LedgerState, planId: string | null, date: IsoDate): PlanTermsState | null {
  if (planId === null) return null;
  const plan = state.plans.get(planId);
  if (!plan) return null;
  let terms: PlanTermsState | null = null;
  for (const entry of plan.termsHistory) if (entry.date <= date) terms = entry;
  return terms;
}

/**
 * The exercise window that applies to a termination type and where it comes from: the grant's own, else the plan
 * default at grant. `terms` names the plan terms consulted (a `relies_on_terms` edge), also when they have no window
 * for the type: that absence decides the deadline too.
 */
export function windowSource(state: LedgerState, security: SecurityState, type: TerminationType): { window: TerminationWindow | null; terms: PlanTermsState | null } {
  const reason = WINDOW_REASON_FOR_TERMINATION[type];
  const own = security.terminationWindows.find((w) => w.reason === reason);
  if (own) return { window: own, terms: null };
  const terms = planTermsOn(state, security.identity.stockPlanId, security.issueDate ?? state.asOf);
  return { window: terms?.defaultTerminationWindows.find((w) => w.reason === reason) ?? null, terms };
}

/** The exercise window that applies to a termination type: the grant's own, else the plan default at grant. */
export function windowFor(state: LedgerState, security: SecurityState, type: TerminationType): TerminationWindow | null {
  return windowSource(state, security, type).window;
}

/** The deadline a termination sets for an option, before any extension. Null when no window applies. */
export function computeContractualDeadline(state: LedgerState, security: SecurityState, terminationDate: IsoDate, type: TerminationType): IsoDate | null {
  const window = windowFor(state, security, type);
  if (window === null) return null;
  const end = windowEnd(terminationDate, window);
  return security.expirationDate !== null ? minDate(end, security.expirationDate) : end;
}

export interface DeadlineInfo {
  date: IsoDate;
  source: "termination" | "extension";
  setBy: TxRef;
  /** Why, in words: "3 months after voluntary termination", "extended by a recorded document". */
  reason: string;
}

function describeWindow(window: TerminationWindow | null, type: string): string {
  if (window === null) return `no exercise window recorded for ${type.replace("_", " ")} termination`;
  const unit = window.period_type.toLowerCase().replace(/s$/, "");
  return `${window.period} ${unit}${window.period === 1 ? "" : "s"} after ${type.replace("_", " ")} termination`;
}

export function contractualDeadline(security: SecurityState): DeadlineInfo | null {
  if (security.extendedDeadline !== null) {
    return { date: security.extendedDeadline.deadline, source: "extension", setBy: security.extendedDeadline, reason: "extended by a recorded document" };
  }
  if (security.computedDeadline !== null && security.termination !== null) {
    return {
      date: security.computedDeadline.deadline,
      source: "termination",
      setBy: security.computedDeadline,
      reason: describeWindow(security.computedDeadline.window, security.termination.type),
    };
  }
  return null;
}

export type IsoDeadlineKind = "termination" | "disability" | "leave" | "death";

export interface IsoDeadlineInfo {
  /** Null after death: there is no ISO deadline, only the contractual one. */
  date: IsoDate | null;
  kind: IsoDeadlineKind;
  reason: string;
  /** End of employment for the ISO test. */
  employmentEnd: IsoDate;
  /** The ledger facts the deadline comes from: the termination, and the leave when it ended employment first. */
  sources: TxRef[];
}

/**
 * The leave that ends employment for the ISO test, and the day: a leave longer than 3 months without a guaranteed
 * return ends it on the day after the third month (Treas. Reg. §1.421-1(h)(2)). Recorded leaves count as soon as they
 * are recorded, so the deadline is known in advance.
 */
export function leaveEndingEmployment(stakeholder: StakeholderState | undefined): { date: IsoDate; leave: LeaveRecord } | null {
  if (!stakeholder) return null;
  let earliest: { date: IsoDate; leave: LeaveRecord } | null = null;
  for (const leave of stakeholder.leaves) {
    if (leave.returnGuaranteed) continue;
    const thirdMonth = addMonths(leave.startDate, 3);
    if (leave.endDate !== null && leave.endDate <= thirdMonth) continue;
    const end = addDays(thirdMonth, 1);
    if (earliest === null || end < earliest.date) earliest = { date: end, leave };
  }
  return earliest;
}

/** The day a leave ends employment for the ISO test (see `leaveEndingEmployment`), or null. */
export function leaveEmploymentEnd(stakeholder: StakeholderState | undefined): IsoDate | null {
  return leaveEndingEmployment(stakeholder)?.date ?? null;
}

/**
 * The ISO deadline of an ISO option, or null when none applies yet (an active employee without a long leave). It is
 * statutory and fixed when employment ends: the cap is the contractual deadline the termination itself computed, never
 * a later extension, so extending the exercise window can't lengthen the ISO deadline.
 */
export function isoDeadline(state: LedgerState, security: SecurityState): IsoDeadlineInfo | null {
  if (security.identity.subtype !== "OPTION_ISO") return null;
  const stakeholder = state.stakeholders.get(security.identity.stakeholderId);
  const termination = security.termination;
  const leave = leaveEndingEmployment(stakeholder);
  const leaveEnd = leave?.date ?? null;
  const leaveFirst = leaveEnd !== null && (termination === null || leaveEnd < termination.date);
  if (!leaveFirst && termination === null) return null;
  const sources: TxRef[] = [];
  if (termination !== null) sources.push({ transactionId: termination.transactionId, commandId: termination.commandId, date: termination.date });
  if (leaveFirst) sources.push({ transactionId: leave!.leave.transactionId, commandId: leave!.leave.commandId, date: leave!.leave.date });
  if (!leaveFirst && termination!.type === "death") {
    return { date: null, kind: "death", reason: "No ISO deadline after death", employmentEnd: termination!.date, sources };
  }
  const employmentEnd = leaveFirst ? leaveEnd! : termination!.date;
  const disability = !leaveFirst && termination!.type === "disability" && termination!.disabilityAttestation;
  const months = disability ? 12 : 3;
  let date = addMonths(employmentEnd, months);
  let reason = leaveFirst
    ? `3 months after ${employmentEnd}: a leave of absence over 3 months without a guaranteed return ended employment for the ISO test`
    : disability
      ? "12 months after termination (§22(e)(3) disability attested)"
      : "3 months after termination";
  // The deadline the termination computed, not contractualDeadline(): an extension replaces that one, and the ISO
  // deadline never moves with it.
  const contractual = security.computedDeadline?.deadline ?? null;
  if (contractual !== null && contractual < date) {
    date = contractual;
    reason += ", capped at the contractual deadline";
  }
  if (security.expirationDate !== null && security.expirationDate < date) {
    date = security.expirationDate;
    reason += ", capped at the expiration date";
  }
  return { date, kind: leaveFirst ? "leave" : disability ? "disability" : "termination", reason, employmentEnd, sources };
}

/** The last day an option or warrant can be exercised: the earlier of the contractual deadline and expiration. */
export function lastExerciseDate(security: SecurityState): IsoDate | null {
  const contractual = contractualDeadline(security)?.date ?? null;
  const expiration = security.expirationDate;
  if (contractual === null) return expiration;
  if (expiration === null) return contractual;
  return minDate(contractual, expiration);
}

export type ExercisabilityBlock = "not_outstanding" | "not_exercisable_type" | "execution_pending" | "past_contractual_deadline" | "past_expiration" | "nothing_vested";

export interface Exercisability {
  /** Vested outstanding, or 0 when the grant cannot currently be exercised. */
  exercisable: Dec;
  /** What an early-exercisable grant can exercise including unvested options, under the same gates. */
  exercisableIncludingUnvested: Dec;
  blockedBy: ExercisabilityBlock | null;
}

const EXERCISABLE_SUBTYPES = new Set(["OPTION_ISO", "OPTION_NSO", "SAR", "WARRANT"]);

/** Exercisable(D) (the ledger rules): 0 if not outstanding, execution-pending or past the deadline; else vested outstanding. */
export function exercisability(state: LedgerState, security: SecurityState, date: IsoDate = state.asOf): Exercisability {
  const none = (blockedBy: ExercisabilityBlock): Exercisability => ({ exercisable: Dec.ZERO, exercisableIncludingUnvested: Dec.ZERO, blockedBy });
  if (!EXERCISABLE_SUBTYPES.has(security.identity.subtype)) return none("not_exercisable_type");
  if (!security.issued || !security.outstanding.isPositive()) return none("not_outstanding");
  if (security.executionStatus.startsWith("pending")) return none("execution_pending");
  if (security.expirationDate !== null && date > security.expirationDate) return none("past_expiration");
  const contractual = contractualDeadline(security);
  if (contractual !== null && date > contractual.date) return none("past_contractual_deadline");
  const position = positionAt(state, security, date);
  const includingUnvested = security.earlyExercisable ? security.outstanding : position.vestedOutstanding;
  return {
    exercisable: position.vestedOutstanding,
    exercisableIncludingUnvested: includingUnvested,
    blockedBy: position.vestedOutstanding.isZero() && includingUnvested.isZero() ? "nothing_vested" : null,
  };
}

export interface ExpiryCandidate {
  securityId: string;
  reason: "contractual_deadline" | "expiration";
  lastExerciseDate: IsoDate;
  /** The cancellation's effective date: the day after the last exercise day (the API contract). */
  effectiveDate: IsoDate;
  quantity: Dec;
  /** The command that set the deadline (a termination or an extension): the expiry's `relies_on_deadline` edge. */
  dependsOnCommandId: string | null;
}

/**
 * Options and warrants the daily job expires on `date`: outstanding, and `date` is after their last exercise day.
 * Options expire past the contractual deadline or expiration, warrants past expiration (the ledger rules).
 */
export function expiryCandidates(state: LedgerState, date: IsoDate = state.asOf): ExpiryCandidate[] {
  const candidates: ExpiryCandidate[] = [];
  for (const security of state.securities.values()) {
    const family = security.identity.family;
    if (family !== "EQUITY_COMPENSATION" && family !== "WARRANT") continue;
    if (!security.issued || !security.outstanding.isPositive()) continue;
    const contractual = family === "EQUITY_COMPENSATION" ? contractualDeadline(security) : null;
    const expiration = security.expirationDate;
    let last: IsoDate | null = null;
    let reason: ExpiryCandidate["reason"] = "expiration";
    if (contractual !== null && (expiration === null || contractual.date <= expiration)) {
      last = contractual.date;
      reason = "contractual_deadline";
    } else if (expiration !== null) last = expiration;
    if (last === null || date <= last) continue;
    candidates.push({
      securityId: security.identity.id,
      reason,
      lastExerciseDate: last,
      effectiveDate: addDays(last, 1),
      quantity: security.outstanding,
      dependsOnCommandId: reason === "contractual_deadline" ? contractual!.setBy.commandId : null,
    });
  }
  return candidates.sort((a, b) => (a.securityId < b.securityId ? -1 : 1));
}

/**
 * The last day the company can repurchase a terminated holder's unvested shares and where it comes from: a recorded
 * date, else termination + the lot's own window, else + the plan default in force at termination (`terms`, named
 * also when it has no default window).
 */
export function repurchaseDeadlineSource(state: LedgerState, security: SecurityState): { date: IsoDate | null; terms: PlanTermsState | null } {
  if (security.identity.family !== "STOCK") return { date: null, terms: null };
  if (security.lastRepurchaseDate !== null) return { date: security.lastRepurchaseDate.deadline, terms: null };
  if (security.termination === null) return { date: null, terms: null };
  const own = security.repurchaseRight?.window ?? null;
  if (own !== null) return { date: windowEnd(security.termination.date, own), terms: null };
  const terms = planTermsOn(state, security.identity.stockPlanId, security.termination.date);
  const window = terms?.defaultRepurchaseWindow ?? null;
  return { date: window === null ? null : windowEnd(security.termination.date, window), terms };
}

/** The last day the company can repurchase a terminated holder's unvested shares (recorded, else termination + window). */
export function repurchaseDeadline(state: LedgerState, security: SecurityState): IsoDate | null {
  return repurchaseDeadlineSource(state, security).date;
}

export interface TerminationEffect {
  securityId: string;
  family: SecurityState["identity"]["family"];
  /** Vested on the stop date (before any acceleration in the request). */
  vestedAtStop: Dec;
  acceleration: Dec;
  /** Outstanding options or shares that stay with the holder. */
  keep: Dec;
  /** Unvested options cancelled at the stop (restricted shares become repurchaseable instead). */
  cancel: Dec;
  unvestedShares: Dec;
  contractualDeadline: IsoDate | null;
  isoDeadline: IsoDate | null;
  /** Shares returned to plans by the cancellation, under the rules in force on the stop date. */
  poolReturn: Dec;
  blockedBy: "stop_before_issue" | null;
}

export interface TerminationRequest {
  terminationDate: IsoDate;
  terminationType: TerminationType;
  vestingStopDate: IsoDate;
  disabilityAttestation?: boolean;
  accelerations?: Readonly<Record<string, Dec>>;
}

/**
 * What a termination would do to each of a stakeholder's open lots (the terminate wizard's review and the dry run,
 * the API contract): vested at the stop, unvested to cancel, deadlines and pool returns. It reads the state; the ledger
 * writer builds the transactions from it.
 */
export function terminationPreview(state: LedgerState, stakeholderId: string, request: TerminationRequest): TerminationEffect[] {
  const effects: TerminationEffect[] = [];
  const stakeholder = state.stakeholders.get(stakeholderId);
  for (const security of state.securitiesByStakeholder.get(stakeholderId) ?? []) {
    if (!security.issued || !security.outstanding.isPositive()) continue;
    const family = security.identity.family;
    if (family !== "EQUITY_COMPENSATION" && !(family === "STOCK" && hasVestingSchedule(security))) continue;
    const base: TerminationEffect = {
      securityId: security.identity.id,
      family,
      vestedAtStop: Dec.ZERO,
      acceleration: Dec.ZERO,
      keep: security.outstanding,
      cancel: Dec.ZERO,
      unvestedShares: Dec.ZERO,
      contractualDeadline: null,
      isoDeadline: null,
      poolReturn: Dec.ZERO,
      blockedBy: null,
    };
    if (security.issueDate !== null && request.vestingStopDate < security.issueDate) {
      effects.push({ ...base, blockedBy: "stop_before_issue" });
      continue;
    }
    const inputs = { ...vestingInputsFor(state, security), stopDate: request.vestingStopDate };
    const consumedUnvested = security.cancelledUnvested.add(security.repurchasedUnvested);
    const vestedAtStop = Dec.min(vestedAt(inputs, request.vestingStopDate), security.issuedQuantity.sub(consumedUnvested)).clampZero();
    const room = security.issuedQuantity.sub(consumedUnvested).sub(vestedAtStop).clampZero();
    const acceleration = Dec.min(request.accelerations?.[security.identity.id] ?? Dec.ZERO, room);
    const vested = vestedAtStop.add(acceleration);
    const consumedVested = security.exercised.add(security.released).add(security.cancelledVested).add(security.repurchasedVested);
    const keepVested = Dec.min(vested.sub(consumedVested).clampZero(), security.outstanding);
    if (family === "STOCK") {
      effects.push({ ...base, vestedAtStop, acceleration, unvestedShares: security.outstanding.sub(keepVested) });
      continue;
    }
    const cancel = security.outstanding.sub(keepVested);
    let contractual: IsoDate | null = null;
    let iso: IsoDate | null = null;
    if (keepVested.isPositive()) {
      contractual = computeContractualDeadline(state, security, request.terminationDate, request.terminationType);
      if (security.identity.subtype === "OPTION_ISO" && request.terminationType !== "death") {
        const leaveEnd = leaveEmploymentEnd(stakeholder);
        const end = leaveEnd !== null && leaveEnd < request.terminationDate ? leaveEnd : request.terminationDate;
        const disability = end === request.terminationDate && request.terminationType === "disability" && request.disabilityAttestation === true;
        iso = addMonths(end, disability ? 12 : 3);
        if (contractual !== null) iso = minDate(iso, contractual);
        if (security.expirationDate !== null) iso = minDate(iso, security.expirationDate);
      }
    }
    const rules = planTermsOn(state, security.identity.stockPlanId, request.vestingStopDate)?.rules;
    const poolReturn = security.identity.stockPlanId !== null && (rules === undefined || rules.cancelledUnvestedAwards === "RETURN") ? cancel : Dec.ZERO;
    effects.push({ ...base, vestedAtStop, acceleration, keep: keepVested, cancel, contractualDeadline: contractual, isoDeadline: iso, poolReturn });
  }
  return effects.sort((a, b) => (a.securityId < b.securityId ? -1 : 1));
}
