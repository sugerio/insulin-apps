import "./setup.ts";
import { describe, expect, it } from "vitest";
import {
  compareDecimals,
  compareRatios,
  formatCompact,
  formatExact,
  formatFractionPercent,
  formatRatioPercent,
  formatRounded,
  fractionOf,
  multiplyDecimals,
  sumDecimals,
  toUnits,
} from "../../src/app/lib/decimal.ts";
import { addDays, addYears, createFormatter, daysBetween, formatBytes, formatDate, formatDaysLeft } from "../../src/app/lib/format.ts";

describe("exact decimals for display", () => {
  it("sums and compares without floating point", () => {
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["7999999.8", "1499999.8", "999999", undefined, null])).toBe("10499998.6");
    expect(sumDecimals(["9".repeat(30), "1"])).toBe(`1${"0".repeat(30)}`);
    expect(compareDecimals("10", "9.999999999999")).toBe(1);
    expect(compareDecimals("0.000000000001", "0")).toBe(1);
    expect(multiplyDecimals("0.31", "72000")).toBe("22320");
    expect(toUnits("not a number")).toBe(0n);
  });

  it("compares exact fractions", () => {
    expect(compareRatios("1/3", "333333/1000000")).toBe(1);
    expect(compareRatios("1/4", "2/8")).toBe(0);
    expect(compareRatios("0", "1/24312120")).toBe(-1);
  });

  it("formats quantities exactly, never hiding fractional digits", () => {
    expect(formatExact("24312120", 0)).toBe("24,312,120");
    expect(formatExact("0.00001", 2)).toBe("0.00001");
    expect(formatExact("0.95", 2)).toBe("0.95");
    expect(formatExact("2.6", 2)).toBe("2.60");
    expect(formatExact("1000.5", 0)).toBe("1,000.5");
  });

  it("rounds money half up to the shown digits", () => {
    expect(formatRounded("16147718.6", 2)).toBe("16,147,718.60");
    expect(formatRounded("0.005", 2)).toBe("0.01");
    expect(formatRounded("0.004999999999", 2)).toBe("0.00");
    expect(formatRounded("250000", 0)).toBe("250,000");
  });

  it("formats exact fractions as percentages with two decimals", () => {
    expect(formatRatioPercent("1/4")).toBe("25.00%");
    expect(formatRatioPercent("1")).toBe("100.00%");
    expect(formatRatioPercent("0")).toBe("0.00%");
    expect(formatRatioPercent("4300000/24312120".replace("4300000/24312120", "107500/607803"))).toBe("17.69%");
    expect(formatRatioPercent("1/3")).toBe("33.33%");
    expect(formatRatioPercent("2/3")).toBe("66.67%");
    expect(formatRatioPercent(null)).toBe("—");
    expect(formatFractionPercent(fractionOf("460750", "24312120"))).toBe("1.90%");
    expect(formatFractionPercent(fractionOf("1", "0"))).toBe("0.00%");
  });

  it("abbreviates large quantities for the donut", () => {
    expect(formatCompact("24312120")).toBe("24M");
    expect(formatCompact("4300000")).toBe("4.3M");
    expect(formatCompact("12500")).toBe("13K");
    expect(formatCompact("1500")).toBe("1.5K");
    expect(formatCompact("940")).toBe("940");
  });
});

describe("dates and the org formatter", () => {
  it("formats legal dates without a time zone", () => {
    expect(formatDate("2026-10-21")).toBe("Oct 21, 2026");
    expect(formatDate(null)).toBe("—");
    expect(daysBetween("2026-10-21", "2026-11-05")).toBe(15);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
    expect(formatDaysLeft("2026-10-21", "2026-10-22")).toBe("1 day");
    expect(formatDaysLeft("2026-10-21", "2026-10-01")).toBe("passed");
  });

  it("formats shares, prices, money and instants with the org's settings", () => {
    const format = createFormatter({ shareDecimals: 0, priceDecimals: 2 }, "America/Los_Angeles", "2026-10-21");
    expect(format.shares("4039250")).toBe("4,039,250");
    expect(format.price("0.1")).toBe("$0.10");
    expect(format.price("0.0001")).toBe("$0.0001");
    expect(format.money("7999999.8")).toBe("$7,999,999.80");
    expect(format.money("250000", 0)).toBe("$250,000");
    expect(format.dateTime(Date.UTC(2026, 9, 21, 16, 40))).toBe("Oct 21, 2026 at 9:40am");
    expect(format.relative(Date.UTC(2026, 9, 21, 16, 40))).toBe("Today 9:40am");
    expect(format.relative(Date.UTC(2026, 9, 20, 16, 40))).toBe("Yesterday");
    expect(format.relative(Date.UTC(2026, 9, 11, 16))).toBe("10 days ago");
    expect(format.localDate(Date.UTC(2026, 9, 22, 2))).toBe("2026-10-21");
    const fourDecimals = createFormatter({ shareDecimals: 2, priceDecimals: 4 }, "Not/A_Zone", "2026-10-21");
    expect(fourDecimals.shares("10")).toBe("10.00");
    expect(fourDecimals.price("0.95")).toBe("$0.9500");
  });

  it("writes file sizes in the binary units the upload limits use", () => {
    expect(formatBytes(20)).toBe("1 KiB");
    expect(formatBytes(48_000)).toBe("47 KiB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1,024 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.5 MiB");
  });
});
