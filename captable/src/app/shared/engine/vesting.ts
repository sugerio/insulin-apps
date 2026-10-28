import "./zod-config.ts";
import { z } from "zod";
import { addDays, addMonths, daysBetween, type IsoDate } from "./dates.ts";
import { Dec, type DecInput } from "./decimal.ts";
import { EngineError } from "./errors.ts";
import { Rational, type RationalInput } from "./rational.ts";
import { IsoDateString, PositiveDecimalString } from "./schemas.ts";

/**
 * Vesting (the ledger and product rules).
 *
 * Definitions live in the immutable `vesting_terms` rows: `SCHEDULE` templates expanded by the tranche generator for
 * new grants, and `EXPLICIT` event lists for every migrated grant (Pulley's events, authoritative, each with its Pulley
 * id). Whether an event is vested or cancelled is computed: events after the vesting stop are cancelled (or exactly the
 * listed ones, for migrated terminations), accelerations add a dated quantity, and a pause shifts later events.
 */

export const ScheduleDefinition = z.strictObject({
  type: z.literal("SCHEDULE"),
  totalMonths: z.number().int().min(1).max(240),
  frequency: z.enum(["MONTHLY", "QUARTERLY", "ANNUALLY"]),
  cliff: z
    .strictObject({
      months: z.number().int().min(1),
      quantityRule: z.union([z.literal("RATABLE"), z.strictObject({ explicitQuantity: PositiveDecimalString })]),
    })
    .nullable(),
  dayRule: z.literal("SAME_DAY_CLAMPED"),
});

export const ExplicitDefinition = z.strictObject({
  type: z.literal("EXPLICIT"),
  events: z
    .array(
      z.strictObject({
        date: IsoDateString,
        quantity: PositiveDecimalString,
        pulleyId: z.string().min(1).max(100).optional(),
        /** Pulley's TIMED / CUSTOM, mapped by the migration (the migration rules); display only. */
        kind: z.enum(["SCHEDULED", "EXPLICIT"]).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

/** `VestingDefinition` in the API contract (the EXPLICIT events may also carry the migrated `kind`). */
export const VestingDefinition = z.discriminatedUnion("type", [ScheduleDefinition, ExplicitDefinition]);
export type VestingDefinition = z.infer<typeof VestingDefinition>;
export type ScheduleDefinition = z.infer<typeof ScheduleDefinition>;
export type ExplicitDefinition = z.infer<typeof ExplicitDefinition>;

export function parseVestingDefinition(value: unknown): VestingDefinition {
  const result = VestingDefinition.safeParse(value);
  if (!result.success) {
    throw new EngineError("VESTING_DEFINITION_INVALID", result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return result.data;
}

export type VestingEventKind = "CLIFF" | "SCHEDULED" | "EXPLICIT" | "ACCELERATION";

/** One event of a grant's base schedule (before stop, cancellations and accelerations). */
export interface VestingScheduleEvent {
  /** Stable within a grant: "m12" for the generator's month 12, the Pulley id, or "e3" for the 4th explicit event. */
  id: string;
  date: IsoDate;
  quantity: Dec;
  kind: VestingEventKind;
  source: "computed" | "pulley";
}

const PERIOD_MONTHS = { MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12 } as const;

/**
 * The tranche generator (the product rules):
 * - tranche k falls on S + k·p months, same day of month, clamped to the month's last day;
 * - cumulative after month m: 0 before the cliff; the cliff quantity at the cliff; ⌊Q·m/N⌋ after it;
 * - the cliff quantity is ⌊Q·C/N⌋ (ratable) unless an explicit quantity is given, in which case later tranches
 *   spread Q − cliff evenly over the remaining months with the same cumulative floor;
 * - the final tranche absorbs remainders, so the tranches sum to exactly Q.
 * "⌊ ⌋" is FLOOR to the org's share unit. Zero-quantity tranches (tiny grants) are left out.
 */
export function generateSchedule(definition: ScheduleDefinition, quantity: DecInput, startDate: IsoDate, shareUnit: DecInput = Dec.ONE): VestingScheduleEvent[] {
  const total = Dec.from(quantity);
  const unit = Dec.from(shareUnit);
  if (!total.isPositive()) throw new EngineError("VESTING_QUANTITY", "A schedule needs a positive quantity");
  const period = PERIOD_MONTHS[definition.frequency];
  const months = definition.totalMonths;
  if (months % period !== 0) throw new EngineError("VESTING_DEFINITION_INVALID", `${months} months isn't a whole number of periods`);
  const cliffMonths = definition.cliff?.months ?? 0;
  if (cliffMonths > months || cliffMonths % period !== 0) {
    throw new EngineError("VESTING_DEFINITION_INVALID", `A ${cliffMonths}-month cliff doesn't fit the schedule`);
  }
  let cliffQuantity = Dec.ZERO;
  let explicitCliff = false;
  if (definition.cliff) {
    const rule = definition.cliff.quantityRule;
    if (rule === "RATABLE") {
      cliffQuantity = Rational.fromDec(total).mul(cliffMonths).div(months).floorToUnit(unit);
    } else {
      cliffQuantity = Dec.parse(rule.explicitQuantity);
      explicitCliff = true;
      if (cliffQuantity.gt(total)) throw new EngineError("VESTING_DEFINITION_INVALID", "The cliff quantity exceeds the grant");
    }
  }
  const events: VestingScheduleEvent[] = [];
  let previous = Dec.ZERO;
  for (let month = period; month <= months; month += period) {
    if (month < cliffMonths) continue;
    let cumulative: Dec;
    if (month === months) cumulative = total;
    else if (month === cliffMonths) cumulative = cliffQuantity;
    else if (explicitCliff) {
      cumulative = cliffQuantity.add(
        Rational.fromDec(total.sub(cliffQuantity)).mul(month - cliffMonths).div(months - cliffMonths).floorToUnit(unit),
      );
    } else cumulative = Rational.fromDec(total).mul(month).div(months).floorToUnit(unit);
    const amount = cumulative.sub(previous);
    if (amount.isPositive()) {
      events.push({
        id: `m${month}`,
        date: addMonths(startDate, month),
        quantity: amount,
        kind: month === cliffMonths ? "CLIFF" : "SCHEDULED",
        source: "computed",
      });
    }
    previous = cumulative;
  }
  return events;
}

/** An EXPLICIT definition's events in date order (stable for equal dates). */
export function explicitEvents(definition: ExplicitDefinition): VestingScheduleEvent[] {
  return definition.events
    .map((event, index) => ({
      id: event.pulleyId ?? `e${index}`,
      date: event.date,
      quantity: Dec.parse(event.quantity),
      kind: "EXPLICIT" as const,
      source: event.pulleyId !== undefined ? ("pulley" as const) : ("computed" as const),
      index,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.index - b.index))
    .map(({ index: _index, ...event }) => event);
}

/** Expands a definition for a quantity and a vesting start date (the preview endpoint, the API contract). */
export function scheduleEvents(definition: VestingDefinition, quantity: DecInput, startDate: IsoDate, shareUnit: DecInput = Dec.ONE): VestingScheduleEvent[] {
  return definition.type === "SCHEDULE" ? generateSchedule(definition, quantity, startDate, shareUnit) : explicitEvents(definition);
}

/** I11: an EXPLICIT definition's events sum to the grant quantity. */
export function explicitSum(definition: ExplicitDefinition): Dec {
  return Dec.sum(definition.events.map((event) => Dec.parse(event.quantity)));
}

/**
 * Scales base events by a split ratio with the cumulative floor, the last event absorbing the remainder, so the scaled
 * events sum to exactly floor(total × ratio) and vested amounts scale with the shares (the ledger rules).
 */
export function scaleEvents(events: readonly VestingScheduleEvent[], ratio: RationalInput, newTotal: DecInput, shareUnit: DecInput = Dec.ONE): VestingScheduleEvent[] {
  const r = Rational.from(ratio);
  const target = Dec.from(newTotal);
  const scaled: VestingScheduleEvent[] = [];
  let cumulative = Dec.ZERO;
  let previous = Dec.ZERO;
  events.forEach((event, index) => {
    cumulative = cumulative.add(event.quantity);
    const next = index === events.length - 1 ? target : Rational.fromDec(cumulative).mul(r).floorToUnit(shareUnit);
    const amount = next.sub(previous);
    if (amount.isPositive()) scaled.push({ ...event, quantity: amount });
    previous = next;
  });
  return scaled;
}

export interface Acceleration {
  date: IsoDate;
  quantity: Dec;
  /** Migrated accelerations already present in Pulley's explicit events count once. */
  alreadyApplied: boolean;
  transactionId?: string;
}

export interface PauseInterval {
  from: IsoDate;
  /** The resume date, or null while paused. */
  to: IsoDate | null;
}

export interface VestingInputs {
  /** The grant's quantity (split-adjusted): vesting never exceeds it. */
  quantity: Dec;
  /**
   * Base schedule events; empty when the security has no vesting (vested in full at issuance). Quantities are positive
   * (definitions and payloads require it), as are accelerations', which lets `vestedAt` sum instead of walking.
   */
  events: readonly VestingScheduleEvent[];
  /** Fully vested on this date when there is no schedule (OCF: no vesting terms = vested on issuance). */
  vestedInFullOn: IsoDate | null;
  /** The vesting stop of a termination in force, if any. */
  stopDate: IsoDate | null;
  /** Migrated terminations: exactly these events are cancelled instead of every event after the stop. */
  cancelledEventIds: ReadonlySet<string> | null;
  accelerations: readonly Acceleration[];
  pauses: readonly PauseInterval[];
}

export interface VestingTimelineEvent extends VestingScheduleEvent {
  state: "ACTIVE" | "CANCELLED";
  /** Cumulative ACTIVE quantity through this event, capped at the grant quantity. */
  cumulative: Dec;
}

/**
 * Applies recorded pauses to base events: an event on or after a pause start moves later by the paused days, and an
 * event during an open pause doesn't vest. Imports with unsupported pauses fail validation.
 */
function pausedEvents(events: readonly VestingScheduleEvent[], pauses: readonly PauseInterval[]): { event: VestingScheduleEvent; suspended: boolean }[] {
  return events.map((event) => {
    let date = event.date;
    let suspended = false;
    for (const pause of [...pauses].sort((a, b) => (a.from < b.from ? -1 : 1))) {
      if (date < pause.from) continue;
      if (pause.to === null) {
        suspended = true;
        break;
      }
      date = addDays(date, daysBetween(pause.from, pause.to));
    }
    return { event: { ...event, date }, suspended };
  });
}

/** The full timeline: base events with their state, plus acceleration events, in date order, with cumulative totals. */
export function vestingTimeline(inputs: VestingInputs): VestingTimelineEvent[] {
  const timeline: VestingTimelineEvent[] = [];
  if (inputs.events.length === 0 && inputs.vestedInFullOn !== null) {
    timeline.push({
      id: "issuance",
      date: inputs.vestedInFullOn,
      quantity: inputs.quantity,
      kind: "EXPLICIT",
      source: "computed",
      state: "ACTIVE",
      cumulative: inputs.quantity,
    });
    return timeline;
  }
  const entries: { event: VestingScheduleEvent; state: "ACTIVE" | "CANCELLED"; order: number }[] = [];
  pausedEvents(inputs.events, inputs.pauses).forEach(({ event, suspended }, order) => {
    let cancelled = suspended;
    if (inputs.cancelledEventIds !== null) cancelled ||= inputs.cancelledEventIds.has(event.id);
    else if (inputs.stopDate !== null && event.date > inputs.stopDate) cancelled = true;
    entries.push({ event, state: cancelled ? "CANCELLED" : "ACTIVE", order });
  });
  inputs.accelerations.forEach((acceleration, index) => {
    if (acceleration.alreadyApplied) return;
    entries.push({
      event: {
        id: acceleration.transactionId ?? `a${index}`,
        date: acceleration.date,
        quantity: acceleration.quantity,
        kind: "ACCELERATION",
        source: "computed",
      },
      state: "ACTIVE",
      order: inputs.events.length + index,
    });
  });
  entries.sort((a, b) => (a.event.date < b.event.date ? -1 : a.event.date > b.event.date ? 1 : a.order - b.order));
  let cumulative = Dec.ZERO;
  for (const { event, state } of entries) {
    if (state === "ACTIVE") cumulative = Dec.min(inputs.quantity, cumulative.add(event.quantity));
    timeline.push({ ...event, state, cumulative });
  }
  return timeline;
}

/**
 * Quantity vested on `date` (inclusive), before cancellations and exercises are netted: ACTIVE events and
 * accelerations dated on or before it, capped at the grant. An acceleration therefore consumes the last tranches.
 */
export function vestedAt(inputs: VestingInputs, date: IsoDate): Dec {
  if (inputs.events.length === 0 && inputs.vestedInFullOn !== null) {
    return inputs.vestedInFullOn <= date ? inputs.quantity : Dec.ZERO;
  }
  if (inputs.pauses.length > 0) {
    let vested = Dec.ZERO;
    for (const event of vestingTimeline(inputs)) {
      if (event.date > date) break;
      vested = event.cumulative;
    }
    return vested;
  }
  // Without pauses, the capped running total is the capped sum (every increment is positive), so sum directly:
  // replay asks for this on every exercise and cancellation.
  let total = Dec.ZERO;
  for (const event of inputs.events) {
    if (event.date > date) continue;
    const cancelled = inputs.cancelledEventIds !== null ? inputs.cancelledEventIds.has(event.id) : inputs.stopDate !== null && event.date > inputs.stopDate;
    if (!cancelled) total = total.add(event.quantity);
  }
  for (const acceleration of inputs.accelerations) {
    if (!acceleration.alreadyApplied && acceleration.date <= date) total = total.add(acceleration.quantity);
  }
  return Dec.min(inputs.quantity, total);
}

/**
 * Events dated after `date` that will still vest (the portal's "upcoming vests"), each with the quantity it actually
 * adds: an acceleration may already have consumed the last tranches.
 */
export function upcomingEvents(inputs: VestingInputs, date: IsoDate): VestingTimelineEvent[] {
  const upcoming: VestingTimelineEvent[] = [];
  let previous = Dec.ZERO;
  for (const event of vestingTimeline(inputs)) {
    if (event.state !== "ACTIVE") continue;
    const adds = event.cumulative.sub(previous);
    previous = event.cumulative;
    if (event.date > date && adds.isPositive()) upcoming.push({ ...event, quantity: adds });
  }
  return upcoming;
}
