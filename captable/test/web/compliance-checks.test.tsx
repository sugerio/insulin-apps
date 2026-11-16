import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, SECURITIES, security, securityList, uuid, valuation, VALUATIONS } from "./support/acme.ts";
import { apiError, mock } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

// Compliance & Tax › 83(b) elections and Checks: read-only views over the existing admin routes.

function election(n: number, overrides: Partial<api.Election83b> = {}): api.Election83b {
  return {
    id: uuid(20, n), securityId: IDS.cs1, status: "UNCONFIRMED_DEADLINE_PASSED", transferDate: "2021-02-15", dueDate: "2021-03-17", filedDate: null,
    proofDocumentId: null, supersedesId: null, importedFromPulley: true, createdAt: 1, ...overrides,
  };
}

// An early-exercise share whose 83(b) deadline (Aug 2 + 30 days) falls on a Sunday before Labor Day.
const CS4 = security({
  id: IDS.cs4, displayId: "CS-4", stakeholderId: IDS.desmond, stakeholderName: "Desmond Example", issueDate: "2024-08-02", stockPlanId: IDS.plan,
  terms: { share_price: { amount: "0.31", currency: "USD" }, vesting_terms_id: IDS.vs1, x_origin: "EXERCISE" },
});
const SAFE2 = security({
  id: uuid(6, 91), displayId: "SAFE-2", family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: IDS.marcus, stakeholderName: "Marcus Oyelaran", stockClassId: null,
  issueDate: "2025-01-10", boardApprovalDate: null, boardApprovalNotRecordedInPulley: true, terms: { investment_amount: { amount: "100000", currency: "USD" }, convertible_type: "SAFE" },
});
const SECURITY_LIST = securityList([...Object.values(SECURITIES), CS4, SAFE2]);

describe("Compliance & Tax › 83(b) elections", () => {
  it("lists each share's record in force, with its deadline rolled past a weekend and a legal holiday", async () => {
    const elections = [
      // CS-1's correction supersedes the imported record though it is listed first.
      election(2, { status: "FILED", filedDate: "2021-03-01", supersedesId: uuid(20, 1), proofDocumentId: uuid(10, 9), importedFromPulley: false }),
      election(1, { createdAt: 2 }),
      election(3, { securityId: IDS.cs4, status: "PENDING", transferDate: "2024-08-02", dueDate: null }),
    ];
    renderPage("compliance/83b", [mock(api.routes.listElections83b, { items: elections }), mock(api.routes.listSecurities, SECURITY_LIST)]);
    const table = await screen.findByRole("table", { name: "83(b) elections" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const cs1 = rows.find((row) => within(row).queryByText("CS-1"))!;
    expect(within(cs1).getByText("Filed Mar 1, 2021")).toBeTruthy();
    expect(within(cs1).getByText("Freya Lindqvist")).toBeTruthy();
    expect(within(cs1).getByText("4,000,000")).toBeTruthy();
    expect(within(cs1).getByRole("button", { name: /^Download proof/ }).textContent).toBe("Download proof of CS-1");
    expect(within(table).queryByText("Unconfirmed — deadline passed")).toBeNull();
    const cs4 = rows.find((row) => within(row).queryByText("CS-4"))!;
    // Sunday Sep 1, 2024 → Monday Sep 2 is Labor Day → Tuesday Sep 3.
    expect(within(cs4).getByText("Sep 3, 2024")).toBeTruthy();
    expect(within(cs4).getByText("Pending")).toBeTruthy();
    expect(within(cs4).getByText("None")).toBeTruthy();
    expect(within(cs4).getByRole("link", { name: "CS-4" }).getAttribute("href")).toBe(`${base}/securities/${IDS.cs4}`);
    expect(screen.queryByRole("button", { name: /Record|Mark|Edit/ })).toBeNull();
  });

  it("is one of the Compliance & Tax tabs, next to the 409A valuations", async () => {
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: VALUATIONS }), mock(api.routes.listStockClasses, { asOf: "2026-10-21", asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0", items: [] })]);
    const tabs = await screen.findByRole("tablist", { name: "Compliance and tax" });
    expect(within(tabs).getAllByRole("tab").map((tab) => [tab.textContent, tab.getAttribute("href")])).toEqual([
      ["409A Valuations", `${base}/compliance/409a`], ["83(b) elections", `${base}/compliance/83b`], ["Checks", `${base}/compliance/checks`],
    ]);
  });

  it("keeps the keyboard focus on the selected tab when the arrow keys move to another tab's page", async () => {
    const { router } = renderPage("compliance/409a", [
      mock(api.routes.listValuations, { items: VALUATIONS }),
      mock(api.routes.listStockClasses, { asOf: "2026-10-21", asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0", items: [] }),
      mock(api.routes.listElections83b, { items: [] }),
      mock(api.routes.listSecurities, SECURITY_LIST),
    ]);
    const valuations = await screen.findByRole("tab", { name: "409A Valuations" });
    valuations.focus();
    fireEvent.keyDown(valuations, { key: "ArrowRight" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/compliance/83b`));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "83(b) elections" })));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/compliance/409a`));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "409A Valuations" })));
  });

  it("says when no election is recorded, and lets a failed read be retried", async () => {
    let calls = 0;
    renderPage("compliance/83b", [
      mock(api.routes.listElections83b, () => (++calls === 1 ? apiError(500, "internal", "The read model is rebuilding.") : { items: [] })),
      mock(api.routes.listSecurities, SECURITY_LIST),
    ]);
    expect(await screen.findByText(/Couldn't load the 83\(b\) elections/)).toBeTruthy();
    screen.getByRole("button", { name: "Try again" }).click();
    expect(await screen.findByText("No 83(b) elections recorded")).toBeTruthy();
  });
});

describe("Compliance & Tax › Checks", () => {
  const region = (name: string) => screen.getByRole("region", { name });

  it("lists what the company still has to complete", async () => {
    const unadopted = valuation({ boardApprovalDate: null });
    renderPage("compliance/checks", [
      mock(api.routes.listSecurities, SECURITY_LIST),
      // CS-1 has a record; CS-4, also restricted, has none.
      mock(api.routes.listElections83b, { items: [election(1)] }),
      mock(api.routes.listValuations, { items: [unadopted] }),
    ], { orgOverrides: [{ ein: null }] });
    expect(await screen.findByRole("heading", { name: "Board approval not recorded in Pulley" })).toBeTruthy();

    const company = region("Company EIN and address");
    expect(within(company).getByText("1 to complete")).toBeTruthy();
    expect(within(company).getByText("EIN not recorded")).toBeTruthy();
    expect(within(company).queryByText("Street address not recorded")).toBeNull();

    // The ratification list, by family, the SAFEs a group of their own.
    const board = region("Board approval not recorded in Pulley");
    expect(within(board).getByText("2 to complete")).toBeTruthy();
    expect(within(board).getByRole("heading", { name: "Option grants (1)" })).toBeTruthy();
    expect(within(within(board).getByRole("table", { name: "Option grants without a recorded board approval" })).getByText("OPT-49")).toBeTruthy();
    expect(within(within(board).getByRole("table", { name: "SAFEs without a recorded board approval" })).getByText("SAFE-2")).toBeTruthy();
    expect(within(board).queryByRole("table", { name: /^Shares/ })).toBeNull();
    expect(within(board).getByText(/never becomes the original approval date/)).toBeTruthy();

    const adoption = region("409A in effect without board adoption");
    expect(within(adoption).getByText(/has no board adoption date/)).toBeTruthy();
    expect(within(adoption).getByRole("link", { name: "Nov 2025 Valuation" }).getAttribute("href")).toBe(`${base}/compliance/409a/${IDS.v5}`);

    const restricted = within(region("Restricted shares without an 83(b) record")).getByRole("table", { name: "Restricted shares without an 83(b) record" });
    expect(within(restricted).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["CS-4"]);
  });

  it("says each check is complete when nothing is missing", async () => {
    renderPage("compliance/checks", [
      mock(api.routes.listSecurities, securityList([SECURITIES.cs1, SECURITIES.opt1])),
      mock(api.routes.listElections83b, { items: [election(1)] }),
      mock(api.routes.listValuations, { items: VALUATIONS }),
    ]);
    expect(await screen.findByText("Every security has a board approval date.")).toBeTruthy();
    expect(screen.getByText("The EIN and the company's street address are recorded.")).toBeTruthy();
    expect(screen.getByText("Nov 2025 Valuation was adopted by the board on Nov 20, 2025.")).toBeTruthy();
    expect(screen.getByText("Every restricted share has an 83(b) record.")).toBeTruthy();
    expect(screen.getAllByText("Complete")).toHaveLength(4);
  });
});
