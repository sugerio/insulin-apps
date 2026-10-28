import { Dec, type DecInput, type RoundingMode } from "./decimal.ts";
import { Rational, type RationalInput } from "./rational.ts";

/**
 * Display helpers shared by the web app and the exports (the product rules: shares default to 0 decimals, prices to
 * 2–4; the ledger rules: percentages 2 dp in the UI and 6 dp in exports). Share counts are never rounded for display: a
 * fractional quantity shows every digit it has. Money and percentages round at this edge only, with a named mode.
 */

function group(integerDigits: string): string {
  return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface DecimalFormat {
  /** At least this many fractional digits (zero-padded). */
  minFractionDigits?: number;
  /** At most this many; more digits are rounded with `mode`. Omit to keep every digit. */
  maxFractionDigits?: number;
  mode?: RoundingMode;
  grouping?: boolean;
  /** The minus sign: "-" (exports, default) or "−" (U+2212, typeset UI text). */
  minus?: string;
}

export function formatDecimal(value: DecInput, options: DecimalFormat = {}): string {
  const { minFractionDigits = 0, maxFractionDigits, mode = "HALF_EVEN", grouping = true, minus = "-" } = options;
  let d = Dec.from(value);
  if (maxFractionDigits !== undefined) d = d.roundTo(maxFractionDigits, mode);
  const digits = Math.max(d.scale, minFractionDigits);
  const text = d.abs().toFixed(digits);
  const [integerPart = "0", fractionPart] = text.split(".");
  const body = (grouping ? group(integerPart) : integerPart) + (fractionPart ? `.${fractionPart}` : "");
  return d.isNegative() ? `${minus}${body}` : body;
}

/** "24,312,120"; a fractional quantity keeps its digits ("1,000.5"). */
export function formatShares(value: DecInput, minFractionDigits = 0): string {
  return formatDecimal(value, { minFractionDigits });
}

export interface MoneyFormat {
  currency?: string;
  decimals?: number;
  mode?: RoundingMode;
  minus?: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CAD: "CA$", SEK: "SEK " };

/** "$16,147,718.60". Other currencies use their symbol, or the ISO code. */
export function formatMoney(value: DecInput, options: MoneyFormat = {}): string {
  const { currency = "USD", decimals = 2, mode = "HALF_EVEN", minus = "-" } = options;
  const d = Dec.from(value);
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const body = formatDecimal(d.abs(), { minFractionDigits: decimals, maxFractionDigits: decimals, mode });
  return d.isNegative() && body.replace(/[0.,]/g, "") !== "" ? `${minus}${symbol}${body}` : `${symbol}${body}`;
}

/**
 * A per-share price with at least `minDecimals` and as many more as it has, up to `maxDecimals` ("$0.10",
 * "$0.0001"): a price is shown exactly unless it has more digits than the maximum.
 */
export function formatPrice(value: DecInput, options: { currency?: string; minDecimals?: number; maxDecimals?: number } = {}): string {
  const { currency = "USD", minDecimals = 2, maxDecimals = 6 } = options;
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${formatDecimal(value, { minFractionDigits: minDecimals, maxFractionDigits: maxDecimals, mode: "HALF_EVEN" })}`;
}

/** A ratio as a percentage: 4300000/24312120 → "17.69%". */
export function formatPercent(value: RationalInput, digits = 2, mode: RoundingMode = "HALF_EVEN"): string {
  const percent = Rational.from(value).mul(100).roundTo(digits, mode);
  return `${percent.toFixed(digits)}%`;
}

/** A ratio rounded to a decimal fraction (exports use 6 dp of the percentage). */
export function formatRatioDecimal(value: RationalInput, digits: number, mode: RoundingMode = "HALF_EVEN"): string {
  return Rational.from(value).roundTo(digits, mode).toFixed(digits);
}

/** A conversion or split ratio as "A:B" ("1:1", "2:1"). */
export function formatRatio(value: RationalInput): string {
  const r = Rational.from(value);
  return `${r.num}:${r.den}`;
}
