import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import {
  capTable,
  IDS,
  SEED_CLASS,
  securitiesStatus,
  securityList,
  stakeholderList,
  stockClass,
  stockPlan,
  TODAY,
  uuid,
  VESTING_TERMS,
} from "./support/acme.ts";
import { apiError, mock, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

const ECHO = { asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0" };
const EMPTY_PAGE = { items: [], nextCursor: null };
const common = [mock(api.routes.listDocuments, EMPTY_PAGE), mock(api.routes.listOrgAudit, EMPTY_PAGE), mock(api.routes.listSecurities, securityList())];

function definitionOf(label: string): HTMLElement {
  const term = screen.getAllByRole("term").find((item) => item.textContent === label);
  if (!term) throw new Error(`No term ${label}`);
  return term.nextElementSibling as HTMLElement;
}

function rowOf(table: HTMLElement, text: string) {
  return within(table).getAllByRole("row").find((row) => within(row).queryByText(text)) as HTMLElement;
}

describe("share classes", () => {
  it("lists classes with Pulley's columns", async () => {
    renderPage("share-classes", [mock(api.routes.listStockClasses, { ...ECHO, items: [stockClass(), SEED_CLASS] })]);
    const table = await screen.findByRole("table", { name: "Share classes" });
    const seed = rowOf(table, "Series Seed Preferred (PS)");
    expect(within(seed).getByText("Preferred")).toBeTruthy();
    expect(within(seed).getByText("$0.80")).toBeTruthy();
    expect(within(seed).getByText("5,138,019 outstanding")).toBeTruthy();
    expect(within(seed).getByText("1× non-participating")).toBeTruthy();
    expect(within(seed).getByText("No")).toBeTruthy();
    expect(within(rowOf(table, "Common Stock (CS)")).getByText("$0.00001")).toBeTruthy();
    expect(screen.getByText("View only. Share classes come in with the import; the app has no form to change them.")).toBeTruthy();
  });

  it("shows a class's summary, terms, amendments and securities", async () => {
    renderPage(`share-classes/${IDS.common}`, [mock(api.routes.getStockClass, stockClass()), ...common]);
    expect(await screen.findByRole("heading", { name: "Common Stock", level: 1 })).toBeTruthy();
    expect(definitionOf("Authorized").textContent).toBe("30,000,000");
    expect(definitionOf("Available to issue").textContent).toBe("9,954,120");
    expect(definitionOf("Conversion ratio (effective)").textContent).toBe("1:1");
    expect(screen.getByText("Authorized 20,000,000 → 30,000,000 (restated charter)")).toBeTruthy();
    const securities = await screen.findByRole("table", { name: "Securities of this class" });
    expect(within(securities).getByText("CS-1")).toBeTruthy();
    expect(within(securities).queryByText("OPT-1")).toBeNull();
  });

  it("warns when the authorized shares are exceeded", async () => {
    renderPage(`share-classes/${IDS.common}`, [mock(api.routes.getStockClass, stockClass({ authorizedShares: "15000000", numbers: { issuedAndOutstanding: "9743000", reserved: "10302880", availableToIssue: "0", fullyDiluted: "9743000" } })), ...common]);
    expect(await screen.findByText("−5,045,880 — authorized exceeded")).toBeTruthy();
  });

  it("shows the empty state", async () => {
    renderPage("share-classes", [mock(api.routes.listStockClasses, { ...ECHO, items: [] })]);
    expect(await screen.findByText("No share classes yet.")).toBeTruthy();
  });
});

describe("equity plans", () => {
  it("lists plans with size, availability, term and share of fully diluted", async () => {
    renderPage("equity-plans", [mock(api.routes.listStockPlans, { ...ECHO, items: [stockPlan()] }), mock(api.routes.getCapTable, capTable("ownership"))]);
    const table = await screen.findByRole("table", { name: "Equity plans" });
    const row = rowOf(table, "2023 Equity Incentive Plan");
    expect(within(row).getByText("Active")).toBeTruthy();
    expect(within(row).getByText("4,500,000")).toBeTruthy();
    expect(within(row).getByText("460,750 available")).toBeTruthy();
    expect(within(row).getByText("10 years")).toBeTruthy();
    expect(within(row).getByText("4,039,250")).toBeTruthy();
    // (800,000 outstanding awards + 460,750 available) of 24,312,120 fully diluted.
    await waitFor(() => expect(within(row).getByText("5.19%")).toBeTruthy());
  });

  it("shows capacity, exit-window defaults, return-to-pool rules, issued securities and amendments", async () => {
    renderPage(`equity-plans/${IDS.plan}`, [mock(api.routes.getStockPlan, stockPlan()), mock(api.routes.getStockClass, stockClass()), ...common]);
    expect(await screen.findByRole("heading", { name: /2023 Equity Incentive Plan/, level: 1 })).toBeTruthy();
    expect(definitionOf("Available to grant").textContent).toBe("460,750");
    expect(await screen.findByText(/500,000 outstanding options \+ 3,539,250 shares issued from exercises/)).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Plan used 89.76%" })).toBeTruthy();
    expect(definitionOf("Repurchase period").textContent).toBe("90 days after termination");
    expect(definitionOf("With cause").textContent).toBe("0 days");
    expect(definitionOf("Death").textContent).toBe("12 months");
    expect(definitionOf("Repurchased vested shares").textContent).toBe("Retire");
    expect(definitionOf("Cancelled unvested awards").textContent).toBe("Return");
    expect(screen.getByText("Confirmed against the plan document by Freya Lindqvist on Sep 30, 2026, effective Sep 30, 2026.")).toBeTruthy();
    const issued = await screen.findByRole("table", { name: "Shares and options issued" });
    expect(within(rowOf(issued, "OPT-49")).getByText("Execution pending")).toBeTruthy();
    const amendments = screen.getByRole("table", { name: "Plan amendments" });
    expect(within(amendments).getByText("Oct 15, 2025")).toBeTruthy();
    expect(within(amendments).getByText("4,500,000")).toBeTruthy();
  });

  it("answers an unknown plan with the not-found state", async () => {
    renderPage(`equity-plans/${uuid(5, 9)}`, [mock(api.routes.getStockPlan, () => apiError(404, "not_found", "Not found")), ...common]);
    expect(await screen.findByText("This equity plan does not exist.")).toBeTruthy();
  });
});

describe("vesting", () => {
  it("lists the schedule library with Pulley's columns and optional ones", async () => {
    const { callsTo } = renderPage("vesting", [mock(api.routes.listVestingTerms, { items: VESTING_TERMS })]);
    const table = await screen.findByRole("table", { name: "Vesting schedules" });
    const cliff = rowOf(table, "4 years monthly, 1-year cliff (25%)");
    expect(within(cliff).getByText("2.08% per month after a 25% cliff")).toBeTruthy();
    expect(within(cliff).getByText("12")).toBeTruthy();
    expect(within(cliff).getByText("Monthly")).toBeTruthy();
    expect(within(rowOf(table, "4 years monthly, no cliff")).getByText("2.08% per month")).toBeTruthy();
    expect(callsTo(api.routes.listVestingTerms)[0]?.query.get("templates")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Normalized template" }));
    expect(within(table).getByText("48 months, monthly, 12-month cliff")).toBeTruthy();
    expect(screen.getByText(/There is no milestone or pause vesting/)).toBeTruthy();
  });

  it("previews a schedule for 10,000 shares and re-runs it for another start date", async () => {
    const preview = (request: MockRequest) => {
      const body = request.body as { vestingStartDate: string };
      const year = Number(body.vestingStartDate.slice(0, 4));
      return { events: [{ date: `${year + 1}${body.vestingStartDate.slice(4)}`, quantity: "2500", cumulative: "2500", state: "ACTIVE", kind: "CLIFF", source: "computed" }], total: "10000" };
    };
    const { callsTo } = renderPage(`vesting/schedules/${IDS.vs1}`, [mock(api.routes.getVestingTerms, VESTING_TERMS[0]!), mock(api.routes.previewVesting, preview)]);
    expect(await screen.findByRole("heading", { name: "4 years monthly, 1-year cliff (25%)", level: 1 })).toBeTruthy();
    expect(definitionOf("Normalized definition").textContent).toBe("48 months, monthly, 12-month cliff");
    expect(definitionOf("Cliff").textContent).toBe("12 months (25%)");
    const table = await screen.findByRole("table", { name: "Vesting preview" });
    expect(within(table).getByText("Oct 21, 2027")).toBeTruthy();
    expect(within(table).getByText("Cliff")).toBeTruthy();
    expect(callsTo(api.routes.previewVesting)[0]?.body).toMatchObject({ quantity: "10000", vestingStartDate: TODAY });
    expect(callsTo(api.routes.previewVesting)[0]?.headers.get("Idempotency-Key")).toBeNull();
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-01-31" } });
    expect(await screen.findByText("Jan 31, 2027")).toBeTruthy();
  });
});

describe("securities status", () => {
  const handlers = [mock(api.routes.getSecuritiesStatus, securitiesStatus()), mock(api.routes.listSecurities, securityList()), mock(api.routes.listStakeholders, stakeholderList())];

  it("shows each queue with its explainer, rows and counts", async () => {
    renderPage("securities-status", handlers);
    const exec = await screen.findByRole("table", { name: "Execution pending (migrated)" });
    expect(within(exec).getByText("OPT-49")).toBeTruthy();
    expect(within(exec).getByText("Holder + company")).toBeTruthy();
    expect(screen.getByText(/They count in fully diluted and plan usage/)).toBeTruthy();
    const scheduled = screen.getByRole("table", { name: "Scheduled terminations" });
    expect(within(scheduled).getByText("Dec 4, 2026")).toBeTruthy();
    expect(within(scheduled).getByText("(in 44 days)")).toBeTruthy();
    expect(within(scheduled).getByText("89,375")).toBeTruthy();
    expect(within(scheduled).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(`${base}/stakeholders/${IDS.mateo}`);
    const repurchase = screen.getByRole("table", { name: "Unvested shares from terminated holders" });
    expect(within(repurchase).getByText("Window open")).toBeTruthy();
    expect(within(repurchase).getByText("Repurchase offline, with counsel")).toBeTruthy();
    expect(screen.getByText(/Cap Table doesn't record repurchases: counsel papers the repurchase offline/)).toBeTruthy();
    const options = screen.getByRole("table", { name: "Options from terminated holders" });
    expect(within(options).getByText("OPT-21")).toBeTruthy();
    expect(within(options).getByText("(NSO)")).toBeTruthy();
    expect(screen.getByText("Nothing expires in the next 90 days.")).toBeTruthy();
    expect(document.getElementById("exp")?.className).toContain("collapsed");
  });

  it("gives every admin the queue actions, Reverse included", async () => {
    renderPage("securities-status", handlers, { role: "admin_rw" });
    const exec = await screen.findByRole("table", { name: "Execution pending (migrated)" });
    expect((within(exec).getByRole("button", { name: "Mark OPT-49 executed" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(screen.getByRole("table", { name: "Scheduled terminations" })).getByRole("button", { name: /Reverse/ })).toBeTruthy();
  });

  it("shows read-only admins no write buttons", async () => {
    renderPage("securities-status", handlers, { role: "admin_ro" });
    await screen.findByRole("table", { name: "Execution pending (migrated)" });
    expect(screen.queryByRole("button", { name: /Mark .* executed/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancel .* now/ })).toBeNull();
    expect(screen.getByText("Read-only")).toBeTruthy();
  });

  it("collapses every empty queue to one line", async () => {
    renderPage("securities-status", [mock(api.routes.getSecuritiesStatus, securitiesStatus({ executionPending: [], scheduledTerminations: [], unvestedSharesFromTerminated: [], optionsFromTerminated: [] })), ...handlers.slice(1)]);
    expect(await screen.findByText("No grants are awaiting signatures.")).toBeTruthy();
    expect(screen.getByText("No scheduled terminations.")).toBeTruthy();
    expect(screen.getByText("No open repurchase windows.")).toBeTruthy();
    expect(screen.getByText("No open exit windows.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
