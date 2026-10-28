import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Dec,
  EngineError,
  explicitEvents,
  explicitSum,
  fromEpochDay,
  generateSchedule,
  parseIsoDate,
  parseVestingDefinition,
  Rational,
  scaleEvents,
  scheduleEvents,
  toEpochDay,
  upcomingEvents,
  vestedAt,
  vestingTimeline,
  type ScheduleDefinition,
  type VestingInputs,
} from "../../../src/app/shared/engine/index.ts";
import { monthlyEvents } from "./fixtures/builder.ts";

// Room for full replays and property runs on a loaded CI machine (vitest's default is 5 s per test).
const SLOW = { timeout: 30_000 };

const VS1: ScheduleDefinition = { type: "SCHEDULE", totalMonths: 48, frequency: "MONTHLY", cliff: { months: 12, quantityRule: "RATABLE" }, dayRule: "SAME_DAY_CLAMPED" };
const NO_CLIFF: ScheduleDefinition = { ...VS1, cliff: null };

function quantities(events: { quantity: Dec }[]): string[] {
  return events.map((e) => e.quantity.toString());
}

function inputs(overrides: Partial<VestingInputs> = {}): VestingInputs {
  return {
    quantity: Dec.from(48000),
    events: generateSchedule(VS1, "48000", "2026-01-31"),
    vestedInFullOn: null,
    stopDate: null,
    cancelledEventIds: null,
    accelerations: [],
    pauses: [],
    ...overrides,
  };
}

describe("the tranche generator", SLOW, () => {
  it("vests a ratable cliff, then monthly with the cumulative floor, the last tranche absorbing the remainder", () => {
    const events = generateSchedule(VS1, "40000", "2026-10-19");
    expect(events).toHaveLength(37);
    expect(events[0]).toMatchObject({ id: "m12", date: "2027-10-19", kind: "CLIFF", source: "computed" });
    expect(events[0]!.quantity.toString()).toBe("10000");
    expect(quantities(events.slice(1, 4))).toEqual(["833", "833", "834"]);
    expect(events[36]).toMatchObject({ id: "m48", date: "2030-10-19", kind: "SCHEDULED" });
    expect(Dec.sum(events.map((e) => e.quantity)).toString()).toBe("40000");
  });

  it("matches Pulley-style explicit events built independently", () => {
    for (const [quantity, start] of [
      [400000, "2025-11-17"],
      [72000, "2024-08-15"],
      [99999, "2024-01-31"],
      [7, "2023-02-28"],
    ] as const) {
      const generated = generateSchedule(VS1, String(quantity), start).map((e) => ({ date: e.date, quantity: e.quantity.toString() }));
      expect(generated).toEqual(monthlyEvents(BigInt(quantity), start, 48, 12));
    }
  });

  it("clamps to the month end from the start, never chaining clamped dates", () => {
    const events = generateSchedule(NO_CLIFF, "48", "2027-01-31");
    expect(events.slice(0, 3).map((e) => e.date)).toEqual(["2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(generateSchedule(NO_CLIFF, "48", "2027-02-28")[11]!.date).toBe("2028-02-28"); // not the 29th: same day as the start
    expect(generateSchedule(NO_CLIFF, "48", "2028-01-29")[0]!.date).toBe("2028-02-29");
  });

  it("supports quarterly and annual periods and explicit cliff quantities", () => {
    const quarterly = generateSchedule({ ...VS1, frequency: "QUARTERLY" }, "1200", "2026-01-15");
    expect(quarterly.map((e) => e.date)).toEqual([
      "2027-01-15",
      "2027-04-15",
      "2027-07-15",
      "2027-10-15",
      "2028-01-15",
      "2028-04-15",
      "2028-07-15",
      "2028-10-15",
      "2029-01-15",
      "2029-04-15",
      "2029-07-15",
      "2029-10-15",
      "2030-01-15",
    ]);
    expect(quarterly[0]!.quantity.toString()).toBe("300");
    const annual = generateSchedule({ ...NO_CLIFF, frequency: "ANNUALLY" }, "1000", "2026-03-01");
    expect(quantities(annual)).toEqual(["250", "250", "250", "250"]);
    // An explicit 10% cliff spreads the other 90% over the remaining 36 months with the same floor.
    const explicit = generateSchedule({ ...VS1, cliff: { months: 12, quantityRule: { explicitQuantity: "4800" } } }, "48000", "2026-01-01");
    expect(explicit[0]!.quantity.toString()).toBe("4800");
    expect(explicit[1]!.quantity.toString()).toBe("1200");
    expect(Dec.sum(explicit.map((e) => e.quantity)).toString()).toBe("48000");
    // A cliff as long as the schedule vests everything at the end.
    expect(quantities(generateSchedule({ ...VS1, totalMonths: 12 }, "100", "2026-01-01"))).toEqual(["100"]);
  });

  it("rounds down to the share unit and leaves out empty tranches", () => {
    const fine = generateSchedule(NO_CLIFF, "1", "2026-01-01", "0.001");
    expect(fine[0]!.quantity.toString()).toBe("0.02");
    expect(Dec.sum(fine.map((e) => e.quantity)).toString()).toBe("1");
    const tiny = generateSchedule(VS1, "10", "2026-01-01");
    expect(Dec.sum(tiny.map((e) => e.quantity)).toString()).toBe("10");
    expect(tiny.every((e) => e.quantity.isPositive())).toBe(true);
    expect(tiny.length).toBeLessThan(37);
  });

  it("refuses definitions that don't fit", () => {
    expect(() => generateSchedule(VS1, "0", "2026-01-01")).toThrow(EngineError);
    expect(() => generateSchedule({ ...VS1, frequency: "QUARTERLY", totalMonths: 10 }, "100", "2026-01-01")).toThrow(/whole number of periods/);
    expect(() => generateSchedule({ ...VS1, cliff: { months: 60, quantityRule: "RATABLE" } }, "100", "2026-01-01")).toThrow(/cliff/);
    expect(() => generateSchedule({ ...VS1, frequency: "QUARTERLY", cliff: { months: 4, quantityRule: "RATABLE" } }, "100", "2026-01-01")).toThrow(/cliff/);
    expect(() => generateSchedule({ ...VS1, cliff: { months: 12, quantityRule: { explicitQuantity: "101" } } }, "100", "2026-01-01")).toThrow(/exceeds/);
    expect(() => parseVestingDefinition({ type: "SCHEDULE", totalMonths: 0 })).toThrow(EngineError);
    expect(parseVestingDefinition(VS1)).toEqual(VS1);
  });

  it("satisfies the generator's laws for any grant", () => {
    const arbDefinition = fc.record({
      frequency: fc.constantFrom("MONTHLY" as const, "QUARTERLY" as const, "ANNUALLY" as const),
      periods: fc.integer({ min: 1, max: 20 }),
      cliffPeriods: fc.integer({ min: 0, max: 20 }),
    });
    fc.assert(
      fc.property(arbDefinition, fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.integer({ min: 0, max: 40_000 }), ({ frequency, periods, cliffPeriods }, quantity, day) => {
        const period = { MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12 }[frequency];
        const months = periods * period;
        const cliff = Math.min(cliffPeriods, periods) * period;
        const definition: ScheduleDefinition = { ...VS1, frequency, totalMonths: months, cliff: cliff > 0 ? { months: cliff, quantityRule: "RATABLE" } : null };
        const start = fromEpochDay(toEpochDay("2000-01-01") + day);
        const events = generateSchedule(definition, quantity, start);
        expect(Dec.sum(events.map((e) => e.quantity)).eq(Dec.from(quantity))).toBe(true);
        let previous = "";
        let cumulative = 0n;
        for (const event of events) {
          expect(event.quantity.isPositive()).toBe(true);
          expect(event.date > previous).toBe(true);
          previous = event.date;
          cumulative += event.quantity.mantissa;
          const month = Number(event.id.slice(1));
          if (month < months) expect(cumulative).toBe((quantity * BigInt(month)) / BigInt(months)); // the cumulative floor
          expect(parseIsoDate(event.date).day).toBeLessThanOrEqual(parseIsoDate(start).day);
          expect(month).toBeGreaterThanOrEqual(cliff);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("explicit events", () => {
  it("sorts by date, keeps Pulley ids and checks the sum", () => {
    const definition = {
      type: "EXPLICIT" as const,
      events: [
        { date: "2027-01-01", quantity: "50", pulleyId: "pv-2" },
        { date: "2026-01-01", quantity: "25" },
        { date: "2026-01-01", quantity: "25", kind: "SCHEDULED" as const },
      ],
    };
    const events = explicitEvents(definition);
    expect(events.map((e) => [e.id, e.date, e.source])).toEqual([
      ["e1", "2026-01-01", "computed"],
      ["e2", "2026-01-01", "computed"],
      ["pv-2", "2027-01-01", "pulley"],
    ]);
    expect(explicitSum(definition).toString()).toBe("100");
    expect(scheduleEvents(definition, "100", "2020-01-01")).toEqual(events);
    expect(scheduleEvents(VS1, "48", "2026-01-01")).toHaveLength(37);
  });

  it("scales by a split ratio with the cumulative floor", () => {
    const events = generateSchedule(NO_CLIFF, "10", "2026-01-01");
    const scaled = scaleEvents(events, Rational.of(3, 1), "30");
    expect(Dec.sum(scaled.map((e) => e.quantity)).toString()).toBe("30");
    const reverse = scaleEvents(generateSchedule(NO_CLIFF, "48", "2026-01-01"), Rational.of(1, 10), "4");
    expect(Dec.sum(reverse.map((e) => e.quantity)).toString()).toBe("4");
    expect(reverse.every((e) => e.quantity.isPositive())).toBe(true);
  });
});

describe("the vesting timeline", SLOW, () => {
  it("vests in full at issuance without a schedule", () => {
    const none = inputs({ events: [], vestedInFullOn: "2026-01-01", quantity: Dec.from(500) });
    expect(vestedAt(none, "2025-12-31").toString()).toBe("0");
    expect(vestedAt(none, "2026-01-01").toString()).toBe("500");
    expect(vestingTimeline(none)).toHaveLength(1);
    expect(vestedAt(inputs({ events: [], vestedInFullOn: null }), "2030-01-01").toString()).toBe("0");
    expect(vestingTimeline(inputs({ events: [], vestedInFullOn: null }))).toEqual([]);
    // A schedule that expanded to nothing still vests its accelerations, in the sum as in the timeline.
    const accelerated = inputs({ events: [], vestedInFullOn: null, accelerations: [{ date: "2027-01-31", quantity: Dec.from(100), alreadyApplied: false }] });
    expect(vestedAt(accelerated, "2027-01-30").toString()).toBe("0");
    expect(vestedAt(accelerated, "2027-01-31").toString()).toBe("100");
    expect(vestingTimeline(accelerated).map((e) => e.cumulative.toString())).toEqual(["100"]);
  });

  it("vests through the date inclusive and caps at the grant", () => {
    const base = inputs();
    expect(vestedAt(base, "2027-01-30").toString()).toBe("0");
    expect(vestedAt(base, "2027-01-31").toString()).toBe("12000");
    expect(vestedAt(base, "2027-02-28").toString()).toBe("13000");
    expect(vestedAt(base, "2099-01-01").toString()).toBe("48000");
  });

  it("cancels events after the stop, or exactly the listed ones", () => {
    const stopped = inputs({ stopDate: "2027-03-15" });
    // m13 vests on Feb 28; m14 falls on Mar 31, after the stop.
    expect(vestedAt(stopped, "2099-01-01").toString()).toBe("13000");
    const timeline = vestingTimeline(stopped);
    expect(timeline.filter((e) => e.state === "CANCELLED")).toHaveLength(35);
    const listed = inputs({ stopDate: "2027-03-15", cancelledEventIds: new Set(["m13"]) });
    expect(vestedAt(listed, "2099-01-01").toString()).toBe("47000");
  });

  it("adds accelerations once, consuming the last tranches", () => {
    const accelerated = inputs({ stopDate: "2027-01-31", accelerations: [{ date: "2027-01-31", quantity: Dec.from(3000), alreadyApplied: false, transactionId: "t1" }] });
    expect(vestedAt(accelerated, "2027-01-31").toString()).toBe("15000");
    expect(vestingTimeline(accelerated).find((e) => e.kind === "ACCELERATION")?.id).toBe("t1");
    const applied = inputs({ accelerations: [{ date: "2027-01-31", quantity: Dec.from(3000), alreadyApplied: true }] });
    expect(vestedAt(applied, "2027-01-31").toString()).toBe("12000");
    const full = inputs({ accelerations: [{ date: "2027-01-31", quantity: Dec.from(40000), alreadyApplied: false }] });
    expect(vestedAt(full, "2027-02-28").toString()).toBe("48000");
    const upcoming = upcomingEvents(full, "2027-01-31");
    expect(upcoming).toEqual([]); // everything vested already
    const partial = upcomingEvents(inputs({ accelerations: [{ date: "2027-01-31", quantity: Dec.from(35500), alreadyApplied: false }] }), "2027-01-31");
    expect(partial.map((e) => e.quantity.toString())).toEqual(["500"]);
  });

  it("sums exactly what the timeline accumulates, for any events, stops, accelerations and pauses", () => {
    const day = (n: number) => fromEpochDay(18_000 + n);
    const arbInputs = fc.record({
      events: fc.array(fc.record({ day: fc.nat({ max: 2000 }), quantity: fc.integer({ min: 1, max: 5000 }) }), { maxLength: 30 }),
      quantity: fc.integer({ min: 0, max: 60_000 }),
      stop: fc.option(fc.nat({ max: 2000 })),
      cancelled: fc.option(fc.array(fc.nat({ max: 29 }), { maxLength: 10 })),
      accelerations: fc.array(fc.record({ day: fc.nat({ max: 2000 }), quantity: fc.integer({ min: 1, max: 20_000 }), applied: fc.boolean() }), { maxLength: 3 }),
      pauses: fc.array(fc.record({ from: fc.nat({ max: 2000 }), days: fc.option(fc.integer({ min: 1, max: 300 })) }), { maxLength: 2 }),
      fullOn: fc.option(fc.nat({ max: 2000 })),
    });
    fc.assert(
      fc.property(arbInputs, fc.array(fc.nat({ max: 2600 }), { minLength: 1, maxLength: 8 }), (x, days) => {
        const sample: VestingInputs = {
          quantity: Dec.from(x.quantity),
          events: x.events
            .map((event, i) => ({ id: `e${i}`, date: day(event.day), quantity: Dec.from(event.quantity), kind: "EXPLICIT" as const, source: "computed" as const }))
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
          vestedInFullOn: x.events.length === 0 && x.fullOn !== null ? day(x.fullOn) : null,
          stopDate: x.stop === null ? null : day(x.stop),
          cancelledEventIds: x.cancelled === null ? null : new Set(x.cancelled.map((i) => `e${i}`)),
          accelerations: x.accelerations.map((a) => ({ date: day(a.day), quantity: Dec.from(a.quantity), alreadyApplied: a.applied })),
          pauses: x.pauses.map((p) => ({ from: day(p.from), to: p.days === null ? null : day(p.from + p.days) })),
        };
        const timeline = vestingTimeline(sample);
        for (const n of days) {
          const date = day(n - 300);
          let expected = Dec.ZERO;
          for (const event of timeline) {
            if (event.date > date) break;
            expected = event.cumulative;
          }
          expect(vestedAt(sample, date).toString()).toBe(expected.toString());
        }
      }),
      { numRuns: 300 },
    );
  });

  it("shifts events after a pause and suspends them while it is open", () => {
    const paused = inputs({ pauses: [{ from: "2027-01-01", to: "2027-02-01" }] });
    expect(vestedAt(paused, "2027-01-31").toString()).toBe("0");
    expect(vestedAt(paused, "2027-03-03").toString()).toBe("12000");
    const open = inputs({ pauses: [{ from: "2027-06-01", to: null }] });
    expect(vestedAt(open, "2099-01-01").toString()).toBe("16000");
    const twice = inputs({ pauses: [{ from: "2027-06-01", to: "2027-06-11" }, { from: "2027-01-01", to: "2027-01-02" }] });
    expect(vestingTimeline(twice)[0]!.date).toBe("2027-02-01");
  });
});
