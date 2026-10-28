import "./zod-config.ts";
import { z } from "zod";

// Closed vocabularies for the retained cap-table API and engine.

// ---------------------------------------------------------------------------
// Identity and access

/** Identity is supplied by the Insulin console. */
export const AUTH_METHODS = ["console"] as const;
export const authMethodSchema = z.enum(AUTH_METHODS);
export type AuthMethod = z.infer<typeof authMethodSchema>;

/** Effective company access derived from the console role. */
export const ORG_ACCESS_LEVELS = ["admin_rw", "admin_ro"] as const;
export const orgAccessSchema = z.enum(ORG_ACCESS_LEVELS);
export type OrgAccess = z.infer<typeof orgAccessSchema>;

// ---------------------------------------------------------------------------
// Orgs

/** Importing and archived companies are storage states; every ordinary API read exposes active companies only. */
export const ORG_STATUSES = ["importing", "active", "archived"] as const;
export const orgStatusSchema = z.enum(ORG_STATUSES);
export type OrgStatus = z.infer<typeof orgStatusSchema>;

/** `orgs.entity_type`. */
export const ENTITY_TYPES = ["C_CORPORATION"] as const;

/** `settings.expiry.mode`: report_only until an administrator confirms the first expiry run. */
export const EXPIRY_MODES = ["report_only", "automatic"] as const;
export const expiryModeSchema = z.enum(EXPIRY_MODES);

// ---------------------------------------------------------------------------
// Stakeholders and e-mail addresses

/** `stakeholders.kind`. */
export const STAKEHOLDER_KINDS = ["individual", "institution"] as const;
export const stakeholderKindSchema = z.enum(STAKEHOLDER_KINDS);

/** `stakeholders.relationship`. A termination sets ex_employee and keeps the previous value for a reversal. */
export const RELATIONSHIPS = [
  "founder",
  "employee",
  "ex_employee",
  "officer",
  "board_member",
  "advisor",
  "consultant",
  "investor",
  "other",
] as const;
export const relationshipSchema = z.enum(RELATIONSHIPS);
export type Relationship = z.infer<typeof relationshipSchema>;

/** `stakeholders.tax_status`. */
export const TAX_STATUSES = ["us", "non_us", "unknown"] as const;
export const taxStatusSchema = z.enum(TAX_STATUSES);

/** `stakeholders.portal_access`: closed denies portal access; auto and open still require an active self e-mail. */
export const PORTAL_ACCESS_MODES = ["auto", "open", "closed"] as const;
export const portalAccessSchema = z.enum(PORTAL_ACCESS_MODES);

/** Whether the stakeholder can currently use the holder portal. */
export const PORTAL_STATES = [
  "open",
  "no_self_email",
  "closed_by_admin",
] as const;
export const portalStateSchema = z.enum(PORTAL_STATES);
export type PortalState = z.infer<typeof portalStateSchema>;

/** `stakeholder_emails.kind`: institutions list contacts; estates and guardians list representatives. */
export const STAKEHOLDER_EMAIL_KINDS = ["self", "contact", "representative"] as const;
export const stakeholderEmailKindSchema = z.enum(STAKEHOLDER_EMAIL_KINDS);

/** `admin_stakeholder_links.source` (the self-dealing block, the ledger rules). */
export const ADMIN_LINK_SOURCES = ["directory", "admin"] as const;
export const adminLinkSourceSchema = z.enum(ADMIN_LINK_SOURCES);

/** `scheduled_terminations.termination_type`; also the type of a recorded termination. */
export const TERMINATION_TYPES = ["voluntary", "involuntary", "with_cause", "death", "disability", "retirement"] as const;
export const terminationTypeSchema = z.enum(TERMINATION_TYPES);
export type TerminationType = z.infer<typeof terminationTypeSchema>;

/** The termination reasons of an exit window: one window per termination type, in upper case (the API contract). */
export const TERMINATION_WINDOW_REASONS = [
  "VOLUNTARY",
  "INVOLUNTARY",
  "WITH_CAUSE",
  "DEATH",
  "DISABILITY",
  "RETIREMENT",
] as const;
export const terminationWindowReasonSchema = z.enum(TERMINATION_WINDOW_REASONS);

/** A stakeholder's state on the cap table's ownership tab. */
export const STAKEHOLDER_STATUSES = ["active", "terminating", "terminated"] as const;

// ---------------------------------------------------------------------------
// Securities and the ledger

/** `securities.family`. */
export const SECURITY_FAMILIES = ["STOCK", "EQUITY_COMPENSATION", "WARRANT", "CONVERTIBLE"] as const;
export const securityFamilySchema = z.enum(SECURITY_FAMILIES);
export type SecurityFamily = z.infer<typeof securityFamilySchema>;

/**
 * `securities.subtype`, per family as the securities CHECK pairs them. RSU, SAR and NOTE are model-ready; the sample
 * data holds none. There is no OPTION_INTL: non-US is an exemption (the product rules).
 */
export const SECURITY_SUBTYPES_BY_FAMILY = {
  STOCK: ["COMMON", "PREFERRED"],
  EQUITY_COMPENSATION: ["OPTION_ISO", "OPTION_NSO", "RSU", "SAR"],
  WARRANT: ["WARRANT"],
  CONVERTIBLE: ["SAFE", "NOTE"],
} as const satisfies Record<SecurityFamily, readonly string[]>;
export const SECURITY_SUBTYPES = [
  "COMMON",
  "PREFERRED",
  "OPTION_ISO",
  "OPTION_NSO",
  "RSU",
  "SAR",
  "WARRANT",
  "SAFE",
  "NOTE",
] as const;
export const securitySubtypeSchema = z.enum(SECURITY_SUBTYPES);
export type SecuritySubtype = z.infer<typeof securitySubtypeSchema>;

export const OPTION_TYPES = ["ISO", "NSO"] as const;
export const optionTypeSchema = z.enum(OPTION_TYPES);
export type OptionType = z.infer<typeof optionTypeSchema>;

/** Computed by the replay. "Execution pending" is the separate executionStatus, not a status. */
export const SECURITY_STATUSES = [
  "OUTSTANDING",
  "EXERCISED",
  "CANCELLED",
  "EXPIRED",
  "REPURCHASED",
  "TRANSFERRED",
  "CONVERTED",
  "RETRACTED",
] as const;
export const securityStatusSchema = z.enum(SECURITY_STATUSES);
export type SecurityStatus = z.infer<typeof securityStatusSchema>;

/** From the ledger (`X_EXECUTION_STATUS`, the product rules): a pending grant counts in FD but can't be exercised. */
export const EXECUTION_STATUSES = ["executed", "pending_company", "pending_holder", "pending_both", "not_required"] as const;
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const FEDERAL_EXEMPTIONS = [
  "RULE_701",
  "SECTION_4A2",
  "REG_D_506B",
  "REG_D_506C",
  "REG_S",
  "NON_US",
  "NONE",
  "OTHER",
] as const;
export const federalExemptionSchema = z.enum(FEDERAL_EXEMPTIONS);

/** `exercise_requests.payment_method`. MANUAL_UNSPECIFIED exists only on rows migrated from Pulley. */
export const PAYMENT_METHODS = ["ACH", "WIRE", "CHECK", "CASH", "MANUAL_UNSPECIFIED", "OTHER"] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

/** What an admin may enter when recording an exercise. */
export const EXERCISE_PAYMENT_METHODS = ["ACH", "WIRE", "CHECK", "CASH"] as const;
export const exercisePaymentMethodSchema = z.enum(EXERCISE_PAYMENT_METHODS);

export const TAX_TREATMENTS = ["W2", "FORM_1099_NEC", "NON_US"] as const;
export const taxTreatmentSchema = z.enum(TAX_TREATMENTS);

/** `transaction_types.family`. */
export const TRANSACTION_TYPE_FAMILIES = [
  "STOCK",
  "EQUITY_COMPENSATION",
  "WARRANT",
  "CONVERTIBLE",
  "STOCK_CLASS",
  "ISSUER",
  "STOCK_PLAN",
  "VESTING",
  "STAKEHOLDER",
  "LEDGER",
  "MIGRATION",
] as const;

/**
 * The seeded `transaction_types` codes (OCF v1.2.0 names, then the X_ extensions). The API accepts any well-formed
 * code (`transactionTypeSchema`), because the table is the authority; this list names the ones migration 0001 seeds.
 */
export const TRANSACTION_TYPES = [
  "TX_STOCK_ISSUANCE",
  "TX_STOCK_TRANSFER",
  "TX_STOCK_CANCELLATION",
  "TX_STOCK_REPURCHASE",
  "TX_STOCK_CONVERSION",
  "TX_STOCK_REISSUANCE",
  "TX_STOCK_RETRACTION",
  "TX_STOCK_ACCEPTANCE",
  "TX_EQUITY_COMPENSATION_ISSUANCE",
  "TX_EQUITY_COMPENSATION_EXERCISE",
  "TX_EQUITY_COMPENSATION_CANCELLATION",
  "TX_EQUITY_COMPENSATION_RELEASE",
  "TX_EQUITY_COMPENSATION_TRANSFER",
  "TX_EQUITY_COMPENSATION_RETRACTION",
  "TX_EQUITY_COMPENSATION_ACCEPTANCE",
  "TX_WARRANT_ISSUANCE",
  "TX_WARRANT_EXERCISE",
  "TX_WARRANT_CANCELLATION",
  "TX_WARRANT_TRANSFER",
  "TX_WARRANT_RETRACTION",
  "TX_WARRANT_ACCEPTANCE",
  "TX_CONVERTIBLE_ISSUANCE",
  "TX_CONVERTIBLE_CONVERSION",
  "TX_CONVERTIBLE_CANCELLATION",
  "TX_CONVERTIBLE_TRANSFER",
  "TX_CONVERTIBLE_RETRACTION",
  "TX_CONVERTIBLE_ACCEPTANCE",
  "TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT",
  "TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT",
  "TX_STOCK_CLASS_SPLIT",
  "TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT",
  "TX_STOCK_PLAN_POOL_ADJUSTMENT",
  "TX_STOCK_PLAN_RETURN_TO_POOL",
  "TX_VESTING_START",
  "TX_VESTING_EVENT",
  "TX_VESTING_ACCELERATION",
  "X_STOCK_CLASS_TERMS",
  "X_STOCK_PLAN_TERMS",
  "X_EQUITY_COMPENSATION_REPRICING",
  "X_VESTING_PAUSE",
  "X_VESTING_RESUME",
  "X_STAKEHOLDER_TERMINATION",
  "X_STAKEHOLDER_LEAVE",
  "X_STAKEHOLDER_MERGE",
  "X_EXECUTION_STATUS",
  "X_SECURITY_MODIFICATION",
  "X_REVERSAL",
  "X_CORRECTION",
  "X_MIGRATION_OPENING_BALANCE",
] as const;
/** `TransactionType` in the API contract: values are the `transaction_types` table's codes. */
export const transactionTypeSchema = z.string().regex(/^(TX|X)_[A-Z0-9_]+$/, "Use a transaction type code");

/** `transactions.source`. */
export const TRANSACTION_SOURCES = ["app", "import", "system"] as const;
export const transactionSourceSchema = z.enum(TRANSACTION_SOURCES);

/** `commands.actor_kind`. */
export const COMMAND_ACTOR_KINDS = ["user", "system", "import"] as const;
export const commandActorKindSchema = z.enum(COMMAND_ACTOR_KINDS);

/** `command_dependencies.kind`: the causal edges a reversal checks (the ledger rules). */
export const DEPENDENCY_KINDS = ["consumes_security", "relies_on_deadline", "relies_on_terms"] as const;
export const dependencyKindSchema = z.enum(DEPENDENCY_KINDS);

/** Ledger commands with an HTTP endpoint, by URL name. */
export const COMMAND_NAMES = [
  "terminate-stakeholder",
  "schedule-termination",
  "cancel-scheduled-termination",
  "exercise-option",
  "grant-equity-compensation",
  "cancel-security",
  "mark-executed",
  "record-leave-of-absence",
  "extend-exercise-deadline",
  "set-plan-terms",
  "merge-stakeholders",
  "reverse-command",
] as const;
export const commandNameSchema = z.enum(COMMAND_NAMES);
export type CommandName = z.infer<typeof commandNameSchema>;

/** System commands run by on-demand due processing; they appear as `commands.type` but have no direct endpoint. */
export const SYSTEM_COMMAND_NAMES = ["expire-securities", "apply-scheduled-termination"] as const;

/** What a command's dry run reports as changed (`CommandResult.changes[].entity`). */
export const CHANGE_ENTITIES = [
  "security",
  "stakeholder",
  "stock_plan",
  "stock_class",
  "vesting",
  "deadline",
  "pool",
  "capital",
] as const;

/** cancel-security reasons (the product rules). EXPIRED is used only by the system command expire-securities. */
export const CANCEL_REASONS = ["HOLDER_WAIVER", "NOT_EXECUTED", "MUTUAL_AGREEMENT", "FORFEITURE_UNDER_AGREEMENT"] as const;
export const cancelReasonSchema = z.enum(CANCEL_REASONS);

export const ACCELERATION_KINDS = ["NONE", "SINGLE_TRIGGER", "DOUBLE_TRIGGER"] as const;

// ---------------------------------------------------------------------------
// Equity structure, vesting and valuations

/** `stock_classes.class_type`. */
export const STOCK_CLASS_TYPES = ["COMMON", "PREFERRED"] as const;
export const stockClassTypeSchema = z.enum(STOCK_CLASS_TYPES);

export const PARTICIPATION_KINDS = ["NON_PARTICIPATING", "PARTICIPATING", "CAPPED"] as const;
export const ANTI_DILUTION_KINDS = [
  "NONE",
  "BROAD_BASED_WEIGHTED_AVERAGE",
  "NARROW_BASED_WEIGHTED_AVERAGE",
  "FULL_RATCHET",
] as const;

/** `legends.kind`. */
export const LEGEND_KINDS = ["LEGEND", "CERTIFICATE_TERMS"] as const;
export const legendKindSchema = z.enum(LEGEND_KINDS);

/** A plan's status in its `X_STOCK_PLAN_TERMS`. */
export const PLAN_STATUSES = ["active", "terminated"] as const;
export const planStatusSchema = z.enum(PLAN_STATUSES);

/** Each of the five return-to-pool rules either returns shares to the pool or retires them (the ledger rules). */
export const PLAN_RETURN_RULE_VALUES = ["RETURN", "RETIRE"] as const;
export const planReturnRuleSchema = z.enum(PLAN_RETURN_RULE_VALUES);

export const PERIOD_UNITS = ["DAYS", "MONTHS", "QUARTERS", "YEARS"] as const;
export const periodUnitSchema = z.enum(PERIOD_UNITS);

export const VESTING_FREQUENCIES = ["MONTHLY", "QUARTERLY", "ANNUALLY"] as const;
export const VESTING_EVENT_STATES = ["ACTIVE", "CANCELLED"] as const;
export const VESTING_EVENT_KINDS = ["CLIFF", "SCHEDULED", "EXPLICIT", "ACCELERATION"] as const;
export const VESTING_EVENT_SOURCES = ["computed", "pulley"] as const;

/** `valuations.valuation_type`. */
export const VALUATION_TYPES = ["409A", "OTHER"] as const;
/** `valuations.report_version`. */
export const VALUATION_REPORT_VERSIONS = ["FINAL", "DRAFT"] as const;
/** `valuation_events.kind`: the facts a valuation's status is computed from. */
export const VALUATION_EVENT_KINDS = ["MATERIAL_EVENT", "REVIEW_CLEARED", "VOIDED", "EVENT_REVERSED"] as const;
/**
 * Computed for a date (the API contract). Only a final 409A report has the 409A statuses. Until it is voided, a draft report
 * is `draft` and a valuation of another type is `not_409a`: neither is ever valid or in effect.
 */
export const VALUATION_STATUSES = [
  "presumptively_valid",
  "expiring_soon",
  "review_required",
  "superseded",
  "expired",
  "voided",
  "draft",
  "not_409a",
] as const;
export const valuationStatusSchema = z.enum(VALUATION_STATUSES);
export type ValuationStatus = z.infer<typeof valuationStatusSchema>;

// ---------------------------------------------------------------------------
// Documents

/** Volatile: zod only, never a CHECK (CL-26). */
export const DOCUMENT_KINDS = [
  "GRANT_AGREEMENT",
  "STOCK_PURCHASE_AGREEMENT",
  "SAFE_AGREEMENT",
  "WARRANT_AGREEMENT",
  "NOTICE_OF_EXERCISE",
  "ELECTION_83B",
  "BOARD_CONSENT",
  "STOCKHOLDER_CONSENT",
  "PLAN_DOCUMENT",
  "CHARTER",
  "VALUATION_REPORT",
  "VALUATION_SUPPORT",
  "COUNSEL_MEMO",
  "SEPARATION_AGREEMENT",
  "PAYMENT_RECORD",
  "CERTIFICATE",
  "TEMPLATE",
  "STATEMENT",
  "FORM_3921",
  "RECONCILIATION_REPORT",
  "IMPORT_ARCHIVE",
  "OTHER",
] as const;
export const documentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof documentKindSchema>;

/** Volatile: zod only. */
export const DOCUMENT_LINK_ROLES = [
  "AGREEMENT",
  "CONSENT",
  "NOTICE",
  "REPORT",
  "EVIDENCE",
  "CERTIFICATE",
  "ELECTION",
  "TAX_FORM",
  "ATTACHMENT",
] as const;
export const documentLinkRoleSchema = z.enum(DOCUMENT_LINK_ROLES);
export type DocumentLinkRole = z.infer<typeof documentLinkRoleSchema>;

/** What a link can point at: one per `document_links` target column. */
export const LINK_TARGET_TYPES = [
  "security",
  "stakeholder",
  "stock_plan",
  "stock_class",
  "valuation",
  "exercise_request",
  "transaction",
] as const;
export const linkTargetTypeSchema = z.enum(LINK_TARGET_TYPES);
export type LinkTargetType = z.infer<typeof linkTargetTypeSchema>;

/** `documents.content_type`. PPTX only on the import path (files migrated from Pulley). */
export const DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/csv",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;
export const documentContentTypeSchema = z.enum(DOCUMENT_CONTENT_TYPES);
/** What an admin may upload in the app: every type but PPTX (the API contract). */
export const UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/csv",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const satisfies readonly (typeof DOCUMENT_CONTENT_TYPES)[number][];
export const uploadContentTypeSchema = z.enum(UPLOAD_CONTENT_TYPES);

/** `documents.source`. */
export const DOCUMENT_SOURCES = ["upload", "generated", "pulley"] as const;
/** Who can see a document, derived from `holder_visible` and its links (the API contract). */
export const DOCUMENT_VISIBILITY_SCOPES = ["admins", "holder", "all_holders"] as const;

/** `document_collections.kind`: folders admins create; template groups are migrated and read-only. */
export const COLLECTION_KINDS = ["FOLDER", "TEMPLATE_GROUP"] as const;
/** `document_collections.source`. */
export const COLLECTION_SOURCES = ["app", "pulley"] as const;

// ---------------------------------------------------------------------------
// Records and workflows

/** `certificates.status`. */
export const CERTIFICATE_STATUSES = ["ISSUED", "CANCELLED", "VOID"] as const;
/** `exercise_requests.status`; imported requests are read-only historical rows. */
export const EXERCISE_REQUEST_STATUSES = [
  "NEEDS_REVIEW",
  "AWAITING_HOLDER_CONFIRMATION",
  "AWAITING_PAYMENT",
  "EXERCISED",
  "REJECTED",
  "CANCELLED",
  "REVERSED",
] as const;
/** `signature_requests.signer_role`. */
export const SIGNER_ROLES = ["COMPANY_SIGNATORY", "HOLDER", "SPOUSE", "APPROVER"] as const;
/** `signature_requests.status`. */
export const SIGNATURE_STATUSES = ["PENDING", "SIGNED", "WAIVED", "CANCELLED"] as const;
/** `signature_requests.method`. */
export const SIGNATURE_METHODS = ["pulley", "offline_upload", "portal_acknowledgement", "esign"] as const;
/** `scheduled_terminations.status`. */
export const SCHEDULED_TERMINATION_STATUSES = ["SCHEDULED", "APPLIED", "CANCELLED"] as const;
/** `election_83b_records.status`. */
export const ELECTION_83B_STATUSES = ["PENDING", "FILED", "NOT_REQUIRED", "UNCONFIRMED_DEADLINE_PASSED", "PROOF_MISSING"] as const;
/** Why a grant is execution pending: whose signature is missing (Securities Status). */
export const EXECUTION_MISSING_PARTIES = ["company_signatory", "holder", "both"] as const;
/** The repurchase window of unvested shares held by a terminated holder. */
export const REPURCHASE_WINDOW_STATUSES = ["open", "closing_soon", "lapsed", "not_recorded"] as const;
/** Dashboard "Needs attention" items (the API contract). */
export const NEEDS_ATTENTION_KINDS = [
  "EXECUTION_PENDING",
  "SCHEDULED_TERMINATION",
  "ISO_DEADLINE_SOON",
  "REPURCHASE_WINDOW_CLOSING",
  "VALUATION_STATUS",
  "EXPIRY_RUN_TO_CONFIRM",
] as const;
/** Cap table tabs (the API contract). */
export const CAP_TABLE_TABS = ["ownership", "shares", "options", "safes", "warrants"] as const;
export const capTableTabSchema = z.enum(CAP_TABLE_TABS);

// ---------------------------------------------------------------------------
// Audit

/** `audit_events.actor_kind`. */
export const AUDIT_ACTOR_KINDS = ["user", "system", "anonymous", "import"] as const;
export const auditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);
/** `audit_events.result`. */
export const AUDIT_RESULTS = ["success", "denied", "error"] as const;

// ---------------------------------------------------------------------------
// Reports

/** The available exports and the formats each offers (the API contract). The first format is the default. */
export const REPORT_FORMATS_BY_KEY = {
  "cap-table": ["xlsx", "json"],
  "raw-cap-table": ["csv", "xlsx", "json"],
  stakeholders: ["csv", "xlsx", "json"],
  "vesting-details": ["xlsx", "json"],
  "exercise-history": ["xlsx", "json"],
  "audit-log": ["csv"],
} as const;
export const REPORT_KEYS = [
  "cap-table",
  "raw-cap-table",
  "stakeholders",
  "vesting-details",
  "exercise-history",
  "audit-log",
] as const satisfies readonly (keyof typeof REPORT_FORMATS_BY_KEY)[];
export const reportKeySchema = z.enum(REPORT_KEYS);
export type ReportKey = z.infer<typeof reportKeySchema>;
export const REPORT_FORMATS = ["csv", "xlsx", "json"] as const;
export const reportFormatSchema = z.enum(REPORT_FORMATS);
export type ReportFormat = z.infer<typeof reportFormatSchema>;
