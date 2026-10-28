import { daysBetween, type IsoDate } from "./dates.ts";
import { Dec } from "./decimal.ts";
import { Rational } from "./rational.ts";

/**
 * 409A status (the API and product rules). Valuations are immutable reference rows; their status for a date is
 * computed from the dates and the append-only `valuation_events`. The engine uses it to pick the FMV a grant or an
 * exercise snapshots; the web shows the same computation.
 */

export type ValuationStatus =
  | "presumptively_valid" | "expiring_soon" | "review_required" | "superseded" | "expired" | "voided" | "draft" | "not_409a" | "not_yet_effective";

export type ValuationEventKind = "MATERIAL_EVENT" | "REVIEW_CLEARED" | "VOIDED" | "EVENT_REVERSED";

/** `valuations.valuation_type`: a 409A, or another valuation (Pulley's token FMV is imported as OTHER). */
export type ValuationType = "409A" | "OTHER";

/** `valuations.report_version`: the provider's final report, or a draft (Pulley keeps drafts). */
export type ValuationReportVersion = "FINAL" | "DRAFT";

export interface ValuationEventRecord {
  id: string;
  kind: ValuationEventKind;
  eventDate: IsoDate;
  reversesEventId: string | null;
  /**
   * The event's recording ordinal: orders events of the same date (a confirmation clears only the flags recorded before
   * it). The writer stores it in `created_at`, strictly increasing across the org's events in the order they were
   * recorded. Absent (fixtures), a same-day confirmation counts as recorded after the flag.
   */
  createdAt?: number;
}

export interface ValuationRecord {
  id: string;
  /**
   * Only a 409A is in effect for option pricing (the product rules): it alone prices grants and exercises, supersedes
   * another 409A and takes a material-event flag. A valuation of another type never does any of it, and its status is
   * `not_409a` until it is voided.
   */
  valuationType: ValuationType;
  /**
   * A draft report is never valid, presumptively valid or in effect (the conservative safe-harbour reading): it never
   * prices, supersedes a final report or takes a flag, and its status is `draft` until it is voided.
   */
  reportVersion: ValuationReportVersion;
  effectiveDate: IsoDate;
  expirationDate: IsoDate | null;
  prices: readonly { stockClassId: string; pricePerShare: string }[];
  events: readonly ValuationEventRecord[];
}

/** Days before expiry when a valid 409A shows as expiring soon. */
export const EXPIRING_SOON_DAYS = 60;

function voidedOn(valuation: ValuationRecord, date: IsoDate): boolean {
  return valuation.events.some((event) => event.kind === "VOIDED" && event.eventDate <= date);
}

/**
 * Whether the valuation is a final 409A report: the only kind that is ever in effect, prices, supersedes another or
 * takes a flag. Every 409A rule below reads only these.
 */
export function isFinal409A(valuation: ValuationRecord): boolean {
  return valuation.valuationType === "409A" && valuation.reportVersion === "FINAL";
}

/** Whether the valuation ever counted: a final 409A report, not voided on or before its effective date. */
export function tookEffect(valuation: ValuationRecord): boolean {
  return isFinal409A(valuation) && !voidedOn(valuation, valuation.effectiveDate);
}

/**
 * The later final 409A, in effect on `date`, that supersedes this one (a voided one supersedes nothing from its void
 * on). Only final 409As supersede or are superseded.
 */
export function supersededBy(valuation: ValuationRecord, all: readonly ValuationRecord[], date: IsoDate): ValuationRecord | null {
  if (!isFinal409A(valuation)) return null;
  let result: ValuationRecord | null = null;
  for (const other of all) {
    if (other.id === valuation.id || !isFinal409A(other)) continue;
    if (other.effectiveDate <= valuation.effectiveDate || other.effectiveDate > date) continue;
    if (voidedOn(other, date)) continue;
    if (result === null || other.effectiveDate < result.effectiveDate) result = other;
  }
  return result;
}

/**
 * the API contract: events are ordered by `eventDate`, then by their recording ordinal (`createdAt`), then by id. Without an
 * ordinal on both sides (fixtures), a same-day confirmation counts as recorded after the flag.
 */
function after(later: ValuationEventRecord, earlier: ValuationEventRecord): boolean {
  if (later.eventDate !== earlier.eventDate) return later.eventDate > earlier.eventDate;
  if (later.createdAt === undefined || earlier.createdAt === undefined) return true;
  return later.createdAt !== earlier.createdAt ? later.createdAt > earlier.createdAt : later.id > earlier.id;
}

function chronological(a: ValuationEventRecord, b: ValuationEventRecord): number {
  if (a.eventDate !== b.eventDate) return a.eventDate < b.eventDate ? -1 : 1;
  if ((a.createdAt ?? 0) !== (b.createdAt ?? 0)) return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The material event that requires review on `date`: flagged on or after the effective date, not reversed
 * (EVENT_REVERSED), and cleared neither by a REVIEW_CLEARED recorded after it (clearing is chronological, so a flag
 * recorded after a confirmation needs review again, the same day included) nor by a later valuation of the same type
 * that took effect after it, on or before `date`. That clearance holds even if the later valuation was voided since: it
 * counted from its effective date to its void, so a valuation it superseded comes back without the flags it cleared.
 */
export function openMaterialEvent(valuation: ValuationRecord, date: IsoDate, all: readonly ValuationRecord[]): ValuationEventRecord | null {
  // Only a final 409A takes flags: a draft's or another type's events never require review (nor clear anything).
  if (!isFinal409A(valuation)) return null;
  const reversed = new Set(valuation.events.filter((e) => e.kind === "EVENT_REVERSED" && e.eventDate <= date).map((e) => e.reversesEventId));
  const ordered = [...valuation.events].sort(chronological);
  for (const event of ordered) {
    if (event.kind !== "MATERIAL_EVENT" || event.eventDate < valuation.effectiveDate || event.eventDate > date) continue;
    if (reversed.has(event.id)) continue;
    if (valuation.events.some((e) => e.kind === "REVIEW_CLEARED" && e.eventDate <= date && after(e, event))) continue;
    const superseded = all.some((other) =>
      other.id !== valuation.id && tookEffect(other) && other.effectiveDate > valuation.effectiveDate
      && other.effectiveDate > event.eventDate && other.effectiveDate <= date);
    if (!superseded) return event;
  }
  return null;
}

export function valuationStatus(valuation: ValuationRecord, all: readonly ValuationRecord[], date: IsoDate): ValuationStatus {
  if (valuation.valuationType !== "409A") return voidedOn(valuation, date) ? "voided" : "not_409a";
  if (valuation.reportVersion === "DRAFT") return voidedOn(valuation, date) ? "voided" : "draft";
  if (valuation.effectiveDate > date) return "not_yet_effective";
  if (voidedOn(valuation, date)) return "voided";
  if (supersededBy(valuation, all, date)) return "superseded";
  if (valuation.expirationDate !== null && date >= valuation.expirationDate) return "expired";
  if (openMaterialEvent(valuation, date, all)) return "review_required";
  if (valuation.expirationDate !== null && daysBetween(date, valuation.expirationDate) <= EXPIRING_SOON_DAYS) return "expiring_soon";
  return "presumptively_valid";
}

/**
 * The 409A in effect on `date` (the latest effective final report, not voided), valid or not. No other type, and no
 * draft, is ever in effect.
 */
export function valuationInEffect(all: readonly ValuationRecord[], date: IsoDate): ValuationRecord | null {
  let result: ValuationRecord | null = null;
  for (const valuation of all) {
    if (!isFinal409A(valuation) || valuation.effectiveDate > date || voidedOn(valuation, date)) continue;
    if (result === null || valuation.effectiveDate > result.effectiveDate) result = valuation;
  }
  return result;
}

/** The 409A presumptively valid on `date` (valid or expiring soon), or null: what a material event attaches to. */
export function presumptivelyValidOn(all: readonly ValuationRecord[], date: IsoDate): ValuationRecord | null {
  const valuation = valuationInEffect(all, date);
  if (valuation === null) return null;
  const status = valuationStatus(valuation, all, date);
  return status === "presumptively_valid" || status === "expiring_soon" ? valuation : null;
}

/** A split of the class: post-split shares per pre-split share, on its date (the engine's `ClassState.splits`). */
export interface FmvSplit {
  date: IsoDate;
  ratio: Rational;
}

/**
 * A class's price per share reported on `from`, in shares of `to`: divided by the class's splits after `from`, on or
 * before `to`. A price the splits leave non-terminating rounds half-even to 12 decimal places, the storage precision.
 */
export function splitAdjustedPrice(price: Dec, from: IsoDate, to: IsoDate, splits: readonly FmvSplit[]): { price: Dec; splitAdjusted: boolean } {
  let ratio = Rational.ONE;
  for (const split of splits) if (split.date > from && split.date <= to) ratio = ratio.mul(split.ratio);
  if (ratio.eq(Rational.ONE)) return { price, splitAdjusted: false };
  const exact = Rational.fromDec(price).div(ratio);
  const terminating = exact.toDecExact();
  return { price: terminating !== null && Dec.isCanonical(terminating.toString()) ? terminating : exact.roundTo(12, "HALF_EVEN"), splitAdjusted: true };
}

export type FmvLookup =
  | { valid: true; valuation: ValuationRecord; pricePerShare: Dec; splitAdjusted: boolean; status: "presumptively_valid" | "expiring_soon" }
  | { valid: false; valuation: ValuationRecord | null; pricePerShare: Dec | null; splitAdjusted: boolean; reason: "none" | "expired" | "review_required" | "no_price_for_class" };

/**
 * The FMV for a class on a date (the product rules): the price of the presumptively valid 409A, adjusted for the class's
 * splits since it took effect. It is the one figure the FMV endpoint shows, a grant's strike is checked against, and
 * a grant or an exercise snapshots. When none is valid, the caller blocks the grant (or an exercise needs a manual FMV
 * with its source) and shows `reason`.
 */
export function fmvOn(all: readonly ValuationRecord[], date: IsoDate, stockClassId: string, splits: readonly FmvSplit[]): FmvLookup {
  const valuation = valuationInEffect(all, date);
  if (valuation === null) return { valid: false, valuation: null, pricePerShare: null, splitAdjusted: false, reason: "none" };
  const price = valuation.prices.find((p) => p.stockClassId === stockClassId);
  const adjusted = price ? splitAdjustedPrice(Dec.parse(price.pricePerShare), valuation.effectiveDate, date, splits) : null;
  const status = valuationStatus(valuation, all, date);
  if (status === "expired" || status === "review_required") {
    return { valid: false, valuation, pricePerShare: adjusted?.price ?? null, splitAdjusted: adjusted?.splitAdjusted ?? false, reason: status };
  }
  if (adjusted === null) return { valid: false, valuation, pricePerShare: null, splitAdjusted: false, reason: "no_price_for_class" };
  return { valid: true, valuation, pricePerShare: adjusted.price, splitAdjusted: adjusted.splitAdjusted, status: status === "expiring_soon" ? "expiring_soon" : "presumptively_valid" };
}
