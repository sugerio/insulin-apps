import { engine, type api } from "#shared";

// What the holder portal derives from the allowlisted portal payloads, and nothing else: every figure here
// is a sum, difference or product of the holder's own numbers, computed with the engine's exact decimals (`Dec`: sums
// align scales and products add them, so nothing is ever truncated). No percentage of ownership, no fully
// diluted figure, no other holder and no org total exists in these payloads, so none can appear on a portal page.

type Security = api.PortalSecurity;

/** A canonical decimal from a portal payload as an exact engine decimal; null (a figure the family hasn't) is zero. */
export function decOf(value: string | null | undefined): engine.Dec {
  return value ? engine.Dec.parse(value) : engine.Dec.ZERO;
}

function sum(values: readonly (string | null | undefined)[]): string {
  return engine.Dec.sum(values.map(decOf)).toString();
}

export function isPositive(value: string | null | undefined): boolean {
  return decOf(value).isPositive();
}

/** The portal route of a security below the portal's base: SAFEs live under `convertibles/`. */
export function securityPath(security: Pick<Security, "id" | "family">): string {
  return security.family === "CONVERTIBLE" ? `convertibles/${security.id}` : `securities/${security.id}`;
}

/** "ISO option", "Series Seed Preferred", "Warrant", "SAFE". */
export function typeLabel(security: Pick<Security, "family" | "optionType" | "className">): string {
  switch (security.family) {
    case "EQUITY_COMPENSATION":
      return security.optionType ? `${security.optionType} option` : "Option";
    case "STOCK":
      return security.className ?? "Shares";
    case "WARRANT":
      return "Warrant";
    case "CONVERTIBLE":
      return "SAFE";
  }
}

/** The unit a security's quantities are in. */
export function unitOf(security: Pick<Security, "family">): "options" | "shares" {
  return security.family === "EQUITY_COMPENSATION" ? "options" : "shares";
}

/**
 * The holder's own signature is still missing: nothing of the grant can be exercised until they sign. A grant awaiting
 * only the company's countersignature can be exercised.
 */
export function awaitingHolderSignature(security: Pick<Security, "executionPending">): boolean {
  return security.executionPending === "pending_holder" || security.executionPending === "pending_both";
}

/** Whose signature a security awaits, in the holder's words. */
export const EXECUTION_PENDING_LABELS: Record<NonNullable<Security["executionPending"]>, string> = {
  pending_holder: "Awaiting your signature",
  pending_company: "Awaiting the company's signature",
  pending_both: "Awaiting signatures",
};

/** Outstanding options that have vested (outstanding minus unvested), never below zero. */
export function vestedUnexercised(security: Security): string {
  return decOf(security.numbers.outstanding).sub(decOf(security.numbers.unvested)).clampZero().toString();
}

export interface ShareClassHolding {
  className: string;
  quantity: string;
  records: Security[];
}

export interface HoldingSummary {
  sharesByClass: ShareClassHolding[];
  /** Outstanding options; null when the holder has none on record. */
  options: { outstanding: string; vestedUnexercised: string; unvested: string; cancelled: string; grants: Security[] } | null;
  warrants: string | null;
  safes: Security[];
}

/** The overview's tiles and vesting card: shares by class, options, warrants and converted SAFEs. */
export function summarize(securities: readonly Security[]): HoldingSummary {
  const shares = securities.filter((security) => security.family === "STOCK" && isPositive(security.numbers.outstanding));
  const classes = new Map<string, ShareClassHolding>();
  for (const security of shares) {
    const name = security.className ?? "Shares";
    const entry = classes.get(name) ?? { className: name, quantity: "0", records: [] };
    entry.quantity = sum([entry.quantity, security.numbers.outstanding]);
    entry.records.push(security);
    classes.set(name, entry);
  }
  const grants = securities.filter((security) => security.family === "EQUITY_COMPENSATION");
  const live = grants.filter((security) => security.status === "OUTSTANDING");
  const warrants = securities.filter((security) => security.family === "WARRANT" && security.status === "OUTSTANDING");
  return {
    sharesByClass: [...classes.values()],
    options: grants.length
      ? {
          outstanding: sum(live.map((security) => security.numbers.outstanding)),
          vestedUnexercised: sum(live.map(vestedUnexercised)),
          unvested: sum(live.map((security) => security.numbers.unvested)),
          cancelled: sum(grants.map((security) => security.numbers.cancelled)),
          grants,
        }
      : null,
    warrants: warrants.length ? sum(warrants.map((security) => security.numbers.outstanding)) : null,
    safes: securities.filter((security) => security.family === "CONVERTIBLE"),
  };
}

/** Where an ISO deadline stands for a former employee's grant. */
export type IsoDeadlineState =
  /** No ISO deadline before the contractual one: an NSO, a death, or an ISO deadline capped at the contractual deadline. */
  | { kind: "none" }
  /** Exercises after `date` are taxed as NSOs. */
  | { kind: "upcoming"; date: string }
  /** `date` has passed: every exercise from now on is taxed as an NSO, while the contractual window stays open. */
  | { kind: "passed"; date: string };

export function isoDeadlineState(security: Pick<Security, "isoDeadline" | "contractualDeadline">, today: string): IsoDeadlineState {
  const iso = security.isoDeadline;
  if (iso === null || (security.contractualDeadline !== null && iso >= security.contractualDeadline)) return { kind: "none" };
  return iso < today ? { kind: "passed", date: iso } : { kind: "upcoming", date: iso };
}

/** One exit-window statement: grants that share both deadlines, so their options add up exactly. */
export interface ExitWindow {
  /** The contractual deadline every grant here shares. */
  deadline: string;
  iso: IsoDeadlineState;
  /**
   * The grant awaits the holder's own signature: nothing of it is exercisable until they sign, while its window
   * runs all the same. Such a window holds that one grant.
   */
  awaitingSignature: boolean;
  /** Vested options of these grants the holder can still exercise: now, or once they have signed. */
  quantity: string;
  grants: Security[];
}

/**
 * A former holder's open exercise windows (the overview banner): outstanding options with something
 * exercisable and a contractual deadline (set only for terminated holders) that hasn't passed. Grants are grouped by
 * their contractual and ISO deadlines, so a sum never borrows another grant's date; earliest deadline first. A grant
 * awaiting the holder's signature has nothing exercisable, but its deadline is shown all the same, on its own.
 */
export function exitWindows(securities: readonly Security[], today: string): ExitWindow[] {
  const groups = new Map<string, ExitWindow>();
  for (const security of securities) {
    const deadline = security.contractualDeadline;
    if (security.family !== "EQUITY_COMPENSATION" || security.status !== "OUTSTANDING" || deadline === null || deadline < today) continue;
    const awaitingSignature = awaitingHolderSignature(security);
    const quantity = awaitingSignature ? vestedUnexercised(security) : security.numbers.exercisable;
    if (!isPositive(quantity)) continue;
    const iso = isoDeadlineState(security, today);
    const key = awaitingSignature ? `signature|${security.id}` : `${deadline}|${iso.kind === "none" ? "" : iso.date}`;
    const group = groups.get(key) ?? { deadline, iso, awaitingSignature, quantity: "0", grants: [] };
    group.quantity = sum([group.quantity, quantity]);
    group.grants.push(security);
    groups.set(key, group);
  }
  const isoDate = (window: ExitWindow) => (window.iso.kind === "none" ? "" : window.iso.date);
  return [...groups.values()].sort((a, b) => a.deadline.localeCompare(b.deadline) || isoDate(a).localeCompare(isoDate(b))
    || Number(a.awaitingSignature) - Number(b.awaitingSignature));
}

export interface UpcomingVest {
  date: string;
  quantity: string;
  unit: "options" | "shares";
  security: Security;
}

/** The next vest events across the holder's securities (the overview's "Upcoming vest events", 6 by default). */
export function upcomingVests(securities: readonly Security[], limit = 6): UpcomingVest[] {
  return securities
    .flatMap((security) => security.vesting.filter((event) => event.status === "UPCOMING").map((event) => ({ date: event.date, quantity: event.quantity, unit: unitOf(security), security })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.security.displayId.localeCompare(b.security.displayId, undefined, { numeric: true }))
    .slice(0, limit);
}

/** "NPS" for "Nadia Pereira-Stone": the first letter of every part of the name, hyphenated parts included. */
export function initials(name: string): string {
  return name.split(/[\s-]+/).map((part) => part.replace(/[^\p{L}]/gu, "")[0] ?? "").join("").toUpperCase();
}

/**
 * The reference to quote with a payment, from the company's format (e.g. "EX-<grant>-<initials>"): the grant's ID and
 * the holder's initials filled in; any other placeholder is left for the holder to complete.
 */
export function paymentReference(format: string, grantDisplayId: string | null, holderName: string): string {
  let reference = format.replace(/<\s*(holder\s+)?initials\s*>/gi, initials(holderName));
  if (grantDisplayId) reference = reference.replace(/<\s*grant\s*>/gi, grantDisplayId);
  return reference;
}

/** The most a holder can ask to exercise: whole options only, never more than is exercisable. */
export function maxWholeOptions(exercisable: string | null): string {
  return decOf(exercisable).roundTo(0, "FLOOR").toString();
}

/** A typed number of options to exercise: whole, at least one, at most `maxWholeOptions`; or what is wrong with it. */
export function exerciseQuantity(input: string, exercisable: string | null): { quantity: string } | { problem: "not_whole" | "none" | "too_many" } {
  const text = input.trim().replace(/,/g, "");
  if (!/^\d+$/.test(text)) return { problem: "not_whole" };
  const quantity = engine.Dec.from(text);
  if (!quantity.isPositive()) return { problem: "none" };
  if (quantity.gt(maxWholeOptions(exercisable))) return { problem: "too_many" };
  return { quantity: quantity.toString() };
}

/** Exercise cost = strike × quantity: an exact product (its scale is the sum of theirs, so no digit is ever lost). */
export function exerciseCost(quantity: string, strike: string): engine.Dec {
  return decOf(quantity).mul(decOf(strike));
}

/**
 * Computed money at the display edge: HALF_EVEN to the cent, the named rounding for computed money.
 * `rounded` says the exact amount had more digits, so the page can say it was rounded.
 */
export function formatComputedMoney(amount: engine.Dec): { text: string; rounded: boolean } {
  return { text: engine.formatMoney(amount, { decimals: 2, mode: "HALF_EVEN" }), rounded: amount.scale > 2 };
}

/** Recorded money shown exactly, as recorded: "$50,000", "$50,000.25" (never rounded; cents shown once there are any). */
export function formatRecordedMoney(value: string): string {
  const amount = decOf(value);
  return `$${engine.formatDecimal(amount, { minFractionDigits: amount.isInteger() ? 0 : 2 })}`;
}

/** A SAFE's discount, stored as a fraction (0.2), as the percentage its terms state ("20%"), exactly. */
export function discountLabel(rate: string): string {
  return `${decOf(rate).mul(100).toString()}%`;
}
