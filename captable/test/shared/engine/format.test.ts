import { describe, expect, it } from "vitest";
import { formatDecimal, formatMoney, formatPercent, formatPrice, formatRatio, formatRatioDecimal, formatShares, Rational } from "../../../src/app/shared/engine/index.ts";

describe("formatting", () => {
  it("groups share counts and never rounds them", () => {
    expect(formatShares("24312120")).toBe("24,312,120");
    expect(formatShares("999")).toBe("999");
    expect(formatShares("1000.5")).toBe("1,000.5");
    expect(formatShares("12", 2)).toBe("12.00");
    expect(formatShares("-53125")).toBe("-53,125");
  });

  it("formats money at two decimals by default", () => {
    expect(formatMoney("16147718.6")).toBe("$16,147,718.60");
    expect(formatMoney("0.005")).toBe("$0.00");
    expect(formatMoney("0.015")).toBe("$0.02");
    expect(formatMoney("-10695", { minus: "−" })).toBe("−$10,695.00");
    expect(formatMoney("-0.001")).toBe("$0.00");
    expect(formatMoney("1234.5", { currency: "EUR" })).toBe("€1,234.50");
    expect(formatMoney("12", { currency: "JPY", decimals: 0 })).toBe("JPY 12");
  });

  it("shows prices exactly up to a maximum", () => {
    expect(formatPrice("0.1")).toBe("$0.10");
    expect(formatPrice("0.0001")).toBe("$0.0001");
    expect(formatPrice("2.6")).toBe("$2.60");
    expect(formatPrice("0.3333333", { maxDecimals: 4 })).toBe("$0.3333");
    expect(formatPrice("1.95", { currency: "CAD" })).toBe("CA$1.95");
  });

  it("formats ratios and percentages at the edge", () => {
    expect(formatPercent(Rational.of(4300000, 24312120))).toBe("17.69%");
    expect(formatPercent(Rational.of(460750, 24312120))).toBe("1.90%");
    expect(formatPercent("1/3", 6)).toBe("33.333333%");
    expect(formatRatioDecimal(Rational.of(1, 3), 6)).toBe("0.333333");
    expect(formatRatio("1")).toBe("1:1");
    expect(formatRatio(Rational.of(4, 2))).toBe("2:1");
    expect(formatDecimal("1234567.891", { maxFractionDigits: 2, grouping: false })).toBe("1234567.89");
    expect(formatDecimal("5", { minFractionDigits: 3 })).toBe("5.000");
  });
});
