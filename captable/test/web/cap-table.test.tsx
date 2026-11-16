import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { capTable, IDS, numbers, SECURITIES, security, securityList, stakeholderList, TODAY, uuid } from "./support/acme.ts";
import { mock, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

const capTableByTab = (request: MockRequest) => {
  const tab = (request.query.get("tab") ?? "ownership") as Parameters<typeof capTable>[0];
  return capTable(tab, { asOf: request.query.get("asOf") ?? TODAY });
};
const handlers = [
  mock(api.routes.getCapTable, capTableByTab),
  mock(api.routes.listSecurities, securityList()),
  mock(api.routes.listStakeholders, stakeholderList()),
];

function rowOf(table: HTMLElement, text: string) {
  return within(table).getAllByRole("row").find((row) => within(row).queryByText(text)) as HTMLElement;
}

describe("cap table", () => {
  it("shows the ownership tab with tiles, Pulley's columns, the pool and the totals", async () => {
    renderPage("captable", handlers);
    const table = await screen.findByRole("table", { name: "Ownership" });
    const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers.slice(0, 5)).toEqual(["External ID", "Stakeholder", "Stakeholder type", "Common Stock", "Series Seed Preferred"]);
    expect(headers).toContain("Issued and outstanding %");
    expect(headers).toContain("2023 Equity Incentive Plan");
    expect(headers).toContain("Fully diluted");
    expect(within(table).getByRole("columnheader", { name: "Fully diluted" }).getAttribute("aria-sort")).toBe("descending");
    expect(headers.at(-1)).toBe("Fully diluted %");
    expect(headers).not.toContain("E-mail");
    const freya = rowOf(table, "Freya Lindqvist");
    expect(within(freya).getByText("EMP-001")).toBeTruthy();
    expect(within(freya).getAllByText("4,000,000")).toHaveLength(2);
    expect(within(freya).getByText("17.69%")).toBeTruthy();
    expect(within(rowOf(table, "Mateo Villalobos")).getByText("Terminating Dec 4, 2026")).toBeTruthy();
    expect(within(rowOf(table, "Nadia Pereira-Stone")).getByText("Terminated")).toBeTruthy();
    const pool = rowOf(table, "Available pool");
    expect(within(pool).getAllByText("460,750")).toHaveLength(2);
    expect(within(pool).getByText("1.90%")).toBeTruthy();
    const totals = rowOf(table, "Totals");
    expect(within(totals).getByText("24,312,120")).toBeTruthy();
    expect(within(totals).getAllByText("100.00%")).toHaveLength(2);
    const tiles = screen.getByRole("list", { name: "Cap table summary" });
    expect(within(tiles).getByText("Common Stock issued")).toBeTruthy();
    expect(within(tiles).getByText("9,743,000")).toBeTruthy();
    expect(within(tiles).getByText("460,750 available")).toBeTruthy();
    expect(within(tiles).getByText("1 converted")).toBeTruthy();
  });

  it("sorts by fully diluted, largest first, and toggles the direction", async () => {
    renderPage("captable", handlers);
    const table = await screen.findByRole("table", { name: "Ownership" });
    const names = () => within(table).getAllByRole("row").slice(1, 6).map((row) => within(row).queryAllByRole("link")[0]?.textContent);
    expect(names()[0]).toBe("Freya Lindqvist");
    expect(within(table).getByRole("columnheader", { name: "Fully diluted %" }).getAttribute("aria-sort")).toBe("none");
    expect(within(table).getByRole("columnheader", { name: "Fully diluted" }).getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(table).getByRole("button", { name: "Fully diluted" }));
    expect(within(table).getByRole("columnheader", { name: "Fully diluted" }).getAttribute("aria-sort")).toBe("ascending");
    expect(names()[0]).toBe("Nadia Pereira-Stone");
  });

  it("filters by status with a removable chip and recomputes the totals for the rows shown", async () => {
    renderPage("captable", handlers);
    await screen.findByRole("table", { name: "Ownership" });
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "terminated" } });
    const table = screen.getByRole("table", { name: "Ownership" });
    expect(within(table).queryByText("Freya Lindqvist")).toBeNull();
    expect(within(table).queryByText("Available pool")).toBeNull();
    const totals = rowOf(table, "Totals (1 shown)");
    expect(within(totals).getByText("0.25%")).toBeTruthy();
    const chip = screen.getByRole("button", { name: "Remove filter Status" });
    fireEvent.click(chip);
    expect(within(table).getByText("Freya Lindqvist")).toBeTruthy();
  });

  it("searches stakeholders and shows the empty state when nothing matches", async () => {
    renderPage("captable", handlers);
    await screen.findByRole("table", { name: "Ownership" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search ownership" }), { target: { value: "northgate" } });
    const table = screen.getByRole("table", { name: "Ownership" });
    expect(within(table).getByText("Northgate Ventures Fund II, L.P.")).toBeTruthy();
    expect(within(table).queryByText("Freya Lindqvist")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search ownership" }), { target: { value: "nobody" } });
    expect(within(table).getByText("No results match.")).toBeTruthy();
  });

  it("adds optional columns from the chooser and remembers the choice", async () => {
    renderPage("captable", handlers);
    await screen.findByRole("table", { name: "Ownership" });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Individual / Institution" }));
    const table = screen.getByRole("table", { name: "Ownership" });
    expect(within(table).getByRole("columnheader", { name: "Individual / Institution" })).toBeTruthy();
    expect(within(rowOf(table, "Northgate Ventures Fund II, L.P.")).getByText("Institution")).toBeTruthy();
    const saved = Object.keys(window.localStorage).find((key) => key.endsWith(".cap-own"));
    expect(saved && JSON.parse(window.localStorage.getItem(saved)!).columns.kind).toBe(true);
  });

  it("recomputes for an as-of date, shows the banner, and goes back to today", async () => {
    const { router, callsTo } = renderPage("captable", handlers);
    await screen.findByRole("table", { name: "Ownership" });
    fireEvent.change(screen.getByLabelText("Cap table as-of date"), { target: { value: "2025-12-31" } });
    expect(await screen.findByText("Showing the cap table as of Dec 31, 2025")).toBeTruthy();
    expect(router.state.location.search).toBe("?asOf=2025-12-31");
    await waitFor(() => expect(callsTo(api.routes.getCapTable).at(-1)?.query.get("asOf")).toBe("2025-12-31"));
    expect(callsTo(api.routes.listSecurities).at(-1)?.query.get("asOf")).toBe("2025-12-31");
    fireEvent.click(screen.getByRole("link", { name: "Back to today" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.queryByText(/Showing the cap table as of/)).toBeNull();
  });

  it("ignores an as-of date in the future", async () => {
    const { callsTo } = renderPage(`${base}/captable?asOf=2030-01-01`, handlers);
    await screen.findByRole("table", { name: "Ownership" });
    expect(callsTo(api.routes.getCapTable)[0]?.query.get("asOf")).toBe(TODAY);
    expect(screen.queryByText(/Showing the cap table as of/)).toBeNull();
  });

  it("shows an opening-balance banner for dates before a documented opening balance", async () => {
    renderPage(`${base}/captable?asOf=2021-12-31`, [
      mock(api.routes.getCapTable, (request: MockRequest) => capTable("ownership", { asOf: request.query.get("asOf")!, openingBalances: [{ securityId: IDS.cs1, date: "2022-01-01" }] })),
      ...handlers.slice(1),
    ]);
    expect(await screen.findByText("Opening balance")).toBeTruthy();
    expect(screen.getByText(/History before Jan 1, 2022 came in with the import as opening balances/)).toBeTruthy();
  });

  it("names each instrument tab with its count and keeps the as-of date across tabs", async () => {
    const { router } = renderPage(`${base}/captable?asOf=2026-06-30`, handlers);
    const tabs = await screen.findByRole("tablist", { name: "Cap table views" });
    // As of Jun 30, 2026 the Sep 2026 grant isn't issued yet: three option grants.
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: "Options (3)" })).toBeTruthy());
    expect(within(tabs).getByRole("tab", { name: "Ownership" }).getAttribute("aria-selected")).toBe("true");
    expect(within(tabs).getByRole("tab", { name: "Shares (4)" })).toBeTruthy();
    expect(within(tabs).getByRole("tab", { name: "SAFEs (1)" })).toBeTruthy();
    expect(within(tabs).getByRole("tab", { name: "Warrants (1)" })).toBeTruthy();
    fireEvent.click(within(tabs).getByRole("tab", { name: "Options (3)" }));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=options&asOf=2026-06-30"));
    expect(await screen.findByRole("table", { name: "Options" })).toBeTruthy();
  });

  it("shows the options tab with Pulley's default columns, execution-pending badges and tiles", async () => {
    renderPage(`${base}/captable?tab=options`, handlers);
    const table = await screen.findByRole("table", { name: "Options" });
    const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["Certificate", "Stakeholder", "Share Class", "Issued On", "Fully Diluted", "Ownership", "Price/Share", "Exercise Price"]);
    const pending = rowOf(table, "OPT-49");
    expect(within(pending).getByText("Execution pending")).toBeTruthy();
    expect(within(pending).getByText("$0.95")).toBeTruthy();
    const tiles = screen.getByRole("list", { name: "Options summary" });
    expect(within(tiles).getByText("Options outstanding")).toBeTruthy();
    expect(within(tiles).getByText("500,000")).toBeTruthy();
    expect(within(tiles).getByText("grants (counted in FD)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Execution pending" }), { target: { value: "yes" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  it("splits outstanding options into Vested and Unvested that add up, and shows Exercisable now apart", async () => {
    const rows = [
      SECURITIES.opt1, // 250,000 outstanding: 218,750 vested, all exercisable
      // Awaiting the holder's signature: vested, but not exercisable.
      security({ ...SECURITIES.opt49, executionStatus: "pending_holder", numbers: numbers({ issued: "50000", outstanding: "50000", fullyDiluted: "50000", vested: "12500", vestedOutstanding: "12500", unvested: "37500" }) }),
      // Past its exit-window deadline: vested, but not exercisable.
      security({ ...SECURITIES.opt21, deadlines: { contractual: "2026-10-01", iso: null, reason: "3 months after involuntary termination" }, numbers: numbers({ ...SECURITIES.opt21.numbers!, exercisable: "0" }) }),
      // Fully exercised: no longer outstanding, so in none of the three.
      security({ ...SECURITIES.opt18, status: "EXERCISED", numbers: numbers({ issued: "140000", exercised: "140000", vested: "140000" }) }),
    ];
    renderPage(`${base}/captable?tab=options`, [mock(api.routes.getCapTable, capTable("options", { rows })), ...handlers.slice(1)]);
    await screen.findByRole("table", { name: "Options" });
    const tiles = screen.getByRole("list", { name: "Options summary" });
    const tile = (label: string) => within(tiles).getByText(label).closest("li")!.querySelector('[data-slot="tile-value"]')!.textContent;
    expect(tile("Options outstanding")).toBe("360,000");
    expect(tile("Vested")).toBe("291,250");
    expect(tile("Unvested")).toBe("68,750");
    expect(BigInt(tile("Vested")!.replace(/,/g, "")) + BigInt(tile("Unvested")!.replace(/,/g, ""))).toBe(360000n);
    expect(tile("Exercisable now")).toBe("218,750");
    expect(within(tiles).queryByText("Vested & unexercised")).toBeNull();
  });

  it("hides stakeholders with no holdings until asked, without changing the totals", async () => {
    const zero = (stakeholderId: string, name: string, relationship: api.Relationship) => ({
      stakeholderId, name, relationship, issuerAssignedId: null, status: "active" as const,
      byClass: { [IDS.common]: "0" }, issuedAndOutstanding: "0", issuedAndOutstandingPct: "0", planAwards: { [IDS.plan]: "0" }, awardsOutsidePlans: "0", warrants: "0",
      fullyDiluted: "0", fullyDilutedPct: "0",
    });
    const ownership = [...capTable("ownership").ownership!, zero(IDS.rafael, "Rafael Duarte", "ex_employee"), zero(IDS.marcus, "Marcus Oyelaran", "investor")];
    // Marcus holds an outstanding SAFE, which has no figure on this tab: he still holds something.
    const safe = security({
      id: uuid(6, 90), displayId: "SAFE-2", family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: IDS.marcus, stakeholderName: "Marcus Oyelaran", stockClassId: null,
      issueDate: "2025-01-10", terms: { investment_amount: { amount: "100000", currency: "USD" }, convertible_type: "SAFE" },
    });
    renderPage("captable", [
      mock(api.routes.getCapTable, capTable("ownership", { ownership })),
      mock(api.routes.listSecurities, securityList([...Object.values(SECURITIES), safe])),
      ...handlers.slice(2),
    ]);
    const table = await screen.findByRole("table", { name: "Ownership" });
    expect(within(table).queryByText("Rafael Duarte")).toBeNull();
    expect(within(table).getByText("Marcus Oyelaran")).toBeTruthy();
    expect(within(rowOf(table, "Totals")).getByText("24,312,120")).toBeTruthy();
    const toggle = screen.getByRole("checkbox", { name: "Show 1 stakeholder with no holdings" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(within(table).getByText("Rafael Duarte")).toBeTruthy();
    expect(within(rowOf(table, "Totals")).getByText("24,312,120")).toBeTruthy();
  });

  it("counts a stakeholder who never held a security among those with no holdings", async () => {
    // As the server sends one: no class or plan figures at all, every total zero.
    const newcomer = {
      stakeholderId: uuid(3, 40), name: "Ines Okafor", relationship: "employee" as const, issuerAssignedId: null, status: "active" as const,
      byClass: {}, issuedAndOutstanding: "0", issuedAndOutstandingPct: "0", planAwards: {}, awardsOutsidePlans: "0", warrants: "0",
      fullyDiluted: "0", fullyDilutedPct: "0",
    };
    renderPage("captable", [
      mock(api.routes.getCapTable, capTable("ownership", { ownership: [...capTable("ownership").ownership!, newcomer] })),
      ...handlers.slice(1),
    ]);
    const table = await screen.findByRole("table", { name: "Ownership" });
    expect(within(table).queryByText("Ines Okafor")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show 1 stakeholder with no holdings" }));
    expect(within(table).getByText("Ines Okafor")).toBeTruthy();
    expect(within(rowOf(table, "Totals")).getByText("24,312,120")).toBeTruthy();
  });

  it("shows the shares tab with prices and the source of exercise shares", async () => {
    renderPage(`${base}/captable?tab=shares`, handlers);
    const table = await screen.findByRole("table", { name: "Shares" });
    expect(within(rowOf(table, "CS-1")).getByText("$0.0001")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Source" }));
    expect(within(rowOf(table, "CS-7")).getByText("Exercise of OPT-1")).toBeTruthy();
    expect(within(rowOf(table, "PS-1")).getByText("Conversion of SAFE-1")).toBeTruthy();
  });

  it("shows the SAFEs tab as converted history", async () => {
    renderPage(`${base}/captable?tab=safes`, handlers);
    const table = await screen.findByRole("table", { name: "SAFEs" });
    const row = rowOf(table, "SAFE-1");
    expect(within(row).getByText("$250,000")).toBeTruthy();
    expect(within(row).getByText("$6,000,000")).toBeTruthy();
    expect(within(row).getByText("20%")).toBeTruthy();
    expect(within(row).getByText("Converted")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "PS-1" }).getAttribute("href")).toBe(`${base}/securities/${IDS.ps1}`);
    expect(within(row).getByRole("link", { name: "SAFE-1" }).getAttribute("href")).toBe(`${base}/convertibles/${IDS.safe1}`);
    expect(within(row).getByText("$0.48")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("paginates 50 rows at a time", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      stakeholderId: `00000003-0000-4000-8000-${(1000 + index).toString(16).padStart(12, "0")}`,
      name: `Holder ${String(index + 1).padStart(2, "0")}`, relationship: "employee" as const, issuerAssignedId: null, status: "active" as const,
      byClass: {}, issuedAndOutstanding: "0", issuedAndOutstandingPct: "0", planAwards: {}, awardsOutsidePlans: "0", warrants: "0",
      fullyDiluted: String(1000 + index), fullyDilutedPct: "0",
    }));
    renderPage("captable", [mock(api.routes.getCapTable, capTable("ownership", { ownership: many })), ...handlers.slice(1)]);
    await screen.findByRole("table", { name: "Ownership" });
    expect(screen.getByText(/Showing/).textContent).toBe("Showing 1 to 50 of 60 results");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Showing/).textContent).toBe("Showing 51 to 60 of 60 results");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives writers the Actions menu: Add options opens the grant wizard, Cancel options the bulk cancellation", async () => {
    renderPage(`${base}/captable?tab=options`, handlers, { role: "admin_rw" });
    await screen.findByRole("table", { name: "Options" });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const menu = screen.getByRole("menu", { name: "Actions" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining("Add options"), expect.stringContaining("Cancel options")]);
    for (const item of items) expect(item.getAttribute("aria-disabled")).toBeNull();
    expect(items[0]!.getAttribute("href")).toBe(`${base}/issue/options`);
  });

  it("gives read-only admins no Actions menu, a Read-only badge, and masked e-mails", async () => {
    renderPage("captable", handlers, { role: "admin_ro" });
    await screen.findByRole("table", { name: "Ownership" });
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.getByText("Read-only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "E-mail" }));
    const table = screen.getByRole("table", { name: "Ownership" });
    expect(within(rowOf(table, "Daniel Achterberg")).getByText("d•••@mailbox.example")).toBeTruthy();
    expect(within(table).queryByText("daniel.achterberg@mailbox.example")).toBeNull();
  });

  it("opens the download dialog with the as-of date and the PII note for read-only admins", async () => {
    renderPage(`${base}/captable?asOf=2025-12-31`, handlers, { role: "admin_ro" });
    await screen.findByRole("table", { name: "Ownership" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const dialog = screen.getByRole("dialog", { name: "Download cap table" });
    expect(within(dialog).getByText("AcmeRobotics_CapTable_2025-12-31.xlsx")).toBeTruthy();
    expect(within(dialog).getByText(/E-mail columns are blank for your access level/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Download" }));
    expect(await within(dialog).findByText("This export isn't available.")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
