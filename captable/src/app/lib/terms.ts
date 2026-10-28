import type { api } from "#shared";

// `Security.terms` is a free-form record in the contract ("per family, from the issuance payload and later
// modifications"). The read model fills it from the engine's issuance payloads (payload version 1, OCF
// property names plus the app's own x_ extensions), so this is the one place that knows those key names. Every reader checks
// the value's shape and answers null when it is absent or unexpected, so a renamed key shows "—", never a crash.

type Terms = Readonly<Record<string, unknown>>;

const DECIMAL = /^(0|[1-9]\d*)(\.\d{0,11}[1-9])?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function record(value: unknown): Terms | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Terms) : null;
}

function decimal(value: unknown): string | null {
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function date(value: unknown): string | null {
  return typeof value === "string" && ISO_DATE.test(value) ? value : null;
}

/** A Monetary `{amount, currency}`'s amount. */
function money(value: unknown): string | null {
  return decimal(record(value)?.amount);
}

export function exercisePrice(terms: Terms): string | null {
  return money(terms.exercise_price);
}

export function sharePrice(terms: Terms): string | null {
  return money(terms.share_price);
}

export function capitalContribution(terms: Terms): string | null {
  return money(terms.x_capital_contribution);
}

export function expirationDate(terms: Terms): string | null {
  return date(terms.expiration_date) ?? date(terms.warrant_expiration_date);
}

export function earlyExercisable(terms: Terms): boolean | null {
  return typeof terms.early_exercisable === "boolean" ? terms.early_exercisable : null;
}

export function vestingTermsId(terms: Terms): string | null {
  return text(terms.vesting_terms_id);
}

export function issueReason(terms: Terms): string | null {
  return text(terms.x_issue_reason);
}

export function holdingStartDate(terms: Terms): string | null {
  return date(terms.x_holding_start_date);
}

export function consideration(terms: Terms): string | null {
  return text(terms.consideration_text);
}

export function exerciseProvisions(terms: Terms): string | null {
  return text(terms.x_exercise_provisions);
}

export function comments(terms: Terms): string[] {
  return Array.isArray(terms.comments) ? terms.comments.filter((item): item is string => typeof item === "string") : [];
}

/** "Exercise", "Conversion", "Transfer": how a lot came about (the issuance's x_origin). */
export function origin(terms: Terms): string | null {
  return text(terms.x_origin);
}

export interface AccelerationTerms {
  kind: string;
  percent: string | null;
  months: number | null;
  text: string | null;
}

export function accelerationTerms(terms: Terms): AccelerationTerms | null {
  const value = record(terms.x_acceleration_terms);
  const kind = text(value?.kind);
  if (!value || !kind) return null;
  return { kind, percent: decimal(value.percent), months: typeof value.months === "number" ? value.months : null, text: text(value.text) };
}

export function accelerationLabel(value: AccelerationTerms | null): string {
  if (!value || value.kind === "NONE") return "None";
  if (value.text) return value.text;
  const trigger = value.kind === "DOUBLE_TRIGGER" ? "Double trigger" : "Single trigger";
  return [trigger, value.percent ? `${value.percent}%` : null, value.months !== null ? `${value.months} months` : null].filter(Boolean).join(" ");
}

/** OCF termination-window reasons, mapped onto our six termination types. */
const OCF_REASONS: Record<string, string> = {
  VOLUNTARY_OTHER: "VOLUNTARY",
  VOLUNTARY_GOOD_CAUSE: "VOLUNTARY",
  VOLUNTARY_RETIREMENT: "RETIREMENT",
  INVOLUNTARY_OTHER: "INVOLUNTARY",
  INVOLUNTARY_DEATH: "DEATH",
  INVOLUNTARY_DISABILITY: "DISABILITY",
  INVOLUNTARY_WITH_CAUSE: "WITH_CAUSE",
};

/** The grant's own exit windows, keyed by our termination reason, as `{period, unit}` like the plan's. */
export function terminationWindows(terms: Terms): Map<string, { period: string; unit: string }> {
  const windows = new Map<string, { period: string; unit: string }>();
  if (!Array.isArray(terms.termination_exercise_windows)) return windows;
  for (const item of terms.termination_exercise_windows) {
    const value = record(item);
    const reason = OCF_REASONS[String(value?.reason)] ?? text(value?.reason);
    if (!value || !reason || typeof value.period !== "number") continue;
    const unit = String(value.period_type ?? "MONTHS").toUpperCase();
    if (!windows.has(reason)) windows.set(reason, { period: String(value.period), unit: unit.endsWith("S") ? unit : `${unit}S` });
  }
  return windows;
}

export interface RepurchaseRight {
  pricePerShare: string | null;
  window: { period: string; unit: string } | null;
  termsText: string | null;
}

export function repurchaseRight(terms: Terms): RepurchaseRight | null {
  const value = record(terms.x_repurchase_right);
  if (!value) return null;
  const window = record(value.window);
  return {
    pricePerShare: money(value.price_per_share),
    window: window && typeof window.period === "number" ? { period: String(window.period), unit: `${String(window.period_type ?? "DAYS").toUpperCase().replace(/S$/, "")}S` } : null,
    termsText: text(value.terms_text),
  };
}

export interface SafeTerms {
  principal: string | null;
  form: string | null;
  conversionTiming: string | null;
  valuationCap: string | null;
  uncapped: boolean;
  discountRate: string | null;
  mfn: boolean | null;
  proRata: boolean | null;
  fundsReceivedOn: string | null;
  conversionPrice: string | null;
}

export function safeTerms(terms: Terms): SafeTerms {
  const safe = record(terms.x_safe_terms) ?? {};
  return {
    principal: money(terms.investment_amount),
    form: text(safe.form),
    conversionTiming: text(safe.conversion_timing),
    valuationCap: money(safe.valuation_cap),
    uncapped: safe.uncapped === true,
    discountRate: decimal(safe.discount_rate),
    mfn: typeof safe.mfn === "boolean" ? safe.mfn : null,
    proRata: typeof safe.pro_rata === "boolean" ? safe.pro_rata : terms.pro_rata !== undefined ? decimal(terms.pro_rata) !== "0" : null,
    fundsReceivedOn: date(terms.x_funds_received_on),
    conversionPrice: money(terms.x_conversion_price),
  };
}

/** A security's link: SAFEs have their own page. */
export function securityHref(security: { id: string; family: api.SecurityFamily }): string {
  return security.family === "CONVERTIBLE" ? `convertibles/${security.id}` : `securities/${security.id}`;
}
