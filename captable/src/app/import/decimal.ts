import { engine } from "#shared";
import { exactDecimal } from "./xlsx.ts";

/** Canonicalizes display text with digit operations only. It never evaluates the value as a number. */
export function canonicalDecimal(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  let text = normalizeNumber(raw);
  if (text === null) return null;
  if (/^\(.+\)$/.test(text)) text = `-${text.slice(1, -1)}`;
  try {
    if (/[eE]/.test(text)) text = exactDecimal(text).value;
    const value = engine.Dec.from(text);
    const canonical = value.toString();
    return engine.Dec.isCanonical(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

export function decimalError(raw: string | null | undefined): "missing" | "invalid" | "precision" | null {
  if (raw === null || raw === undefined || raw.trim() === "") return "missing";
  let text = normalizeNumber(raw);
  if (text === null) return "invalid";
  if (/^\(.+\)$/.test(text)) text = `-${text.slice(1, -1)}`;
  try {
    if (/[eE]/.test(text)) text = exactDecimal(text).value;
    engine.Dec.from(text).toCanonical();
    return null;
  } catch (error) {
    return error instanceof Error && /fractional digits|canonical decimal|40 characters|DECIMAL_PRECISION/i.test(error.message)
      ? "precision"
      : "invalid";
  }
}

function normalizeNumber(raw: string): string | null {
  let text = raw.trim().replace(/^[$£€]\s*/, "").replace(/\s/g, "");
  if (text.includes(",")) {
    const unsigned = /^\(.+\)$/.test(text) ? text.slice(1, -1) : text.replace(/^[+-]/, "");
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(unsigned)) return null;
    text = text.replace(/,/g, "");
  }
  return text;
}

export function addDecimals(values: Iterable<string>): string | null {
  try {
    return engine.Dec.sum([...values].map((value) => engine.Dec.parse(value))).toCanonical();
  } catch {
    return null;
  }
}

export function subtractDecimals(left: string, ...right: string[]): string | null {
  try {
    let value = engine.Dec.parse(left);
    for (const item of right) value = value.sub(engine.Dec.parse(item));
    return value.toCanonical();
  } catch {
    return null;
  }
}

export function multiplyDecimals(left: string, right: string): string | null {
  try {
    return engine.Dec.parse(left).mul(engine.Dec.parse(right)).toCanonical();
  } catch {
    return null;
  }
}

export interface RepurchasePrice {
  price: string;
  fromLotPrice: boolean;
}

/** Prefer the contractual lot price when its extended amount explains a cent-rounded payment. */
export function repurchasePrice(consideration: string, quantity: string, lotPrice: string | null): RepurchasePrice | null {
  try {
    const paid = engine.Dec.parse(consideration);
    const shares = engine.Rational.fromDec(quantity);
    if (shares.isZero()) return null;
    if (lotPrice !== null && engine.Dec.isCanonical(lotPrice)) {
      const extended = engine.Rational.fromDec(lotPrice).mul(shares).roundTo(2, "HALF_EVEN");
      if (extended.eq(paid)) return { price: lotPrice, fromLotPrice: true };
    }
    return {
      price: engine.Rational.fromDec(consideration).div(shares).roundTo(12, "HALF_EVEN").toCanonical(),
      fromLotPrice: false,
    };
  } catch {
    return null;
  }
}

export function decimalsEqual(left: string, right: string): boolean {
  try {
    return engine.Dec.parse(left).eq(engine.Dec.parse(right));
  } catch {
    return false;
  }
}

export function isPositive(value: string): boolean {
  try {
    return engine.Dec.parse(value).isPositive();
  } catch {
    return false;
  }
}
