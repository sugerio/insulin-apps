// Exact arithmetic on the API's decimal and ratio strings, for display only. Quantities and money arrive as canonical
// decimals ("4000000", "0.95") and percentages as exact fractions ("1/4"); the engine did the real arithmetic. The UI
// still sums rows, compares values and rounds for display, so it works in BigInt units and never in floats
// (no float arithmetic for shares or money).

/** The contract's decimal scale: at most 12 fractional digits. */
const SCALE = 12;
const UNIT = 10n ** BigInt(SCALE);
const DECIMAL = /^(\d+)(?:\.(\d{1,12}))?$/;
const RATIO = /^(\d+)(?:\/(\d+))?$/;

export interface Fraction {
  num: bigint;
  den: bigint;
}

/** A decimal string as an exact count of 10^-12 units. Anything that isn't a plain non-negative decimal is 0. */
export function toUnits(value: string | null | undefined): bigint {
  const match = value ? DECIMAL.exec(value) : null;
  if (!match) return 0n;
  return BigInt(match[1]!) * UNIT + BigInt((match[2] ?? "").padEnd(SCALE, "0") || "0");
}

/** Units back to a canonical decimal string ("1.5", "0"). */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / UNIT;
  const fraction = (abs % UNIT).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function isPositive(value: string | null | undefined): boolean {
  return toUnits(value) > 0n;
}

export function compareDecimals(a: string | null | undefined, b: string | null | undefined): number {
  const x = toUnits(a);
  const y = toUnits(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

export function sumDecimals(values: readonly (string | null | undefined)[]): string {
  return fromUnits(values.reduce((total, value) => total + toUnits(value), 0n));
}

export function subtractDecimals(a: string | null | undefined, b: string | null | undefined): string {
  return fromUnits(toUnits(a) - toUnits(b));
}

/** a × b, exact, truncated to the 12-digit scale (inputs have at most 12 digits each, so only display rounding remains). */
export function multiplyDecimals(a: string | null | undefined, b: string | null | undefined): string {
  return fromUnits((toUnits(a) * toUnits(b)) / UNIT);
}

/** An exact fraction "n" or "n/d" (the engine's Rational#toJSON). Malformed input is 0. */
export function parseRatio(value: string | null | undefined): Fraction {
  const match = value ? RATIO.exec(value) : null;
  if (!match) return { num: 0n, den: 1n };
  const den = match[2] === undefined ? 1n : BigInt(match[2]);
  return den === 0n ? { num: 0n, den: 1n } : { num: BigInt(match[1]!), den };
}

/** a ÷ b as an exact fraction of two decimals; 0 when b is 0. */
export function fractionOf(a: string | null | undefined, b: string | null | undefined): Fraction {
  const den = toUnits(b);
  return den === 0n ? { num: 0n, den: 1n } : { num: toUnits(a), den };
}

export function compareFractions(a: Fraction, b: Fraction): number {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareRatios(a: string | null | undefined, b: string | null | undefined): number {
  return compareFractions(parseRatio(a), parseRatio(b));
}

/** Rounds num/den to `digits` decimals, half up (values are never negative here). */
function roundFraction(num: bigint, den: bigint, digits: number): bigint {
  const scaled = num * 10n ** BigInt(digits);
  return (scaled * 2n + den) / (den * 2n);
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function withFraction(whole: bigint, fraction: string): string {
  return `${group(whole.toString())}${fraction ? `.${fraction}` : ""}`;
}

/**
 * A decimal with thousands separators and at least `minDigits` fractional digits. Digits beyond that are kept, never
 * rounded away: a par value of 0.00001 stays visible, and a fractional share shows its remainder.
 */
export function formatExact(value: string, minDigits: number): string {
  const units = toUnits(value);
  const fraction = (units % UNIT).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return withFraction(units / UNIT, fraction.padEnd(minDigits, "0"));
}

/** A decimal rounded half up to exactly `digits` fractional digits, with thousands separators. */
export function formatRounded(value: string, digits: number): string {
  const rounded = roundFraction(toUnits(value), UNIT, digits);
  const base = 10n ** BigInt(digits);
  const fraction = digits === 0 ? "" : (rounded % base).toString().padStart(digits, "0");
  return withFraction(rounded / base, fraction);
}

/** A fraction of the whole as a percentage, rounded half up: 1/4 → "25.00%" (2 decimals in the UI). */
export function formatFractionPercent(fraction: Fraction, digits = 2): string {
  if (fraction.den === 0n) return "—";
  const rounded = roundFraction(fraction.num * 100n, fraction.den, digits);
  const base = 10n ** BigInt(digits);
  const part = digits === 0 ? "" : `.${(rounded % base).toString().padStart(digits, "0")}`;
  return `${group((rounded / base).toString())}${part}%`;
}

export function formatRatioPercent(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  return formatFractionPercent(parseRatio(value), digits);
}

/** "24M", "4.3M", "12K", "940": the donut's centre label. */
export function formatCompact(value: string | null | undefined): string {
  const units = toUnits(value);
  const whole = units / UNIT;
  const scaled = (divisor: bigint, suffix: string) => {
    const tenths = roundFraction(units, UNIT * divisor, 1);
    const text = whole >= divisor * 10n ? (roundFraction(units, UNIT * divisor, 0)).toString() : `${tenths / 10n}.${tenths % 10n}`;
    return `${text.replace(/\.0$/, "")}${suffix}`;
  };
  if (whole >= 1_000_000n) return scaled(1_000_000n, "M");
  if (whole >= 1_000n) return scaled(1_000n, "K");
  return formatRounded(fromUnits(units), 0);
}
