import { api } from "#shared";
import {
  IDS, SEED_CLASS, VALUATIONS, VESTING_TERMS, auditEvent, capTable, dashboard, document, me, org, securitiesStatus, securityList, stakeholderList,
  expiryRun, expiryRunSummary, stockClass, stockPlan, TODAY, uuid, valuation,
} from "./acme.ts";
import { apiError, mock, type MockHandler, type MockRequest } from "./mockApi.ts";
import { COMPANY_RESOURCES, NADIA, NADIA_OPTION, detailOf, howToExercise, overview } from "./portal.ts";
import { ECHO, STAKEHOLDER_DETAILS, securityHandlers } from "./securities.ts";

// Every admin read route answered from the synthetic Acme fixtures, so a test can render any page completely and then
// hold back or fail one route at a time (the page walk). Bodies are parsed with the contract by the mock.

export const REQUEST_ID = uuid(22, 2);

const exercise = (overrides: Partial<api.ExerciseRecord> = {}): api.ExerciseRecord => api.exerciseRecordSchema.parse({
  transactionId: uuid(17, 1), commandId: uuid(9, 7), exerciseDate: "2026-03-20", stakeholderId: IDS.daniel, stakeholderName: "Daniel Achterberg",
  securityId: IDS.opt1, grantDisplayId: "OPT-1", quantity: "50000", isoQuantity: "50000", nsoQuantity: "0", exercisePrice: "0.1", cost: "5000",
  paymentMethod: "CHECK", paymentReference: "1042", fmvPerShare: "0.44", taxTreatment: null, withholding: null,
  resultingShares: [{ securityId: IDS.cs7, displayId: "CS-7", portion: "ISO" }], source: { kind: "recorded", requestNumber: null }, reversed: false,
  ...overrides,
});

const request = api.exerciseRequestSchema.parse({
  id: REQUEST_ID, requestNumber: 2, securityId: IDS.opt21, stakeholderId: IDS.nadia, quantity: "19000", isoQuantity: "0", nsoQuantity: "19000",
  exercisePrice: "0.31", fmvPerShare: "0.95", valuationId: IDS.v5, estimatedWithholding: "4699.84", totalCost: "10589.84", currency: "USD", paymentMethod: "ACH",
  status: "EXERCISED", pulleyStatus: "EXERCISED", paymentDueDate: "2026-08-10", paymentReceivedOn: "2026-08-11", exerciseDate: "2026-08-12",
  completedCommandId: uuid(9, 20), decidedAt: Date.UTC(2026, 7, 3, 17), cancelledAt: null,
  documents: [{ id: uuid(10, 20), filename: "ER-2 Notice of exercise.pdf", kind: "NOTICE_OF_EXERCISE" }], importedFromPulley: true, createdAt: Date.UTC(2026, 7, 1, 17),
});

const certificates = [
  { id: uuid(13, 1), securityId: IDS.cs1, certificateNumber: "CS-1", status: "ISSUED", issuedDate: "2021-02-15", cancelledDate: null, cancelReason: null, documentId: IDS.doc2, signatories: [], legends: [], renderingNote: null, importedFromPulley: true },
];

const valuationDetail = api.valuationDetailSchema.parse({
  ...valuation({ prices: [{ stockClassId: IDS.seed, pricePerShare: "1.6" }, { stockClassId: IDS.common, pricePerShare: "0.95" }] }),
  documents: [{ id: IDS.doc1, filename: "Nov 2025 Valuation.pdf", kind: "VALUATION_REPORT" }],
  grants: [{ securityId: IDS.opt49, displayId: "OPT-49", stakeholderId: IDS.daniel, grantDate: "2026-09-04", exercisePrice: "0.95" }],
});

const stakeholderDetail = (id: string) => STAKEHOLDER_DETAILS[id] ?? apiError(404, "not_found", "Not found");

export function allRoutes(): MockHandler[] {
  return [
    mock(api.routes.getMe, me("owner")),
    // Non-default decimals, so a figure formatted before the org's settings arrive would differ from the complete page.
    mock(api.routes.getOrg, org({}, { display: { shareDecimals: 0, priceDecimals: 4 } })),
    mock(api.routes.getDashboard, dashboard()),
    mock(api.routes.listValuations, { items: VALUATIONS }),
    mock(api.routes.getValuation, valuationDetail),
    mock(api.routes.listStockClasses, { ...ECHO, items: [stockClass(), SEED_CLASS] }),
    mock(api.routes.listStockPlans, { ...ECHO, items: [stockPlan()] }),
    mock(api.routes.getCapTable, (req: MockRequest) => capTable((req.query.get("tab") ?? "ownership") as Parameters<typeof capTable>[0], { asOf: req.query.get("asOf") ?? TODAY })),
    mock(api.routes.listSecurities, securityList()),
    mock(api.routes.listStakeholders, stakeholderList()),
    mock(api.routes.getStakeholder, (req: MockRequest) => stakeholderDetail(req.params.id!)),
    mock(api.routes.getStakeholderHoldings, (req: MockRequest) => ({ ...ECHO, items: securityList().items.filter((item) => item.stakeholderId === req.params.id) })),
    mock(api.routes.listVestingTerms, { items: VESTING_TERMS }),
    mock(api.routes.previewVesting, { events: [{ date: "2027-10-21", quantity: "2500", cumulative: "2500", state: "ACTIVE", kind: "CLIFF", source: "computed" }], total: "10000" }),
    mock(api.routes.getTerminationPreview, (req: MockRequest) => ({
      securityId: req.params.id!, terminationDate: "2026-12-04", terminationType: "voluntary", vestingStopDate: "2026-12-04",
      vested: "50625", unvested: "89375", exercisable: "50625", repurchaseable: "0", contractualDeadline: "2027-03-04", isoDeadline: "2027-03-04",
    })),
    mock(api.routes.listDocuments, { items: [document({ id: uuid(10, 4), filename: "Board consent.pdf", kind: "BOARD_CONSENT" })], nextCursor: null }),
    mock(api.routes.getDocument, api.documentDetailSchema.parse({ ...document({ id: uuid(10, 4), filename: "Board consent.pdf", kind: "BOARD_CONSENT" }), versions: [{ id: uuid(10, 4), versionLabel: null, createdAt: Date.UTC(2026, 9, 1), supersedesDocumentId: null }] })),
    mock(api.routes.listCollections, { items: [] }),
    mock(api.routes.listOrgAudit, { items: [auditEvent(1), auditEvent(2)], nextCursor: null }),
    mock(api.routes.getSecuritiesStatus, securitiesStatus()),
    mock(api.routes.listExercises, { items: [exercise(), exercise({ transactionId: uuid(17, 2), exerciseDate: "2025-08-20", paymentMethod: "WIRE" })] }),
    mock(api.routes.listExerciseRequests, { items: [request] }),
    mock(api.routes.getExerciseRequest, request),
    mock(api.routes.listCertificates, { items: certificates }),
    mock(api.routes.listLegends, { items: [{ id: uuid(18, 1), kind: "LEGEND", name: "L1 · Securities Act legend", text: "THE SHARES HAVE NOT BEEN REGISTERED.", archivedAt: null, version: 1 }] }),
    mock(api.routes.listCertificateTerms, { items: [{ id: uuid(18, 9), kind: "CERTIFICATE_TERMS", name: "Common stock certificate", text: "This certifies that {{holder_name}} owns {{quantity}} shares of {{share_class}}.", archivedAt: null, version: 1 }] }),
    mock(api.routes.getPaymentInstructions, {
      details: { bankName: "First Example Bank", beneficiaryName: "Acme Robotics, Inc.", beneficiaryAddress: "400 Harbor Way, Suite 12, Oakland, CA", accountNumber: "••••4321", routingNumber: "000000000", swift: "EXMPUS00", referenceFormat: "EX-<grant>-<initials>" },
      updatedBy: "Rachel Ostrowski", updatedAt: Date.UTC(2026, 9, 2, 17),
    }),
    // Today's report-only expiry run (the expiry runs page).
    mock(api.routes.listExpiryRuns, { items: [expiryRunSummary(expiryRun())] }),
    mock(api.routes.getExpiryRun, expiryRun()),
    mock(api.routes.previewAsStakeholder, overview([NADIA])),
    mock(api.routes.previewPortalSecurity, (request: MockRequest) => (request.params.securityId === NADIA_OPTION.id ? detailOf(NADIA_OPTION) : apiError(404, "not_found", "Not found"))),
    mock(api.routes.previewPortalDocuments, [...NADIA_OPTION.documents, ...COMPANY_RESOURCES]),
    mock(api.routes.previewHowToExercise, howToExercise()),
    mock(api.routes.listSignatories, { items: [{ id: uuid(24, 1), name: "Freya Lindqvist", title: "Chief Executive Officer", capabilities: ["options_signatory"], active: true, importedFromPulley: true }] }),
    // The security pages' routes (getSecurity, vesting, timeline, vesting terms, plan, class, FMV, ISO split, 83(b),
    // documents), minus the routes already answered above.
    ...securityHandlers.filter((handler) => ![api.routes.getStakeholder, api.routes.listDocuments, api.routes.getStockPlan, api.routes.getStockClass].includes(handler.route as never)),
    mock(api.routes.getStockPlan, stockPlan()),
    mock(api.routes.getStockClass, (req: MockRequest) => (req.params.id === IDS.seed ? SEED_CLASS : stockClass())),
  ];
}
