import { Dec, divRound, pow10, type DecInput, type RoundingMode } from "./decimal.ts";
import { EngineError } from "./errors.ts";

/**
 * Exact fractions for ratios and percentages: ownership, conversion ratios, split ratios, vesting percentages
 * (the ledger rules). Always reduced, with a positive denominator. Rounded only at the display or export edge, where the
 * caller names the digits and the mode (Pulley comparisons round to Pulley's digits, migration R-24).
 */

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

const FRACTION = /^\s*([+-]?\d+)\s*\/\s*(\d+)\s*$/;
const PERCENT = /^\s*([+-]?\d+(?:\.\d+)?)\s*%\s*$/;

export type RationalInput = Rational | DecInput;

export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    if (den === 0n) throw new EngineError("DIVISION_BY_ZERO", "A rational needs a non-zero denominator");
    let n = num;
    let d = den;
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    this.num = g > 1n ? n / g : n;
    this.den = g > 1n ? d / g : d;
  }

  static readonly ZERO: Rational = new Rational(0n, 1n);
  static readonly ONE: Rational = new Rational(1n, 1n);

  static of(num: bigint | number, den: bigint | number = 1n): Rational {
    const toBig = (v: bigint | number) => {
      if (typeof v === "bigint") return v;
      if (!Number.isSafeInteger(v)) throw new EngineError("RATIONAL_NOT_EXACT", `${v} is not a safe integer`);
      return BigInt(v);
    };
    return new Rational(toBig(num), toBig(den));
  }

  static fromDec(value: DecInput): Rational {
    const d = Dec.from(value);
    return new Rational(d.mantissa, pow10(d.scale));
  }

  /**
   * Parses "1/48", "2.0833%" or a decimal string exactly, never through a float, matching Pulley's vesting percentages
   * and the ledger's exact arithmetic. Also accepts a Dec, a bigint, a safe integer or a Rational.
   */
  static from(value: RationalInput): Rational {
    if (value instanceof Rational) return value;
    if (typeof value === "string") {
      const fraction = FRACTION.exec(value);
      if (fraction) return new Rational(BigInt(fraction[1]!), BigInt(fraction[2]!));
      const percent = PERCENT.exec(value);
      if (percent) return Rational.fromDec(percent[1]!).div(Rational.of(100));
    }
    return Rational.fromDec(value);
  }

  static sum(values: Iterable<Rational>): Rational {
    let total = Rational.ZERO;
    for (const value of values) total = total.add(value);
    return total;
  }

  add(other: RationalInput): Rational {
    const b = Rational.from(other);
    if (this.den === b.den) return new Rational(this.num + b.num, this.den);
    return new Rational(this.num * b.den + b.num * this.den, this.den * b.den);
  }

  sub(other: RationalInput): Rational {
    const b = Rational.from(other);
    return this.add(new Rational(-b.num, b.den));
  }

  mul(other: RationalInput): Rational {
    const b = Rational.from(other);
    return new Rational(this.num * b.num, this.den * b.den);
  }

  div(other: RationalInput): Rational {
    const b = Rational.from(other);
    if (b.num === 0n) throw new EngineError("DIVISION_BY_ZERO", "Division by zero");
    return new Rational(this.num * b.den, this.den * b.num);
  }

  neg(): Rational {
    return new Rational(-this.num, this.den);
  }

  abs(): Rational {
    return this.num < 0n ? this.neg() : this;
  }

  inverse(): Rational {
    return Rational.ONE.div(this);
  }

  sign(): number {
    return this.num > 0n ? 1 : this.num < 0n ? -1 : 0;
  }

  cmp(other: RationalInput): number {
    const b = Rational.from(other);
    const left = this.num * b.den;
    const right = b.num * this.den;
    return left === right ? 0 : left < right ? -1 : 1;
  }

  eq(other: RationalInput): boolean {
    return this.cmp(other) === 0;
  }

  lt(other: RationalInput): boolean {
    return this.cmp(other) < 0;
  }

  lte(other: RationalInput): boolean {
    return this.cmp(other) <= 0;
  }

  gt(other: RationalInput): boolean {
    return this.cmp(other) > 0;
  }

  gte(other: RationalInput): boolean {
    return this.cmp(other) >= 0;
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  isInteger(): boolean {
    return this.den === 1n;
  }

  /** Rounds to an integer. */
  round(mode: RoundingMode): bigint {
    return divRound(this.num, this.den, mode);
  }

  floor(): bigint {
    return this.round("FLOOR");
  }

  ceil(): bigint {
    return this.round("CEIL");
  }

  /** Rounds to `scale` fractional digits: the display (2 dp) and export (6 dp) edge for percentages. */
  roundTo(scale: number, mode: RoundingMode): Dec {
    return Dec.of(divRound(this.num * pow10(scale), this.den, mode), scale);
  }

  /** Rounds to a multiple of `unit`, e.g. FLOOR to the share unit for computed share counts. */
  roundToUnit(unit: DecInput, mode: RoundingMode): Dec {
    const u = Dec.from(unit);
    if (!u.isPositive()) throw new EngineError("DECIMAL_UNIT", "The rounding unit must be positive");
    // this / unit = num·10^s / (den·m)
    const units = divRound(this.num * pow10(u.scale), this.den * u.mantissa, mode);
    return Dec.of(units * u.mantissa, u.scale);
  }

  floorToUnit(unit: DecInput): Dec {
    return this.roundToUnit(unit, "FLOOR");
  }

  /** The exact decimal, when the denominator has no prime factor other than 2 and 5; otherwise null. */
  toDecExact(): Dec | null {
    let d = this.den;
    let twos = 0;
    let fives = 0;
    while (d % 2n === 0n) {
      d /= 2n;
      twos += 1;
    }
    while (d % 5n === 0n) {
      d /= 5n;
      fives += 1;
    }
    if (d !== 1n) return null;
    const scale = Math.max(twos, fives);
    return Dec.of((this.num * pow10(scale)) / this.den, scale);
  }

  /** "numerator/denominator", the form JSON exports carry (the API contract). */
  toFraction(): string {
    return `${this.num}/${this.den}`;
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : this.toFraction();
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Shorthand for `Rational.from`. */
export function ratio(value: RationalInput): Rational {
  return Rational.from(value);
}
