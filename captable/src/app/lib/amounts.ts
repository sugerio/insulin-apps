import { engine } from "#shared";
import { formatExact } from "./decimal.ts";

// What an admin types into a quantity, price or money field, read with the engine's exact decimals (`Dec`):
// never a JS number, never rounded. A request body carries the canonical string the contract's `Dec` schema accepts.

export type ParsedAmount = { ok: true; value: string } | { ok: false; error: string };

export interface AmountRules {
  /** Zero is refused (quantities, prices, payments: the contract's PositiveDec). */
  positive?: boolean;
  /** The amount must be a multiple of this unit: the org's share unit for share and option quantities. */
  unit?: string | null;
  /** The unit's name in the error ("options", "shares"). */
  unitName?: string;
}

const TYPED = /^[0-9.,\s]+$/;

/** The typed text as a canonical decimal, an error to show, or null when the field is empty. */
export function parseAmount(text: string, rules: AmountRules = {}): ParsedAmount | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!TYPED.test(trimmed)) return { ok: false, error: trimmed.startsWith("-") ? "Enter an amount that isn't negative." : "Enter a number, such as 40000 or 0.95." };
  const clean = trimmed.replace(/[,\s]/g, "");
  let amount: engine.Dec;
  try {
    amount = engine.Dec.from(clean);
  } catch (error) {
    const code = error instanceof engine.EngineError ? error.code : "";
    return { ok: false, error: code === "DECIMAL_PRECISION" ? "Use at most 12 decimal places." : "Enter a number, such as 40000 or 0.95." };
  }
  if (amount.isNegative()) return { ok: false, error: "Enter an amount that isn't negative." };
  if (rules.positive && amount.isZero()) return { ok: false, error: "Enter an amount greater than 0." };
  if (rules.unit && !amount.isZero() && !amount.isMultipleOf(rules.unit)) {
    return { ok: false, error: rules.unit === "1" ? `Use whole ${rules.unitName ?? "units"}.` : `Use multiples of ${rules.unit} ${rules.unitName ?? ""}`.trim() + "." };
  }
  try {
    return { ok: true, value: amount.toCanonical() };
  } catch {
    return { ok: false, error: "This number is too large to record." };
  }
}

/** The canonical value of a typed amount, or null when it is empty or invalid. */
export function amountOf(text: string, rules: AmountRules = {}): string | null {
  const parsed = parseAmount(text, rules);
  return parsed?.ok ? parsed.value : null;
}

/** An exact engine decimal from a canonical string; null stays null. */
export function decOrNull(value: string | null | undefined): engine.Dec | null {
  return value === null || value === undefined || value === "" ? null : engine.Dec.parse(value);
}

/** Money exactly as recorded: "$9,300.00", "$154.105" (at least 2 decimals, never rounded away). */
export function exactMoney(value: string | null | undefined): string {
  return value === null || value === undefined ? "—" : `$${formatExact(value, 2)}`;
}

/** a × b, exact (the engine adds the scales; nothing is truncated). */
export function times(a: string, b: string): string {
  return engine.Dec.parse(a).mul(engine.Dec.parse(b)).toString();
}

/** a − b, exact; may be negative (a shortfall). */
export function minus(a: string, b: string): string {
  return engine.Dec.parse(a).sub(engine.Dec.parse(b)).toString();
}

export function compareAmounts(a: string, b: string): number {
  return engine.Dec.parse(a).cmp(engine.Dec.parse(b));
}
