import { api } from "#shared";

type Me = api.MeResponse;
type ConsoleRole = Me["consoleRole"];
type MeAccess = Me["access"];

// Synthetic "Acme Robotics, Inc." data: no real person, company, number or id. Every builder parses its result with
// the contract's schema, so a fixture that drifts fails where it is built.

export function uuid(kind: number, n: number): string {
  return `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
const HASH = "ab".repeat(32);

/** An exact fraction in lowest terms, as the contract's ratios are ("n" or "n/d"). */
export function ratio(num: number, den: number): string {
  let [a, b] = [BigInt(num), BigInt(den)];
  while (b !== 0n) [a, b] = [b, a % b];
  const n = BigInt(num) / a;
  const d = BigInt(den) / a;
  return d === 1n ? `${n}` : `${n}/${d}`;
}
const AT = Date.UTC(2026, 9, 21, 16, 40); // Oct 21, 2026 9:40am in Oakland

export const TODAY = "2026-10-21";
export const ORG_ID = uuid(1, 1);
export const USER_ID = uuid(2, 1);

export const IDS = {
  freya: uuid(3, 1),
  daniel: uuid(3, 4),
  rachel: uuid(3, 13),
  mateo: uuid(3, 14),
  nadia: uuid(3, 21),
  rafael: uuid(3, 22),
  desmond: uuid(3, 24),
  northgate: uuid(3, 31),
  tidewater: uuid(3, 34),
  marcus: uuid(3, 37),
  common: uuid(4, 1),
  seed: uuid(4, 2),
  seriesA1: uuid(4, 3),
  plan: uuid(5, 1),
  cs1: uuid(6, 1),
  cs4: uuid(6, 4),
  cs7: uuid(6, 7),
  ps1: uuid(6, 21),
  ps9: uuid(6, 29),
  opt1: uuid(6, 101),
  opt18: uuid(6, 118),
  opt21: uuid(6, 121),
  opt49: uuid(6, 149),
  safe1: uuid(6, 201),
  war1: uuid(6, 301),
  vs1: uuid(7, 1),
  vs2: uuid(7, 2),
  v4: uuid(8, 4),
  v5: uuid(8, 5),
  command: uuid(9, 1),
  doc1: uuid(10, 1),
  doc2: uuid(10, 2),
} as const;

// ---------------------------------------------------------------------------
// Session and org

/**
 * Who the console says is using the app: an owner or an admin manage the cap table (`admin_rw`), an editor views it
 * (`admin_ro`, with or without personal data).
 */
export type Role = "owner" | "admin_rw" | "admin_ro" | "admin_ro_pii";

const PEOPLE: Record<Role, { email: string; name: string; consoleRole: ConsoleRole; access: MeAccess; pii: boolean }> = {
  owner: { email: "rachel@acmerobotics.example", name: "Rachel Ostrowski", consoleRole: "OWNER", access: "admin_rw", pii: true },
  admin_rw: { email: "morgan@acmerobotics.example", name: "Morgan Ellis", consoleRole: "ADMIN", access: "admin_rw", pii: true },
  admin_ro: { email: "tobias@acmerobotics.example", name: "Tobias Renner", consoleRole: "EDITOR", access: "admin_ro", pii: false },
  admin_ro_pii: { email: "reviewer@acmerobotics.example", name: "Riley Reviewer", consoleRole: "EDITOR", access: "admin_ro", pii: true },
};

export const COMPANY = { id: ORG_ID, displayName: "Acme Robotics", legalName: "Acme Robotics, Inc.", timezone: "America/Los_Angeles", currency: "USD", importSource: "pulley" as const };

/** `/api/me` for a console user of the given role; `ownStakeholderId` is a stakeholder their e-mail matches. */
export function me(role: Role, options: { ownStakeholderId?: string; preview?: boolean; company?: Me["company"] } = {}): Me {
  const person = PEOPLE[role];
  return api.meResponseSchema.parse({
    user: { id: USER_ID, email: person.email, displayName: person.name },
    consoleRole: person.consoleRole,
    preview: options.preview ?? false,
    company: options.company === undefined ? COMPANY : options.company,
    access: person.access,
    pii: person.pii,
    portal: { matches: options.ownStakeholderId ? [{ orgId: ORG_ID, stakeholderId: options.ownStakeholderId, stakeholderName: person.name }] : [] },
    serverTime: AT,
  });
}

export function org(overrides: Partial<api.Org> = {}, settings: Partial<api.OrgSettings> = {}): api.Org {
  return api.orgSchema.parse({
    id: ORG_ID, orgKey: "acme-robotics", slug: "acme-robotics", status: "active", archivedReason: null,
    legalName: "Acme Robotics, Inc.", displayName: "Acme Robotics", entityType: "C_CORPORATION", jurisdiction: "US-DE",
    incorporationDate: "2021-02-15", timezone: "America/Los_Angeles", currency: "USD", fiscalYearEnd: "12-31",
    ein: "••-•••0000", address: { line1: "400 Harbor Way, Suite 12", city: "Oakland", region: "CA", postalCode: "94607", country: "US" },
    shareUnit: "1", shareUnitFrozen: true, importSource: "pulley",
    settings: {
      ...api.DEFAULT_ORG_SETTINGS,
      companyContact: { name: "Equity team", email: "equity@acmerobotics.example" },
      ...settings,
    },
    ledgerSeq: 412, ledgerHeadHash: HASH, version: 3,
    ...overrides,
  });
}

const ECHO = { asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: HASH, engineVersion: "1.0.0" };

// ---------------------------------------------------------------------------
// Stakeholders

function email(address: string, overrides: Partial<api.StakeholderEmail> = {}): api.StakeholderEmail {
  return {
    id: uuid(11, address.length * 97 + address.charCodeAt(0)), email: address, kind: "self", contactName: null, contactRole: null,
    authorizingDocumentId: null, addedBy: "Imported from Pulley", createdAt: Date.UTC(2026, 9, 1), removedAt: null,
    ...overrides,
  };
}

export function stakeholder(overrides: Partial<api.Stakeholder> & { id: string; displayName: string }): api.Stakeholder {
  return api.stakeholderSchema.parse({
    kind: "individual", legalName: overrides.displayName, relationship: "employee", issuerAssignedId: null,
    address: { line1: "120 Larkspur Ln", city: "Oakland", region: "CA", postalCode: "94610", country: "US" },
    phone: "+1 510 555 0100", countryOfResidence: "US", taxStatus: "us", hireDate: "2023-03-01", comments: null,
    portalAccess: "auto", mergedInto: null, mergedRecords: [], portalState: "open", termination: null, scheduledTermination: null,
    leaveOfAbsence: [], emails: [email(`${overrides.displayName.split(" ")[0]!.toLowerCase()}@mailbox.example`)],
    totals: { issuedAndOutstanding: "0", fullyDiluted: "0", fullyDilutedPct: "0", capitalContribution: "0" },
    provenance: { importedFromPulley: true, pulleyId: null }, version: 1,
    ...overrides,
  });
}

export const STAKEHOLDERS = {
  freya: stakeholder({
    id: IDS.freya, displayName: "Freya Lindqvist", relationship: "founder", issuerAssignedId: "EMP-001",
    emails: [email("freya.lindqvist@mailbox.example"), email("freya@acmerobotics.example", { addedBy: "Morgan Ellis", createdAt: Date.UTC(2026, 9, 5) })],
    totals: { issuedAndOutstanding: "4000000", fullyDiluted: "4300000", fullyDilutedPct: ratio(4300000, 24312120), capitalContribution: "400" },
  }),
  daniel: stakeholder({
    id: IDS.daniel, displayName: "Daniel Achterberg", issuerAssignedId: "EMP-004",
    emails: [
      email("daniel.achterberg@mailbox.example"),
      email("daniel@acmerobotics.example", { addedBy: "Morgan Ellis", createdAt: Date.UTC(2026, 9, 6) }),
    ],
    totals: { issuedAndOutstanding: "50000", fullyDiluted: "300000", fullyDilutedPct: ratio(300000, 24312120), capitalContribution: "5000" },
  }),
  mateo: stakeholder({
    id: IDS.mateo, displayName: "Mateo Villalobos",
    scheduledTermination: { id: uuid(12, 1), terminationDate: "2026-12-04", type: "voluntary" },
    emails: [email("mateo.villalobos@mailbox.example"), email("mateo@acmerobotics.example", { addedBy: "Morgan Ellis" })],
    totals: { issuedAndOutstanding: "0", fullyDiluted: "140000", fullyDilutedPct: ratio(140000, 24312120), capitalContribution: "0" },
  }),
  nadia: stakeholder({
    id: IDS.nadia, displayName: "Nadia Pereira-Stone", relationship: "ex_employee",
    termination: { date: "2026-08-31", type: "involuntary", vestingStopDate: "2026-08-31", commandId: IDS.command },
    emails: [email("nadia.ps@mailbox.example")],
    totals: { issuedAndOutstanding: "0", fullyDiluted: "60000", fullyDilutedPct: ratio(60000, 24312120), capitalContribution: "0" },
  }),
  rafael: stakeholder({
    id: IDS.rafael, displayName: "Rafael Duarte", relationship: "ex_employee", portalAccess: "closed", portalState: "closed_by_admin",
    termination: { date: "2024-10-31", type: "voluntary", vestingStopDate: "2024-10-31", commandId: uuid(9, 2) },
    emails: [email("rafael.duarte@mailbox.example")],
  }),
  northgate: stakeholder({
    id: IDS.northgate, displayName: "Northgate Ventures Fund II, L.P.", kind: "institution", relationship: "investor", hireDate: null,
    emails: [
      email("ops@northgate.example", { kind: "contact", contactName: "Fund operations", contactRole: "Operations" }),
      email("ir@northgate.example", { kind: "contact", contactName: "Investor relations", contactRole: "IR" }),
    ],
    totals: { issuedAndOutstanding: "3858173", fullyDiluted: "3858173", fullyDilutedPct: ratio(3858173, 24312120), capitalContribution: "3499999.8" },
  }),
  marcus: stakeholder({
    id: IDS.marcus, displayName: "Marcus Oyelaran", relationship: "investor",
    emails: [email("marcus.oyelaran@kensington.example")],
    totals: { issuedAndOutstanding: "91145", fullyDiluted: "91145", fullyDilutedPct: ratio(91145, 24312120), capitalContribution: "0" },
  }),
};

export function stakeholderList(items: readonly api.Stakeholder[] = Object.values(STAKEHOLDERS)): api.StakeholderList {
  return api.stakeholderListSchema.parse({ ...ECHO, items });
}

// ---------------------------------------------------------------------------
// Securities

export function numbers(overrides: Partial<api.SecurityNumbers> = {}): api.SecurityNumbers {
  return {
    asOf: TODAY, asKnownAt: 412, issued: "0", outstanding: "0", fullyDiluted: "0", vested: "0", unvested: "0", vestedOutstanding: "0",
    exercised: "0", exercisable: "0", cancelled: "0", repurchased: "0", repurchaseable: "0", forfeited: "0",
    fullyDilutedPct: "0", outstandingPct: "0", ...overrides,
  };
}

export function security(overrides: Partial<api.Security> & { id: string; displayId: string }): api.Security {
  return api.securitySchema.parse({
    family: "STOCK", subtype: "COMMON", stakeholderId: IDS.freya, stakeholderName: "Freya Lindqvist", stockClassId: IDS.common,
    stockPlanId: null, issueDate: "2021-02-15", status: "OUTSTANDING", executionStatus: "executed", parentSecurityId: null,
    originCommandId: IDS.command, terms: {}, deadlines: null, exemption: { federal: "RULE_701", country: null, state: null },
    boardApprovalDate: "2021-02-15", boardApprovalNotRecordedInPulley: false, numbers: numbers(), certificate: null,
    provenance: { importedFromPulley: true, sourceFile: "raw_captable_2026-09-30.csv", sourceSha256: HASH, pulleyId: null },
    ...overrides,
  });
}

const money = (amount: string) => ({ amount, currency: "USD" });

export const SECURITIES = {
  cs1: security({
    id: IDS.cs1, displayId: "CS-1",
    terms: { share_price: money("0.0001"), quantity: "4000000", vesting_terms_id: IDS.vs1, x_holding_start_date: "2021-02-15", x_issue_reason: "Founder RSPA", consideration_text: "Cash and IP assignment" },
    numbers: numbers({ issued: "4000000", outstanding: "4000000", fullyDiluted: "4000000", vested: "4000000", vestedOutstanding: "4000000", fullyDilutedPct: ratio(4000000, 24312120), outstandingPct: ratio(4000000, 19945120) }),
    certificate: { id: uuid(13, 1), number: "CS-1", status: "ISSUED", documentId: IDS.doc2 },
  }),
  cs7: security({
    id: IDS.cs7, displayId: "CS-7", stakeholderId: IDS.daniel, stakeholderName: "Daniel Achterberg", issueDate: "2026-03-20", parentSecurityId: IDS.opt1,
    stockPlanId: IDS.plan, boardApprovalDate: null,
    terms: { share_price: money("0.1"), x_origin: "EXERCISE", x_source_security_id: IDS.opt1 },
    numbers: numbers({ issued: "50000", outstanding: "50000", fullyDiluted: "50000", vested: "50000", vestedOutstanding: "50000", fullyDilutedPct: ratio(50000, 24312120) }),
    certificate: { id: uuid(13, 7), number: "CS-7", status: "ISSUED", documentId: null },
  }),
  ps9: security({
    id: IDS.ps9, displayId: "PS-9", stakeholderId: IDS.northgate, stakeholderName: "Northgate Ventures Fund II, L.P.", subtype: "PREFERRED",
    stockClassId: IDS.seed, issueDate: "2023-03-31", exemption: { federal: "REG_D_506B", country: null, state: null },
    terms: { share_price: money("0.8"), x_capital_contribution: money("2000000") },
    numbers: numbers({ issued: "2500000", outstanding: "2500000", fullyDiluted: "2500000", vested: "2500000", vestedOutstanding: "2500000", fullyDilutedPct: ratio(2500000, 24312120) }),
  }),
  ps1: security({
    id: IDS.ps1, displayId: "PS-1", stakeholderId: IDS.tidewater, stakeholderName: "Tidewater Seed Fund I, L.P.", subtype: "PREFERRED",
    stockClassId: IDS.seed, issueDate: "2023-03-31", parentSecurityId: IDS.safe1, terms: { share_price: money("0"), x_origin: "CONVERSION", x_source_security_id: IDS.safe1 },
    numbers: numbers({ issued: "520833", outstanding: "520833", fullyDiluted: "520833", vested: "520833", vestedOutstanding: "520833", fullyDilutedPct: ratio(520833, 24312120) }),
  }),
  opt1: security({
    id: IDS.opt1, displayId: "OPT-1", family: "EQUITY_COMPENSATION", subtype: "OPTION_ISO", stakeholderId: IDS.daniel, stakeholderName: "Daniel Achterberg",
    stockPlanId: IDS.plan, issueDate: "2023-04-14", boardApprovalDate: "2023-04-14",
    terms: {
      exercise_price: money("0.1"), expiration_date: "2033-04-14", early_exercisable: false, vesting_terms_id: IDS.vs1,
      termination_exercise_windows: [{ reason: "VOLUNTARY_OTHER", period: 3, period_type: "MONTHS" }],
      x_acceleration_terms: { kind: "NONE" }, x_issue_reason: "New hire grant",
    },
    numbers: numbers({ issued: "300000", outstanding: "250000", fullyDiluted: "250000", vested: "268750", unvested: "31250", vestedOutstanding: "218750", exercised: "50000", exercisable: "218750", fullyDilutedPct: ratio(250000, 24312120) }),
  }),
  opt18: security({
    id: IDS.opt18, displayId: "OPT-18", family: "EQUITY_COMPENSATION", subtype: "OPTION_ISO", stakeholderId: IDS.mateo, stakeholderName: "Mateo Villalobos",
    stockPlanId: IDS.plan, issueDate: "2024-08-15", terms: { exercise_price: money("0.31"), expiration_date: "2034-08-15", vesting_terms_id: IDS.vs1 },
    numbers: numbers({ issued: "140000", outstanding: "140000", fullyDiluted: "140000", vested: "61250", unvested: "78750", vestedOutstanding: "61250", exercisable: "61250", fullyDilutedPct: ratio(140000, 24312120) }),
  }),
  opt21: security({
    id: IDS.opt21, displayId: "OPT-21", family: "EQUITY_COMPENSATION", subtype: "OPTION_NSO", stakeholderId: IDS.nadia, stakeholderName: "Nadia Pereira-Stone",
    stockPlanId: IDS.plan, issueDate: "2024-12-13", exemption: { federal: "NON_US", country: "CA", state: null },
    deadlines: { contractual: "2026-11-30", iso: null, reason: "3 months after involuntary termination" },
    terms: { exercise_price: money("0.31"), expiration_date: "2034-12-13", vesting_terms_id: IDS.vs1, early_exercisable: true },
    numbers: numbers({ issued: "100000", outstanding: "60000", fullyDiluted: "60000", vested: "60000", unvested: "0", vestedOutstanding: "60000", exercisable: "60000", cancelled: "40000", fullyDilutedPct: ratio(60000, 24312120) }),
  }),
  opt49: security({
    id: IDS.opt49, displayId: "OPT-49", family: "EQUITY_COMPENSATION", subtype: "OPTION_NSO", stakeholderId: IDS.daniel, stakeholderName: "Daniel Achterberg",
    stockPlanId: IDS.plan, issueDate: "2026-09-04", executionStatus: "pending_both", boardApprovalDate: null, boardApprovalNotRecordedInPulley: true,
    terms: { exercise_price: money("0.95"), expiration_date: "2036-09-04", vesting_terms_id: IDS.vs2 },
    numbers: numbers({ issued: "50000", outstanding: "50000", fullyDiluted: "50000", unvested: "50000", fullyDilutedPct: ratio(50000, 24312120) }),
  }),
  safe1: security({
    id: IDS.safe1, displayId: "SAFE-1", family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: IDS.tidewater, stakeholderName: "Tidewater Seed Fund I, L.P.",
    stockClassId: null, issueDate: "2022-04-01", status: "CONVERTED", exemption: { federal: "REG_D_506B", country: null, state: null },
    terms: { investment_amount: money("250000"), convertible_type: "SAFE", x_safe_terms: { form: "Post-money SAFE (valuation cap)", conversion_timing: "POST_MONEY", valuation_cap: money("6000000"), discount_rate: "0.2", mfn: false, pro_rata: true }, x_funds_received_on: "2022-04-04", x_conversion_price: money("0.48") },
    numbers: numbers({ fullyDilutedPct: "0" }),
  }),
  war1: security({
    id: IDS.war1, displayId: "WAR-1", family: "WARRANT", subtype: "WARRANT", stakeholderId: IDS.northgate, stakeholderName: "Northgate Ventures Fund II, L.P.",
    issueDate: "2024-05-01", terms: { exercise_price: money("0.31"), purchase_price: money("0"), warrant_expiration_date: "2031-05-01", x_exercise_provisions: "Cash or net exercise allowed (section 2.3 of the warrant)." },
    numbers: numbers({ issued: "60000", outstanding: "60000", fullyDiluted: "60000", vested: "60000", vestedOutstanding: "60000", exercisable: "60000", fullyDilutedPct: ratio(60000, 24312120) }),
  }),
};

export function securityList(items: readonly api.Security[] = Object.values(SECURITIES)): api.SecurityList {
  return api.securityListSchema.parse({ ...ECHO, items });
}

// ---------------------------------------------------------------------------
// Report-only expiry runs

/**
 * What a report-only run proposes: Nadia's option past its exit window, the Northgate warrant and Daniel's
 * option past their term, and Mateo's option, exercised since, with nothing left to expire (`confirmable: null`).
 */
export const EXPIRY_PROPOSALS: api.ExpiryProposal[] = [
  {
    securityId: IDS.opt21, displayId: "OPT-21", family: "EQUITY_COMPENSATION", holder: { stakeholderId: IDS.nadia, name: "Nadia Pereira-Stone", email: "nadia.ps@mailbox.example" },
    quantity: "30000", reason: "contractual_deadline", lastExerciseDate: "2026-10-19", effectiveDate: "2026-10-20", confirmable: { quantity: "30000", effectiveDate: "2026-10-20" },
  },
  {
    securityId: IDS.war1, displayId: "WAR-1", family: "WARRANT", holder: { stakeholderId: IDS.northgate, name: "Northgate Ventures Fund II, L.P.", email: "ops@northgate.example" },
    quantity: "100000", reason: "expiration", lastExerciseDate: "2026-10-19", effectiveDate: "2026-10-20", confirmable: { quantity: "100000", effectiveDate: "2026-10-20" },
  },
  {
    securityId: IDS.opt1, displayId: "OPT-1", family: "EQUITY_COMPENSATION", holder: { stakeholderId: IDS.daniel, name: "Daniel Achterberg", email: "daniel.achterberg@mailbox.example" },
    quantity: "250000", reason: "expiration", lastExerciseDate: "2026-10-19", effectiveDate: "2026-10-20", confirmable: { quantity: "250000", effectiveDate: "2026-10-20" },
  },
  {
    securityId: IDS.opt18, displayId: "OPT-18", family: "EQUITY_COMPENSATION", holder: { stakeholderId: IDS.mateo, name: "Mateo Villalobos", email: null },
    quantity: "40000", reason: "contractual_deadline", lastExerciseDate: "2026-10-19", effectiveDate: "2026-10-20", confirmable: null,
  },
];

/** A report-only expiry run as `GET …/expiry-runs/:runId` answers it: today's, pending, with the proposals above. */
export function expiryRun(overrides: Partial<api.ExpiryRunDetail> = {}): api.ExpiryRunDetail {
  const proposals = overrides.proposals ?? EXPIRY_PROPOSALS;
  return api.expiryRunDetailSchema.parse({
    runId: 41, localDate: TODAY, startedAt: Date.UTC(2026, 9, 21, 7, 15), state: "pending", proposalCount: proposals.length,
    confirmedAt: null, confirmedBy: null, confirmationStartedAt: null, proposals, ...overrides,
  });
}

/** The run as `GET …/expiry-runs` lists it. */
export function expiryRunSummary(run: api.ExpiryRunDetail): api.ExpiryRunSummary {
  const { runId, localDate, startedAt, state, proposalCount } = run;
  return { runId, localDate, startedAt, state, proposalCount };
}

// ---------------------------------------------------------------------------
// Cap table and dashboard

export function capTable(tab: "ownership" | "shares" | "options" | "safes" | "warrants" = "ownership", overrides: Partial<api.CapTableResponse> = {}): api.CapTableResponse {
  const base = {
    ...ECHO,
    metrics: { issuedAndOutstanding: "19945120", fullyDiluted: "24312120", executionPendingAwards: "50000", planAvailable: "460750", capitalContribution: "16147718.6" },
    classes: [
      { stockClassId: IDS.common, name: "Common Stock", authorized: "30000000", issuedAndOutstanding: "9743000", fullyDiluted: "9743000", availableToIssue: "15824880" },
      { stockClassId: IDS.seed, name: "Series Seed Preferred", authorized: "5200000", issuedAndOutstanding: "5138019", fullyDiluted: "5138019", availableToIssue: "61981" },
    ],
    plans: [{ stockPlanId: IDS.plan, name: "2023 Equity Incentive Plan", poolSize: "4500000", equityOutstanding: "4039250", equityRetired: "0", available: "460750" }],
    availablePool: { fullyDiluted: "460750", fullyDilutedPct: ratio(460750, 24312120) },
    totals: { issuedAndOutstanding: "19945120", fullyDiluted: "24312120" },
    openingBalances: [],
  };
  const tabData =
    tab === "ownership"
      ? {
          ownership: [
            { stakeholderId: IDS.freya, name: "Freya Lindqvist", relationship: "founder", issuerAssignedId: "EMP-001", status: "active", byClass: { [IDS.common]: "4000000" }, issuedAndOutstanding: "4000000", issuedAndOutstandingPct: ratio(4000000, 19945120), planAwards: { [IDS.plan]: "300000" }, awardsOutsidePlans: "0", warrants: "0", fullyDiluted: "4300000", fullyDilutedPct: ratio(4300000, 24312120) },
            { stakeholderId: IDS.northgate, name: "Northgate Ventures Fund II, L.P.", relationship: "investor", issuerAssignedId: null, status: "active", byClass: { [IDS.seed]: "3281250" }, issuedAndOutstanding: "3281250", issuedAndOutstandingPct: ratio(3281250, 19945120), planAwards: {}, awardsOutsidePlans: "0", warrants: "60000", fullyDiluted: "3341250", fullyDilutedPct: ratio(3341250, 24312120) },
            { stakeholderId: IDS.daniel, name: "Daniel Achterberg", relationship: "employee", issuerAssignedId: "EMP-004", status: "active", byClass: { [IDS.common]: "50000" }, issuedAndOutstanding: "50000", issuedAndOutstandingPct: ratio(50000, 19945120), planAwards: { [IDS.plan]: "300000" }, awardsOutsidePlans: "0", warrants: "0", fullyDiluted: "350000", fullyDilutedPct: ratio(350000, 24312120) },
            { stakeholderId: IDS.mateo, name: "Mateo Villalobos", relationship: "employee", issuerAssignedId: null, status: "terminating", byClass: {}, issuedAndOutstanding: "0", issuedAndOutstandingPct: "0", planAwards: { [IDS.plan]: "140000" }, awardsOutsidePlans: "0", warrants: "0", fullyDiluted: "140000", fullyDilutedPct: ratio(140000, 24312120) },
            { stakeholderId: IDS.nadia, name: "Nadia Pereira-Stone", relationship: "ex_employee", issuerAssignedId: null, status: "terminated", byClass: {}, issuedAndOutstanding: "0", issuedAndOutstandingPct: "0", planAwards: { [IDS.plan]: "60000" }, awardsOutsidePlans: "0", warrants: "0", fullyDiluted: "60000", fullyDilutedPct: ratio(60000, 24312120) },
          ],
        }
      : tab === "safes"
        ? {
            safes: [{
              securityId: IDS.safe1, displayId: "SAFE-1", stakeholderId: IDS.tidewater, principal: "250000", issueDate: "2022-04-01", valuationCap: "6000000",
              conversionTiming: "POST_MONEY", discountRate: "0.2", status: "CONVERTED", convertedInto: [{ securityId: IDS.ps1, displayId: "PS-1" }],
            }],
          }
        : {
            rows: Object.values(SECURITIES).filter((item) => item.family === { shares: "STOCK", options: "EQUITY_COMPENSATION", warrants: "WARRANT" }[tab]),
          };
  return api.capTableResponseSchema.parse({ ...base, ...tabData, ...overrides });
}

export function dashboard(overrides: Partial<api.DashboardResponse> = {}): api.DashboardResponse {
  return api.dashboardResponseSchema.parse({
    asOf: TODAY,
    company: { totalCapitalContribution: "16147718.6", fullyDilutedShares: "24312120", stakeholdersWithSecurities: 38 },
    employeeEquity: [{ stockPlanId: IDS.plan, name: "2023 Equity Incentive Plan", granted: "4039250", available: "460750", usedPct: ratio(4039250, 4500000) }],
    ownershipByRelationship: [
      { relationship: "founder", fullyDiluted: "10200000", pct: ratio(10200000, 24312120) },
      { relationship: "investor", fullyDiluted: "10252120", pct: ratio(10252120, 24312120) },
      { relationship: "employee", fullyDiluted: "2895000", pct: ratio(2895000, 24312120) },
      { relationship: "ex_employee", fullyDiluted: "274250", pct: ratio(274250, 24312120) },
      { relationship: "advisor", fullyDiluted: "170000", pct: ratio(170000, 24312120) },
      { relationship: "other", fullyDiluted: "60000", pct: ratio(60000, 24312120) },
      { relationship: "available", fullyDiluted: "460750", pct: ratio(460750, 24312120) },
    ],
    topStakeholders: [
      { stakeholderId: IDS.freya, name: "Freya Lindqvist", fullyDiluted: "4300000", pct: ratio(4300000, 24312120) },
      { stakeholderId: IDS.northgate, name: "Northgate Ventures Fund II, L.P.", fullyDiluted: "3858173", pct: ratio(3858173, 24312120) },
    ],
    needsAttention: [
      { kind: "EXECUTION_PENDING", count: 6, dueDate: null, href: "/securities-status#exec" },
      { kind: "SCHEDULED_TERMINATION", count: 1, dueDate: "2026-12-04", href: "/securities-status#sched" },
      { kind: "ISO_DEADLINE_SOON", count: 0, dueDate: null, href: "/securities-status#term" },
      { kind: "REPURCHASE_WINDOW_CLOSING", count: 1, dueDate: "2026-12-14", href: "/securities-status#rep" },
      { kind: "VALUATION_STATUS", count: 1, dueDate: "2026-11-05", href: "/compliance/409a" },
    ],
    inProgress: { executionPending: 6, unvestedSharesFromTerminated: 1, optionsFromTerminated: 2, scheduledTerminations: 1 },
    recentActivity: [
      { id: 301, occurredAt: AT - 3_600_000, description: "OPT-56 recorded — 40,000 options for Omar Haddad-Lewis", actor: "Morgan Ellis" },
      { id: 300, occurredAt: Date.UTC(2026, 9, 18, 17), description: "Payment instructions updated", actor: "Rachel Ostrowski" },
    ],
    ...overrides,
  });
}

export function securitiesStatus(overrides: Partial<api.SecuritiesStatus> = {}): api.SecuritiesStatus {
  return api.securitiesStatusSchema.parse({
    executionPending: [{ securityId: IDS.opt49, displayId: "OPT-49", stakeholderId: IDS.daniel, issueDate: "2026-09-04", missing: "both", signatureRequestIds: [uuid(14, 1)] }],
    scheduledTerminations: [{ id: uuid(12, 1), stakeholderId: IDS.mateo, terminationDate: "2026-12-04", type: "voluntary", securitiesAffected: 1, unvestedToCancel: "89375", version: 1 }],
    unvestedSharesFromTerminated: [{ securityId: IDS.cs4, stakeholderId: IDS.desmond, unvested: "34500", repurchasePrice: "0.31", lastRepurchaseDate: "2026-12-14", status: "open" }],
    optionsFromTerminated: [{ securityId: IDS.opt21, stakeholderId: IDS.nadia, vestedUnexercised: "60000", contractualDeadline: "2026-11-30", contractualDaysLeft: 40, isoDeadline: null, isoDaysLeft: null }],
    expiringWithin90Days: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Reference data

export function stockClass(overrides: Partial<api.StockClassDetail> = {}): api.StockClassDetail {
  return api.stockClassDetailSchema.parse({
    ...ECHO, id: IDS.common, name: "Common Stock", classType: "COMMON", defaultIdPrefix: "CS", parValue: "0.00001", originalIssuePrice: null, currency: "USD",
    isCertificated: true, boardApprovalDate: "2021-02-15", stockholderApprovalDate: "2021-02-15", authorizedShares: "30000000",
    conversionRatio: { numerator: "1", denominator: "1" },
    terms: { votesPerShare: "1", excludeFromFullyDiluted: false, seniority: null, liquidationPreferenceMultiple: null, participation: null, participationCapMultiple: null, dividendTerms: null, antiDilution: null, notRecordedInPulley: [] },
    numbers: { issuedAndOutstanding: "9743000", reserved: "10302880", availableToIssue: "9954120", fullyDiluted: "9743000" },
    history: [{ effectiveDate: "2025-09-26", transactionId: uuid(15, 1), type: "TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", summary: "Authorized 20,000,000 → 30,000,000 (restated charter)" }],
    version: 1,
    ...overrides,
  });
}

export const SEED_CLASS = stockClass({
  id: IDS.seed, name: "Series Seed Preferred", classType: "PREFERRED", defaultIdPrefix: "PS", originalIssuePrice: "0.8", isCertificated: false,
  authorizedShares: "5200000", terms: { votesPerShare: "1", excludeFromFullyDiluted: false, seniority: 2, liquidationPreferenceMultiple: "1", participation: "NON_PARTICIPATING", participationCapMultiple: null, dividendTerms: null, antiDilution: "BROAD_BASED_WEIGHTED_AVERAGE", notRecordedInPulley: [] },
  numbers: { issuedAndOutstanding: "5138019", reserved: "0", availableToIssue: "61981", fullyDiluted: "5138019" }, history: [],
});

export function stockPlan(overrides: Partial<api.StockPlanDetail> = {}): api.StockPlanDetail {
  return api.stockPlanDetailSchema.parse({
    ...ECHO, id: IDS.plan, name: "2023 Equity Incentive Plan", stockClassId: IDS.common, boardApprovalDate: "2023-01-20", stockholderApprovalDate: "2023-01-25",
    effectiveDate: "2023-01-20", expirationDate: "2033-01-20", poolSize: "4500000", equityOutstanding: "4039250", equityRetired: "0", availableToGrant: "460750",
    returnRules: { cancelledUnvestedAwards: "RETURN", expiredVestedOptions: "RETURN", repurchasedUnvestedShares: "RETURN", repurchasedVestedShares: "RETIRE", sharesWithheldForTax: "RETIRE" },
    returnRulesConfirmation: { transactionId: uuid(15, 2), effectiveDate: "2026-09-30", confirmedBy: "Freya Lindqvist", confirmedAt: Date.UTC(2026, 8, 30, 18), documentId: null },
    defaultTerminationWindows: [
      { reason: "VOLUNTARY", period: "3", unit: "MONTHS" }, { reason: "INVOLUNTARY", period: "3", unit: "MONTHS" }, { reason: "WITH_CAUSE", period: "0", unit: "DAYS" },
      { reason: "DEATH", period: "12", unit: "MONTHS" }, { reason: "DISABILITY", period: "12", unit: "MONTHS" }, { reason: "RETIREMENT", period: "3", unit: "MONTHS" },
    ],
    defaultRepurchaseWindow: { period: "90", unit: "DAYS" }, status: "active", pourOverPlanId: null,
    amendments: [
      { effectiveDate: "2024-06-12", transactionId: uuid(15, 3), type: "TX_STOCK_PLAN_POOL_ADJUSTMENT", poolSize: "3000000" },
      { effectiveDate: "2025-10-15", transactionId: uuid(15, 4), type: "TX_STOCK_PLAN_POOL_ADJUSTMENT", poolSize: "4500000" },
    ],
    version: 1,
    ...overrides,
  });
}

export function vestingTerms(overrides: Partial<api.VestingTerms> = {}): api.VestingTerms {
  return api.vestingTermsSchema.parse({
    id: IDS.vs1, name: "4 years monthly, 1-year cliff (25%)", description: null, isTemplate: true, templateId: null,
    definition: { type: "SCHEDULE", totalMonths: 48, frequency: "MONTHLY", cliff: { months: 12, quantityRule: "RATABLE" }, dayRule: "SAME_DAY_CLAMPED" },
    definitionSha256: HASH, algorithmVersion: 1, grantsUsing: 48, confirmedBy: "Freya Lindqvist", confirmedAt: Date.UTC(2026, 8, 30), importedFromPulley: true, createdAt: Date.UTC(2026, 8, 1),
    ...overrides,
  });
}

export const VESTING_TERMS = [
  vestingTerms(),
  vestingTerms({ id: IDS.vs2, name: "4 years monthly, no cliff", definition: { type: "SCHEDULE", totalMonths: 48, frequency: "MONTHLY", cliff: null, dayRule: "SAME_DAY_CLAMPED" }, grantsUsing: 4, confirmedBy: null, confirmedAt: null }),
];

export function valuation(overrides: Partial<api.Valuation> = {}): api.Valuation {
  return api.valuationSchema.parse({
    id: IDS.v5, name: "Nov 2025 Valuation", valuationType: "409A", provider: "Carver Valuation Advisors", effectiveDate: "2025-11-05", expirationDate: "2026-11-05",
    boardApprovalDate: "2025-11-20", reportVersion: "FINAL", prices: [{ stockClassId: IDS.common, pricePerShare: "0.95" }], status: "expiring_soon", statusAsOf: TODAY,
    presumptivelyValidUntil: "2026-11-05", events: [], reportDocumentId: IDS.doc1, importedFromPulley: true,
    ...overrides,
  });
}

export const VALUATIONS = [
  valuation(),
  valuation({ id: IDS.v4, name: "Mar 2025 Valuation", effectiveDate: "2025-03-15", expirationDate: "2026-03-15", prices: [{ stockClassId: IDS.common, pricePerShare: "0.44" }], status: "superseded", presumptivelyValidUntil: null, reportDocumentId: null }),
];

export function auditEvent(id: number, overrides: Partial<api.AuditEvent> = {}): api.AuditEvent {
  return api.auditEventSchema.parse({
    id, occurredAt: AT - id * 60_000, orgId: ORG_ID, actor: { kind: "user", userId: USER_ID, email: "morgan@acmerobotics.example", authMethod: null },
    action: "command.grant-equity-compensation", targetType: "security", targetId: IDS.opt49, result: "success", reason: null, ip: null, userAgent: null,
    details: { summary: "OPT-49 recorded", changes: [{ field: "Status", old: "—", new: "Outstanding" }] },
    ...overrides,
  });
}

export function document(overrides: Partial<api.Document> = {}): api.Document {
  return api.documentSchema.parse({
    id: IDS.doc1, filename: "Nov 2025 Valuation.pdf", contentType: "application/pdf", byteSize: 245_000, sha256: HASH, kind: "VALUATION_REPORT", source: "pulley",
    holderVisible: false, visibilityScope: "admins", collectionId: null, versionLabel: null, supersedesDocumentId: null, description: null,
    sourceCreatedAt: null, uploadedBy: null, createdAt: Date.UTC(2026, 9, 1),
    archivedAt: null, links: [], importedFromPulley: true, version: 1,
    ...overrides,
  });
}

export const EMPTY_PAGE = { items: [], nextCursor: null };
