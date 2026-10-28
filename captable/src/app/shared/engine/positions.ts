import type { IsoDate } from "./dates.ts";
import { Dec } from "./decimal.ts";
import { Rational } from "./rational.ts";
import type { LedgerState, SecurityState } from "./state.ts";
import { scaleEvents, scheduleEvents, vestedAt, vestingTimeline, upcomingEvents, type VestingInputs, type VestingScheduleEvent, type VestingTimelineEvent } from "./vesting.ts";

/**
 * A lot's position on a date: how vesting nets against cancellations, exercises and repurchases, matching Pulley's
 * security numbers. Exercised and released shares consume vested quantity first (early-exercised shares
 * vest first under the product rules); unvested cancellations and repurchases cap what can still vest.
 */

export interface Position {
  issued: Dec;
  outstanding: Dec;
  /** Vested through the date, net of unvested cancellations and repurchases, never above issued. */
  vested: Dec;
  /** Vested and still held: the ordinary maximum an option holder can exercise. */
  vestedOutstanding: Dec;
  unvestedOutstanding: Dec;
}

const ZERO_POSITION: Position = {
  issued: Dec.ZERO,
  outstanding: Dec.ZERO,
  vested: Dec.ZERO,
  vestedOutstanding: Dec.ZERO,
  unvestedOutstanding: Dec.ZERO,
};

/** The base schedule events of a lot (definition expanded, split-scaled, plus TX_VESTING_EVENT events). */
export function baseVestingEvents(state: LedgerState, security: SecurityState): VestingScheduleEvent[] {
  if (security.baseEventsCache !== null) return security.baseEventsCache;
  let events: VestingScheduleEvent[] = [];
  const terms = security.vestingTermsId !== null ? state.vestingTerms.get(security.vestingTermsId) : undefined;
  if (terms && security.vestingBase !== null) {
    const start = security.vestingStartDate ?? security.issueDate;
    if (start !== null) {
      events = scheduleEvents(terms.definition, security.vestingBase.quantity, start, state.shareUnit);
      if (!security.vestingBase.splitRatio.eq(Rational.ONE)) {
        events = scaleEvents(events, security.vestingBase.splitRatio, security.issuedQuantity, state.shareUnit);
      }
    }
  }
  events = [...events, ...security.extraVestingEvents].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  security.baseEventsCache = events;
  return events;
}

/** The inputs the vesting functions need for this lot. A lot without vesting terms vests in full at issuance. */
export function vestingInputsFor(state: LedgerState, security: SecurityState): VestingInputs {
  const events = baseVestingEvents(state, security);
  const hasSchedule = security.vestingTermsId !== null || security.extraVestingEvents.length > 0;
  return {
    quantity: security.issuedQuantity,
    events: hasSchedule ? events : [],
    vestedInFullOn: hasSchedule ? null : security.issueDate,
    stopDate: security.vestingStop?.date ?? null,
    cancelledEventIds: security.cancelledEventIds,
    accelerations: security.accelerations,
    pauses: security.pauses,
  };
}

export function hasVestingSchedule(security: SecurityState): boolean {
  return security.vestingTermsId !== null || security.extraVestingEvents.length > 0;
}

export function positionAt(state: LedgerState, security: SecurityState, date: IsoDate): Position {
  if (!security.issued || security.retracted) return ZERO_POSITION;
  const issued = security.issuedQuantity;
  const outstanding = security.outstanding;
  if (security.identity.family === "CONVERTIBLE") {
    return { issued, outstanding, vested: issued, vestedOutstanding: outstanding.clampZero(), unvestedOutstanding: Dec.ZERO };
  }
  const gross = vestedAt(vestingInputsFor(state, security), date);
  const consumedUnvested = security.cancelledUnvested.add(security.repurchasedUnvested);
  const vested = Dec.min(gross, issued.sub(consumedUnvested)).clampZero();
  const consumedVested = security.exercised.add(security.released).add(security.cancelledVested).add(security.repurchasedVested);
  const vestedOutstanding = Dec.min(vested.sub(consumedVested).clampZero(), outstanding.clampZero());
  return { issued, outstanding, vested, vestedOutstanding, unvestedOutstanding: outstanding.sub(vestedOutstanding) };
}

/** The lot's vesting timeline as of the state (`VestingEvent` in the API contract). */
export function securityVestingTimeline(state: LedgerState, security: SecurityState): VestingTimelineEvent[] {
  if (!security.issued) return [];
  return vestingTimeline(vestingInputsFor(state, security));
}

/** Vesting events after the state's date that will still vest. */
export function securityUpcomingVests(state: LedgerState, security: SecurityState): VestingTimelineEvent[] {
  if (!security.issued || security.outstanding.isZero()) return [];
  return upcomingEvents(vestingInputsFor(state, security), state.asOf);
}
