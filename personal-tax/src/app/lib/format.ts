import type { MaritalStatus, Province, Relationship } from "#shared";

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
