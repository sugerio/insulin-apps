import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import {
  IDS, STAKEHOLDERS, TODAY, VALUATIONS, auditEvent, capTable, dashboard, org, securitiesStatus, securityList, stakeholderList, stockClass, stockPlan,
  SEED_CLASS, uuid, valuation, VESTING_TERMS,
} from "./support/acme.ts";
import { apiError, deferred, mock, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";
import { DETAILS, ECHO, securityHandlers } from "./support/securities.ts";
import { renderHook } from "@testing-library/react";
import { allOf, useResource } from "../../src/app/lib/useResource.ts";

// Financial and compliance figures are never derived from a request that is still loading or that failed: the page
// shows a loading or error state (with Try again) instead of zeros, "none" or empty lists.

const capTableByTab = (request: MockRequest) => capTable((request.query.get("tab") ?? "ownership") as Parameters<typeof capTable>[0], { asOf: request.query.get("asOf") ?? TODAY });
const serverError = () => apiError(500, "internal", "The read model is rebuilding.");

function rowOf(table: HTMLElement, text: string) {
  return within(table).getAllByRole("row").find((row) => within(row).queryByText(text)) as HTMLElement;
}

describe("cap table lookups", () => {
  it("shows no derived figure until the securities lookup has answered, however late", async () => {
    const late = deferred<api.SecurityList>();
    renderPage("captable", [mock(api.routes.getCapTable, capTableByTab), mock(api.routes.listSecurities, () => late.promise), mock(api.routes.listStakeholders, stakeholderList())]);
    expect(await screen.findByText("Loading…")).toBeTruthy();
    // The cap table itself is in, but its tiles and columns combine it with the securities: nothing shows yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("table", { name: "Ownership" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Cap table summary" })).toBeNull();
    late.resolve(securityList());
    const table = await screen.findByRole("table", { name: "Ownership" });
    expect(within(screen.getByRole("list", { name: "Cap table summary" })).getByText("1 converted")).toBeTruthy();
    expect(within(rowOf(table, "Freya Lindqvist")).getByText("4,300,000")).toBeTruthy();
  });

  it("shows an error, not zeros, when a lookup fails, and retries only that lookup", async () => {
    let attempts = 0;
    const { callsTo } = renderPage("captable", [
      mock(api.routes.getCapTable, capTableByTab),
      mock(api.routes.listSecurities, () => (++attempts === 1 ? serverError() : securityList())),
      mock(api.routes.listStakeholders, stakeholderList()),
    ]);
    expect(await screen.findByText("Couldn't load this page")).toBeTruthy();
    expect(screen.getByText("The read model is rebuilding.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Ownership" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Cap table summary" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Ownership" })).toBeTruthy();
    expect(callsTo(api.routes.listSecurities)).toHaveLength(2);
    expect(callsTo(api.routes.getCapTable)).toHaveLength(1);
  });

  it("gives each table its own filters and column choice when the tab changes", async () => {
    renderPage(`${base}/captable?tab=shares`, [mock(api.routes.getCapTable, capTableByTab), mock(api.routes.listSecurities, securityList()), mock(api.routes.listStakeholders, stakeholderList())]);
    await screen.findByRole("table", { name: "Shares" });
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "OUTSTANDING" } });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Quantity" }));
    expect(screen.getByRole("button", { name: "Remove filter Status" })).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Shares" })).getByRole("columnheader", { name: "Quantity" })).toBeTruthy();

    fireEvent.click(within(screen.getByRole("tablist", { name: "Cap table views" })).getByRole("tab", { name: /^Options/ }));
    const options = await screen.findByRole("table", { name: "Options" });
    // The Shares filter and the Shares column choice (both keyed "status" and "issued") stay with the Shares table.
    expect(screen.queryByRole("button", { name: "Remove filter Status" })).toBeNull();
    expect(within(options).queryByRole("columnheader", { name: "Granted" })).toBeNull();
    expect(within(options).getAllByRole("row").length).toBeGreaterThan(3);

    fireEvent.click(within(screen.getByRole("tablist", { name: "Cap table views" })).getByRole("tab", { name: /^Shares/ }));
    const shares = await screen.findByRole("table", { name: "Shares" });
    expect(within(shares).getByRole("columnheader", { name: "Quantity" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove filter Status" })).toBeNull();
  });
});

describe("409A valuations", () => {
  const material = (id: number, eventDate: string, kind: api.ValuationEvent["kind"] = "MATERIAL_EVENT") => ({
    id: uuid(21, id), kind, eventDate, description: kind === "MATERIAL_EVENT" ? `Event ${id}` : "Provider confirms the valuation holds", documentId: null,
    reversesEventId: null, createdBy: "Rachel Ostrowski", createdAt: Date.UTC(2026, 0, 1) + id,
  });
  const classes = { ...ECHO, items: [SEED_CLASS, stockClass()] };

  it("resolves material events by chronology: a confirmation clears only the events before it", async () => {
    const current = valuation({ status: "review_required", events: [material(1, "2026-03-01"), material(2, "2026-04-01", "REVIEW_CLEARED"), material(3, "2026-06-01")] });
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: [current, VALUATIONS[1]!] }), mock(api.routes.listStockClasses, classes)]);
    const table = await screen.findByRole("table", { name: "Material events" });
    expect(within(rowOf(table, "Event 1")).getByText("Written confirmation (Apr 1, 2026)")).toBeTruthy();
    expect(within(rowOf(table, "Event 3")).getByText("Open — review required")).toBeTruthy();
    expect(screen.getByText(/needs review — material event on Jun 1, 2026/)).toBeTruthy();
  });

  it("finds the common FMV by class even when a preferred price comes first", async () => {
    const priced = valuation({ prices: [{ stockClassId: IDS.seed, pricePerShare: "1.6" }, { stockClassId: IDS.common, pricePerShare: "0.95" }] });
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: [priced] }), mock(api.routes.listStockClasses, classes)]);
    const table = await screen.findByRole("table", { name: "409A valuations" });
    await waitFor(() => expect(within(rowOf(table, "Nov 2025 Valuation")).getByText("$0.95")).toBeTruthy());
    expect(within(table).queryByText("$1.60")).toBeNull();
  });

  it("never guesses the common FMV when the class lookup fails", async () => {
    const priced = valuation({ prices: [{ stockClassId: IDS.seed, pricePerShare: "1.6" }, { stockClassId: IDS.common, pricePerShare: "0.95" }] });
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: [priced] }), mock(api.routes.listStockClasses, serverError)]);
    const table = await screen.findByRole("table", { name: "409A valuations" });
    expect(await within(table).findByText(/Couldn't load the share classes/)).toBeTruthy();
    expect(within(table).queryByText("$1.60")).toBeNull();
    expect(within(table).queryByText("$0.95")).toBeNull();
  });

  it("waits for the classes before comparing grant strikes with the FMV on a valuation's page", async () => {
    const detail = api.valuationDetailSchema.parse({
      ...valuation({ prices: [{ stockClassId: IDS.seed, pricePerShare: "1.6" }, { stockClassId: IDS.common, pricePerShare: "0.95" }] }),
      documents: [],
      grants: [{ securityId: IDS.opt49, displayId: "OPT-49", stakeholderId: IDS.daniel, grantDate: "2026-09-04", exercisePrice: "0.95" }],
    });
    let attempts = 0;
    renderPage(`compliance/409a/${IDS.v5}`, [
      mock(api.routes.getValuation, detail),
      mock(api.routes.listStockClasses, () => (++attempts === 1 ? serverError() : classes)),
      mock(api.routes.listStakeholders, stakeholderList()),
    ]);
    await screen.findByRole("heading", { name: /^Nov 2025 Valuation/, level: 1 });
    const errors = await screen.findAllByText(/Couldn't load the share classes/);
    expect(errors.length).toBeGreaterThan(0);
    expect(screen.queryByRole("table", { name: "Grants priced with this valuation" })).toBeNull();
    expect(screen.queryByText("Common Stock")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    const grants = await screen.findByRole("table", { name: "Grants priced with this valuation" });
    // Strike $0.95 and the common FMV $0.95 (not the preferred $1.60 listed first).
    expect(within(rowOf(grants, "OPT-49")).getAllByText("$0.95")).toHaveLength(2);
    expect(within(rowOf(grants, "OPT-49")).getByText("Yes")).toBeTruthy();
    const fmv = screen.getByLabelText("FMV per class");
    expect(within(fmv).getByText("Series Seed Preferred")).toBeTruthy();
    expect(within(fmv).getByText("$1.60")).toBeTruthy();
  });
});

describe("dashboard and reference pages", () => {
  it("says the 409A status is unknown when the valuations fail, never \"No reminders\"", async () => {
    let attempts = 0;
    renderPage("dashboard", [mock(api.routes.getDashboard, dashboard()), mock(api.routes.listValuations, () => (++attempts === 1 ? serverError() : { items: VALUATIONS }))]);
    const attention = await screen.findByRole("list", { name: "Needs attention" });
    expect(await within(attention).findByText("Couldn't load the 409A status — open Compliance & Tax")).toBeTruthy();
    expect(screen.queryByText("No reminders.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/409A expires in 15 days/)).toBeTruthy();
    expect(within(attention).getByText(/Presumptively valid until Nov 5, 2026/)).toBeTruthy();
  });

  it("shows the equity plans only with their share of fully diluted, or an error", async () => {
    renderPage("equity-plans", [mock(api.routes.listStockPlans, { ...ECHO, items: [stockPlan()] }), mock(api.routes.getCapTable, serverError)]);
    expect(await screen.findByText("Couldn't load this page")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Equity plans" })).toBeNull();
  });

  it("shows a stakeholder's holdings and termination effects only once the holdings load", async () => {
    let attempts = 0;
    const detail = api.stakeholderDetailSchema.parse({ ...STAKEHOLDERS.mateo, ...ECHO, exercises: [] });
    renderPage(`stakeholders/${IDS.mateo}`, [
      mock(api.routes.getStakeholder, detail),
      mock(api.routes.getStakeholderHoldings, () => (++attempts === 1 ? serverError() : { ...ECHO, items: [securityList().items.find((item) => item.id === IDS.opt18)!] })),
      mock(api.routes.listVestingTerms, { items: VESTING_TERMS }),
      mock(api.routes.getTerminationPreview, { securityId: IDS.opt18, terminationDate: "2026-12-04", terminationType: "voluntary", vestingStopDate: "2026-12-04", vested: "50625", unvested: "89375", exercisable: "50625", repurchaseable: "0", contractualDeadline: "2027-03-04", isoDeadline: "2027-03-04" }),
      mock(api.routes.listDocuments, { items: [], nextCursor: null }),
      mock(api.routes.listOrgAudit, { items: [], nextCursor: null }),
    ]);
    expect(await screen.findByText(/Couldn't load the holdings, so the effects couldn't be computed/)).toBeTruthy();
    expect(screen.getByText(/^Couldn't load the holdings\./)).toBeTruthy();
    expect(screen.queryByText("No holdings.")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    expect(await screen.findByRole("table", { name: "Options" })).toBeTruthy();
    const effects = await screen.findByRole("table", { name: /scheduled termination/ });
    expect(within(rowOf(effects, "OPT-18")).getByText("89,375")).toBeTruthy();
  });
});

describe("security pages", () => {
  /** The security pages' handlers with some routes answered differently. */
  const replacing = (...replacements: ReturnType<typeof mock>[]) => [
    ...securityHandlers.filter((handler) => !replacements.some((replacement) => replacement.route === handler.route)),
    ...replacements,
  ];

  it("shows the current FMV and the exit windows only from their own answers", async () => {
    renderPage(`securities/${IDS.opt1}`, replacing(mock(api.routes.getFmv, serverError), mock(api.routes.getStockPlan, serverError)));
    await screen.findByRole("heading", { name: "OPT-1 Options", level: 1 });
    expect(await screen.findByText(/Couldn't load the current FMV/)).toBeTruthy();
    expect(await screen.findByText(/Couldn't load the plan's exercise windows/)).toBeTruthy();
    // No window is shown as missing ("—") or as inherited while the plan's defaults are unknown.
    expect(screen.queryByLabelText("Post-termination exercise")).toBeNull();
    expect(screen.queryByText("inherited from the plan")).toBeNull();
  });

  it("never shows a holder's exercises as none while the stakeholder is loading", async () => {
    const late = deferred<api.StakeholderDetail>();
    renderPage(`securities/${IDS.opt1}`, replacing(mock(api.routes.getStakeholder, () => late.promise)));
    await screen.findByRole("heading", { name: "OPT-1 Options", level: 1 });
    expect(screen.getByRole("status", { name: "Loading the exercises" })).toBeTruthy();
    late.resolve(api.stakeholderDetailSchema.parse({ ...STAKEHOLDERS.daniel, ...ECHO, exercises: [{
      transactionId: uuid(17, 1), commandId: uuid(9, 7), exerciseDate: "2026-03-20", stakeholderId: IDS.daniel, stakeholderName: "Daniel Achterberg",
      securityId: IDS.opt1, grantDisplayId: "OPT-1", quantity: "50000", isoQuantity: "50000", nsoQuantity: "0", exercisePrice: "0.1", cost: "5000",
      paymentMethod: "CHECK", paymentReference: "1042", fmvPerShare: "0.44", taxTreatment: null, withholding: null,
      resultingShares: [{ securityId: IDS.cs7, displayId: "CS-7", portion: "ISO" }], source: { kind: "recorded", requestNumber: null }, reversed: false,
    }] }));
    expect(await screen.findByRole("link", { name: "CS-7" })).toBeTruthy();
  });
});

describe("no self-dealing affordance on an admin's own holdings", () => {
  const cases: [string, string, string][] = [
    ["option", IDS.opt1, IDS.daniel],
    ["share", IDS.cs7, IDS.daniel],
    ["warrant", IDS.war1, IDS.northgate],
    ["SAFE", IDS.safe1, IDS.tidewater],
  ];

  it.each(cases)("shows no Actions and no Upload on the admin's own %s", async (_kind, securityId, holderId) => {
    const path = DETAILS[securityId]!.family === "CONVERTIBLE" ? `convertibles/${securityId}` : `securities/${securityId}`;
    renderPage(path, securityHandlers, { ownStakeholderId: holderId });
    expect(await screen.findByText("Your own holding")).toBeTruthy();
    await screen.findByRole("heading", { name: "Attachments" });
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Upload/ })).toBeNull();
  });

  it.each(cases)("offers Upload on someone else's %s", async (_kind, securityId) => {
    const path = DETAILS[securityId]!.family === "CONVERTIBLE" ? `convertibles/${securityId}` : `securities/${securityId}`;
    renderPage(path, securityHandlers);
    await screen.findByRole("heading", { name: "Attachments" });
    const upload = (await screen.findByRole("button", { name: `Upload a document for ${DETAILS[securityId]!.displayId}` })) as HTMLButtonElement;
    expect(upload.disabled).toBe(false);
  });

  it("offers no queue action on the admin's own securities in Securities Status", async () => {
    renderPage("securities-status", [mock(api.routes.getSecuritiesStatus, securitiesStatus()), mock(api.routes.listSecurities, securityList()), mock(api.routes.listStakeholders, stakeholderList())], { ownStakeholderId: IDS.daniel });
    const pending = await screen.findByRole("table", { name: "Execution pending (migrated)" });
    expect(within(rowOf(pending, "OPT-49")).queryByRole("button", { name: /Mark .*executed|Cancel/ })).toBeNull();
    const terminated = screen.getByRole("table", { name: "Options from terminated holders" });
    expect(within(rowOf(terminated, "OPT-21")).getByRole("button", { name: "Cancel OPT-21 now" })).toBeTruthy();
  });

  it("shows no write control on the admin's own stakeholder record", async () => {
    const detail = api.stakeholderDetailSchema.parse({ ...STAKEHOLDERS.nadia, ...ECHO, exercises: [] });
    renderPage(`stakeholders/${IDS.nadia}`, [
      mock(api.routes.getStakeholder, detail),
      mock(api.routes.getStakeholderHoldings, { ...ECHO, items: [] }),
      mock(api.routes.listVestingTerms, { items: VESTING_TERMS }),
      mock(api.routes.listDocuments, { items: [], nextCursor: null }),
      mock(api.routes.listOrgAudit, { items: [], nextCursor: null }),
    ], { ownStakeholderId: IDS.nadia });
    expect(await screen.findByText("This is your own record")).toBeTruthy();
    await screen.findByText("No holdings.");
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    for (const label of [/^Add$/, /^Change/, /^Remove/, /Upload/, /^Link$/, /Unlink/]) expect(screen.queryByRole("button", { name: label })).toBeNull();
  });
});

describe("the shell's write access", () => {

  it("renders no page, figure or + New until the company record (display settings, time zone, status) has loaded", async () => {
    const late = deferred<api.Org>();
    renderPage("dashboard", [mock(api.routes.getDashboard, dashboard()), mock(api.routes.listValuations, { items: VALUATIONS })], { orgResponse: () => late.promise as unknown as Response });
    expect(await screen.findByText("Loading the company…")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Needs attention" })).toBeNull();
    expect(screen.queryByText("24,312,120")).toBeNull();
    expect(screen.queryByRole("button", { name: /New/ })).toBeNull();
    late.resolve(org({}, { display: { shareDecimals: 2, priceDecimals: 2 } }));
    // The figures appear with the org's own precision, never with defaults standing in for it.
    expect(await screen.findByText("24,312,120.00")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /New/ })).toBeTruthy();
  });

  it("shows the error with Try again, and no page, when the org record can't be read", async () => {
    let attempts = 0;
    renderPage("dashboard", [mock(api.routes.getDashboard, dashboard()), mock(api.routes.listValuations, { items: VALUATIONS })], { orgResponse: () => (++attempts === 1 ? serverError() : org()) as Response });
    expect(await screen.findByText("Couldn't load this page")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Needs attention" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Needs attention" })).toBeTruthy();
  });
});

describe("figures from a successful answer that lacks them", () => {
  it("says a dashboard queue the server didn't report is unknown, not zero", async () => {
    const partial = dashboard({ needsAttention: dashboard().needsAttention.filter((item) => item.kind !== "EXECUTION_PENDING"), inProgress: { unvestedSharesFromTerminated: 1, optionsFromTerminated: 2, scheduledTerminations: 1 } });
    renderPage("dashboard", [mock(api.routes.getDashboard, partial), mock(api.routes.listValuations, { items: VALUATIONS })]);
    const attention = await screen.findByRole("list", { name: "Needs attention" });
    const line = within(attention).getByText("Execution pending (migrated)").closest("a")!;
    expect(within(line).getByText("Not reported")).toBeTruthy();
    expect(within(line).queryByText("0")).toBeNull();
    const pending = screen.getByRole("link", { name: /Execution pending \(migrated\)—/ });
    expect(within(pending).getByTitle("Not reported").textContent).toBe("—");
  });

  it("shows a stakeholder without totals as unknown in the list", async () => {
    const withoutTotals = stakeholderList([{ ...STAKEHOLDERS.freya, totals: undefined }]);
    renderPage("stakeholders", [mock(api.routes.listStakeholders, withoutTotals)]);
    const table = await screen.findByRole("table", { name: "Stakeholders" });
    const freya = rowOf(table, "Freya Lindqvist");
    expect(within(freya).queryByText("0")).toBeNull();
    expect(within(freya).getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("FMV of the option's own class", () => {
  const preferredOption = { ...DETAILS[IDS.opt1]!, stockClassId: IDS.seed };
  const fmvFor = (classId: string, price: string) => ({ date: TODAY, stockClassId: classId, fmv: { valuationId: IDS.v5, valuationName: "Nov 2025 Valuation", pricePerShare: price, splitAdjusted: false, status: "expiring_soon" as const } });

  it("asks for the FMV of the class the option is on", async () => {
    const { callsTo } = renderPage(`securities/${IDS.opt1}`, [
      ...securityHandlers.filter((handler) => handler.route !== api.routes.getSecurity && handler.route !== api.routes.getFmv),
      mock(api.routes.getSecurity, preferredOption),
      mock(api.routes.getFmv, (request: MockRequest) => (request.query.get("stockClassId") === IDS.seed ? fmvFor(IDS.seed, "1.6") : fmvFor(IDS.common, "0.95"))),
    ]);
    expect(await screen.findByText("$1.60")).toBeTruthy();
    expect(screen.queryByText("$0.95")).toBeNull();
    expect(callsTo(api.routes.getFmv)[0]?.query.get("stockClassId")).toBe(IDS.seed);
  });

  it("never presents another class's FMV as the option's", async () => {
    renderPage(`securities/${IDS.opt1}`, [
      ...securityHandlers.filter((handler) => handler.route !== api.routes.getSecurity && handler.route !== api.routes.getFmv),
      mock(api.routes.getSecurity, preferredOption),
      mock(api.routes.getFmv, fmvFor(IDS.common, "0.95")),
    ]);
    expect(await screen.findByText("Unavailable for this class")).toBeTruthy();
    expect(screen.queryByText("$0.95")).toBeNull();
  });
});

describe("recent activity paging", () => {
  it("retries a page that failed to load", async () => {
    let olderAttempts = 0;
    renderPage("activity", [
      mock(api.routes.listOrgAudit, (request: MockRequest) => {
        if (!request.query.get("cursor")) return { items: [auditEvent(1)], nextCursor: "page-2" };
        olderAttempts += 1;
        return olderAttempts === 1 ? serverError() : { items: [auditEvent(2, { details: { summary: "OPT-48 recorded" } })], nextCursor: null };
      }),
    ]);
    await screen.findByRole("table", { name: "Audit log" });
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByText(/Couldn't load older activity\. The read model is rebuilding\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("OPT-48 recorded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Load older activity|Try again/ })).toBeNull();
    expect(olderAttempts).toBe(2);
  });
});

describe("company signatories", () => {
  const others = [
    mock(api.routes.getPaymentInstructions, null),
  ];

  it("lists each signatory type with the person and title, in order", async () => {
    renderPage("company", [...others, mock(api.routes.listSignatories, {
      items: [
        { id: uuid(24, 1), name: "Freya Lindqvist", title: "Chief Executive Officer", capabilities: ["certificate_primary", "options_signatory"], active: true, importedFromPulley: true },
        { id: uuid(24, 2), name: "Rachel Ostrowski", title: null, capabilities: ["certificate_secondary", "safes_signatory"], active: true, importedFromPulley: true },
        { id: uuid(24, 3), name: "Former Officer", title: "Secretary", capabilities: ["warrants_signatory"], active: false, importedFromPulley: true },
      ],
    })]);
    const table = await screen.findByRole("table", { name: "Signatories" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["Options", "Freya Lindqvist", "Chief Executive Officer"],
      ["Certificate (primary)", "Freya Lindqvist", "Chief Executive Officer"],
      ["Certificate (secondary)", "Rachel Ostrowski", "—"],
      ["SAFEs", "Rachel Ostrowski", "—"],
      ["Warrants", "Former Officer Inactive", "Secretary"],
    ]);
  });

  it("says when there are none, and retries a failed load", async () => {
    let attempts = 0;
    renderPage("company", [...others, mock(api.routes.listSignatories, () => (++attempts === 1 ? serverError() : { items: [] }))]);
    expect(await screen.findByText(/Couldn't load the signatories/)).toBeTruthy();
    fireEvent.click(within(screen.getByText(/Couldn't load the signatories/)).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No signatories yet.")).toBeTruthy();
  });
});


describe("resources", () => {
  it("drops what was shown when a reload fails, so the failure is visible", async () => {
    let attempts = 0;
    const load = () => (++attempts === 1 ? Promise.resolve("first answer") : Promise.reject(new Error("reload failed")));
    const { result } = renderHook(() => {
      const one = useResource(load, []);
      const two = useResource(() => Promise.resolve(2), []);
      return { one, both: allOf(one, two) };
    });
    await waitFor(() => expect(result.current.both.data).toEqual(["first answer", 2]));
    result.current.one.reload();
    await waitFor(() => expect(result.current.one.error).toBeInstanceOf(Error));
    expect(result.current.one.data).toBeUndefined();
    expect(result.current.both.data).toBeUndefined();
    expect(result.current.both.error).toBeInstanceOf(Error);
  });
});
