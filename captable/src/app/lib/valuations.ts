import type { api } from "#shared";

// 409A material events and what resolved them. A material event puts the
// valuation it was flagged on into "review required" until either an admin records the provider's or counsel's
// written confirmation (REVIEW_CLEARED) after it, or a later valuation takes effect after it. Events are ordered by
// their legal date, then by when they were recorded; an event that was reversed (EVENT_REVERSED) counts for nothing.
// The valuation's computed status is the authority: these helpers only explain it per event.
//
// Only a final 409A counts: it is the one in effect, prices grants, supersedes an earlier 409A and takes
// or clears a material-event flag. Another type of valuation (an imported "OTHER") and a 409A whose report is a draft
// are shown as what they are, never as the 409A in effect.

/**
 * A final 409A: the only valuation that can be in effect, supersede another or carry a material event. The same rule
 * as the engine's `isFinal409A` (the server reads the others with status `draft` or `not_409a`).
 */
export function counts409A(valuation: Pick<api.Valuation, "valuationType" | "reportVersion">): boolean {
  return valuation.valuationType === "409A" && valuation.reportVersion === "FINAL";
}

export type Resolution =
  | { kind: "confirmation"; date: string }
  | { kind: "valuation"; date: string; valuationName: string }
  | { kind: "voided"; date: string };

export interface MaterialEventState {
  event: api.ValuationEvent;
  /** Null while the event is open: the valuation needs review. */
  resolution: Resolution | null;
}

function chronological(a: api.ValuationEvent, b: api.ValuationEvent): number {
  return a.eventDate === b.eventDate ? a.createdAt - b.createdAt : a.eventDate < b.eventDate ? -1 : 1;
}

function reversedIds(valuation: api.Valuation): Set<string> {
  return new Set(valuation.events.filter((event) => event.kind === "EVENT_REVERSED" && event.reversesEventId).map((event) => event.reversesEventId!));
}

/**
 * Every material event flagged on `valuation` that wasn't reversed, oldest first, with what resolved it:
 * - the first written confirmation recorded after it on the same valuation;
 * - else the first later valuation (not voided) that took effect after the event, on or before `today`;
 * - else the valuation's own voiding;
 * - else nothing: it is open.
 * When the server says the valuation needs review but every event looks resolved by these rules, the newest event is
 * shown open, so this view never contradicts the computed status.
 */
export function materialEvents(valuation: api.Valuation, all: readonly api.Valuation[], today: string): MaterialEventState[] {
  if (!counts409A(valuation)) return [];
  const reversed = reversedIds(valuation);
  const live = valuation.events.filter((event) => !reversed.has(event.id)).sort(chronological);
  const later = all
    .filter((other) => other.id !== valuation.id && counts409A(other) && other.status !== "voided" && other.effectiveDate > valuation.effectiveDate && other.effectiveDate <= today)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const voided = live.find((event) => event.kind === "VOIDED");
  const states = live
    .filter((event) => event.kind === "MATERIAL_EVENT")
    .map((event): MaterialEventState => {
      const confirmation = live.find((other) => other.kind === "REVIEW_CLEARED" && chronological(other, event) > 0);
      const valuationAfter = later.find((other) => other.effectiveDate > event.eventDate);
      const candidates: Resolution[] = [];
      if (confirmation) candidates.push({ kind: "confirmation", date: confirmation.eventDate });
      if (valuationAfter) candidates.push({ kind: "valuation", date: valuationAfter.effectiveDate, valuationName: valuationAfter.name });
      if (voided && chronological(voided, event) > 0) candidates.push({ kind: "voided", date: voided.eventDate });
      candidates.sort((a, b) => a.date.localeCompare(b.date));
      return { event, resolution: candidates[0] ?? null };
    });
  if (valuation.status === "review_required" && states.length && states.every((state) => state.resolution !== null)) {
    states[states.length - 1] = { ...states[states.length - 1]!, resolution: null };
  }
  return states;
}

/** The open material events of a valuation, oldest first (empty unless it needs review). */
export function openMaterialEvents(valuation: api.Valuation, all: readonly api.Valuation[], today: string): api.ValuationEvent[] {
  return materialEvents(valuation, all, today).filter((state) => state.resolution === null).map((state) => state.event);
}

/** The 409A in effect today: the latest effective final 409A that a later one hasn't superseded. */
export function currentValuation(valuations: readonly api.Valuation[], today: string): api.Valuation | null {
  return valuations
    .filter((valuation) => counts409A(valuation) && valuation.effectiveDate <= today && valuation.status !== "voided" && valuation.status !== "superseded")
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0] ?? null;
}

/**
 * The FMV of one class in a valuation, matched by class id; the common class when no id is given. Null when the
 * valuation has no price for it. Never guessed from the order of `prices` (the contract doesn't order them).
 */
export function classPrice(valuation: Pick<api.Valuation, "prices">, classes: readonly api.StockClass[], stockClassId?: string | null): string | null {
  const classId = stockClassId ?? classes.find((item) => item.classType === "COMMON")?.id;
  if (!classId) return null;
  return valuation.prices.find((price) => price.stockClassId === classId)?.pricePerShare ?? null;
}
