import { yearOf, type IsoDate } from "./dates.ts";
import { Dec } from "./decimal.ts";
import { EngineError } from "./errors.ts";
import { positionAt, vestingInputsFor } from "./positions.ts";
import { Rational } from "./rational.ts";
import type { LedgerState, OutsideIsoGrant, SecurityState } from "./state.ts";
import { vestingTimeline, type VestingInputs } from "./vesting.ts";

/**
 * The ISO $100,000 test (the ledger and product rules; IRC §422(d)).
 *
 * For an optionee, take app-recorded and attested outside ISO grants from a parent or subsidiary, ordered by
 * grant date, then ID. The shares first exercisable in year Y are the vest events and accelerations dated in Y; an
 * early-exercisable grant counts in full in its grant year. Walking the grants with T_Y = Σ FMV at grant × ISO shares
 * already allotted in Y, a grant's ISO shares in Y = min(shares_Y, ⌊(100,000 − T_Y) ÷ FMV⌋); the rest are NSO. "⌊ ⌋"
 * floors to the share unit.
 *
 * The test needs each grant's FMV at grant. A grant without one (or with a zero FMV) is never computed with a
 * substitute: its lots are unclassified and flagged for manual review, and so are later grants' lots in the same
 * years, whose room depends on it.
 */

export const ISO_ANNUAL_LIMIT = Dec.of(100000);

/** Why a grant's lots need manual review. */
export type IsoReview = "FMV_REQUIRED" | "PRIOR_GRANT_UNCLASSIFIED";

export interface IsoYearLot {
  year: number;
  /** Shares first exercisable in the year. */
  shares: Dec;
  /** FMV per share at grant; null when the grant has none. */
  fmv: Rational | null;
  /** shares × FMV at grant, exact; null without an FMV. */
  value: Rational | null;
  iso: Dec;
  nso: Dec;
  /** Shares whose ISO/NSO status can't be computed: manual review. */
  unclassified: Dec;
}

export interface IsoGrantSplit {
  securityId: string;
  displayId: string;
  grantDate: IsoDate;
  fmv: Rational | null;
  years: IsoYearLot[];
  iso: Dec;
  nso: Dec;
  unclassified: Dec;
  review: IsoReview | null;
}

function naturalCompare(a: string, b: string): number {
  const pa = /^(.*?)(\d+)$/.exec(a);
  const pb = /^(.*?)(\d+)$/.exec(b);
  if (pa && pb && pa[1] === pb[1]) return Number(pa[2]) - Number(pb[2]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Σ of the ACTIVE vesting quantities (events and accelerations) by year, on or before `through` when given. Replay
 * asks for this on every ISO exercise, for each of the holder's grants, so it sums instead of building a timeline
 * unless a pause moves events.
 */
function activeQuantityByYear(inputs: VestingInputs, through: IsoDate | null): Map<number, Dec> {
  const totals = new Map<number, Dec>();
  const add = (date: IsoDate, quantity: Dec): void => {
    if (through !== null && date > through) return;
    const year = yearOf(date);
    totals.set(year, (totals.get(year) ?? Dec.ZERO).add(quantity));
  };
  if (inputs.events.length === 0 && inputs.vestedInFullOn !== null) {
    add(inputs.vestedInFullOn, inputs.quantity);
  } else if (inputs.pauses.length > 0) {
    for (const event of vestingTimeline(inputs)) if (event.state === "ACTIVE") add(event.date, event.quantity);
  } else {
    for (const event of inputs.events) {
      const cancelled = inputs.cancelledEventIds !== null ? inputs.cancelledEventIds.has(event.id) : inputs.stopDate !== null && event.date > inputs.stopDate;
      if (!cancelled) add(event.date, event.quantity);
    }
    for (const acceleration of inputs.accelerations) if (!acceleration.alreadyApplied) add(acceleration.date, acceleration.quantity);
  }
  return totals;
}

/**
 * What each year adds to min(running total, cap). Vesting quantities are positive, so this is what the capped
 * timeline adds in the year (the timeline caps at the grant, and `cap` never exceeds it).
 */
function cappedByYear(totals: Map<number, Dec>, cap: Dec): Map<number, Dec> {
  const byYear = new Map<number, Dec>();
  let sum = Dec.ZERO;
  let previous = Dec.ZERO;
  for (const year of [...totals.keys()].sort((a, b) => a - b)) {
    sum = sum.add(totals.get(year)!);
    const reached = Dec.min(sum, cap);
    const added = reached.sub(previous);
    previous = reached;
    if (added.isPositive()) byYear.set(year, added);
  }
  return byYear;
}

/** The shares of a grant that first become exercisable in each year. */
export function firstExercisableByYear(state: LedgerState, security: SecurityState): Map<number, Dec> {
  if (!security.issued || security.issueDate === null) return new Map();
  if (security.earlyExercisable) return new Map([[yearOf(security.issueDate), security.issuedQuantity]]);
  const inputs = vestingInputsFor(state, security);
  const cap = Dec.min(inputs.quantity, security.issuedQuantity.sub(security.cancelledUnvested).clampZero());
  return cappedByYear(activeQuantityByYear(inputs, null), cap);
}

interface GrantInOrder {
  id: string;
  grantDate: IsoDate;
  fmv: Rational | null;
  byYear: Map<number, Dec>;
  security: SecurityState | null;
}

/** An optionee's ISO grants in statutory order: grant date, then recorded grant id. */
function grantsInOrder(state: LedgerState, stakeholderId: string, outside: readonly OutsideIsoGrant[]): GrantInOrder[] {
  const grants: GrantInOrder[] = [];
  for (const s of state.securitiesByStakeholder.get(stakeholderId) ?? []) {
    if (s.identity.subtype !== "OPTION_ISO" || !s.issued || s.retracted || s.issueDate === null) continue;
    grants.push({ id: s.identity.displayId, grantDate: s.issueDate, fmv: s.fmvAtGrant, byYear: firstExercisableByYear(state, s), security: s });
  }
  for (const grant of outside) grants.push({ id: grant.id, grantDate: grant.grantDate, fmv: grant.fmv, byYear: grant.firstExercisable, security: null });
  return grants.sort((a, b) => (a.grantDate < b.grantDate ? -1 : a.grantDate > b.grantDate ? 1 : naturalCompare(a.id, b.id)));
}

/** The app-recorded ISO grants of the same optionee that come before this one in statutory order. */
export function precedingIsoGrants(state: LedgerState, security: SecurityState): SecurityState[] {
  const ordered = grantsInOrder(state, security.identity.stakeholderId, []);
  const index = ordered.findIndex((g) => g.security === security);
  return index < 0 ? [] : ordered.slice(0, index).map((g) => g.security!);
}

/**
 * Outside grants given directly (a preview) get the checks replay applies to the stakeholder's row: an id is the
 * tie-break on a shared grant date, so each is unique and no security's display id. A repeat would use the limit
 * twice, a collision would make the order ambiguous.
 */
function checkOutsideIds(state: LedgerState, outside: readonly OutsideIsoGrant[]): void {
  const seen = new Set<string>();
  const displayIds = new Set([...state.securities.values()].map((s) => s.identity.displayId));
  for (const grant of outside) {
    if (seen.has(grant.id)) throw new EngineError("OUTSIDE_ISO_GRANT_ID", `Outside ISO grant id ${grant.id} is given twice`);
    if (displayIds.has(grant.id)) throw new EngineError("OUTSIDE_ISO_GRANT_ID", `Outside ISO grant id ${grant.id} is also a security's display id`);
    seen.add(grant.id);
  }
}

/**
 * ISO/NSO lots by year for every ISO grant of a stakeholder, in grant order. Outside grants
 * come from the stakeholder's reference row (validated by replay) unless given.
 */
export function isoSplit(state: LedgerState, stakeholderId: string, outside?: readonly OutsideIsoGrant[]): IsoGrantSplit[] {
  if (outside !== undefined) checkOutsideIds(state, outside);
  const grants = grantsInOrder(state, stakeholderId, outside ?? state.stakeholders.get(stakeholderId)?.outsideIsoGrants ?? []);
  const used = new Map<number, Rational>();
  const unclassifiedYears = new Set<number>();
  const limit = Rational.fromDec(ISO_ANNUAL_LIMIT);
  const result: IsoGrantSplit[] = [];
  for (const grant of grants) {
    const fmv = grant.fmv !== null && grant.fmv.sign() > 0 ? grant.fmv : null;
    const years: IsoYearLot[] = [];
    let review: IsoReview | null = fmv === null ? "FMV_REQUIRED" : null;
    for (const year of [...grant.byYear.keys()].sort((a, b) => a - b)) {
      const shares = grant.byYear.get(year)!;
      if (fmv === null || unclassifiedYears.has(year)) {
        // Without this grant's FMV (or an earlier grant's), the year's room is unknown: nothing is guessed.
        unclassifiedYears.add(year);
        review ??= "PRIOR_GRANT_UNCLASSIFIED";
        years.push({ year, shares, fmv, value: fmv === null ? null : Rational.fromDec(shares).mul(fmv), iso: Dec.ZERO, nso: Dec.ZERO, unclassified: shares });
        continue;
      }
      const room = limit.sub(used.get(year) ?? Rational.ZERO);
      const iso = room.sign() <= 0 ? Dec.ZERO : Dec.min(shares, room.div(fmv).floorToUnit(state.shareUnit));
      used.set(year, (used.get(year) ?? Rational.ZERO).add(Rational.fromDec(iso).mul(fmv)));
      years.push({ year, shares, fmv, value: Rational.fromDec(shares).mul(fmv), iso, nso: shares.sub(iso), unclassified: Dec.ZERO });
    }
    if (grant.security === null) continue;
    result.push({
      securityId: grant.security.identity.id,
      displayId: grant.security.identity.displayId,
      grantDate: grant.grantDate,
      fmv,
      years,
      iso: Dec.sum(years.map((y) => y.iso)),
      nso: Dec.sum(years.map((y) => y.nso)),
      unclassified: Dec.sum(years.map((y) => y.unclassified)),
      review,
    });
  }
  return result;
}

/** Σ FMV × shares first exercisable in a year across an optionee's ISO grants (the product rulesexamples). */
export function isoYearValue(state: LedgerState, stakeholderId: string, year: number): Rational {
  let total = Rational.ZERO;
  for (const grant of isoSplit(state, stakeholderId)) {
    for (const lot of grant.years) if (lot.year === year && lot.value !== null) total = total.add(lot.value);
  }
  return total;
}

export interface LotAvailability {
  iso: Dec;
  nso: Dec;
  /** Vested and unexercised on the date. */
  total: Dec;
  /** The grant's lots need manual review (no FMV at grant here or on an earlier grant): `iso` counts no such lot. */
  review: boolean;
}

/**
 * The ISO and NSO lots an exercise on `date` can use, consuming ISO lots first: vested lots by year,
 * less the lots earlier exercises consumed (an early-exercisable grant: all its lots). An NSO grant has only NSO lots.
 */
export function isoLotsAvailable(state: LedgerState, security: SecurityState, date: IsoDate): LotAvailability {
  const position = positionAt(state, security, date);
  // An early-exercisable grant can consume unvested lots, so all its lots are available.
  const total = security.earlyExercisable ? security.outstanding.clampZero() : position.vestedOutstanding;
  if (security.identity.subtype !== "OPTION_ISO") return { iso: Dec.ZERO, nso: total, total, review: false };
  const split = isoSplit(state, security.identity.stakeholderId).find((g) => g.securityId === security.identity.id);
  let vestedIso = Dec.ZERO;
  let vestedNso = Dec.ZERO;
  if (!split) {
    vestedNso = position.vested;
  } else if (security.earlyExercisable) {
    vestedIso = split.iso;
    vestedNso = split.nso;
  } else {
    // The lots vested by the date, year by year: each year's ISO lots first, the rest NSO.
    const isoByYear = new Map(split.years.map((y) => [y.year, y.iso]));
    const inputs = vestingInputsFor(state, security);
    for (const [year, added] of cappedByYear(activeQuantityByYear(inputs, date), Dec.min(inputs.quantity, position.vested))) {
      const iso = Dec.min(added, isoByYear.get(year) ?? Dec.ZERO);
      vestedIso = vestedIso.add(iso);
      vestedNso = vestedNso.add(added.sub(iso));
    }
  }
  const consumedIso = Dec.sum(security.exercises.map((e) => e.lotsConsumed.iso));
  const consumedNso = Dec.sum(security.exercises.map((e) => e.lotsConsumed.nso));
  let iso = vestedIso.sub(consumedIso).clampZero();
  let nso = vestedNso.sub(consumedNso).clampZero();
  if (iso.add(nso).lt(total)) nso = total.sub(iso);
  iso = Dec.min(iso, total);
  nso = Dec.min(nso, total);
  return { iso, nso, total, review: split !== undefined && split.review !== null };
}
