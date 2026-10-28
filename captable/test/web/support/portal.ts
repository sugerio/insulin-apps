import { api } from "#shared";
import { COMPANY, IDS, ORG_ID, TODAY, USER_ID, uuid } from "./acme.ts";

// Synthetic holder-portal payloads for "Acme Robotics, Inc." (personas: Nadia, a former employee with an open exit
// window; Marcus, an investor holding vested Series Seed shares and converted SAFEs; Daniel, a current employee).
// Every builder parses its result with the strict portal schema.

type Me = api.MeResponse;
type ConsoleRole = Me["consoleRole"];
type MeAccess = Me["access"];

const AT = Date.UTC(2026, 9, 21, 16, 40);
export const OTHER_ORG_ID = uuid(1, 2);

export function portalDocument(overrides: Partial<api.PortalDocument> & { id: string; filename: string }): api.PortalDocument {
  return api.portalDocumentSchema.parse({ kind: "GRANT_AGREEMENT", createdAt: Date.UTC(2026, 9, 1), scope: "mine", ...overrides });
}

const numbers = (overrides: Partial<api.PortalSecurityNumbers> = {}): api.PortalSecurityNumbers => ({
  asOf: TODAY, granted: null, outstanding: null, vested: null, unvested: null, exercised: null, exercisable: null, cancelled: null, ...overrides,
});

export function portalSecurity(overrides: Partial<api.PortalSecurity> & { id: string; displayId: string }): api.PortalSecurity {
  return api.portalSecuritySchema.parse({
    orgId: ORG_ID, family: "STOCK", optionType: null, className: "Common Stock", planName: null, issueDate: "2023-03-31", status: "OUTSTANDING",
    executionPending: false, exercisePrice: null, expirationDate: null, contractualDeadline: null, isoDeadline: null, numbers: numbers(), vesting: [], documents: [],
    ...overrides,
  });
}

/** The plan defaults of the synthetic 2023 plan: 3 months, 0 days with cause, 12 months for death and disability. */
export const PLAN_WINDOWS: api.PortalOptionDetail["postTerminationPeriods"] = [
  { reason: "VOLUNTARY", period: "3", unit: "MONTHS" },
  { reason: "INVOLUNTARY", period: "3", unit: "MONTHS" },
  { reason: "WITH_CAUSE", period: "0", unit: "DAYS" },
  { reason: "DEATH", period: "12", unit: "MONTHS" },
  { reason: "DISABILITY", period: "12", unit: "MONTHS" },
  { reason: "RETIREMENT", period: "3", unit: "MONTHS" },
];

type DetailOverrides = Partial<api.PortalOptionDetail> | Partial<api.PortalShareDetail> | Partial<api.PortalSafeDetail>;

/** A security's holding detail (`getPortalSecurity`): the family's defaults, then the given facts. */
export function securityDetail(security: api.PortalSecurity, overrides: DetailOverrides = {}): api.PortalSecurityDetail {
  const defaults = {
    EQUITY_COMPENSATION: { family: "EQUITY_COMPENSATION", earlyExerciseAllowed: false, isoSplit: [], postTerminationPeriods: PLAN_WINDOWS, exercises: [] },
    STOCK: { family: "STOCK", pricePerShare: null, form: "book_entry", legends: [], election83b: null, repurchase: null, origin: null },
    WARRANT: { family: "WARRANT" },
    CONVERTIBLE: { family: "CONVERTIBLE", principal: "50000", terms: { form: null, valuationCap: null, discountRate: null }, conversion: null },
  }[security.family];
  return api.portalSecurityDetailSchema.parse({ ...security, detail: { ...defaults, ...overrides } });
}

/** Monthly tranches of `quantity` from `first`, vested up to TODAY, stopped after `stop` (a termination). */
function monthly(first: string, count: number, quantity: number, stop?: string): api.PortalVestingEvent[] {
  const [y, m, d] = first.split("-").map(Number) as [number, number, number];
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(y, m - 1 + index, d)).toISOString().slice(0, 10);
    const status = stop && date > stop ? "STOPPED" : date <= TODAY ? "VESTED" : "UPCOMING";
    return { date, quantity: String(quantity), cumulative: String(quantity * (index + 1)), status } as const;
  });
}

export const NADIA_OPTION = portalSecurity({
  id: uuid(6, 120), displayId: "OPT-20", family: "EQUITY_COMPENSATION", optionType: "ISO", className: "Common Stock", planName: "2023 Equity Incentive Plan",
  issueDate: "2024-08-15", exercisePrice: "0.31", expirationDate: "2034-08-15", contractualDeadline: "2027-02-28", isoDeadline: "2026-11-30",
  numbers: numbers({ granted: "120000", outstanding: "60000", vested: "60000", unvested: "0", exercised: "0", exercisable: "60000", cancelled: "60000" }),
  // 4 years monthly from Aug 1, 2024 with a 1-year cliff; vesting stopped on the Aug 31, 2026 termination.
  vesting: [{ date: "2025-08-01", quantity: "30000", cumulative: "30000", status: "VESTED" }, ...monthly("2025-09-01", 36, 2500, "2026-08-31").map((event, index) => ({ ...event, cumulative: String(30000 + 2500 * (index + 1)) }))],
  documents: [
    portalDocument({ id: uuid(10, 120), filename: "OPT-20 Option Agreement.pdf" }),
    portalDocument({ id: uuid(10, 121), filename: "Separation agreement.pdf", kind: "SEPARATION_AGREEMENT" }),
  ],
});

export const NADIA: api.PortalHolding = { orgId: ORG_ID, orgDisplayName: "Acme Robotics", stakeholderId: IDS.nadia, stakeholderName: "Nadia Pereira-Stone", securities: [NADIA_OPTION] };

export const MARCUS_SHARES = [
  portalSecurity({ id: uuid(6, 23), displayId: "PS-3", className: "Series Seed Preferred", numbers: numbers({ granted: "52083", outstanding: "52083", vested: "52083" }) }),
  portalSecurity({ id: uuid(6, 25), displayId: "PS-5", className: "Series Seed Preferred", numbers: numbers({ granted: "39062", outstanding: "39062", vested: "39062" }) }),
];
export const MARCUS_SAFES = [
  portalSecurity({ id: uuid(6, 203), displayId: "SAFE-3", family: "CONVERTIBLE", className: null, issueDate: "2021-06-01", status: "CONVERTED", convertedInto: [{ displayId: "PS-3" }], documents: [portalDocument({ id: uuid(10, 203), filename: "SAFE-3 - Marcus Oyelaran.pdf", kind: "SAFE_AGREEMENT" })] }),
  portalSecurity({ id: uuid(6, 205), displayId: "SAFE-5", family: "CONVERTIBLE", className: null, issueDate: "2022-04-20", status: "CONVERTED", convertedInto: [{ displayId: "PS-5" }] }),
];
export const MARCUS: api.PortalHolding = { orgId: ORG_ID, orgDisplayName: "Acme Robotics", stakeholderId: IDS.marcus, stakeholderName: "Marcus Oyelaran", securities: [...MARCUS_SHARES, ...MARCUS_SAFES] };

export const DANIEL_OPTION = portalSecurity({
  id: IDS.opt1, displayId: "OPT-1", family: "EQUITY_COMPENSATION", optionType: "ISO", planName: "2023 Equity Incentive Plan", issueDate: "2023-04-14",
  exercisePrice: "0.1", expirationDate: "2033-04-14",
  numbers: numbers({ granted: "300000", outstanding: "250000", vested: "268750", unvested: "31250", exercised: "50000", exercisable: "218750", cancelled: "0" }),
  vesting: [{ date: "2024-03-01", quantity: "75000", cumulative: "75000", status: "VESTED" }, ...monthly("2024-04-01", 36, 6250).map((event, index) => ({ ...event, cumulative: String(75000 + 6250 * (index + 1)) }))],
});
export const DANIEL_SHARES = portalSecurity({ id: IDS.cs7, displayId: "CS-7", issueDate: "2026-03-20", numbers: numbers({ granted: "50000", outstanding: "50000", vested: "50000" }) });
export const DANIEL_WARRANT = portalSecurity({
  id: IDS.war1, displayId: "WAR-1", family: "WARRANT", className: "Series Seed Preferred", issueDate: "2024-05-01", exercisePrice: "0.31", expirationDate: "2031-05-01",
  numbers: numbers({ granted: "60000", outstanding: "60000", vested: "60000", exercisable: "60000" }),
});
export const DANIEL: api.PortalHolding = { orgId: ORG_ID, orgDisplayName: "Acme Robotics", stakeholderId: IDS.daniel, stakeholderName: "Daniel Achterberg", securities: [DANIEL_SHARES, DANIEL_OPTION] };

/** The holding details the personas' pages show. */
export const DETAILS: ReadonlyMap<string, api.PortalSecurityDetail> = new Map([
  securityDetail(NADIA_OPTION, {
    isoSplit: [
      { year: 2025, firstExercisable: "40000", valueAtGrant: "12400", iso: "40000", nso: "0" },
      { year: 2026, firstExercisable: "20000", valueAtGrant: "6200", iso: "20000", nso: "0" },
    ],
  }),
  securityDetail(DANIEL_OPTION, {
    isoSplit: [{ year: 2024, firstExercisable: "143750", valueAtGrant: "14375", iso: "143750", nso: "0" }],
    exercises: [{ date: "2026-03-20", quantity: "50000", iso: "50000", nso: "0", resultingShares: [{ displayId: "CS-7" }] }],
  }),
  securityDetail(DANIEL_SHARES, { pricePerShare: "0.1", legends: ["Rule 144 legend", "ISO disqualifying disposition legend"], origin: { kind: "exercise", from: "OPT-1" } }),
  securityDetail(DANIEL_WARRANT),
  securityDetail(MARCUS_SHARES[0]!, { pricePerShare: "1.92", form: "uncertificated", origin: { kind: "conversion", from: "SAFE-3" } }),
  securityDetail(MARCUS_SHARES[1]!, { pricePerShare: "1.92", form: "uncertificated", origin: { kind: "conversion", from: "SAFE-5" } }),
  securityDetail(MARCUS_SAFES[0]!, {
    principal: "100000",
    terms: { form: "Post-money valuation cap", valuationCap: "8000000", discountRate: "0.2" },
    conversion: { date: "2023-03-01", quantity: "52083", className: "Series Seed Preferred" },
  }),
  securityDetail(MARCUS_SAFES[1]!, {
    principal: "75000",
    terms: { form: "Post-money valuation cap", valuationCap: "8000000", discountRate: null },
    conversion: { date: "2023-03-01", quantity: "39062", className: "Series Seed Preferred" },
  }),
].map((detail) => [detail.id, detail]));

/** The detail the portal answers for a security: its persona's facts (by id) on the security as given, else the defaults. */
export function detailOf(security: api.PortalSecurity): api.PortalSecurityDetail {
  const known = DETAILS.get(security.id)?.detail;
  return securityDetail(security, known && known.family === security.family ? (known as DetailOverrides) : {});
}

export function overview(holdings: readonly api.PortalHolding[], asOf = TODAY): api.PortalOverview {
  return api.portalOverviewSchema.parse({ asOf, holdings });
}

export const NOTICE_FORM = portalDocument({ id: uuid(10, 300), filename: "Notice of exercise (counsel form).docx", kind: "NOTICE_OF_EXERCISE", scope: "company" });
/** Counsel's privacy notice, the company resource the org designates for the portal footer (settings.portal). */
export const PRIVACY_NOTICE = portalDocument({ id: uuid(10, 302), filename: "Acme Robotics Privacy Notice.pdf", kind: "OTHER", scope: "company", createdAt: Date.UTC(2026, 8, 15) });

export function howToExercise(overrides: Partial<api.HowToExercise> = {}): api.HowToExercise {
  return api.howToExerciseSchema.parse({
    text: "",
    noticeForm: NOTICE_FORM,
    privacyNotice: PRIVACY_NOTICE,
    paymentInstructions: {
      bankName: "First Example Bank", beneficiaryName: "Acme Robotics, Inc.", beneficiaryAddress: "400 Harbor Way, Suite 12, Oakland, CA 94607",
      accountNumber: "000123454321", routingNumber: "000000000", swift: "EXMPUS00", intermediaryBank: "Example Correspondent Bank, SWIFT EXCOUS00",
      checkPayee: "Acme Robotics, Inc.", checkMailingAddress: "400 Harbor Way, Suite 12, Oakland, CA 94607", referenceFormat: "EX-<grant>-<initials>",
    },
    companyContact: { name: "Equity team", email: "equity@acmerobotics.example" },
    ...overrides,
  });
}

export const COMPANY_RESOURCES = [
  NOTICE_FORM,
  portalDocument({ id: uuid(10, 301), filename: "2023 Equity Incentive Plan.pdf", kind: "PLAN_DOCUMENT", scope: "company", createdAt: Date.UTC(2026, 8, 30) }),
  PRIVACY_NOTICE,
];

/**
 * `/api/me` for a console user whose e-mail matches the given holdings' stakeholders: holder access (a USER) unless
 * `access` says they also administer the company.
 */
export function holderMe(matches: readonly api.PortalHolding[], options: { email?: string; name?: string | null; access?: MeAccess; consoleRole?: ConsoleRole; pii?: boolean } = {}): Me {
  const access = options.access ?? (matches.length ? "holder" : "none");
  return api.meResponseSchema.parse({
    user: { id: USER_ID, email: options.email ?? "nadia.ps@mailbox.example", displayName: options.name === undefined ? matches[0]?.stakeholderName ?? null : options.name },
    consoleRole: options.consoleRole ?? (access === "admin_rw" ? "ADMIN" : access === "admin_ro" ? "EDITOR" : "USER"),
    preview: false,
    company: COMPANY,
    access,
    pii: options.pii ?? (access === "admin_rw" || access === "admin_ro"),
    portal: { matches: matches.map((holding) => ({ orgId: holding.orgId, stakeholderId: holding.stakeholderId, stakeholderName: holding.stakeholderName })) },
    serverTime: AT,
  });
}
