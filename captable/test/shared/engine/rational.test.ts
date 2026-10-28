import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Dec, EngineError, Rational, ratio } from "../../../src/app/shared/engine/index.ts";

// Room for full replays and property runs on a loaded CI machine (vitest's default is 5 s per test).
const SLOW = { timeout: 30_000 };

const arbRational = fc
  .tuple(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.bigInt({ min: 1n, max: 10n ** 15n }))
  .map(([n, d]) => Rational.of(n, d));

describe("Rational", SLOW, () => {
  it("is always reduced with a positive denominator", () => {
    const r = Rational.of(6, -8);
    expect([r.num, r.den]).toEqual([-3n, 4n]);
    expect(Rational.of(0, 5).toString()).toBe("0");
    expect(Rational.of(10, 5).toString()).toBe("2");
    expect(() => Rational.of(1, 0)).toThrow(EngineError);
    expect(() => Rational.of(0.5)).toThrow(EngineError);
  });

  it("parses fractions, percentages and decimals exactly (never through a float)", () => {
    expect(ratio("1/48").toFraction()).toBe("1/48");
    expect(ratio(" 2 / 4 ").toFraction()).toBe("1/2");
    expect(ratio("2.0833%").toFraction()).toBe("20833/1000000");
    expect(ratio("8.333%").eq(Rational.of(8333, 100000))).toBe(true);
    expect(ratio("25%").toString()).toBe("1/4");
    expect(ratio("0.25").toString()).toBe("1/4");
    expect(ratio(Dec.from("1.5")).toString()).toBe("3/2");
    expect(ratio(7n).toString()).toBe("7");
    const r = Rational.of(1, 3);
    expect(ratio(r)).toBe(r);
    expect(() => ratio("1/0")).toThrow(EngineError);
    expect(() => ratio("abc")).toThrow(EngineError);
  });

  it("does exact arithmetic and comparison", () => {
    const third = Rational.of(1, 3);
    expect(third.add(third).add(third).eq(1)).toBe(true);
    expect(third.sub(Rational.of(1, 2)).toFraction()).toBe("-1/6");
    expect(third.mul(3).toString()).toBe("1");
    expect(third.div(Rational.of(2, 3)).toFraction()).toBe("1/2");
    expect(third.inverse().toString()).toBe("3");
    expect(third.neg().abs().eq(third)).toBe(true);
    expect(third.sign()).toBe(1);
    expect(third.neg().sign()).toBe(-1);
    expect(Rational.ZERO.sign()).toBe(0);
    expect(third.lt(Rational.of(1, 2))).toBe(true);
    expect(third.lte(third)).toBe(true);
    expect(third.gt(Rational.of(1, 4))).toBe(true);
    expect(third.gte(Rational.of(1, 2))).toBe(false);
    expect(Rational.sum([third, third, third]).isInteger()).toBe(true);
    expect(third.isZero()).toBe(false);
    expect(() => third.div(0)).toThrow(/Division by zero/);
    expect(Rational.of(5, 2).add(Rational.of(1, 2)).toString()).toBe("3");
  });

  it("rounds only when asked, with a named mode", () => {
    const fd = Rational.of(4300000, 24312120);
    expect(fd.mul(100).roundTo(2, "HALF_EVEN").toString()).toBe("17.69");
    expect(Rational.of(7, 2).round("HALF_EVEN")).toBe(4n);
    expect(Rational.of(5, 2).round("HALF_EVEN")).toBe(2n);
    expect(Rational.of(-7, 2).floor()).toBe(-4n);
    expect(Rational.of(-7, 2).ceil()).toBe(-3n);
    expect(Rational.of(100000, 1).div(Rational.from("0.95")).floorToUnit("1").toString()).toBe("105263");
    expect(Rational.of(1, 3).floorToUnit("0.01").toString()).toBe("0.33");
    expect(Rational.of(1, 3).roundToUnit("0.01", "CEIL").toString()).toBe("0.34");
    expect(() => Rational.ONE.roundToUnit("0", "FLOOR")).toThrow(EngineError);
  });

  it("converts to an exact decimal only when the denominator allows it", () => {
    expect(Rational.of(1, 8).toDecExact()?.toString()).toBe("0.125");
    expect(Rational.of(3, 20).toDecExact()?.toString()).toBe("0.15");
    expect(Rational.of(1, 3).toDecExact()).toBeNull();
    expect(Rational.of(-1, 4).toDecExact()?.toString()).toBe("-0.25");
    expect(JSON.stringify({ r: Rational.of(1, 3) })).toBe('{"r":"1/3"}');
  });

  it("satisfies the field axioms exactly", () => {
    fc.assert(
      fc.property(arbRational, arbRational, arbRational, (a, b, c) => {
        expect(a.add(b).eq(b.add(a))).toBe(true);
        expect(a.mul(b.add(c)).eq(a.mul(b).add(a.mul(c)))).toBe(true);
        expect(a.add(b).sub(b).eq(a)).toBe(true);
        if (!b.isZero()) expect(a.div(b).mul(b).eq(a)).toBe(true);
        // Addition normalizes the equal case to +0; Object.is distinguishes 0 from the unary-minus result -0.
        expect(a.cmp(b) + b.cmp(a)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it("rounds consistently with floor and ceil", () => {
    fc.assert(
      fc.property(arbRational, (a) => {
        expect(a.floor() <= a.ceil()).toBe(true);
        expect(Rational.of(a.floor()).lte(a) && a.lt(Rational.of(a.floor() + 1n))).toBe(true);
        expect(a.ceil() - a.floor()).toBe(a.isInteger() ? 0n : 1n);
        const even = a.round("HALF_EVEN");
        expect(even === a.floor() || even === a.ceil()).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
