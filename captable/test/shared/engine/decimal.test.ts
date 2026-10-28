import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DECIMAL_VECTORS } from "../../../src/app/shared/api/primitives.ts";
import { Dec, dec, divRound, EngineError, pow10, type RoundingMode } from "../../../src/app/shared/engine/index.ts";

// Room for full replays and property runs on a loaded CI machine (vitest's default is 5 s per test).
const SLOW = { timeout: 30_000 };

const MODES: RoundingMode[] = ["FLOOR", "CEIL", "DOWN", "UP", "HALF_UP", "HALF_DOWN", "HALF_EVEN"];

/** Random decimals: up to 30 significant digits and 12 fractional digits, either sign. */
const arbDec = fc
  .tuple(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), fc.integer({ min: 0, max: 12 }))
  .map(([mantissa, scale]) => Dec.of(mantissa, scale));
const arbNonNeg = arbDec.map((d) => d.abs());

/** An independent oracle: both values as integers at a common scale of 24. */
function scaled(d: Dec): bigint {
  return d.mantissa * pow10(24 - d.scale);
}

describe("Dec.parse (canonical storage form)", () => {
  it("accepts canonical decimals", () => {
    for (const text of ["0", "1", "24312120", "0.5", "0.0001", "1.25", "16147718.6", "123456789012345678901234567", "1234567890123456789012345678", "0.000000000001"]) {
      expect(Dec.parse(text).toString()).toBe(text);
    }
  });

  it("refuses signs, exponents, leading and trailing zeros, too many digits", () => {
    for (const text of ["-1", "+1", "1e3", "01", "1.0", "1.50", ".5", "5.", "", " 1", "1,000", "0.0000000000001", "9".repeat(41), "NaN"]) {
      expect(() => Dec.parse(text), text).toThrow(EngineError);
    }
  });

  it("refuses non-strings", () => {
    expect(() => Dec.parse(5 as unknown as string)).toThrow(EngineError);
  });

  it("accepts and refuses exactly the D1 CHECK's and the API contract's conformance vectors", () => {
    for (const text of DECIMAL_VECTORS.accept) expect(Dec.isCanonical(text), text).toBe(true);
    for (const text of DECIMAL_VECTORS.reject) expect(Dec.isCanonical(text), text).toBe(false);
  });

  it("knows canonical text", () => {
    expect(Dec.isCanonical("1.5")).toBe(true);
    expect(Dec.isCanonical("1.50")).toBe(false);
    expect(Dec.isCanonical(1.5)).toBe(false);
  });
});

describe("Dec.from (lenient input)", () => {
  it("normalizes import formats", () => {
    expect(Dec.from("0001.2500").toString()).toBe("1.25");
    expect(Dec.from("-0.50").toString()).toBe("-0.5");
    expect(Dec.from("+7").toString()).toBe("7");
    expect(Dec.from(" 42 ").toString()).toBe("42");
    expect(Dec.from("1.000000000000000000").toString()).toBe("1");
    expect(Dec.from(12345).toString()).toBe("12345");
    expect(Dec.from(-3).toString()).toBe("-3");
    expect(Dec.from(10n ** 25n).toString()).toBe("10000000000000000000000000");
    const d = Dec.from("5");
    expect(Dec.from(d)).toBe(d);
    expect(dec("2.5").toString()).toBe("2.5");
  });

  it("refuses floats, exponents, commas and more than 12 fractional digits (never rounds)", () => {
    expect(() => Dec.from(0.1)).toThrow(/safe integer/);
    expect(() => Dec.from(2 ** 60)).toThrow(EngineError);
    expect(() => Dec.from(Number.NaN)).toThrow(EngineError);
    expect(() => Dec.from("1e5")).toThrow(EngineError);
    expect(() => Dec.from("1,000")).toThrow(EngineError);
    expect(() => Dec.from("0.0000000000001")).toThrow(/fractional digits/);
    expect(() => Dec.from(null as unknown as string)).toThrow(EngineError);
  });

  it("builds from a mantissa and a scale", () => {
    expect(Dec.of(12345, 2).toString()).toBe("123.45");
    expect(Dec.of(-5n, 3).toString()).toBe("-0.005");
    expect(Dec.of(1200n, 2).scale).toBe(0); // normalized
    expect(() => Dec.of(1, -1)).toThrow(EngineError);
    expect(() => Dec.of(1.5)).toThrow(EngineError);
    expect(() => pow10(-1)).toThrow(EngineError);
  });
});

describe("exact arithmetic", () => {
  it("adds, subtracts and multiplies without rounding", () => {
    expect(dec("0.1").add("0.2").toString()).toBe("0.3");
    expect(dec("1.005").sub("0.006").toString()).toBe("0.999");
    expect(dec("3076923").mul("2.60").toString()).toBe("7999999.8");
    expect(dec("0.000001").mul("0.000001").toString()).toBe("0.000000000001");
    expect(dec("10").sub("12.5").toString()).toBe("-2.5");
    expect(dec("-2.5").neg().toString()).toBe("2.5");
    expect(dec("-2.5").abs().toString()).toBe("2.5");
    expect(dec("2.5").abs().toString()).toBe("2.5");
    expect(Dec.sum([dec("1.1"), dec("2.2"), dec("3.3")]).toString()).toBe("6.6");
    expect(Dec.sum([]).toString()).toBe("0");
  });

  it("compares across scales", () => {
    expect(dec("1.50").eq("1.5")).toBe(true);
    expect(dec("100").gt("9")).toBe(true); // the reason decimal TEXT is never compared in SQL
    expect(dec("0.1").lt("0.10001")).toBe(true);
    expect(dec("2").lte("2.0")).toBe(true);
    expect(dec("2").gte("2.0000001")).toBe(false);
    expect(dec("-1").cmp("1")).toBe(-1);
    expect(Dec.min(dec("3"), dec("1.5"), dec("2")).toString()).toBe("1.5");
    expect(Dec.max(dec("3"), dec("10.5"), dec("2")).toString()).toBe("10.5");
    expect(dec("-0.1").sign()).toBe(-1);
    expect(dec("0").sign()).toBe(0);
    expect(dec("7").sign()).toBe(1);
    expect(dec("-3").clampZero().toString()).toBe("0");
    expect(dec("3").clampZero().toString()).toBe("3");
    expect(dec("3").isInteger()).toBe(true);
    expect(dec("3.1").isInteger()).toBe(false);
    expect(dec("0").isZero()).toBe(true);
    expect(dec("-0.0").isZero()).toBe(true);
    expect(dec("-1").isNegative()).toBe(true);
    expect(dec("1").isPositive()).toBe(true);
  });
});

describe("rounding", () => {
  it("divRound rounds half-way cases by mode", () => {
    const cases: [bigint, bigint, Record<RoundingMode, bigint>][] = [
      [5n, 2n, { FLOOR: 2n, CEIL: 3n, DOWN: 2n, UP: 3n, HALF_UP: 3n, HALF_DOWN: 2n, HALF_EVEN: 2n }],
      [7n, 2n, { FLOOR: 3n, CEIL: 4n, DOWN: 3n, UP: 4n, HALF_UP: 4n, HALF_DOWN: 3n, HALF_EVEN: 4n }],
      [-5n, 2n, { FLOOR: -3n, CEIL: -2n, DOWN: -2n, UP: -3n, HALF_UP: -3n, HALF_DOWN: -2n, HALF_EVEN: -2n }],
      [7n, 3n, { FLOOR: 2n, CEIL: 3n, DOWN: 2n, UP: 3n, HALF_UP: 2n, HALF_DOWN: 2n, HALF_EVEN: 2n }],
      [8n, 3n, { FLOOR: 2n, CEIL: 3n, DOWN: 2n, UP: 3n, HALF_UP: 3n, HALF_DOWN: 3n, HALF_EVEN: 3n }],
      [6n, 3n, { FLOOR: 2n, CEIL: 2n, DOWN: 2n, UP: 2n, HALF_UP: 2n, HALF_DOWN: 2n, HALF_EVEN: 2n }],
      [5n, -2n, { FLOOR: -3n, CEIL: -2n, DOWN: -2n, UP: -3n, HALF_UP: -3n, HALF_DOWN: -2n, HALF_EVEN: -2n }],
    ];
    for (const [n, d, expected] of cases) {
      for (const mode of MODES) expect(divRound(n, d, mode), `${n}/${d} ${mode}`).toBe(expected[mode]);
    }
    expect(() => divRound(1n, 0n, "FLOOR")).toThrow(/Division by zero/);
  });

  it("rounds to a scale, a unit, and divides with a named mode", () => {
    expect(dec("2.675").roundTo(2, "HALF_EVEN").toString()).toBe("2.68");
    expect(dec("2.665").roundTo(2, "HALF_EVEN").toString()).toBe("2.66");
    expect(dec("2.665").roundTo(2, "HALF_UP").toString()).toBe("2.67");
    expect(dec("-2.665").roundTo(2, "FLOOR").toString()).toBe("-2.67");
    expect(dec("2.6").roundTo(4, "FLOOR").toString()).toBe("2.6");
    expect(dec("10").divideTo("3", 2, "HALF_EVEN").toString()).toBe("3.33");
    expect(dec("100000").divideTo("0.95", 0, "FLOOR").toString()).toBe("105263");
    expect(dec("1234.5678").floorToUnit("1").toString()).toBe("1234");
    expect(dec("1234.5678").floorToUnit("0.01").toString()).toBe("1234.56");
    expect(dec("1234.5678").roundToUnit("100", "HALF_UP").toString()).toBe("1200");
    expect(dec("-1.5").floorToUnit("1").toString()).toBe("-2");
    expect(() => dec("1").roundToUnit("0", "FLOOR")).toThrow(EngineError);
    expect(dec("1.5").isMultipleOf("0.5")).toBe(true);
    expect(dec("1.5").isMultipleOf("1")).toBe(false);
    expect(dec("300").isMultipleOf("100")).toBe(true);
    expect(dec("1").isMultipleOf("0")).toBe(false);
  });
});

describe("formatting to text", () => {
  it("prints signed canonical text and refuses to store what can't be stored", () => {
    expect(dec("0.05").toString()).toBe("0.05");
    expect(dec("-0.05").toString()).toBe("-0.05");
    expect(dec("1.5").toCanonical()).toBe("1.5");
    expect(() => dec("-1").toCanonical()).toThrow(/can't be stored/);
    expect(() => Dec.of(1n, 13).toCanonical()).toThrow(/can't be stored/);
    expect(() => Dec.of(10n ** 40n).toCanonical()).toThrow(/can't be stored/);
    expect(Dec.of(10n ** 28n).toCanonical()).toBe(`1${"0".repeat(28)}`);
    expect(JSON.stringify({ q: dec("12.5") })).toBe('{"q":"12.5"}');
  });

  it("prints a fixed number of fractional digits", () => {
    expect(dec("2").toFixed(2)).toBe("2.00");
    expect(dec("2.005").toFixed(2)).toBe("2.00");
    expect(dec("2.015").toFixed(2)).toBe("2.02");
    expect(dec("2.5").toFixed(0)).toBe("2");
    expect(dec("3.5").toFixed(0)).toBe("4");
    expect(dec("-0.004").toFixed(2)).toBe("0.00");
    expect(dec("-1.236").toFixed(2, "HALF_UP")).toBe("-1.24");
    expect(dec("0.0001").toFixed(4)).toBe("0.0001");
  });
});

describe("properties", SLOW, () => {
  it("agrees with integer arithmetic at a common scale", () => {
    fc.assert(
      fc.property(arbDec, arbDec, (a, b) => {
        expect(scaled(a.add(b))).toBe(scaled(a) + scaled(b));
        expect(scaled(a.sub(b))).toBe(scaled(a) - scaled(b));
        // Products have up to 24 fractional digits: compare at scale 48.
        expect(a.mul(b).mantissa * pow10(48 - a.mul(b).scale)).toBe(scaled(a) * scaled(b));
        expect(a.cmp(b)).toBe(scaled(a) === scaled(b) ? 0 : scaled(a) < scaled(b) ? -1 : 1);
      }),
      { numRuns: 500 },
    );
  });

  it("is a commutative ring on exact values", () => {
    fc.assert(
      fc.property(arbDec, arbDec, arbDec, (a, b, c) => {
        expect(a.add(b).eq(b.add(a))).toBe(true);
        expect(a.mul(b).eq(b.mul(a))).toBe(true);
        expect(a.add(b).add(c).eq(a.add(b.add(c)))).toBe(true);
        expect(a.mul(b.add(c)).eq(a.mul(b).add(a.mul(c)))).toBe(true);
        expect(a.add(b).sub(b).eq(a)).toBe(true);
        expect(a.sub(a).isZero()).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips through text", () => {
    fc.assert(
      fc.property(arbDec, (a) => {
        expect(Dec.from(a.toString()).eq(a)).toBe(true);
        expect(Dec.from(a.toString()).toString()).toBe(a.toString());
      }),
    );
    fc.assert(
      fc.property(arbNonNeg, (a) => {
        if (Dec.isCanonical(a.toString())) expect(Dec.parse(a.toCanonical()).eq(a)).toBe(true);
        else expect(() => a.toCanonical()).toThrow(EngineError);
      }),
    );
  });

  it("rounds within one unit, in the right direction", () => {
    fc.assert(
      fc.property(arbDec, fc.integer({ min: 0, max: 12 }), (a, scale) => {
        const unit = Dec.of(1n, scale);
        const floor = a.roundTo(scale, "FLOOR");
        const ceil = a.roundTo(scale, "CEIL");
        expect(floor.lte(a) && a.lt(floor.add(unit))).toBe(true);
        expect(ceil.gte(a) && a.gt(ceil.sub(unit))).toBe(true);
        const even = a.roundTo(scale, "HALF_EVEN");
        expect(even.sub(a).abs().lte(unit.mul("0.5"))).toBe(true);
        expect(a.floorToUnit(unit).eq(floor)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("divides to a scale like the exact quotient rounded", () => {
    fc.assert(
      fc.property(arbDec, arbDec.filter((d) => !d.isZero()), fc.integer({ min: 0, max: 8 }), (a, b, scale) => {
        const q = a.divideTo(b, scale, "FLOOR");
        // q ≤ a/b < q + 10^-scale  ⇔  q·b ≤ a < (q + u)·b for b > 0 (reversed for b < 0)
        const u = Dec.of(1n, scale);
        if (b.isPositive()) expect(q.mul(b).lte(a) && a.lt(q.add(u).mul(b))).toBe(true);
        else expect(q.mul(b).gte(a) && a.gt(q.add(u).mul(b))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
