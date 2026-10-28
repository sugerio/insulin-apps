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

/** One exit-window statement: grants that share both deadlines, so their exercisable options add up exactly. */
export interface ExitWindow {
  /** The contractual deadline every grant here shares. */
  deadline: string;
  iso: IsoDeadlineState;
  /** Vested options of these grants the holder can still exercise. */
  exercisable: string;
  grants: Security[];
}

/**
 * A former holder's open exercise windows (the overview banner): outstanding options with something
 * exercisable and a contractual deadline (set only for terminated holders) that hasn't passed. Grants are grouped by
 * their contractual and ISO deadlines, so a sum never borrows another grant's date; earliest deadline first.
 */
export function exitWindows(securities: readonly Security[], today: string): ExitWindow[] {
  const groups = new Map<string, ExitWindow>();
  for (const security of securities) {
    const deadline = security.contractualDeadline;
    if (security.family !== "EQUITY_COMPENSATION" || security.status !== "OUTSTANDING" || deadline === null || deadline < today) continue;
    if (!isPositive(security.numbers.exercisable)) continue;
    const iso = isoDeadlineState(security, today);
    const key = `${deadline}|${iso.kind === "none" ? "" : iso.date}`;
    const group = groups.get(key) ?? { deadline, iso, exercisable: "0", grants: [] };
    group.exercisable = sum([group.exercisable, security.numbers.exercisable]);
    group.grants.push(security);
    groups.set(key, group);
  }
  const isoDate = (window: ExitWindow) => (window.iso.kind === "none" ? "" : window.iso.date);
  return [...groups.values()].sort((a, b) => a.deadline.localeCompare(b.deadline) || isoDate(a).localeCompare(isoDate(b)));
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
