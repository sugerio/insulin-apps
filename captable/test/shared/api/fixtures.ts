// Synthetic "Acme Robotics, Inc." data for the contract tests. Every name, address, id and number is invented; ids and
// hashes interleave letters so no long run of digits could resemble a real record id.

const hex4 = (n: number) => n.toString(16).padStart(4, "0");
/** A lowercase UUID such as aced0001-face-4bad-8cab-dead0001beef. */
export const uid = (n: number) => `aced${hex4(n)}-face-4bad-8cab-dead${hex4(n)}beef`;
/** A 64-character lowercase hex digest. */
export const sha = (n: number) => `ab${n.toString(16).padStart(2, "0")}`.repeat(16);

export const ORG_ID = uid(1);
export const PLAN_ID = uid(2);
export const COMMON_CLASS_ID = uid(3);
export const SEED_CLASS_ID = uid(4);
export const TEMPLATE_ID = uid(5);
export const STAKEHOLDER_ID = uid(16); // Dana Example, an employee
export const OTHER_STAKEHOLDER_ID = uid(17); // Robin Sample, an investor
export const OPTION_ID = uid(32); // OPT-7
export const SHARES_ID = uid(33); // CS-4
export const COMMAND_ID = uid(48);
export const OTHER_COMMAND_ID = uid(49);
export const TX_ID = uid(64);
export const OTHER_TX_ID = uid(65);
export const DOCUMENT_ID = uid(80);
export const OTHER_DOCUMENT_ID = uid(81);
export const LINK_ID = uid(82);
export const COLLECTION_ID = uid(83);
export const VALUATION_ID = uid(96);
export const VALUATION_EVENT_ID = uid(97);
export const EMAIL_ID = uid(112);
export const USER_ID = uid(128);
export const ADMIN_LINK_ID = uid(129);
export const SCHEDULED_TERMINATION_ID = uid(176);
export const EXERCISE_REQUEST_ID = uid(192);
export const SIGNATURE_REQUEST_ID = uid(193);
export const CERTIFICATE_ID = uid(194);
export const LEGEND_ID = uid(195);
export const ELECTION_ID = uid(196);
export const SIGNATORY_ID = uid(197);

/** 2026-12-04 17:00 UTC, the cut-over day, in epoch ms. */
export const T = 1_796_403_600_000;
export const HEAD = sha(1);
export const ENGINE = "engine-acme-test";

export const echo = { asOf: "2026-12-10", asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: HEAD, engineVersion: ENGINE };

export const address = { line1: "100 Example Way", city: "Springfield", region: "CA", postalCode: "94000", country: "US" };

export const settings = {
  companyContact: { name: "Acme Equity Desk", email: "equity@acme.example" },
  display: { shareDecimals: 0, priceDecimals: 2 },
  portal: { howToExerciseText: "Sign the notice of exercise and send payment.", noticeFormDocumentId: DOCUMENT_ID, privacyNoticeDocumentId: OTHER_DOCUMENT_ID },
  expiry: { mode: "report_only" },
};

export const org = {
  id: ORG_ID,
  orgKey: "acme-demo",
  slug: "acme-demo",
  status: "active",
  legalName: "Acme Robotics, Inc.",
  displayName: "Acme Robotics",
  entityType: "C_CORPORATION",
  jurisdiction: "US-DE",
  incorporationDate: "2019-03-14",
  timezone: "America/Los_Angeles",
  currency: "USD",
  importSource: "pulley",
  fiscalYearEnd: "12-31",
  ein: "••-•••4321",
  address,
  shareUnit: "1",
  shareUnitFrozen: true,
  settings,
  ledgerSeq: 412,
  ledgerHeadHash: HEAD,
  version: 3,
};

export const stakeholderEmail = {
  id: EMAIL_ID,
  email: "dana@mailbox.example",
  kind: "self",
  contactName: null,
  contactRole: null,
  authorizingDocumentId: null,
  addedBy: null,
  createdAt: T - 5000,
  removedAt: null,
};

export const stakeholder = {
  id: STAKEHOLDER_ID,
  kind: "individual",
  displayName: "Dana Example",
  legalName: "Dana Q. Example",
  relationship: "employee",
  issuerAssignedId: "E-104",
  address,
  phone: "+1 555 0100",
  countryOfResidence: "US",
  taxStatus: "us",
  hireDate: "2021-06-01",
  comments: null,
  portalAccess: "auto",
  mergedInto: null,
  mergedRecords: [],
  portalState: "open",
  termination: null,
  scheduledTermination: null,
  leaveOfAbsence: [],
  emails: [stakeholderEmail],
  totals: { issuedAndOutstanding: "12000", fullyDiluted: "60000", fullyDilutedPct: "1/400", capitalContribution: "11400" },
  provenance: { importedFromPulley: true, pulleyId: null },
  version: 2,
};

export const securityNumbers = {
  asOf: "2026-12-10",
  asKnownAt: 412,
  issued: "48000",
  outstanding: "48000",
  fullyDiluted: "48000",
  vested: "18000",
  unvested: "30000",
  vestedOutstanding: "18000",
  exercised: "0",
  exercisable: "18000",
  cancelled: "0",
  repurchased: "0",
  repurchaseable: "0",
  forfeited: "0",
  fullyDilutedPct: "1/500",
  outstandingPct: "0",
};

export const security = {
  id: OPTION_ID,
  family: "EQUITY_COMPENSATION",
  subtype: "OPTION_ISO",
  stakeholderId: STAKEHOLDER_ID,
  stakeholderName: "Dana Example",
  stockClassId: COMMON_CLASS_ID,
  stockPlanId: PLAN_ID,
  displayId: "OPT-7",
  issueDate: "2024-12-10",
  status: "OUTSTANDING",
  executionStatus: "executed",
  parentSecurityId: null,
  originCommandId: COMMAND_ID,
  terms: { exercisePrice: "0.95", expirationDate: "2034-12-09" },
  deadlines: { contractual: null, iso: null, reason: null },
  exemption: { federal: "RULE_701", country: null, state: "CA" },
  boardApprovalDate: "2024-12-10",
  boardApprovalNotRecordedInPulley: false,
  numbers: securityNumbers,
  certificate: null,
  provenance: { importedFromPulley: true, sourceFile: "grants.json", sourceSha256: sha(2), pulleyId: null },
};

export const transaction = {
  id: TX_ID,
  seq: 412,
  commandId: COMMAND_ID,
  type: "TX_EQUITY_COMPENSATION_ISSUANCE",
  effectiveDate: "2024-12-10",
  securityId: OPTION_ID,
  stakeholderId: STAKEHOLDER_ID,
  valuationId: VALUATION_ID,
  quantity: "48000",
  amount: null,
  currency: null,
  payload: { quantity: "48000", exercisePrice: "0.95" },
  payloadVersion: 1,
  payloadSha256: sha(3),
  reversesTxId: null,
  reversedByTxId: null,
  source: "app",
  recordedAt: T,
  recordedBy: "Morgan Admin",
  prevHash: sha(4),
  chainHash: HEAD,
  pulleyRef: null,
};

export const commandSummary = {
  id: COMMAND_ID,
  type: "grant-equity-compensation",
  actorKind: "user",
  actor: "Morgan Admin",
  authMethod: "console",
  note: null,
  createdAt: T,
  firstSeq: 411,
  lastSeq: 412,
  reversesCommandId: null,
  reversedByCommandId: null,
  importedFromPulley: false,
};

export const commandResult = {
  commandId: null,
  dryRun: true,
  ledgerSeq: 412,
  ledgerHeadHash: HEAD,
  transactions: [
    { id: null, seq: null, type: "TX_EQUITY_COMPENSATION_ISSUANCE", effectiveDate: "2026-12-10", securityId: null, quantity: "48000" },
    { id: null, seq: null, type: "TX_VESTING_START", effectiveDate: "2026-12-10", securityId: null, quantity: null },
  ],
  created: { securityIds: [], scheduledTerminationIds: [], vestingTermsIds: [] },
  changes: [{ entity: "pool", id: PLAN_ID, before: { available: "250000" }, after: { available: "202000" } }],
  diffSha256: sha(5),
  effectSha256: sha(6),
  dependencies: [],
  violations: [],
  warnings: [],
};

export const vestingEvent = {
  date: "2025-12-10",
  quantity: "12000",
  cumulative: "12000",
  state: "ACTIVE",
  kind: "CLIFF",
  source: "computed",
};

export const scheduleDefinition = {
  type: "SCHEDULE",
  totalMonths: 48,
  frequency: "MONTHLY",
  cliff: { months: 12, quantityRule: "RATABLE" },
  dayRule: "SAME_DAY_CLAMPED",
};

export const valuation = {
  id: VALUATION_ID,
  name: "Dec 2026 Valuation",
  valuationType: "409A",
  provider: "Example Valuation Partners",
  effectiveDate: "2026-12-01",
  expirationDate: "2027-11-30",
  boardApprovalDate: "2026-12-03",
  reportVersion: "FINAL",
  prices: [{ stockClassId: COMMON_CLASS_ID, pricePerShare: "0.95" }],
  status: "presumptively_valid",
  statusAsOf: "2026-12-10",
  presumptivelyValidUntil: "2027-11-30",
  events: [],
  reportDocumentId: DOCUMENT_ID,
  importedFromPulley: false,
};

export const documentLink = {
  id: LINK_ID,
  role: "AGREEMENT",
  targetType: "security",
  targetId: OPTION_ID,
  createdAt: T,
  createdBy: "Morgan Admin",
  revokedAt: null,
  revokeReason: null,
};

export const document = {
  id: DOCUMENT_ID,
  filename: "OPT-7 grant agreement.pdf",
  contentType: "application/pdf",
  byteSize: 182_340,
  sha256: sha(6),
  kind: "GRANT_AGREEMENT",
  source: "upload",
  holderVisible: true,
  visibilityScope: "holder",
  collectionId: null,
  versionLabel: null,
  supersedesDocumentId: null,
  description: null,
  sourceCreatedAt: null,
  uploadedBy: "Morgan Admin",
  createdAt: T,
  archivedAt: null,
  links: [documentLink],
  importedFromPulley: false,
  version: 3,
};

export const paymentDetails = {
  bankName: "Example National Bank",
  beneficiaryName: "Acme Robotics, Inc.",
  beneficiaryAddress: "100 Example Way, Springfield, CA",
  accountNumber: "••••6789",
  routingNumber: "123456780",
  referenceFormat: "EX-<grant>-<holder initials>",
};

export const portalDocument = { id: DOCUMENT_ID, filename: "OPT-7 grant agreement.pdf", kind: "GRANT_AGREEMENT", createdAt: T, scope: "mine" };

export const portalSecurity = {
  id: OPTION_ID,
  orgId: ORG_ID,
  displayId: "OPT-7",
  family: "EQUITY_COMPENSATION",
  optionType: "ISO",
  className: "Common",
  planName: "2023 Example Equity Plan",
  issueDate: "2024-12-10",
  status: "OUTSTANDING",
  executionPending: false,
  exercisePrice: "0.95",
  expirationDate: "2034-12-09",
  contractualDeadline: null,
  isoDeadline: null,
  numbers: {
    asOf: "2026-12-10",
    granted: "48000",
    outstanding: "48000",
    vested: "18000",
    unvested: "30000",
    exercised: "0",
    exercisable: "18000",
    cancelled: "0",
  },
  vesting: [{ date: "2025-12-10", quantity: "12000", cumulative: "12000", status: "VESTED" }],
  documents: [portalDocument],
};

/** The holding detail of `portalSecurity` (`GET /api/portal/orgs/:orgId/securities/:id`). */
export const portalSecurityDetail = {
  ...portalSecurity,
  detail: {
    family: "EQUITY_COMPENSATION",
    earlyExerciseAllowed: false,
    isoSplit: [
      { year: 2025, firstExercisable: "12000", valueAtGrant: "11400", iso: "12000", nso: "0" },
      { year: 2026, firstExercisable: "12000", valueAtGrant: "11400", iso: "12000", nso: "0" },
    ],
    postTerminationPeriods: [
      { reason: "VOLUNTARY", period: "3", unit: "MONTHS" },
      { reason: "WITH_CAUSE", period: "0", unit: "DAYS" },
      { reason: "DEATH", period: "12", unit: "MONTHS" },
    ],
    exercises: [{ date: "2026-11-02", quantity: "6000", iso: "6000", nso: "0", resultingShares: [{ displayId: "CS-12" }] }],
  },
};

export const portalOverview = {
  asOf: "2026-12-10",
  holdings: [
    {
      orgId: ORG_ID,
      orgDisplayName: "Acme Robotics",
      stakeholderId: STAKEHOLDER_ID,
      stakeholderName: "Dana Example",
      securities: [portalSecurity],
    },
  ],
};

export const exerciseRecord = {
  transactionId: TX_ID,
  commandId: COMMAND_ID,
  exerciseDate: "2026-11-02",
  stakeholderId: STAKEHOLDER_ID,
  stakeholderName: "Dana Example",
  securityId: OPTION_ID,
  grantDisplayId: "OPT-7",
  quantity: "6000",
  isoQuantity: "6000",
  nsoQuantity: "0",
  exercisePrice: "0.95",
  cost: "5700",
  paymentMethod: "ACH",
  paymentReference: "EX-OPT7-DE",
  fmvPerShare: "1.2",
  taxTreatment: "W2",
  withholding: null,
  resultingShares: [{ securityId: SHARES_ID, displayId: "CS-4", portion: "ISO" }],
  source: { kind: "recorded", requestNumber: null },
  reversed: false,
};

export const auditEvent = {
  id: 9001,
  occurredAt: T,
  orgId: ORG_ID,
  actor: { kind: "user", userId: USER_ID, email: "morgan.admin@example.test", authMethod: "console" },
  action: "command.grant-equity-compensation",
  targetType: "command",
  targetId: COMMAND_ID,
  result: "success",
  reason: null,
  ip: null,
  userAgent: null,
  details: { firstSeq: 411, lastSeq: 412 },
};

export const ledgerVerification = {
  orgId: ORG_ID,
  checkedAt: T,
  ledgerSeq: 412,
  ledgerHeadHash: HEAD,
  ok: true,
  checks: [
    { name: "payload_hashes", ok: true, problems: [] },
    { name: "chain", ok: true, problems: [] },
  ],
};

export const collection = {
  id: COLLECTION_ID,
  kind: "FOLDER",
  name: "Board consents",
  parentId: null,
  source: "app",
  archivedAt: null,
  createdAt: T,
  version: 1,
};

export const scheduledTermination = {
  id: SCHEDULED_TERMINATION_ID,
  stakeholderId: STAKEHOLDER_ID,
  terminationDate: "2027-01-15",
  terminationType: "voluntary",
  vestingStopDate: "2027-01-15",
  status: "CANCELLED",
  appliedCommandId: null,
  cancelledBy: "Casey Admin",
  cancelledAt: T,
  cancelNote: "Offer withdrawn",
  createdBy: "Morgan Admin",
  createdAt: T - 86_400_000,
  version: 2,
};

/** The envelope fields a real command call sends back from its dry run. */
export const guard = { expectedLedgerSeq: 412, expectedDiffSha256: sha(5) };
