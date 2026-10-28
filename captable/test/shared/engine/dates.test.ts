import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  addDays,
  addMonths,
  addPeriod,
  addYears,
  compareDates,
  daysBetween,
  daysInMonth,
  election83bDeadline,
  EngineError,
  form3921Deadlines,
  formatIsoDate,
  fromEpochDay,
  isBusinessDay,
  isIsoDate,
  isLeapYear,
  isLegalHoliday,
  isWeekend,
  legalHolidays,
  maxDate,
  minDate,
  orgToday,
  parseIsoDate,
  rollToBusinessDay,
  toEpochDay,
  weekday,
  yearOf,
} from "../../../src/app/shared/engine/index.ts";

// Room for full replays and property runs on a loaded CI machine (vitest's default is 5 s per test).
const SLOW = { timeout: 30_000 };

describe("dates", SLOW, () => {
  it("validates calendar dates", () => {
    for (const ok of ["2026-10-21", "2028-02-29", "2000-02-29", "0001-01-01", "9999-12-31"]) expect(isIsoDate(ok), ok).toBe(true);
    for (const bad of ["2026-02-29", "1900-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-4-1", "20261021", "0000-01-01", "", 20261021]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
    expect(parseIsoDate("2026-10-21")).toEqual({ year: 2026, month: 10, day: 21 });
    expect(() => parseIsoDate("2026-02-30")).toThrow(EngineError);
    expect(() => formatIsoDate(2026, 2, 30)).toThrow(EngineError);
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(yearOf("2026-10-21")).toBe(2026);
  });

  it("adds days across months, years and leap days", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-09-15", 90)).toBe("2026-12-14");
    expect(daysBetween("2026-10-21", "2026-11-05")).toBe(15);
    expect(daysBetween("2026-10-21", "2027-02-28")).toBe(130);
    expect(daysBetween("2026-11-05", "2026-10-21")).toBe(-15);
    expect(() => addDays("2026-01-01", 1.5)).toThrow(EngineError);
  });

  it("adds months on the same day, clamped to the month end, always counting from the start", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-01-31", 2)).toBe("2026-03-31"); // not Mar 28: computed from the start
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2025-11-17", 12)).toBe("2026-11-17");
    expect(addYears("2028-02-29", 1)).toBe("2029-02-28");
    expect(addYears("2025-11-20", 10)).toBe("2035-11-20");
    expect(() => addMonths("2026-01-01", 0.5)).toThrow(EngineError);
  });

  it("adds periods in whole units", () => {
    expect(addPeriod("2026-10-21", 3, "MONTHS")).toBe("2027-01-21");
    expect(addPeriod("2026-10-21", "0", "DAYS")).toBe("2026-10-21");
    expect(addPeriod("2026-10-21", 2, "QUARTERS")).toBe("2027-04-21");
    expect(addPeriod("2026-10-21", 1, "YEARS")).toBe("2027-10-21");
    expect(addPeriod("2026-10-21", 90, "DAYS")).toBe("2027-01-19");
    expect(() => addPeriod("2026-10-21", "1.5", "MONTHS")).toThrow(/whole/);
    expect(() => addPeriod("2026-10-21", -1, "DAYS")).toThrow(EngineError);
  });

  it("knows weekdays and orders dates", () => {
    expect(weekday("2026-10-21")).toBe(3); // Wednesday
    expect(weekday("1970-01-01")).toBe(4); // Thursday
    expect(weekday("2027-01-31")).toBe(0); // Sunday
    expect(isWeekend("2026-10-24")).toBe(true);
    expect(isWeekend("2026-10-23")).toBe(false);
    expect(compareDates("2026-01-02", "2026-01-10")).toBe(-1);
    expect(compareDates("2026-01-10", "2026-01-10")).toBe(0);
    expect(compareDates("2026-01-11", "2026-01-10")).toBe(1);
    expect(minDate("2026-01-02", "2025-12-31")).toBe("2025-12-31");
    expect(maxDate("2026-01-02", "2025-12-31")).toBe("2026-01-02");
  });

  it("validates exactly as the YYYY-MM-DD rule does, on any text", () => {
    const rule = (text: string): boolean => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      if (!match) return false;
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
    };
    // Digits, plus the characters on either side of them ("/" and ":"), so an off-by-one digit test shows up.
    const field = (n: number, chars: string) => fc.array(fc.constantFrom(...chars), { minLength: n, maxLength: n }).map((d) => d.join(""));
    const shaped = (chars: string) =>
      fc.tuple(field(4, chars), fc.constantFrom("-", "-", "-", "/"), field(2, chars), fc.constantFrom("-", "-", "-", ":"), field(2, chars)).map((parts) => parts.join(""));
    const mutated = fc.tuple(shaped("0123456789"), fc.nat({ max: 10 }), fc.string({ maxLength: 2 })).map(([text, at, insert]) => text.slice(0, at) + insert + text.slice(at + 1));
    fc.assert(
      fc.property(fc.oneof(shaped("0123456789"), shaped("0123456789/:"), mutated, fc.string({ maxLength: 12 })), (text) => {
        expect(isIsoDate(text)).toBe(rule(text));
        if (rule(text)) {
          const { year, month, day } = parseIsoDate(text);
          expect(formatIsoDate(year, month, day)).toBe(text);
          expect(yearOf(text)).toBe(Number(text.slice(0, 4)));
        } else {
          expect(() => parseIsoDate(text)).toThrow(EngineError);
        }
      }),
      { numRuns: 5000 },
    );
  });

  it("formats exactly the real dates", () => {
    fc.assert(
      fc.property(fc.integer({ min: -2, max: 10_001 }), fc.integer({ min: -1, max: 14 }), fc.integer({ min: -1, max: 33 }), (year, month, day) => {
        const valid = year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
        if (valid) expect(parseIsoDate(formatIsoDate(year, month, day))).toEqual({ year, month, day });
        else expect(() => formatIsoDate(year, month, day)).toThrow(EngineError);
      }),
      { numRuns: 2000 },
    );
    expect(formatIsoDate(1, 1, 1)).toBe("0001-01-01");
    expect(() => formatIsoDate(2026.5, 1, 1)).toThrow(EngineError);
    expect(() => formatIsoDate(2026, Number.NaN, 1)).toThrow(EngineError);
  });

  it("matches the JavaScript calendar on day numbers (oracle)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -50_000, max: 100_000 }), (day) => {
        const date = fromEpochDay(day);
        expect(date).toBe(new Date(day * 86_400_000).toISOString().slice(0, 10));
        expect(toEpochDay(date)).toBe(day);
        expect(weekday(date)).toBe(new Date(day * 86_400_000).getUTCDay());
      }),
      { numRuns: 1000 },
    );
    expect(() => fromEpochDay(1.5)).toThrow(EngineError);
  });

  it("never lets month arithmetic pass the start's day of month", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: -240, max: 240 }), (day, months) => {
        const start = fromEpochDay(day);
        const result = addMonths(start, months);
        const s = parseIsoDate(start);
        const r = parseIsoDate(result);
        expect(r.day).toBe(Math.min(s.day, daysInMonth(r.year, r.month)));
        expect((r.year - s.year) * 12 + (r.month - s.month)).toBe(months);
      }),
      { numRuns: 500 },
    );
  });
});

describe("legal holidays and business days (IRC §7503)", () => {
  it("lists the observed federal holidays plus DC Emancipation Day", () => {
    expect([...legalHolidays(2026)].sort()).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-16",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03", // July 4 is a Saturday
      "2026-09-07",
      "2026-10-12",
      "2026-11-11",
      "2026-11-26",
      "2026-12-25",
    ]);
    expect(legalHolidays(2026)).toBe(legalHolidays(2026)); // cached
    expect(legalHolidays(2021).has("2021-12-31")).toBe(true); // Jan 1, 2022 (a Saturday) observed on Dec 31
    expect(legalHolidays(2022).has("2021-12-31")).toBe(false);
    expect(legalHolidays(2020).has("2020-06-19")).toBe(false); // Juneteenth from 2021
    expect(legalHolidays(2023).has("2023-01-02")).toBe(true); // a Sunday New Year's Day observed on Monday
    expect(isLegalHoliday("2027-04-16")).toBe(true);
    expect(isBusinessDay("2026-10-21")).toBe(true);
    expect(isBusinessDay("2026-11-11")).toBe(false);
  });

  it("rolls tax deadlines to the next business day", () => {
    expect(rollToBusinessDay("2027-01-31")).toBe("2027-02-01");
    expect(rollToBusinessDay("2026-10-21")).toBe("2026-10-21");
    expect(rollToBusinessDay("2026-07-03")).toBe("2026-07-06");
    expect(form3921Deadlines(2026)).toEqual({ copyB: "2027-02-01", copyAElectronic: "2027-03-31" });
    expect(election83bDeadline("2026-10-21")).toEqual({ date: "2026-11-20", unrolled: "2026-11-20", rolled: false });
    expect(election83bDeadline("2026-10-12")).toEqual({ date: "2026-11-12", unrolled: "2026-11-11", rolled: true });
    expect(addBusinessDays("2026-10-21", 10)).toBe("2026-11-04");
    expect(addBusinessDays("2026-11-10", 1)).toBe("2026-11-12");
    expect(() => addBusinessDays("2026-11-10", -1)).toThrow(EngineError);
  });

  it("takes the org's local date", () => {
    const now = Date.UTC(2026, 9, 22, 6, 0, 0); // 2026-10-22 06:00 UTC = 23:00 on the 21st in Los Angeles
    expect(orgToday("America/Los_Angeles", now)).toBe("2026-10-21");
    expect(orgToday("UTC", now)).toBe("2026-10-22");
    expect(orgToday("Asia/Tokyo", now)).toBe("2026-10-22");
  });
});
