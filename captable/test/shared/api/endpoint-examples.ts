import type { RouteId } from "../../../src/app/shared/api/routes.ts";
import {
  address,
  ADMIN_LINK_ID,
  auditEvent,
  CERTIFICATE_ID,
  collection,
  COLLECTION_ID,
  COMMAND_ID,
  commandResult,
  commandSummary,
  COMMON_CLASS_ID,
  document,
  DOCUMENT_ID,
  documentLink,
  echo,
  ELECTION_ID,
  EMAIL_ID,
  ENGINE,
  EXERCISE_REQUEST_ID,
  exerciseRecord,
  guard,
  HEAD,
  LEGEND_ID,
  ledgerVerification,
  LINK_ID,
  OPTION_ID,
  org,
  ORG_ID,
  OTHER_COMMAND_ID,
  OTHER_DOCUMENT_ID,
  OTHER_STAKEHOLDER_ID,
  OTHER_TX_ID,
  paymentDetails,
  PLAN_ID,
  portalDocument,
  portalOverview,
  portalSecurity,
  portalSecurityDetail,
  SCHEDULED_TERMINATION_ID,
  SIGNATORY_ID,
  scheduledTermination,
  scheduleDefinition,
  SEED_CLASS_ID,
  security,
  SHARES_ID,
  sha,
  SIGNATURE_REQUEST_ID,
  stakeholder,
  STAKEHOLDER_ID,
  T,
  TEMPLATE_ID,
  transaction,
  TX_ID,
  uid,
  USER_ID,
  valuation,
  VALUATION_EVENT_ID,
  VALUATION_ID,
  vestingEvent,
} from "./fixtures.ts";

/** One endpoint's synthetic examples: a valid call and answer, and requests or answers its schemas must refuse. */
export interface EndpointExample {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  dryRunBody?: unknown;
  headers?: Record<string, string | undefined>;
  response?: unknown;
  /** A file answer's headers. */
  responseHeaders?: Record<string, string>;
  invalid?: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; headers?: Record<string, string | undefined>; response?: unknown }[];
}

const orgParams = { orgId: ORG_ID };
const stakeholderParams = { orgId: ORG_ID, id: STAKEHOLDER_ID };
const securityParams = { orgId: ORG_ID, id: OPTION_ID };
const documentParams = { orgId: ORG_ID, id: DOCUMENT_ID };

const uploadHeaders = {
  "content-type": "Application/PDF; name=agreement",
  "x-filename": "OPT-7%20grant%20agreement.pdf",
  "x-document-kind": "GRANT_AGREEMENT",
  "x-content-sha256": sha(6),
  "x-link-target": "security",
  "x-link-id": OPTION_ID,
  "x-link-role": "AGREEMENT",
};

const attachmentHeaders = (filename: string, contentType: string) => ({
  "content-type": contentType,
  "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "content-security-policy": "sandbox; default-src 'none'",
});
const downloadHeaders = { ...attachmentHeaders("OPT-7 grant agreement.pdf", "application/pdf"), digest: `sha-256=${"q".repeat(43)}=` };

const stockClass = {
  id: COMMON_CLASS_ID,
  name: "Common",
  classType: "COMMON",
  defaultIdPrefix: "CS",
  parValue: "0.00001",
  originalIssuePrice: null,
  currency: "USD",
  isCertificated: false,
  boardApprovalDate: "2019-03-14",
  stockholderApprovalDate: "2019-03-14",
  asOf: "2026-12-10",
  authorizedShares: "30000000",
  conversionRatio: { numerator: "1", denominator: "1" },
  terms: {
    votesPerShare: "1",
    excludeFromFullyDiluted: false,
    seniority: null,
    liquidationPreferenceMultiple: null,
    participation: null,
    participationCapMultiple: null,
    dividendTerms: null,
    antiDilution: null,
    notRecordedInPulley: ["participation"],
  },
  numbers: { issuedAndOutstanding: "15000000", reserved: "4000000", availableToIssue: "11000000", fullyDiluted: "19000000" },
  history: [{ effectiveDate: "2019-03-14", transactionId: TX_ID, type: "TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", summary: "Authorized 30,000,000" }],
  version: 1,
};

const window = (reason: string, period: string, unit = "MONTHS") => ({ period, unit, reason });
const sixWindows = [
  window("VOLUNTARY", "3"),
  window("INVOLUNTARY", "3"),
  window("WITH_CAUSE", "0", "DAYS"),
  window("DEATH", "12"),
  window("DISABILITY", "12"),
  window("RETIREMENT", "3"),
];
const returnRules = {
  cancelledUnvestedAwards: "RETURN",
  expiredVestedOptions: "RETURN",
  repurchasedUnvestedShares: "RETURN",
  repurchasedVestedShares: "RETURN",
  sharesWithheldForTax: "RETURN",
};

const stockPlan = {
  id: PLAN_ID,
  name: "2023 Example Equity Plan",
  stockClassId: COMMON_CLASS_ID,
  boardApprovalDate: "2023-01-20",
  stockholderApprovalDate: "2023-02-01",
  effectiveDate: "2023-01-20",
  expirationDate: "2033-01-19",
  asOf: "2026-12-10",
  poolSize: "4000000",
  equityOutstanding: "3700000",
  equityRetired: "50000",
  availableToGrant: "250000",
  returnRules,
  returnRulesConfirmation: { transactionId: TX_ID, effectiveDate: "2023-01-20", confirmedBy: "Casey Admin", confirmedAt: T, documentId: DOCUMENT_ID },
  defaultTerminationWindows: sixWindows,
  defaultRepurchaseWindow: { period: "90", unit: "DAYS" },
  status: "active",
  pourOverPlanId: null,
  amendments: [{ effectiveDate: "2024-06-01", transactionId: OTHER_TX_ID, type: "TX_STOCK_PLAN_POOL_ADJUSTMENT", poolSize: "4000000" }],
  version: 1,
};

const vestingTerms = {
  id: TEMPLATE_ID,
  name: "4 years, 1-year cliff, monthly",
  description: null,
  isTemplate: true,
  templateId: null,
  definition: scheduleDefinition,
  definitionSha256: sha(12),
  algorithmVersion: 1,
  grantsUsing: 31,
  confirmedBy: "Casey Admin",
  confirmedAt: T,
  importedFromPulley: true,
  createdAt: T - 86_400_000,
};

const terminateBody = {
  ...guard,
  stakeholderId: STAKEHOLDER_ID,
  terminationDate: "2026-12-04",
  terminationType: "voluntary",
  accelerations: [{ securityId: OPTION_ID, quantity: "3000", reason: "Separation agreement", documentId: OTHER_DOCUMENT_ID }],
};

const exerciseBody = {
  ...guard,
  securityId: OPTION_ID,
  quantity: "6000",
  notice: { documentId: DOCUMENT_ID, receivedOn: "2026-11-01" },
  payment: { amount: "5700", receivedOn: "2026-11-02", method: "ACH", reference: "EX-OPT7-DE" },
  exerciseDate: "2026-11-02",
  fmv: { source: "valuation", valuationId: VALUATION_ID },
  tax: { treatment: "W2", withholding: { federalIncome: "0", socialSecurity: "0", medicare: "0" }, zeroReason: "ISO exercise: no NSO spread" },
  resultingShares: [{ portion: "ISO" }],
};

const grantBody = {
  ...guard,
  stockPlanId: PLAN_ID,
  stakeholderId: STAKEHOLDER_ID,
  quantity: "48000",
  board: { approvalDate: "2026-12-10", consentDocumentId: DOCUMENT_ID },
  optionType: "ISO",
  isoAttestations: { employeeAtGrant: true, tenPercentHolder: false },
  vesting: {
    terms: { templateId: TEMPLATE_ID },
    vestingStartDate: "2026-12-10",
    earlyExercisable: false,
    accelerationTerms: { kind: "NONE" },
    matchesSignedAgreement: true,
  },
  exercisePrice: "0.95",
  valuationId: VALUATION_ID,
  expirationDate: "2036-12-09",
  exemption: { federal: "RULE_701" },
  executedAgreement: { documentId: OTHER_DOCUMENT_ID, signedByHolderAndSignatory: true },
};

const reversalPreview = {
  commandId: COMMAND_ID,
  commandType: "exercise-option",
  importedFromPulley: false,
  inverse: [{ reversesTransactionId: TX_ID, type: "TX_EQUITY_COMPENSATION_EXERCISE", effectiveDate: "2026-11-02" }],
  dependents: [],
  changes: commandResult.changes,
  workflowEffects: [],
  violations: [],
  blocked: false,
  diffSha256: sha(13),
  ledgerSeq: 412,
};

const capTable = {
  ...echo,
  metrics: {
    issuedAndOutstanding: "15000000",
    fullyDiluted: "24000000",
    executionPendingAwards: "96000",
    planAvailable: "250000",
    capitalContribution: "16147718.6",
  },
  classes: [
    { stockClassId: COMMON_CLASS_ID, name: "Common", authorized: "30000000", issuedAndOutstanding: "11000000", fullyDiluted: "15000000", availableToIssue: "15000000" },
    { stockClassId: SEED_CLASS_ID, name: "Series Seed", authorized: "5000000", issuedAndOutstanding: "4000000", fullyDiluted: "4000000", availableToIssue: "1000000" },
  ],
  plans: [{ stockPlanId: PLAN_ID, name: "2023 Example Equity Plan", poolSize: "4000000", equityOutstanding: "3700000", equityRetired: "50000", available: "250000" }],
  ownership: [
    {
      stakeholderId: STAKEHOLDER_ID,
      name: "Dana Example",
      relationship: "employee",
      issuerAssignedId: "E-104",
      status: "active",
      byClass: { [COMMON_CLASS_ID]: "12000" },
      issuedAndOutstanding: "12000",
      issuedAndOutstandingPct: "1/1250",
      planAwards: { [PLAN_ID]: "48000" },
      awardsOutsidePlans: "0",
      warrants: "0",
      fullyDiluted: "60000",
      fullyDilutedPct: "1/400",
    },
  ],
  availablePool: { fullyDiluted: "250000", fullyDilutedPct: "1/96" },
  totals: { issuedAndOutstanding: "15000000", fullyDiluted: "24000000" },
  openingBalances: [],
};

const dashboard = {
  asOf: "2026-12-10",
  company: { totalCapitalContribution: "16147718.6", fullyDilutedShares: "24000000", stakeholdersWithSecurities: 118 },
  employeeEquity: [{ stockPlanId: PLAN_ID, name: "2023 Example Equity Plan", granted: "3700000", available: "250000", usedPct: "15/16" }],
  ownershipByRelationship: [{ relationship: "investor", fullyDiluted: "9000000", pct: "3/8" }],
  topStakeholders: [{ stakeholderId: OTHER_STAKEHOLDER_ID, name: "Robin Sample", fullyDiluted: "3000000", pct: "1/8" }],
  needsAttention: [{ kind: "EXECUTION_PENDING", count: 2, dueDate: null, href: "/companies/acme/securities-status" }],
  inProgress: { executionPending: 2 },
  recentActivity: [{ id: 9001, occurredAt: T, description: "Recorded grant OPT-7", actor: "Morgan Admin" }],
};

const securitiesStatus = {
  executionPending: [
    { securityId: OPTION_ID, displayId: "OPT-7", stakeholderId: STAKEHOLDER_ID, issueDate: "2026-10-01", missing: "company_signatory", signatureRequestIds: [SIGNATURE_REQUEST_ID] },
  ],
  scheduledTerminations: [
    { id: SCHEDULED_TERMINATION_ID, stakeholderId: STAKEHOLDER_ID, terminationDate: "2027-01-15", type: "voluntary", securitiesAffected: 1, unvestedToCancel: "30000", version: 1 },
  ],
  unvestedSharesFromTerminated: [],
  optionsFromTerminated: [
    { securityId: OPTION_ID, stakeholderId: STAKEHOLDER_ID, vestedUnexercised: "18000", contractualDeadline: "2027-03-04", contractualDaysLeft: 84, isoDeadline: "2027-03-04", isoDaysLeft: 84 },
  ],
  expiringWithin90Days: [{ securityId: OPTION_ID, displayId: "OPT-7", expirationDate: "2027-02-01" }],
};

const securityDetail = {
  ...security,
  ...echo,
  lineage: { parent: null, children: [{ id: SHARES_ID, displayId: "CS-4", transactionType: "TX_STOCK_ISSUANCE" }] },
  legends: [{ id: LEGEND_ID, name: "Rule 144" }],
  documents: [{ id: DOCUMENT_ID, filename: "OPT-7 grant agreement.pdf", kind: "GRANT_AGREEMENT" }],
};

const exerciseRequest = {
  id: EXERCISE_REQUEST_ID,
  requestNumber: 3,
  securityId: OPTION_ID,
  stakeholderId: STAKEHOLDER_ID,
  quantity: "6000",
  isoQuantity: "6000",
  nsoQuantity: "0",
  exercisePrice: "0.95",
  fmvPerShare: "1.2",
  valuationId: VALUATION_ID,
  estimatedWithholding: null,
  totalCost: "5700",
  currency: "USD",
  paymentMethod: "MANUAL_UNSPECIFIED",
  status: "EXERCISED",
  pulleyStatus: "COMPLETED",
  paymentDueDate: null,
  paymentReceivedOn: "2025-04-01",
  exerciseDate: "2025-04-01",
  completedCommandId: COMMAND_ID,
  decidedAt: T - 100_000_000,
  cancelledAt: null,
  documents: [{ id: DOCUMENT_ID, filename: "Notice of exercise.pdf", kind: "NOTICE_OF_EXERCISE" }],
  importedFromPulley: true,
  createdAt: T - 200_000_000,
};

export const ENDPOINT_EXAMPLES: Record<RouteId, EndpointExample> = {
  getMe: {
    response: {
      user: { id: USER_ID, email: "morgan.admin@example.test", displayName: "Morgan Admin" },
      consoleRole: "ADMIN",
      preview: false,
      company: { id: ORG_ID, displayName: "Acme Robotics", legalName: "Acme Robotics, Inc.", timezone: "America/Los_Angeles", currency: "USD", importSource: "pulley" },
      access: "admin_rw",
      pii: true,
      portal: { matches: [{ orgId: ORG_ID, stakeholderId: STAKEHOLDER_ID, stakeholderName: "Dana Example" }] },
      serverTime: T,
    },
    invalid: [{ response: { user: { id: USER_ID, email: null, displayName: null }, consoleRole: "STAFF", preview: false, company: null, access: "none", pii: false, portal: { matches: [] }, serverTime: T } }],
  },
  listOrgs: { response: { items: [org] }, invalid: [{ response: { items: [{ ...org, entityType: "LLC" }] } }] },
  createOrg: {
    body: { orgKey: "acme-demo", legalName: "Acme Robotics, Inc.", displayName: "Acme Robotics", timezone: "America/Los_Angeles" },
    response: org,
    invalid: [
      { body: { orgKey: "Acme Demo", legalName: "Acme Robotics, Inc.", displayName: "Acme Robotics", timezone: "America/Los_Angeles" } },
      { body: { orgKey: "acme-demo", legalName: "Acme Robotics, Inc.", displayName: "Acme Robotics", timezone: "Mars/Olympus_Mons" } },
    ],
  },
  downloadImportTemplate: {
    responseHeaders: attachmentHeaders("cap-table-template.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
  },
  previewImport: {
    response: {
      runId: ORG_ID,
      preview: {
        detectedFiles: [{ name: "cap-table-template.xlsx", kind: "template", format: "xlsx", sheets: ["Company"], warnings: [] }],
        currency: "USD",
        problems: [],
        openingBalances: [],
        assumptions: [],
        totals: { uploaded: null, app: { fullyDiluted: "100", issuedAndOutstanding: "100", byClass: {}, byPlan: {}, byHolder: {}, bySecurity: {} }, reconciliation: [] },
        canImport: true,
        suggestedAsOfDate: "2026-12-10",
        counts: { stakeholders: 1, shareClasses: 1, equityPlans: 0, securities: 1, commands: 2, transactions: 2 },
      },
    },
  },
  commitImport: {
    params: { runId: ORG_ID },
    response: { orgId: ORG_ID, counts: { stakeholders: 1, shareClasses: 1, equityPlans: 0, securities: 1, commands: 2, transactions: 2 } },
  },
  getImportRun: {
    params: { runId: ORG_ID },
    response: {
      runId: ORG_ID,
      source: "template",
      status: "previewed",
      asOfDate: "2026-12-10",
      fileHashes: [sha(20)],
      counts: { stakeholders: 1, shareClasses: 1, equityPlans: 0, securities: 1, commands: 2, transactions: 2 },
      orgId: null,
      errorMessage: null,
      createdAt: T,
      updatedAt: T,
    },
  },
  getOrg: { params: orgParams, response: org, invalid: [{ params: { orgId: "acme-demo" } }, { response: { ...org, shareUnit: "1.0" } }] },
  patchOrg: {
    params: orgParams,
    body: { version: 3, displayName: "Acme Robotics" },
    response: { ...org, version: 4 },
    invalid: [{ body: { version: 3 } }, { body: { version: 3, shareUnit: "0" } }, { body: { version: 0, displayName: "Acme" } }],
  },
  listSignatories: {
    params: orgParams,
    response: {
      items: [
        { id: SIGNATORY_ID, name: "Morgan Vale", title: "Chief Executive Officer", capabilities: ["options_signatory", "certificate_primary"], active: true, importedFromPulley: true },
      ],
    },
    invalid: [{ response: { items: [{ id: SIGNATORY_ID, name: "Morgan Vale", title: "Chief Executive Officer", capabilities: "options_signatory", active: true, importedFromPulley: true }] } }],
  },
  listAdminLinks: {
    params: orgParams,
    response: { items: [{ id: ADMIN_LINK_ID, email: "morgan.admin@example.test", stakeholderId: STAKEHOLDER_ID, source: "directory", createdBy: null, createdAt: T, removedAt: null, removedBy: null }] },
  },
  createAdminLink: {
    params: orgParams,
    body: { email: "Morgan.Admin@Example.Test", stakeholderId: STAKEHOLDER_ID, source: "admin" },
    response: { id: ADMIN_LINK_ID, email: "morgan.admin@example.test", stakeholderId: STAKEHOLDER_ID, source: "admin", createdBy: "Owner Example", createdAt: T, removedAt: null, removedBy: null },
    invalid: [{ body: { email: "morgan.admin@example.test", stakeholderId: STAKEHOLDER_ID, source: "manual" } }],
  },
  removeAdminLink: {
    params: { orgId: ORG_ID, id: ADMIN_LINK_ID },
    body: { reason: "Moved off the finance team" },
    response: { id: ADMIN_LINK_ID, email: "morgan.admin@example.test", stakeholderId: STAKEHOLDER_ID, source: "admin", createdBy: "Owner Example", createdAt: T, removedAt: T + 1000, removedBy: "Owner Example" },
    invalid: [{ body: { reason: "   " } }],
  },

  // §4.3 -------------------------------------------------------------------------------------------------------
  getPaymentInstructions: {
    params: orgParams,
    response: { details: paymentDetails, updatedBy: "Morgan Admin", updatedAt: T },
    invalid: [{ response: { details: paymentDetails, updatedBy: "Morgan Admin", updatedAt: "today" } }],
  },
  setPaymentInstructions: {
    params: orgParams,
    body: { details: { ...paymentDetails, accountNumber: "ACCT-EXAMPLE-01", swift: "EXAMUS33" }, updatedAt: null },
    response: { details: paymentDetails, updatedBy: "Morgan Admin", updatedAt: T },
    invalid: [{ body: { details: { ...paymentDetails, routingNumber: "12345" } } }, { body: { details: { ...paymentDetails, bankCountry: "US" } } }],
  },
  listStakeholders: {
    params: orgParams,
    query: { asOf: "2026-12-10" },
    response: { ...echo, items: [stakeholder] },
    invalid: [{ query: { asOf: "2026-02-30" } }, { response: { ...echo, items: [{ ...stakeholder, portalState: "maybe" }] } }],
  },
  createStakeholder: {
    params: orgParams,
    body: {
      kind: "individual",
      displayName: "Dana Example",
      relationship: "employee",
      address,
      emails: [{ email: "Dana@Mailbox.Example" }],
    },
    response: stakeholder,
    invalid: [
      { body: { kind: "institution", displayName: "Dana Example", relationship: "investor", emails: [] } },
      { body: { kind: "individual", displayName: "Dana Example", relationship: "employee", emails: [{ email: "x@mailbox.example", kind: "representative" }] } },
      { body: { kind: "individual", displayName: "Dana Example", relationship: "partner", emails: [{ email: "x@mailbox.example" }] } },
    ],
  },
  getStakeholder: {
    params: stakeholderParams,
    query: { asOf: "2026-12-10" },
    response: { ...stakeholder, ...echo, exercises: [exerciseRecord] },
  },
  patchStakeholder: {
    params: stakeholderParams,
    body: { version: 2, phone: "+1 555 0199" },
    response: { ...stakeholder, phone: "+1 555 0199", version: 3 },
    invalid: [{ body: { version: 2 } }, { body: { version: 2, relationship: "ex_employee" } }, { body: { version: 2, emails: [] } }],
  },
  addStakeholderEmail: {
    params: stakeholderParams,
    body: { email: "dana.new@mailbox.example", kind: "self" },
    response: {
      id: EMAIL_ID,
      email: "dana.new@mailbox.example",
      kind: "self",
      contactName: null,
      contactRole: null,
      authorizingDocumentId: null,
      addedBy: "Morgan Admin",
      createdAt: T,
      removedAt: null,
    },
    invalid: [{ body: { email: "dana.new@mailbox.example", kind: "representative" } }, { body: { email: "dana.new@mailbox.example", purpose: "marketing" } }],
  },
  removeStakeholderEmail: {
    params: { orgId: ORG_ID, id: STAKEHOLDER_ID, emailId: EMAIL_ID },
    body: { reason: "Mailbox closed" },
    response: { id: EMAIL_ID, email: "dana@example.test", kind: "self", contactName: null, contactRole: null, authorizingDocumentId: null, addedBy: "Morgan Admin", createdAt: T, removedAt: T + 1000 },
  },
  getStakeholderHoldings: { params: stakeholderParams, query: { asKnownAt: "410" }, response: { ...echo, items: [security] }, invalid: [{ query: { asKnownAt: "-1" } }] },
  previewAsStakeholder: { params: stakeholderParams, query: {}, response: portalOverview },
  previewPortalSecurity: {
    params: { ...stakeholderParams, securityId: OPTION_ID },
    query: {},
    response: portalSecurityDetail,
    invalid: [{ response: { ...portalSecurityDetail, detail: { family: "STOCK" } } }],
  },
  previewPortalDocuments: { params: stakeholderParams, response: [portalDocument, { ...portalDocument, id: OTHER_DOCUMENT_ID, kind: "PLAN_DOCUMENT", scope: "company" }] },
  previewHowToExercise: {
    params: stakeholderParams,
    response: { text: "", noticeForm: null, privacyNotice: null, paymentInstructions: paymentDetails, companyContact: { name: "Acme Equity Desk", email: "equity@acme.example" } },
  },
  getIsoSplit: {
    params: stakeholderParams,
    response: {
      stakeholderId: STAKEHOLDER_ID,
      years: [{ year: 2025, isoValueUsed: "11400", lots: [{ securityId: OPTION_ID, displayId: "OPT-7", fmvAtGrant: "0.95", isoQuantity: "12000", nsoQuantity: "0", exercisedIso: "6000", exercisedNso: "0" }] }],
    },
  },

  // §5.2–§5.4 --------------------------------------------------------------------------------------------------
  listStockClasses: { params: orgParams, query: {}, response: { ...echo, items: [stockClass] }, invalid: [{ response: { ...echo, items: [{ ...stockClass, authorizedShares: "-5" }] } }] },
  getStockClass: {
    params: { orgId: ORG_ID, id: COMMON_CLASS_ID },
    query: { asOf: "2026-12-10" },
    response: { ...stockClass, ...echo },
    invalid: [{ response: { ...stockClass, ...echo, conversionRatio: { numerator: "1.5", denominator: "1" } } }],
  },
  listStockPlans: { params: orgParams, query: {}, response: { ...echo, items: [stockPlan] } },
  getStockPlan: {
    params: { orgId: ORG_ID, id: PLAN_ID },
    query: {},
    response: { ...stockPlan, ...echo },
    invalid: [{ response: { ...stockPlan, ...echo, returnRules: { ...returnRules, sharesWithheldForTax: "KEEP" } } }],
  },
  listVestingTerms: { params: orgParams, query: { templates: "true" }, response: { items: [vestingTerms] }, invalid: [{ query: { templates: "yes" } }] },
  previewVesting: {
    params: orgParams,
    body: { definition: scheduleDefinition, quantity: "48000", vestingStartDate: "2026-12-10" },
    response: { events: [vestingEvent], total: "48000" },
    invalid: [
      { body: { definition: { ...scheduleDefinition, dayRule: "LAST_DAY" }, quantity: "48000", vestingStartDate: "2026-12-10" } },
      { body: { definition: { type: "EXPLICIT", events: [] }, quantity: "48000", vestingStartDate: "2026-12-10" } },
      { body: { definition: scheduleDefinition, quantity: "0", vestingStartDate: "2026-12-10" } },
    ],
  },
  getVestingTerms: { params: { orgId: ORG_ID, id: TEMPLATE_ID }, response: vestingTerms },
  confirmVestingTerms: { params: { orgId: ORG_ID, id: TEMPLATE_ID }, body: {}, response: vestingTerms },

  // §5.5 -------------------------------------------------------------------------------------------------------
  listValuations: { params: orgParams, response: { items: [valuation] } },
  recordValuation: {
    params: orgParams,
    body: {
      provider: "Example Valuation Partners",
      effectiveDate: "2026-12-01",
      prices: [{ stockClassId: COMMON_CLASS_ID, pricePerShare: "0.95" }],
      reportDocumentId: DOCUMENT_ID,
    },
    response: valuation,
    invalid: [
      { body: { provider: "Example Valuation Partners", effectiveDate: "2026-12-01", prices: [], reportDocumentId: DOCUMENT_ID } },
      { body: { provider: "Example Valuation Partners", effectiveDate: "2026-12-01", prices: [{ stockClassId: COMMON_CLASS_ID, pricePerShare: "0.950" }], reportDocumentId: DOCUMENT_ID } },
      { body: { provider: "Example Valuation Partners", effectiveDate: "2026-12-01", prices: [{ stockClassId: COMMON_CLASS_ID, pricePerShare: "0.95" }] } },
    ],
  },
  getFmv: {
    params: orgParams,
    query: { date: "2026-12-10" },
    response: { date: "2026-12-10", stockClassId: COMMON_CLASS_ID, fmv: { valuationId: VALUATION_ID, valuationName: "Dec 2026 Valuation", pricePerShare: "0.95", splitAdjusted: false, status: "presumptively_valid" } },
    invalid: [{ query: {} }],
  },
  flagMaterialEvent: {
    params: orgParams,
    body: { eventDate: "2026-12-20", description: "Signed term sheet for a priced round" },
    response: {
      ...valuation,
      status: "review_required",
      events: [{ id: VALUATION_EVENT_ID, kind: "MATERIAL_EVENT", eventDate: "2026-12-20", description: "Signed term sheet for a priced round", documentId: null, reversesEventId: null, createdBy: "Morgan Admin", createdAt: T }],
    },
  },
  getValuation: {
    params: { orgId: ORG_ID, id: VALUATION_ID },
    response: {
      ...valuation,
      documents: [{ id: DOCUMENT_ID, filename: "409A report.pdf", kind: "VALUATION_REPORT" }],
      grants: [{ securityId: OPTION_ID, displayId: "OPT-7", stakeholderId: STAKEHOLDER_ID, grantDate: "2026-12-10", exercisePrice: "0.95" }],
    },
    invalid: [{ params: { orgId: ORG_ID, id: "fmv" } }],
  },
  clearValuationReview: {
    params: { orgId: ORG_ID, id: VALUATION_ID },
    body: { eventDate: "2027-01-05", description: "Provider confirms the 409A stands", documentId: DOCUMENT_ID },
    response: valuation,
    invalid: [{ body: { eventDate: "2027-01-05", description: "Provider confirms the 409A stands" } }],
  },
  reverseValuationEvent: {
    params: { orgId: ORG_ID, id: VALUATION_ID, eventId: VALUATION_EVENT_ID },
    body: { note: "Flagged on the wrong valuation", confirmation: "Dec 2026 Valuation" },
    response: valuation,
  },
  voidValuation: {
    params: { orgId: ORG_ID, id: VALUATION_ID },
    body: { eventDate: "2026-12-11", description: "Recorded with the wrong price" },
    response: { ...valuation, status: "voided" },
  },

  // §6 ---------------------------------------------------------------------------------------------------------
  terminateStakeholder: {
    params: orgParams,
    query: { dryRun: "true" },
    body: terminateBody,
    dryRunBody: { stakeholderId: STAKEHOLDER_ID, terminationDate: "2026-12-04", terminationType: "voluntary" },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false },
    invalid: [
      { body: { ...terminateBody, terminationType: "layoff" } },
      { body: { ...terminateBody, accelerations: [{ securityId: OPTION_ID, quantity: "-3", reason: "x", documentId: DOCUMENT_ID }] } },
      { body: { ...terminateBody, expectedDiffSha256: undefined } },
      { query: { dryRun: "1" } },
    ],
  },
  scheduleTermination: {
    params: orgParams,
    query: { dryRun: "false" },
    body: { ...terminateBody, terminationDate: "2027-01-15", expectedLedgerSeq: undefined },
    dryRunBody: { stakeholderId: STAKEHOLDER_ID, terminationDate: "2027-01-15", terminationType: "voluntary" },
    response: { scheduledTerminationId: SCHEDULED_TERMINATION_ID, preview: commandResult },
    invalid: [{ body: { ...terminateBody, expectedDiffSha256: undefined } }],
  },
  cancelScheduledTermination: {
    params: orgParams,
    body: { scheduledTerminationId: SCHEDULED_TERMINATION_ID, version: 1, note: "Offer withdrawn" },
    response: scheduledTermination,
    invalid: [{ body: { scheduledTerminationId: SCHEDULED_TERMINATION_ID, version: 1, note: "Offer withdrawn", ...guard } }],
  },
  exerciseOption: {
    params: orgParams,
    query: {},
    body: exerciseBody,
    dryRunBody: { ...exerciseBody, expectedLedgerSeq: undefined, expectedDiffSha256: undefined },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false, warnings: [{ code: "PAYMENT_EXCEEDS_COST", message: "Refund 0.01" }] },
    invalid: [
      { body: { ...exerciseBody, payment: { ...exerciseBody.payment, payerIsHolder: false } } },
      { body: { ...exerciseBody, payment: { ...exerciseBody.payment, method: "MANUAL_UNSPECIFIED" } } },
      { body: { ...exerciseBody, lots: [{ portion: "ISO", quantity: "3000" }, { portion: "ISO", quantity: "3000" }] } },
      { body: { ...exerciseBody, fmv: { source: "manual", pricePerShare: "1.2" } } },
      { body: { ...exerciseBody, quantity: 6000 } },
    ],
  },
  grantEquityCompensation: {
    params: orgParams,
    query: { dryRun: "true" },
    body: grantBody,
    dryRunBody: { ...grantBody, expectedLedgerSeq: undefined, expectedDiffSha256: undefined },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false, created: { securityIds: [OPTION_ID], scheduledTerminationIds: [], vestingTermsIds: [] } },
    invalid: [
      { body: { ...grantBody, isoAttestations: undefined } },
      { body: { ...grantBody, grantDate: "2026-12-12" } },
      { body: { ...grantBody, vesting: { ...grantBody.vesting, matchesSignedAgreement: false } } },
      { body: { ...grantBody, executedAgreement: { documentId: DOCUMENT_ID, signedByHolderAndSignatory: false } } },
      { body: { ...grantBody, optionType: "INTL" } },
    ],
  },
  cancelSecurity: {
    params: orgParams,
    body: { ...guard, securityId: OPTION_ID, effectiveDate: "2026-12-10", reason: "HOLDER_WAIVER", documentId: DOCUMENT_ID, confirmation: "OPT-7" },
    dryRunBody: { securityId: OPTION_ID, effectiveDate: "2026-12-10", reason: "NOT_EXECUTED", documentId: DOCUMENT_ID, confirmation: "OPT-7" },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false },
    invalid: [
      { body: { ...guard, securityId: OPTION_ID, effectiveDate: "2026-12-10", reason: "EXPIRED", documentId: DOCUMENT_ID, confirmation: "OPT-7" } },
      { body: { ...guard, securityId: OPTION_ID, effectiveDate: "2026-12-10", reason: "HOLDER_WAIVER", confirmation: "OPT-7" } },
    ],
  },
  markExecuted: {
    params: orgParams,
    body: { ...guard, securityId: OPTION_ID, executedAgreementDocumentId: DOCUMENT_ID, signatureDates: { company: "2026-12-08" }, attestation: "This PDF bears both signatures", confirmation: "OPT-7" },
    dryRunBody: { securityId: OPTION_ID, executedAgreementDocumentId: DOCUMENT_ID, signatureDates: {}, attestation: "This PDF bears both signatures", confirmation: "OPT-7" },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false },
    invalid: [{ body: { ...guard, securityId: OPTION_ID, executedAgreementDocumentId: DOCUMENT_ID, signatureDates: {}, attestation: "Signed", confirmation: "OPT-7" } }],
  },
  recordLeaveOfAbsence: {
    params: orgParams,
    body: { ...guard, stakeholderId: STAKEHOLDER_ID, startDate: "2026-09-01", endDate: null, returnGuaranteed: false },
    dryRunBody: { stakeholderId: STAKEHOLDER_ID, startDate: "2026-09-01", endDate: "2026-12-01", returnGuaranteed: true },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false },
    invalid: [{ body: { ...guard, stakeholderId: STAKEHOLDER_ID, startDate: "2026-09-01", returnGuaranteed: false } }],
  },
  extendExerciseDeadline: {
    params: orgParams,
    body: { ...guard, securityId: OPTION_ID, newContractualDeadline: "2027-06-30", documentId: DOCUMENT_ID, note: "Separation agreement section 4", confirmation: "OPT-7" },
    dryRunBody: { securityId: OPTION_ID, newContractualDeadline: "2027-06-30", documentId: DOCUMENT_ID, note: "Separation agreement section 4", confirmation: "OPT-7" },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false, warnings: [{ code: "ISO_MODIFICATION_RISK", message: "Counsel decides" }] },
    invalid: [{ body: { ...guard, securityId: OPTION_ID, newContractualDeadline: "2027-06-30", documentId: DOCUMENT_ID, confirmation: "OPT-7" } }],
  },
  setPlanTerms: {
    params: orgParams,
    body: { ...guard, stockPlanId: PLAN_ID, effectiveDate: "2027-01-01", returnRules, defaultTerminationWindows: sixWindows, defaultRepurchaseWindow: null, status: "active", pourOverPlanId: null, documentId: DOCUMENT_ID, note: "Counsel confirmed the plan's rules" },
    dryRunBody: { stockPlanId: PLAN_ID, effectiveDate: "2027-01-01", returnRules, defaultTerminationWindows: sixWindows, defaultRepurchaseWindow: { period: "90", unit: "DAYS" }, status: "active", pourOverPlanId: null, documentId: DOCUMENT_ID, note: "Counsel confirmed the plan's rules" },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false },
    invalid: [
      { body: { ...guard, stockPlanId: PLAN_ID, effectiveDate: "2027-01-01", returnRules: { ...returnRules, sharesWithheldForTax: undefined }, defaultTerminationWindows: sixWindows, defaultRepurchaseWindow: null, status: "active", pourOverPlanId: null, documentId: DOCUMENT_ID, note: "n" } },
      { body: { ...guard, stockPlanId: PLAN_ID, effectiveDate: "2027-01-01", returnRules, defaultTerminationWindows: sixWindows.slice(0, 5), defaultRepurchaseWindow: null, status: "active", pourOverPlanId: null, documentId: DOCUMENT_ID, note: "n" } },
      { body: { ...guard, stockPlanId: PLAN_ID, effectiveDate: "2027-01-01", returnRules, defaultTerminationWindows: [...sixWindows.slice(0, 5), window("VOLUNTARY", "6")], defaultRepurchaseWindow: null, status: "active", pourOverPlanId: null, documentId: DOCUMENT_ID, note: "n" } },
    ],
  },
  mergeStakeholders: {
    params: orgParams,
    body: { ...guard, mergedStakeholderId: OTHER_STAKEHOLDER_ID, survivingStakeholderId: STAKEHOLDER_ID, reason: "Duplicate import record", confirmation: "Robin Sample" },
    dryRunBody: { mergedStakeholderId: OTHER_STAKEHOLDER_ID, survivingStakeholderId: STAKEHOLDER_ID, reason: "Duplicate import record" },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false },
    invalid: [{ body: { ...guard, mergedStakeholderId: OTHER_STAKEHOLDER_ID, survivingStakeholderId: STAKEHOLDER_ID, confirmation: "Robin Sample" } }],
  },
  reverseCommand: {
    params: orgParams,
    body: { commandId: OTHER_COMMAND_ID, note: "Recorded against the wrong grant", expectedLedgerSeq: 412, expectedDiffSha256: sha(13), confirmation: "OPT-7" },
    response: { ...commandResult, commandId: COMMAND_ID, dryRun: false },
    invalid: [{ body: { commandId: OTHER_COMMAND_ID, expectedLedgerSeq: 412, expectedDiffSha256: sha(13), confirmation: "OPT-7" } }],
  },
  getReversalPreview: { params: { orgId: ORG_ID, id: COMMAND_ID }, response: reversalPreview },
  getCommand: {
    params: { orgId: ORG_ID, id: COMMAND_ID },
    response: { ...commandSummary, transactions: [transaction], dependencies: [], dependents: [{ commandId: OTHER_COMMAND_ID, type: "exercise-option", kind: "consumes_security", reversed: false }] },
  },
  listExpiryRuns: {
    params: { orgId: ORG_ID },
    response: { items: [{ runId: 77, localDate: "2027-01-02", startedAt: 1798909200000, state: "pending", proposalCount: 1 }] },
    invalid: [{ params: { orgId: "acme" } }],
  },
  getExpiryRun: {
    params: { orgId: ORG_ID, runId: "77" },
    response: {
      runId: 77, localDate: "2027-01-02", startedAt: 1798909200000, state: "confirming", proposalCount: 1,
      confirmedAt: null, confirmedBy: null, confirmationStartedAt: 1798912800000,
      proposals: [{
        securityId: OPTION_ID, displayId: "OPT-26", family: "EQUITY_COMPENSATION",
        holder: { stakeholderId: STAKEHOLDER_ID, name: "Synthetic Holder S27", email: "s•••@acme.test" },
        quantity: "21250", reason: "contractual_deadline", lastExerciseDate: "2027-01-01", effectiveDate: "2027-01-02",
        confirmable: { quantity: "21250", effectiveDate: "2027-01-02" },
      }],
    },
    invalid: [{ params: { orgId: ORG_ID, runId: "seventy" } }],
  },
  confirmExpiryRun: {
    params: { orgId: ORG_ID, runId: "77" },
    body: { expectedLedgerSeq: 412, securityIds: [OPTION_ID], expectedEffectSha256s: { [OPTION_ID]: sha(6) }, switchToAutomatic: true },
    dryRunBody: { securityIds: [OPTION_ID] },
    response: { runId: 77, commands: [{ ...commandResult, commandId: COMMAND_ID, dryRun: false }], expiryMode: "automatic" },
    invalid: [
      { params: { orgId: ORG_ID, runId: "seventy" } },
      { body: { expectedLedgerSeq: 412, securityIds: [OPTION_ID], switchToAutomatic: true } },
      // A reviewed effect for every security confirmed, and for no other.
      { body: { expectedLedgerSeq: 412, securityIds: [OPTION_ID], expectedEffectSha256s: {}, switchToAutomatic: true } },
      { body: { expectedLedgerSeq: 412, securityIds: [], expectedEffectSha256s: { [OPTION_ID]: sha(6) }, switchToAutomatic: true } },
    ],
  },

  // §7 ---------------------------------------------------------------------------------------------------------
  getDashboard: { params: orgParams, response: dashboard, invalid: [{ response: { ...dashboard, topStakeholders: [{ stakeholderId: OTHER_STAKEHOLDER_ID, name: "Robin Sample", fullyDiluted: "3000000", pct: "12.5" }] } }] },
  getCapTable: {
    params: orgParams,
    query: { asOf: "2026-12-10", tab: "ownership" },
    response: capTable,
    invalid: [{ query: { tab: "pie" } }, { response: { ...capTable, availablePool: { fullyDiluted: "250000", fullyDilutedPct: "10/960" } } }],
  },
  getSecuritiesStatus: { params: orgParams, response: securitiesStatus },
  listSecurities: {
    params: orgParams,
    query: { family: "EQUITY_COMPENSATION" },
    response: { ...echo, items: [security] },
    invalid: [{ query: { family: "OPTION" } }, { response: { ...echo, items: [{ ...security, subtype: "OPTION_INTL" }] } }],
  },
  getSecurity: { params: securityParams, query: { asKnownAt: "412" }, response: securityDetail },
  getSecurityVesting: {
    params: securityParams,
    query: { asOf: "2026-12-10" },
    response: { ...echo, securityId: OPTION_ID, quantity: "48000", vested: "18000", unvested: "30000", vestingStartDate: "2024-12-10", vestingStopDate: null, events: [vestingEvent] },
  },
  getSecurityTimeline: {
    params: securityParams,
    response: { items: [{ kind: "transaction", at: T, effectiveDate: "2024-12-10", transactionId: TX_ID, commandId: COMMAND_ID, type: "TX_EQUITY_COMPENSATION_ISSUANCE", summary: "Granted 48,000 ISO", actor: "Morgan Admin", note: null, securityId: OPTION_ID }] },
  },
  getTerminationPreview: {
    params: securityParams,
    query: { terminationDate: "2026-12-04", terminationType: "voluntary" },
    response: { securityId: OPTION_ID, terminationDate: "2026-12-04", terminationType: "voluntary", vestingStopDate: "2026-12-04", vested: "18000", unvested: "30000", exercisable: "18000", repurchaseable: "0", contractualDeadline: "2027-03-04", isoDeadline: "2027-03-04" },
    invalid: [{ query: { terminationDate: "2026-12-04" } }],
  },
  listTransactions: {
    params: orgParams,
    query: { type: "TX_EQUITY_COMPENSATION_ISSUANCE", cursor: "c-411", limit: "25" },
    response: { items: [transaction], nextCursor: "c-410" },
    invalid: [{ query: { limit: "500" } }, { query: { type: "grant" } }, { response: { items: [{ ...transaction, quantity: "48000.00" }], nextCursor: null } }],
  },
  getTransaction: {
    params: { orgId: ORG_ID, id: TX_ID },
    response: { ...transaction, command: commandSummary, reversal: null },
  },
  listExercises: { params: orgParams, query: { year: "2026" }, response: { items: [exerciseRecord] }, invalid: [{ query: { year: "twenty" } }] },
  listExerciseRequests: { params: orgParams, response: { items: [exerciseRequest] } },
  getExerciseRequest: { params: { orgId: ORG_ID, id: EXERCISE_REQUEST_ID }, response: exerciseRequest },
  listSignatureRequests: {
    params: orgParams,
    query: { securityId: OPTION_ID },
    response: {
      items: [
        { id: SIGNATURE_REQUEST_ID, securityId: OPTION_ID, exerciseRequestId: null, documentId: DOCUMENT_ID, signerRole: "COMPANY_SIGNATORY", signerName: "Casey Officer", signerEmail: null, status: "PENDING", method: null, evidence: null, evidenceSha256: null, signedAt: null, resolvedAt: null, resolutionNote: null, importedFromPulley: true, createdAt: T },
      ],
    },
  },
  listCertificates: {
    params: orgParams,
    response: {
      items: [
        { id: CERTIFICATE_ID, securityId: SHARES_ID, certificateNumber: "CS-4", status: "ISSUED", issuedDate: "2025-04-01", cancelledDate: null, cancelReason: null, documentId: DOCUMENT_ID, signatories: [], legends: [{ name: "Rule 144", text: "These shares are restricted." }], renderingNote: "Unsigned, rendered by the previous provider", importedFromPulley: true },
      ],
    },
  },
  listLegends: { params: orgParams, response: { items: [{ id: LEGEND_ID, kind: "LEGEND", name: "Rule 144", text: "These shares are restricted.", archivedAt: null, version: 1 }] } },
  listCertificateTerms: { params: orgParams, response: { items: [{ id: LEGEND_ID, kind: "CERTIFICATE_TERMS", name: "Standard terms", text: "Terms text.", archivedAt: null, version: 1 }] } },
  listElections83b: {
    params: orgParams,
    query: {},
    response: { items: [{ id: ELECTION_ID, securityId: SHARES_ID, status: "FILED", transferDate: "2024-01-10", dueDate: "2024-02-09", filedDate: "2024-01-20", proofDocumentId: DOCUMENT_ID, supersedesId: null, importedFromPulley: true, createdAt: T }] },
  },
  listOrgAudit: {
    params: orgParams,
    query: { action: "command.grant-equity-compensation", actorType: "user" },
    response: { items: [auditEvent], nextCursor: null },
    invalid: [{ query: { actorType: "robot" } }, { query: { actorId: "morgan" } }],
  },

  // §8 ---------------------------------------------------------------------------------------------------------
  uploadDocument: {
    params: orgParams,
    headers: uploadHeaders,
    response: { ...document, links: [{ ...documentLink }], version: 1 },
    invalid: [
      { headers: { ...uploadHeaders, "x-content-sha256": "ABC" } },
      { headers: { ...uploadHeaders, "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation" } },
      { headers: { ...uploadHeaders, "x-link-role": undefined } },
      { headers: { ...uploadHeaders, "content-type": "application/x-msdownload" } },
    ],
  },
  listDocuments: {
    params: orgParams,
    query: { kind: "GRANT_AGREEMENT", targetType: "security", targetId: OPTION_ID },
    response: { items: [document], nextCursor: null },
    invalid: [{ query: { targetType: "security" } }, { query: { kind: "MEMO" } }],
  },
  getDocument: {
    params: documentParams,
    response: { ...document, versions: [{ id: OTHER_DOCUMENT_ID, versionLabel: "v1", createdAt: T - 1000, supersedesDocumentId: null }] },
  },
  patchDocument: {
    params: documentParams,
    body: { version: 3, collectionId: COLLECTION_ID },
    response: { ...document, collectionId: COLLECTION_ID, version: 4 },
    invalid: [{ body: { version: 3 } }, { body: { version: 3, sha256: sha(1) } }],
  },
  addDocumentLink: {
    params: documentParams,
    body: { role: "AGREEMENT", target: { type: "security", id: OPTION_ID } },
    response: document,
    invalid: [{ body: { role: "AGREEMENT", target: { type: "org", id: ORG_ID } } }, { body: { role: "AGREEMENT", target: { type: "security", id: OPTION_ID, extra: true } } }],
  },
  revokeDocumentLink: {
    params: { orgId: ORG_ID, id: DOCUMENT_ID, linkId: LINK_ID },
    body: { reason: "Linked to the wrong grant" },
    response: { ...document, links: [{ ...documentLink, revokedAt: T, revokeReason: "Linked to the wrong grant" }] },
    invalid: [{ body: { reason: "x".repeat(501) } }],
  },
  setHolderVisibility: { params: documentParams, body: { version: 3, visible: true }, response: document },
  uploadDocumentVersion: { params: documentParams, headers: { ...uploadHeaders, "x-link-target": undefined, "x-link-id": undefined, "x-link-role": undefined }, response: { ...document, id: OTHER_DOCUMENT_ID, supersedesDocumentId: DOCUMENT_ID } },
  downloadDocument: { params: documentParams, responseHeaders: downloadHeaders },
  listCollections: { params: orgParams, response: { items: [collection] } },
  createCollection: { params: orgParams, body: { name: "Board consents" }, response: collection, invalid: [{ body: { name: "" } }] },
  patchCollection: { params: { orgId: ORG_ID, id: COLLECTION_ID }, body: { version: 1, archived: true }, response: { ...collection, archivedAt: T, version: 2 } },

  // §9 ---------------------------------------------------------------------------------------------------------
  runReport: {
    params: { orgId: ORG_ID, reportKey: "cap-table" },
    query: { format: "json", asOf: "2026-12-31", includePii: "false" },
    responseHeaders: attachmentHeaders("AcmeRobotics_CapTable_2026-12-31.json", "application/json"),
    response: {
      reportKey: "cap-table",
      generatedAt: T,
      asOf: "2026-12-31",
      asKnownAt: null,
      ledgerSeq: 412,
      ledgerHeadHash: HEAD,
      engineVersion: ENGINE,
      includePii: false,
      sheets: [{ name: "Ownership", columns: ["Stakeholder", "Fully diluted", "FD %"], rows: [["Dana Example", "60000", "1/400"]] }],
    },
    invalid: [{ params: { orgId: ORG_ID, reportKey: "ownership" } }, { query: { format: "pdf" } }, { query: { includePii: "yes" } }],
  },
  getPortalOverview: {
    query: { asOf: "2026-12-10" },
    response: portalOverview,
    invalid: [{ response: { ...portalOverview, fullyDilutedPct: "1/400" } }],
  },
  getPortalSecurity: {
    params: { orgId: ORG_ID, id: OPTION_ID },
    query: {},
    response: portalSecurityDetail,
    invalid: [
      { response: { ...portalSecurityDetail, status: "RETRACTED" } },
      { response: { ...portalSecurityDetail, numbers: { ...portalSecurityDetail.numbers, fullyDiluted: "48000" } } },
      { response: portalSecurity },
      { response: { ...portalSecurityDetail, detail: { ...portalSecurityDetail.detail, exercises: [{ ...portalSecurityDetail.detail.exercises[0], fmvAtExercise: "1.10" }] } } },
    ],
  },
  listPortalDocuments: { params: orgParams, response: [portalDocument, { ...portalDocument, id: OTHER_DOCUMENT_ID, kind: "PLAN_DOCUMENT", scope: "company" }] },
  getHowToExercise: {
    params: orgParams,
    response: {
      text: "Sign the notice of exercise and send payment.",
      noticeForm: { ...portalDocument, kind: "NOTICE_OF_EXERCISE", scope: "company" },
      privacyNotice: { ...portalDocument, id: OTHER_DOCUMENT_ID, filename: "Privacy notice.pdf", kind: "OTHER", scope: "company" },
      paymentInstructions: paymentDetails,
      companyContact: { name: "Acme Equity Desk", email: "equity@acme.example" },
    },
    invalid: [
      { response: { text: "", noticeForm: null, paymentInstructions: null, companyContact: null } },
      { response: { text: "", noticeForm: null, privacyNotice: { ...portalDocument, id: OTHER_DOCUMENT_ID, scope: "company", counselApprovedBy: "Example LLP" }, paymentInstructions: null, companyContact: null } },
    ],
  },
  downloadPortalDocument: { params: { id: DOCUMENT_ID }, responseHeaders: downloadHeaders },

  // §11 --------------------------------------------------------------------------------------------------------
  verifyLedger: { params: orgParams, response: ledgerVerification },
  processDue: {
    params: orgParams,
    response: { localDate: "2026-12-10", appliedTerminations: 0, expiredSecurities: 0, proposedExpirations: 0, remainingExpirations: 0, failures: 0 },
  },

};

/** Ids the fixtures use that a holder-scoped answer may contain (for the allowlist walk). */
export const DANA_VISIBLE_IDS = new Set([ORG_ID, STAKEHOLDER_ID, OPTION_ID, DOCUMENT_ID, OTHER_DOCUMENT_ID]);
export { uid };
