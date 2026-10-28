import { EngineError } from "./errors.ts";

/**
 * Exact decimals for share quantities and money.
 *
 * A `Dec` is a BigInt mantissa with a decimal scale: value = mantissa / 10^scale. There is no fixed scale: sums align
 * scales and products add them, so neither ever rounds. Division goes through `Rational`, or through `divideTo` with a
 * named rounding mode and target scale; each place that rounds says so. Floats never appear: a JavaScript number is
 * accepted only when it is a safe integer.
 *
 * Storage holds canonical text (no sign, exponent, leading zeros or trailing fractional zeros; at most 12 fractional
 * digits and 40 characters), the same rule as every decimal CHECK in migrations/0001. Computed values may be negative
 * (an over-granted pool, say) or carry more digits; `toCanonical()` refuses them rather than rounding.
 */

export type RoundingMode = "FLOOR" | "CEIL" | "DOWN" | "UP" | "HALF_UP" | "HALF_DOWN" | "HALF_EVEN";

export const MAX_FRACTION_DIGITS = 12;
export const MAX_DECIMAL_LENGTH = 40;

/**
 * The storage format (the ledger rules and every decimal CHECK in migrations/0001): no sign, exponent, leading zeros or trailing
 * fractional zeros, at most 12 fractional digits ending in 1–9; with MAX_DECIMAL_LENGTH, at most 40 characters. The
 * integer part has no separate cap, exactly like the D1 CHECK and the API contract (`DECIMAL_VECTORS`).
 */
export const CANONICAL_DECIMAL = /^(0|[1-9]\d*)(\.\d{0,11}[1-9])?$/;
const LENIENT_DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

const POW10: bigint[] = [1n];

export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0) throw new EngineError("DECIMAL_SCALE", `Invalid scale ${exponent}`);
  while (POW10.length <= exponent) POW10.push(POW10[POW10.length - 1]! * 10n);
  return POW10[exponent]!;
}

/** Rounds numerator / denominator to an integer with the given mode. HALF_UP and UP round away from zero. */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new EngineError("DIVISION_BY_ZERO", "Division by zero");
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const quotient = n / d; // truncates toward zero
  const remainder = n % d; // carries the sign of n
  if (remainder === 0n) return quotient;
  const negative = n < 0n;
  const awayFromZero = negative ? quotient - 1n : quotient + 1n;
  switch (mode) {
    case "DOWN":
      return quotient;
    case "UP":
      return awayFromZero;
    case "FLOOR":
      return negative ? quotient - 1n : quotient;
    case "CEIL":
      return negative ? quotient : quotient + 1n;
    case "HALF_UP":
    case "HALF_DOWN":
    case "HALF_EVEN": {
      const twice = 2n * (remainder < 0n ? -remainder : remainder);
      if (twice > d) return awayFromZero;
      if (twice < d) return quotient;
      if (mode === "HALF_UP") return awayFromZero;
      if (mode === "HALF_DOWN") return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
    }
  }
}

export type DecInput = Dec | string | number | bigint;

export class Dec {
  /** The integer value scaled by 10^scale. Normalized: no trailing zero digits when scale > 0. */
  readonly mantissa: bigint;
  readonly scale: number;

  private constructor(mantissa: bigint, scale: number) {
    let m = mantissa;
    let s = scale;
    while (s > 0 && m % 10n === 0n) {
      m /= 10n;
      s -= 1;
    }
    this.mantissa = m;
    this.scale = s;
  }

  static readonly ZERO: Dec = new Dec(0n, 0);
  static readonly ONE: Dec = new Dec(1n, 0);

  /** mantissa / 10^scale. */
  static of(mantissa: bigint | number, scale = 0): Dec {
    if (!Number.isInteger(scale) || scale < 0) throw new EngineError("DECIMAL_SCALE", `Invalid scale ${scale}`);
    if (typeof mantissa === "number") {
      if (!Number.isSafeInteger(mantissa)) throw new EngineError("DECIMAL_NOT_EXACT", `${mantissa} is not a safe integer`);
      return new Dec(BigInt(mantissa), scale);
    }
    return new Dec(mantissa, scale);
  }

  /** Parses the canonical storage form only (non-negative, ≤ 12 fractional digits, ≤ 40 characters). */
  static parse(text: string): Dec {
    if (typeof text !== "string" || text.length > MAX_DECIMAL_LENGTH || !CANONICAL_DECIMAL.test(text)) {
      throw new EngineError("DECIMAL_NOT_CANONICAL", `Not a canonical decimal: ${JSON.stringify(text)}`);
    }
    return Dec.fromDigits(false, text);
  }

  /**
   * Accepts what imports and forms send: numeric strings with a sign, leading zeros or trailing fractional zeros, a
   * safe integer, a bigint, or a Dec. More than 12 significant fractional digits is refused, never rounded under the
   * ledger's precision rules. Exponents, commas and floats are refused.
   */
  static from(value: DecInput): Dec {
    if (value instanceof Dec) return value;
    if (typeof value === "bigint") return new Dec(value, 0);
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new EngineError("DECIMAL_NOT_EXACT", `${value} is not a safe integer; pass decimals as strings`);
      }
      return new Dec(BigInt(value), 0);
    }
    if (typeof value !== "string") throw new EngineError("DECIMAL_INVALID", "Expected a decimal");
    const match = LENIENT_DECIMAL.exec(value.trim());
    if (!match) throw new EngineError("DECIMAL_INVALID", `Not a decimal: ${JSON.stringify(value)}`);
    const fraction = (match[3] ?? "").replace(/0+$/, "");
    if (fraction.length > MAX_FRACTION_DIGITS) {
      throw new EngineError("DECIMAL_PRECISION", `More than ${MAX_FRACTION_DIGITS} fractional digits: ${value}`);
    }
    const digits = fraction.length > 0 ? `${match[2]}.${fraction}` : match[2]!;
    return Dec.fromDigits(match[1] === "-", digits);
  }

  private static fromDigits(negative: boolean, digits: string): Dec {
    const dot = digits.indexOf(".");
    const scale = dot < 0 ? 0 : digits.length - dot - 1;
    const mantissa = BigInt(dot < 0 ? digits : digits.slice(0, dot) + digits.slice(dot + 1));
    return new Dec(negative ? -mantissa : mantissa, scale);
  }

  static sum(values: Iterable<Dec>): Dec {
    let total = Dec.ZERO;
    for (const value of values) total = total.add(value);
    return total;
  }

  static min(first: Dec, ...rest: Dec[]): Dec {
    let result = first;
    for (const value of rest) if (value.lt(result)) result = value;
    return result;
  }

  static max(first: Dec, ...rest: Dec[]): Dec {
    let result = first;
    for (const value of rest) if (value.gt(result)) result = value;
    return result;
  }

  /** True when the text is a canonical storage decimal. */
  static isCanonical(text: unknown): text is string {
    return typeof text === "string" && text.length <= MAX_DECIMAL_LENGTH && CANONICAL_DECIMAL.test(text);
  }

  add(other: DecInput): Dec {
    const b = Dec.from(other);
    if (this.scale === b.scale) return new Dec(this.mantissa + b.mantissa, this.scale);
    const scale = Math.max(this.scale, b.scale);
    return new Dec(this.mantissa * pow10(scale - this.scale) + b.mantissa * pow10(scale - b.scale), scale);
  }

  sub(other: DecInput): Dec {
    return this.add(Dec.from(other).neg());
  }

  mul(other: DecInput): Dec {
    const b = Dec.from(other);
    return new Dec(this.mantissa * b.mantissa, this.scale + b.scale);
  }

  neg(): Dec {
    return new Dec(-this.mantissa, this.scale);
  }

  abs(): Dec {
    return this.mantissa < 0n ? this.neg() : this;
  }

  /** -1, 0 or 1. */
  sign(): number {
    return this.mantissa > 0n ? 1 : this.mantissa < 0n ? -1 : 0;
  }

  cmp(other: DecInput): number {
    const b = Dec.from(other);
    if (this.scale === b.scale) return this.mantissa === b.mantissa ? 0 : this.mantissa < b.mantissa ? -1 : 1;
    const scale = Math.max(this.scale, b.scale);
    const left = this.mantissa * pow10(scale - this.scale);
    const right = b.mantissa * pow10(scale - b.scale);
    return left === right ? 0 : left < right ? -1 : 1;
  }

  eq(other: DecInput): boolean {
    return this.cmp(other) === 0;
  }

  lt(other: DecInput): boolean {
    return this.cmp(other) < 0;
  }

  lte(other: DecInput): boolean {
    return this.cmp(other) <= 0;
  }

  gt(other: DecInput): boolean {
    return this.cmp(other) > 0;
  }

  gte(other: DecInput): boolean {
    return this.cmp(other) >= 0;
  }

  isZero(): boolean {
    return this.mantissa === 0n;
  }

  isNegative(): boolean {
    return this.mantissa < 0n;
  }

  isPositive(): boolean {
    return this.mantissa > 0n;
  }

  isInteger(): boolean {
    return this.scale === 0;
  }

  /** Zero when the value is negative (a quantity can't go below nothing). */
  clampZero(): Dec {
    return this.mantissa < 0n ? Dec.ZERO : this;
  }

  /** Rounds to at most `scale` fractional digits. */
  roundTo(scale: number, mode: RoundingMode): Dec {
    if (this.scale <= scale) return this;
    return new Dec(divRound(this.mantissa, pow10(this.scale - scale), mode), scale);
  }

  /** this ÷ divisor rounded to `scale` fractional digits: the only division a Dec does by itself. */
  divideTo(divisor: DecInput, scale: number, mode: RoundingMode): Dec {
    const b = Dec.from(divisor);
    // (m1 / 10^s1) / (m2 / 10^s2) = m1·10^s2 / (m2·10^s1); scaled by 10^scale.
    const numerator = this.mantissa * pow10(b.scale + scale);
    const denominator = b.mantissa * pow10(this.scale);
    return new Dec(divRound(numerator, denominator, mode), scale);
  }

  /** Rounds to a multiple of `unit` (the org's share unit for shares, the ledger rules). */
  roundToUnit(unit: DecInput, mode: RoundingMode): Dec {
    const u = Dec.from(unit);
    if (!u.isPositive()) throw new EngineError("DECIMAL_UNIT", "The rounding unit must be positive");
    const numerator = this.mantissa * pow10(u.scale);
    const denominator = u.mantissa * pow10(this.scale);
    return new Dec(divRound(numerator, denominator, mode) * u.mantissa, u.scale);
  }

  floorToUnit(unit: DecInput): Dec {
    return this.roundToUnit(unit, "FLOOR");
  }

  isMultipleOf(unit: DecInput): boolean {
    const u = Dec.from(unit);
    if (u.isZero()) return false;
    return (this.mantissa * pow10(u.scale)) % (u.mantissa * pow10(this.scale)) === 0n;
  }

  /** Signed canonical text: "-12.5", "0", "1250". */
  toString(): string {
    const negative = this.mantissa < 0n;
    const digits = (negative ? -this.mantissa : this.mantissa).toString();
    let text: string;
    if (this.scale === 0) text = digits;
    else if (digits.length > this.scale) text = `${digits.slice(0, digits.length - this.scale)}.${digits.slice(digits.length - this.scale)}`;
    else text = `0.${"0".repeat(this.scale - digits.length)}${digits}`;
    return negative ? `-${text}` : text;
  }

  /** The storage form. Refuses negative values and values outside the CHECK bounds instead of rounding them. */
  toCanonical(): string {
    const text = this.toString();
    if (!Dec.isCanonical(text)) {
      throw new EngineError("DECIMAL_NOT_STORABLE", `${text} can't be stored (negative, or over the precision bound)`);
    }
    return text;
  }

  /** Exactly `digits` fractional digits, rounded with `mode`; no grouping. */
  toFixed(digits: number, mode: RoundingMode = "HALF_EVEN"): string {
    const rounded = this.roundTo(digits, mode);
    const negative = rounded.mantissa < 0n;
    const scaled = (negative ? -rounded.mantissa : rounded.mantissa) * pow10(digits - rounded.scale);
    const raw = scaled.toString().padStart(digits + 1, "0");
    const text = digits === 0 ? raw : `${raw.slice(0, raw.length - digits)}.${raw.slice(raw.length - digits)}`;
    return negative && scaled !== 0n ? `-${text}` : text;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Shorthand for `Dec.from`. */
export function dec(value: DecInput): Dec {
  return Dec.from(value);
}
