import type { api } from "#shared";

type FederalExemption = (typeof api.FEDERAL_EXEMPTIONS)[number];
type PaymentMethod = (typeof api.PAYMENT_METHODS)[number];
type TaxTreatment = (typeof api.TAX_TREATMENTS)[number];

// Display labels for the contract's vocabularies, in the words the screens use.

export type Tone = "green" | "red" | "blue" | "amber" | "teal" | "grey";

export const RELATIONSHIP_LABELS: Record<api.Relationship, string> = {
  founder: "Founder",
  employee: "Employee",
  ex_employee: "Ex Employee",
  officer: "Officer",
  board_member: "Board member",
  advisor: "Advisor",
  consultant: "Consultant",
  investor: "Investor",
  other: "Other",
};

/** The stakeholders list shows a leaver's relationship as "Former Employee". */
export function relationshipChip(relationship: api.Relationship): string {
  return relationship === "ex_employee" ? "Former Employee" : RELATIONSHIP_LABELS[relationship];
}

/** The dashboard's ownership categories, in the donut's order; the unissued pool is "Available". */
export const OWNERSHIP_CATEGORIES = ["Founders", "Investors", "Employees", "Former employees", "Advisors", "Consultants", "Other", "Unknown", "Available"] as const;
export type OwnershipCategory = (typeof OWNERSHIP_CATEGORIES)[number];

export function ownershipCategory(relationship: string): OwnershipCategory {
  switch (relationship) {
    case "founder":
      return "Founders";
    case "investor":
      return "Investors";
    case "employee":
      return "Employees";
    case "ex_employee":
      return "Former employees";
    case "advisor":
      return "Advisors";
    case "consultant":
      return "Consultants";
    case "officer":
    case "board_member":
    case "other":
      return "Other";
    case "available":
    case "pool":
      return "Available";
    default:
      return "Unknown";
  }
}

export const CATEGORY_COLORS: Record<OwnershipCategory, string> = {
  Founders: "var(--s1)",
  Investors: "var(--s2)",
  Employees: "var(--s3)",
  "Former employees": "var(--s4)",
  Advisors: "var(--s5)",
  Consultants: "var(--s5)",
  Other: "var(--s6)",
  Unknown: "var(--hatch)",
  Available: "var(--s-pool)",
};

export const TERMINATION_TYPE_LABELS: Record<api.TerminationType, string> = {
  voluntary: "Voluntary",
  involuntary: "Involuntary",
  with_cause: "With cause",
  death: "Death",
  disability: "Disability",
  retirement: "Retirement",
};

export const TERMINATION_WINDOW_LABELS: Record<string, string> = {
  VOLUNTARY: "Voluntary",
  INVOLUNTARY: "Involuntary",
  WITH_CAUSE: "With cause",
  DEATH: "Death",
  DISABILITY: "Disability",
  RETIREMENT: "Retirement",
};

export const EXECUTION_LABELS: Record<api.ExecutionStatus, string> = {
  executed: "Executed",
  pending_company: "Pending — company signatory",
  pending_holder: "Pending — holder",
  pending_both: "Pending — holder + company",
  not_required: "Not required",
};

export function isExecutionPending(status: api.ExecutionStatus): boolean {
  return status.startsWith("pending");
}

export const MISSING_LABELS: Record<"company_signatory" | "holder" | "both", string> = {
  company_signatory: "Company signatory",
  holder: "Holder",
  both: "Holder + company",
};

export const SECURITY_STATUS_LABELS: Record<api.SecurityStatus, string> = {
  OUTSTANDING: "Outstanding",
  EXERCISED: "Exercised",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  REPURCHASED: "Repurchased",
  TRANSFERRED: "Transferred",
  CONVERTED: "Converted",
  RETRACTED: "Retracted",
};

export const SECURITY_STATUS_TONES: Record<api.SecurityStatus, Tone> = {
  OUTSTANDING: "green",
  EXERCISED: "blue",
  CANCELLED: "red",
  EXPIRED: "red",
  REPURCHASED: "blue",
  TRANSFERRED: "blue",
  CONVERTED: "blue",
  RETRACTED: "grey",
};

export const VALUATION_STATUS_LABELS: Record<api.ValuationStatus, string> = {
  presumptively_valid: "Presumptively valid",
  expiring_soon: "Expiring soon",
  review_required: "Review required",
  superseded: "Superseded",
  expired: "Expired",
  voided: "Voided",
  draft: "Draft report",
  not_409a: "Not a 409A",
};

export const VALUATION_STATUS_TONES: Record<api.ValuationStatus, Tone> = {
  presumptively_valid: "green",
  expiring_soon: "amber",
  review_required: "red",
  superseded: "grey",
  expired: "red",
  voided: "grey",
  draft: "grey",
  not_409a: "grey",
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  ACH: "ACH",
  WIRE: "Wire",
  CHECK: "Check",
  CASH: "Cash",
  MANUAL_UNSPECIFIED: "Manual (method not recorded)",
  OTHER: "Other",
};

export const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
  W2: "W-2",
  FORM_1099_NEC: "1099-NEC",
  NON_US: "Non-US (local payroll)",
};

export const FEDERAL_EXEMPTION_LABELS: Record<FederalExemption, string> = {
  RULE_701: "Rule 701",
  SECTION_4A2: "Section 4(a)(2)",
  REG_D_506B: "Regulation D 506(b)",
  REG_D_506C: "Regulation D 506(c)",
  REG_S: "Regulation S",
  NON_US: "Non-US",
  NONE: "None",
  OTHER: "Other",
};

export const PORTAL_STATE_LABELS: Record<api.PortalState, string> = {
  open: "Open",
  no_self_email: "Not open (no own e-mail address on the record)",
  closed_by_admin: "Closed by an admin",
};

export const EXERCISE_REQUEST_STATUS_LABELS: Record<string, string> = {
  NEEDS_REVIEW: "Needs review",
  AWAITING_HOLDER_CONFIRMATION: "Awaiting holder confirmation",
  AWAITING_PAYMENT: "Awaiting payment",
  EXERCISED: "Exercised",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  REVERSED: "Reversed",
};

export const ELECTION_83B_LABELS: Record<string, string> = {
  PENDING: "Pending",
  FILED: "Filed",
  NOT_REQUIRED: "Not required",
  UNCONFIRMED_DEADLINE_PASSED: "Unconfirmed — deadline passed",
  PROOF_MISSING: "Proof missing",
};

export const FREQUENCY_LABELS: Record<string, string> = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", ANNUALLY: "Annually" };

const DOCUMENT_KIND_LABELS: Record<string, string> = {
  GRANT_AGREEMENT: "Grant agreement",
  STOCK_PURCHASE_AGREEMENT: "Stock purchase agreement",
  SAFE_AGREEMENT: "SAFE agreement",
  WARRANT_AGREEMENT: "Warrant agreement",
  NOTICE_OF_EXERCISE: "Notice of exercise",
  ELECTION_83B: "83(b) election",
  BOARD_CONSENT: "Board consent",
  STOCKHOLDER_CONSENT: "Stockholder consent",
  PLAN_DOCUMENT: "Plan document",
  CHARTER: "Charter",
  VALUATION_REPORT: "Valuation report",
  VALUATION_SUPPORT: "Valuation support",
  COUNSEL_MEMO: "Counsel memo",
  SEPARATION_AGREEMENT: "Separation agreement",
  PAYMENT_RECORD: "Payment record",
  CERTIFICATE: "Certificate",
  TEMPLATE: "Template",
  STATEMENT: "Statement",
  FORM_3921: "Form 3921",
  RECONCILIATION_REPORT: "Reconciliation report",
  IMPORT_ARCHIVE: "Import archive",
  OTHER: "Other",
};

export function documentKindLabel(kind: string): string {
  return DOCUMENT_KIND_LABELS[kind] ?? kind;
}

/** "3 months", "1 month", "0 days" (exit windows and repurchase periods). */
export function periodLabel(period: { period: string; unit: string } | null | undefined): string {
  if (!period) return "—";
  const unit = period.unit.toLowerCase().replace(/s$/, "");
  return `${period.period} ${period.period === "1" ? unit : `${unit}s`}`;
}

export const SECURITY_KIND_LABELS: Record<api.SecurityFamily, string> = {
  STOCK: "Shares",
  EQUITY_COMPENSATION: "Options",
  WARRANT: "Warrant",
  CONVERTIBLE: "SAFE",
};

/** ISO or NSO from an option's subtype; null for anything else. */
export function optionType(subtype: api.SecuritySubtype): "ISO" | "NSO" | null {
  return subtype === "OPTION_ISO" ? "ISO" : subtype === "OPTION_NSO" ? "NSO" : null;
}

/** Company › Signatories: the signatory types in a fixed order, as imported (lowercase). */
export const SIGNATORY_TYPES: readonly (readonly [capability: string, label: string])[] = [
  ["options_signatory", "Options"],
  ["certificate_primary", "Certificate (primary)"],
  ["certificate_secondary", "Certificate (secondary)"],
  ["safes_signatory", "SAFEs"],
  ["warrants_signatory", "Warrants"],
  ["exercise_approver", "Exercise approver"],
];

/** A signatory type's label; an unknown type is shown as imported, in words ("profit_interests_signatory" → "Profit interests signatory"). */
export function signatoryTypeLabel(capability: string): string {
  const known = SIGNATORY_TYPES.find(([key]) => key === capability.toLowerCase());
  if (known) return known[1];
  const words = capability.toLowerCase().replace(/_/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : capability;
}
