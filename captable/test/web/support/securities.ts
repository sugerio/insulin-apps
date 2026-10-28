import { api } from "#shared";
import { IDS, SECURITIES, STAKEHOLDERS, SEED_CLASS, document, stockClass, stockPlan, TODAY, uuid, VESTING_TERMS } from "./acme.ts";
import { apiError, mock, type MockRequest } from "./mockApi.ts";

// The security pages' API, answered from the synthetic Acme fixtures (shared by the security and dependency tests).

export const ECHO = { asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0" };

export function detailOf(security: api.Security, extra: Partial<api.SecurityDetail> = {}): api.SecurityDetail {
  return api.securityDetailSchema.parse({ ...security, ...ECHO, lineage: { parent: null, children: [] }, legends: [], documents: [], ...extra });
}

export const DETAILS: Record<string, api.SecurityDetail> = {
  [IDS.opt1]: detailOf(SECURITIES.opt1, {
    lineage: { parent: null, children: [{ id: IDS.cs7, displayId: "CS-7", transactionType: "TX_EQUITY_COMPENSATION_EXERCISE" }] },
    documents: [{ id: IDS.doc2, filename: "OPT-1 Option Agreement.pdf", kind: "GRANT_AGREEMENT" }, { id: uuid(10, 3), filename: "Board consent 2023-04-14.pdf", kind: "BOARD_CONSENT" }],
  }),
  [IDS.opt49]: detailOf(SECURITIES.opt49),
  [IDS.opt21]: detailOf(SECURITIES.opt21),
  [IDS.cs1]: detailOf(SECURITIES.cs1, { legends: [{ id: uuid(18, 1), name: "L1 · Securities Act legend" }, { id: uuid(18, 2), name: "L2 · Transfer restrictions" }] }),
  [IDS.cs7]: detailOf(SECURITIES.cs7, { lineage: { parent: { id: IDS.opt1, displayId: "OPT-1" }, children: [] } }),
  [IDS.war1]: detailOf(SECURITIES.war1),
  [IDS.safe1]: detailOf(SECURITIES.safe1, { lineage: { parent: null, children: [{ id: IDS.ps1, displayId: "PS-1", transactionType: "TX_CONVERTIBLE_CONVERSION" }] } }),
  [IDS.ps1]: detailOf(SECURITIES.ps1, { lineage: { parent: { id: IDS.safe1, displayId: "SAFE-1" }, children: [] } }),
};

function vestingEvents(): api.VestingEvent[] {
  const events: api.VestingEvent[] = [{ date: "2024-03-01", quantity: "75000", cumulative: "75000", state: "ACTIVE", kind: "CLIFF", source: "pulley" }];
  for (let month = 1; month <= 36; month += 1) {
    const date = new Date(Date.UTC(2024, 2 + month, 1)).toISOString().slice(0, 10);
    events.push({ date, quantity: "6250", cumulative: String(75000 + 6250 * month), state: "ACTIVE", kind: "SCHEDULED", source: "pulley" });
  }
  return events;
}

export const STAKEHOLDER_DETAILS: Record<string, api.StakeholderDetail> = Object.fromEntries(
  [...Object.values(STAKEHOLDERS), { ...STAKEHOLDERS.northgate, id: IDS.tidewater, displayName: "Tidewater Seed Fund I, L.P." }].map((stakeholder) => [stakeholder.id, api.stakeholderDetailSchema.parse({
    ...stakeholder, ...ECHO,
    exercises: stakeholder.id === IDS.daniel ? [{
      transactionId: uuid(17, 1), commandId: uuid(9, 7), exerciseDate: "2026-03-20", stakeholderId: IDS.daniel, stakeholderName: "Daniel Achterberg",
      securityId: IDS.opt1, grantDisplayId: "OPT-1", quantity: "50000", isoQuantity: "50000", nsoQuantity: "0", exercisePrice: "0.1", cost: "5000",
      paymentMethod: "CHECK", paymentReference: "1042", fmvPerShare: "0.44", taxTreatment: null, withholding: null,
      resultingShares: [{ securityId: IDS.cs7, displayId: "CS-7", portion: "ISO" }], source: { kind: "recorded", requestNumber: null }, reversed: false,
    }] : [],
  })]),
);

export const securityHandlers = [
  mock(api.routes.getSecurity, (request: MockRequest) => DETAILS[request.params.id!] ?? apiError(404, "not_found", "Not found")),
  mock(api.routes.getSecurityVesting, (request: MockRequest) => {
    const security = DETAILS[request.params.id!]!;
    const vested = security.numbers?.vested ?? "0";
    return { ...ECHO, securityId: security.id, quantity: security.numbers?.issued ?? "0", vested, unvested: security.numbers?.unvested ?? "0", vestingStartDate: security.id === IDS.cs1 ? "2021-02-15" : "2023-03-01", vestingStopDate: security.id === IDS.opt21 ? "2026-08-31" : null, events: security.id === IDS.opt1 ? vestingEvents() : [] };
  }),
  mock(api.routes.getSecurityTimeline, (request: MockRequest) => ({
    items: [
      { kind: "transaction", at: Date.UTC(2026, 9, 1), effectiveDate: "2023-04-14", transactionId: uuid(19, 1), commandId: uuid(9, 8), type: "TX_EQUITY_COMPENSATION_ISSUANCE", summary: "Issued — 300,000", actor: "Imported from Pulley", note: null, securityId: request.params.id! },
      { kind: "transaction", at: Date.UTC(2026, 2, 20), effectiveDate: "2026-03-20", transactionId: uuid(19, 2), commandId: uuid(9, 7), type: "TX_EQUITY_COMPENSATION_EXERCISE", summary: "Exercised 50,000 ISO → CS-7 · Check", actor: "Morgan Ellis", note: null, securityId: request.params.id! },
      ...(request.params.id === IDS.safe1 ? [{ kind: "transaction", at: Date.UTC(2026, 9, 1), effectiveDate: "2023-03-31", transactionId: uuid(19, 3), commandId: uuid(9, 9), type: "TX_CONVERTIBLE_CONVERSION", summary: "Converted into PS-1", actor: "Imported from Pulley", note: null, securityId: IDS.safe1 }] : []),
    ],
  })),
  mock(api.routes.getStakeholder, (request: MockRequest) => STAKEHOLDER_DETAILS[request.params.id!] ?? apiError(404, "not_found", "Not found")),
  mock(api.routes.getVestingTerms, (request: MockRequest) => VESTING_TERMS.find((terms) => terms.id === request.params.id) ?? apiError(404, "not_found", "Not found")),
  mock(api.routes.getStockPlan, stockPlan()),
  mock(api.routes.getStockClass, (request: MockRequest) => (request.params.id === IDS.seed ? SEED_CLASS : stockClass())),
  mock(api.routes.getFmv, { date: TODAY, stockClassId: IDS.common, fmv: { valuationId: IDS.v5, valuationName: "Nov 2025 Valuation", pricePerShare: "0.95", splitAdjusted: false, status: "expiring_soon" } }),
  mock(api.routes.getIsoSplit, {
    stakeholderId: IDS.daniel,
    years: [
      { year: 2024, isoValueUsed: "13125", lots: [{ securityId: IDS.opt1, displayId: "OPT-1", fmvAtGrant: "0.1", isoQuantity: "131250", nsoQuantity: "0", exercisedIso: "50000", exercisedNso: "0" }] },
      { year: 2025, isoValueUsed: "7500", lots: [{ securityId: IDS.opt1, displayId: "OPT-1", fmvAtGrant: "0.1", isoQuantity: "75000", nsoQuantity: "0", exercisedIso: "0", exercisedNso: "0" }] },
      { year: 2026, isoValueUsed: "7500", lots: [{ securityId: IDS.opt1, displayId: "OPT-1", fmvAtGrant: "0.1", isoQuantity: "75000", nsoQuantity: "0", exercisedIso: "0", exercisedNso: "0" }] },
      { year: 2027, isoValueUsed: "1875", lots: [{ securityId: IDS.opt1, displayId: "OPT-1", fmvAtGrant: "0.1", isoQuantity: "18750", nsoQuantity: "0", exercisedIso: "0", exercisedNso: "0" }] },
    ],
  }),
  mock(api.routes.listElections83b, { items: [{ id: uuid(20, 1), securityId: IDS.cs1, status: "FILED", transferDate: "2021-02-15", dueDate: "2021-03-17", filedDate: "2021-03-01", proofDocumentId: uuid(10, 9), supersedesId: null, importedFromPulley: true, createdAt: 1 }] }),
  mock(api.routes.listDocuments, { items: [document({ id: uuid(10, 4), filename: "SAFE-1 Agreement.pdf", kind: "SAFE_AGREEMENT" })], nextCursor: null }),
];
