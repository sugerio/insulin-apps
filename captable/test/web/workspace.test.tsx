import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { auditEvent, capTable, dashboard, IDS, securitiesStatus, securityList, stakeholderList, stockClass, SEED_CLASS, TODAY } from "./support/acme.ts";
import { apiError, mock, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

const ECHO = { asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0" };
const capTableHandlers = [
  mock(api.routes.getCapTable, (request: MockRequest) => capTable((request.query.get("tab") ?? "ownership") as Parameters<typeof capTable>[0])),
  mock(api.routes.listSecurities, securityList()),
  mock(api.routes.listStakeholders, stakeholderList()),
];

describe("sidebar navigation", () => {
  it("opens the active section's items beside level 1 and marks the current one", async () => {
    renderPage("share-classes", [mock(api.routes.listStockClasses, { ...ECHO, items: [stockClass(), SEED_CLASS] })]);
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    const cap = within(primary).getByRole("link", { name: "Cap Table" });
    expect(cap.getAttribute("aria-current")).toBe("true");
    expect(cap.className).toContain("active");
    const section = screen.getByRole("navigation", { name: "Section" });
    expect(within(section).getAllByRole("link").map((link) => link.textContent)).toEqual(["Cap Table", "Share Classes", "Equity Plans", "Securities Status", "Vesting"]);
    expect(within(section).getByRole("link", { name: "Share Classes" }).getAttribute("aria-current")).toBe("page");
    expect(within(section).getByRole("link", { name: "Vesting" }).getAttribute("href")).toBe(`${base}/vesting`);
    expect(document.getElementById("insulin-nav-section")?.textContent).toContain("Cap Table");
  });

  it("shows no second level for a section without items, and opens Hire and Retain's on its first page", async () => {
    const { router } = renderPage("dashboard", [mock(api.routes.getDashboard, () => apiError(503, "unavailable", "Down")), mock(api.routes.listValuations, { items: [] })]);
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(primary).getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("navigation", { name: "Section" })).toBeNull();
    const hire = within(primary).getByRole("link", { name: "Hire and Retain" });
    expect(hire.getAttribute("href")).toBe(`${base}/exercise-requests`);
    fireEvent.click(hire);
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/exercise-requests`));
    const section = await screen.findByRole("navigation", { name: "Section" });
    expect(within(section).getAllByRole("link").map((link) => link.textContent)).toEqual(["Exercise Requests", "Equity Plans", "Stakeholder Portal"]);
    expect(within(section).getByRole("link", { name: "Exercise Requests" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps Equity Plans in the section it was chosen from", async () => {
    const { router } = renderPage("exercise-requests", []);
    const section = await screen.findByRole("navigation", { name: "Section" });
    fireEvent.click(within(section).getByRole("link", { name: "Equity Plans" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/equity-plans`));
    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(within(primary).getByRole("link", { name: "Hire and Retain" }).getAttribute("aria-current")).toBe("true");
    expect(within(primary).getByRole("link", { name: "Cap Table" }).getAttribute("aria-current")).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Section" })).getByRole("link", { name: "Equity Plans" }).getAttribute("aria-current")).toBe("page");
  });

  it("puts a security's page under Cap Table, with no item of level 2 marked", async () => {
    renderPage(`securities/${IDS.opt1}`, []);
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(primary).getByRole("link", { name: "Cap Table" }).getAttribute("aria-current")).toBe("page");
    const section = screen.getByRole("navigation", { name: "Section" });
    expect(within(section).getAllByRole("link").filter((link) => link.hasAttribute("aria-current"))).toEqual([]);
  });

  it.each([
    ["a stakeholder", `stakeholders/${IDS.daniel}/history`],
    ["a security", `securities/${IDS.opt1}/transfer`],
    ["the company", "settings"],
  ])("answers an address under %s that has no page with Page not found", async (_name, path) => {
    renderPage(path, []);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go home" }).getAttribute("href")).toBe("/");
  });

  it("names a request that doesn't exist, rather than showing an empty page", async () => {
    renderPage("exercise-requests/settings", []);
    expect(await screen.findByText("This exercise request does not exist.")).toBeTruthy();
  });
});

describe("keyboard and focus", () => {
  it("opens the Actions menu from the keyboard, moves through it and returns focus on Escape", async () => {
    renderPage(`${base}/captable?tab=options`, capTableHandlers);
    await screen.findByRole("table", { name: "Options" });
    const button = screen.getByRole("button", { name: "Actions" });
    button.focus();
    fireEvent.keyDown(button, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Actions" });
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("moves between URL tabs with the arrow keys", async () => {
    const { router } = renderPage("captable", capTableHandlers);
    const tabs = await screen.findByRole("tablist", { name: "Cap table views" });
    await waitFor(() => expect(within(tabs).getAllByRole("tab").length).toBe(5));
    const ownership = within(tabs).getByRole("tab", { name: "Ownership" });
    expect(ownership.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(ownership, { key: "ArrowRight" });
    await waitFor(() => expect(router.state.location.search).toBe("?tab=shares"));
    fireEvent.keyDown(within(tabs).getByRole("tab", { name: /^Shares/ }), { key: "End" });
    await waitFor(() => expect(router.state.location.search).toBe("?tab=warrants"));
  });

  it("opens an audit row with Enter and gives focus back when the drawer closes", async () => {
    renderPage("activity", [mock(api.routes.listOrgAudit, { items: [auditEvent(1, { details: { summary: "OPT-26 updated" } })], nextCursor: null })]);
    const table = await screen.findByRole("table", { name: "Audit log" });
    const row = within(table).getByRole("row", { name: /OPT-26 updated/ });
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    const drawer = screen.getByRole("dialog", { name: "Activity detail" });
    expect(drawer.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("toggles row density and remembers the page size", async () => {
    renderPage("stakeholders", [mock(api.routes.listStakeholders, stakeholderList())]);
    const table = await screen.findByRole("table", { name: "Stakeholders" });
    const density = screen.getByRole("button", { name: "Compact rows" });
    fireEvent.click(density);
    expect(density.getAttribute("aria-pressed")).toBe("true");
    expect(table.className).toContain("dense");
    fireEvent.change(screen.getByRole("combobox", { name: "Rows" }), { target: { value: "25" } });
    const saved = Object.keys(window.localStorage).find((key) => key.endsWith(".stakeholders"));
    expect(saved && JSON.parse(window.localStorage.getItem(saved)!)).toMatchObject({ dense: true, pageSize: 25 });
  });
});

describe("the read-only admin experience", () => {
  it("shows the role, no + New, and no write controls anywhere on the queues", async () => {
    renderPage("securities-status", [mock(api.routes.getSecuritiesStatus, securitiesStatus()), mock(api.routes.listSecurities, securityList()), mock(api.routes.listStakeholders, stakeholderList())], { role: "admin_ro" });
    await screen.findByRole("table", { name: "Execution pending (migrated)" });
    expect(screen.getAllByText("Custom role").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /New/ })).toBeNull();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.queryAllByRole("button").filter((button) => /Mark executed|Cancel|Reverse|Invite|Upload|Record/.test(button.textContent ?? ""))).toHaveLength(0);
  });


  it("shows the error, not figures in default settings, when the org record can't be read", async () => {
    const { callsTo } = renderPage("dashboard", [mock(api.routes.getDashboard, dashboard()), mock(api.routes.listValuations, { items: [] })], { orgResponse: () => apiError(503, "unavailable", "Down") });
    expect(await screen.findByText("Couldn't load this page")).toBeTruthy();
    expect(screen.queryByText("$16,147,718.60")).toBeNull();
    expect(callsTo(api.routes.getOrg)).toHaveLength(1);
    expect(callsTo(api.routes.getDashboard)).toHaveLength(0);
  });
});

describe("contract-checked mocks", () => {
  it("refuses a fixture that drifts from the contract", () => {
    expect(() => mock(api.routes.getDashboard, { asOf: TODAY })).toThrow(/breaks the API contract/);
  });
});
