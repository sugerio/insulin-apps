import type { MaritalStatus, Province, Relationship } from "#shared";
import { Dec } from "../shared/engine/decimal.ts";

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  self: "You",
  spouse: "Spouse or partner",
  child: "Child",
  other_dependant: "Other dependant",
};

export const MARITAL_STATUS_LABELS: Record<MaritalStatus, string> = {
  married: "Married",
  common_law: "Living common-law",
  widowed: "Widowed",
  divorced: "Divorced",
  separated: "Separated",
  single: "Single",
};

export const PROVINCE_LABELS: Record<Province, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

const DATE = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/** A 'YYYY-MM-DD' date as "April 30, 2026", read as a calendar date (never shifted by the time zone). */
export function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : DATE.format(parsed);
}

const GROUPED = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 0 });

/** Decimal text as "$5,641.47", rounded half up to the cent as the CRA rounds. */
export function formatMoney(value: string): string {
  const [whole = "0", cents = "00"] = Dec.from(value).abs().toFixed(2, "HALF_UP").split(".");
  return `${value.startsWith("-") ? "-" : ""}$${GROUPED.format(BigInt(whole))}.${cents}`;
}

/** A rate as "14.5%". */
export function formatRate(value: string): string {
  return `${Dec.from(value).mul(100).toString()}%`;
}

/** Slip boxes in the order printed: by number, then letter (14, 16, 16A, 18). */
export function byBox<T>(entries: [string, T][]): [string, T][] {
  const key = (box: string) => [Number.parseInt(box, 10), box.replace(/^\d+/, "")] as const;
  return [...entries].sort(([a], [b]) => key(a)[0] - key(b)[0] || key(a)[1].localeCompare(key(b)[1]));
}
