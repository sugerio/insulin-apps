import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { processedMessage } from "../../src/app/pages/DashboardPage.tsx";
import { dashboard, ORG_ID, TODAY, uuid, valuation, VALUATIONS } from "./support/acme.ts";
import { apiError, mock } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

function handlers(overrides: Parameters<typeof dashboard>[0] = {}, valuations = VALUATIONS) {
  return [mock(api.routes.getDashboard, dashboard(overrides)), mock(api.routes.listValuations, { items: valuations })];
}

describe("dashboard", () => {
  it("shows the company card, employee equity, ownership and top stakeholders", async () => {
    renderPage("dashboard", handlers());
    expect(await screen.findByRole("heading", { name: "Acme Robotics, Inc." })).toBeTruthy();
    expect(screen.getByText("$16,147,718.60")).toBeTruthy();
    expect(screen.getByText("24,312,120")).toBeTruthy();
    expect(screen.getByText("38")).toBeTruthy();
    expect(screen.getByText(/4,039,250 granted \(89\.76%\) · 460,750 available \(10\.24%\)/)).toBeTruthy();
    const legend = screen.getByRole("list", { name: "Ownership by category" });
    expect(within(legend).getByText("Founders")).toBeTruthy();
    expect(within(legend).getByText("41.95%")).toBeTruthy();
    expect(within(legend).getByText("Available")).toBeTruthy();
    expect(within(legend).getByText("1.90%")).toBeTruthy();
    const top = screen.getByRole("table", { name: "Top stakeholders" });
    const rows = within(top).getAllByRole("row");
    expect(within(rows[1]!).getByRole("link", { name: "Freya Lindqvist" }).getAttribute("href")).toContain("/stakeholders/");
    expect(within(rows[1]!).getByText("17.69%")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Founders 41.95%" })).toBeTruthy();
  });

  it("lists what needs attention, in-progress counts, reminders and recent activity", async () => {
    renderPage("dashboard", handlers());
    const attention = await screen.findByRole("list", { name: "Needs attention" });
    expect(within(attention).getByText("6 grants awaiting signatures")).toBeTruthy();
    expect(within(attention).getByText("1 termination scheduled · next Dec 4, 2026")).toBeTruthy();
    expect(within(attention).getByText("Presumptively valid until Nov 5, 2026 (15 days)")).toBeTruthy();
    expect(within(attention).getByRole("link", { name: /Execution pending \(migrated\)/ }).getAttribute("href")).toBe(`${base}/securities-status#exec`);
    expect(screen.getByRole("link", { name: /Options from terminated holders — open windows/ }).textContent).toContain("2");
    expect(screen.getByRole("link", { name: "409A expires in 15 days (Nov 5, 2026) — record the new provider's report" })).toBeTruthy();
    expect(screen.getByText("OPT-56 recorded — 40,000 options for Omar Haddad-Lewis")).toBeTruthy();
    expect(screen.getByText(/Morgan Ellis · Today 8:40am/)).toBeTruthy();
  });

  it("shows a review-required 409A", async () => {
    const flagged = valuation({
      status: "review_required",
      events: [{ id: "00000010-0000-4000-8000-000000000001", kind: "MATERIAL_EVENT", eventDate: "2026-10-10", description: "Series B term sheet signed", documentId: null, reversesEventId: null, createdBy: "Rachel Ostrowski", createdAt: 1 }],
    });
    renderPage("dashboard", handlers({}, [flagged]));
    expect(await screen.findByText("Nov 2025 Valuation: review required (material event flagged)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "409A review required — material event on Oct 10, 2026" })).toBeTruthy();
  });

  it("has sensible empty states", async () => {
    renderPage("dashboard", handlers({ employeeEquity: [], ownershipByRelationship: [], topStakeholders: [], needsAttention: [], inProgress: {}, recentActivity: [] }, []));
    expect(await screen.findByText("No equity plans yet.")).toBeTruthy();
    expect(screen.getByText("Nothing is issued yet.")).toBeTruthy();
    expect(screen.getByText("No stakeholders hold securities yet.")).toBeTruthy();
    expect(screen.getByText("No 409A valuation recorded")).toBeTruthy();
    expect(screen.getByText("No activity yet.")).toBeTruthy();
    // Queues the server didn't report are unknown, not empty: no "None" and no zero counts.
    expect(screen.queryByText("None")).toBeNull();
    expect(within(screen.getByRole("list", { name: "Needs attention" })).getAllByText("Not reported")).toHaveLength(4);
    expect(screen.getAllByTitle("Not reported").map((item) => item.textContent)).toEqual(["—", "—", "—", "—"]);
  });

  it("counts only a final 409A as the 409A in effect", async () => {
    const other = valuation({ id: uuid(8, 7), name: "Sep 2026 Token Valuation", valuationType: "OTHER", effectiveDate: "2026-09-01", expirationDate: null, status: "not_409a", presumptivelyValidUntil: null });
    const draft = valuation({ id: uuid(8, 8), name: "Oct 2026 Draft", reportVersion: "DRAFT", effectiveDate: "2026-10-01", expirationDate: "2027-10-01", status: "draft", presumptivelyValidUntil: null });
    renderPage("dashboard", handlers({}, [other, draft]));
    expect(await screen.findByText("No 409A valuation recorded")).toBeTruthy();
    expect(screen.queryByText(/Presumptively valid until Oct 1, 2027/)).toBeNull();
  });

  it("offers the new-grant hint to writers only, linking to the grant wizard", async () => {
    renderPage("dashboard", handlers(), { role: "admin_rw" });
    const hint = await screen.findByText("Record a new option grant");
    expect(hint.closest("a")?.getAttribute("href")).toBe(`${base}/issue/options`);
  });

  it("hides the new-grant hint from read-only admins", async () => {
    renderPage("dashboard", handlers(), { role: "admin_ro" });
    await screen.findByText("Total capital contribution");
    expect(screen.queryByText("Record a new option grant")).toBeNull();
    expect(screen.queryByRole("button", { name: /New/ })).toBeNull();
  });

  it("shows an error with a retry when the dashboard can't be read", async () => {
    let calls = 0;
    renderPage("dashboard", [
      mock(api.routes.getDashboard, () => (++calls === 1 ? apiError(503, "unavailable", "D1 unavailable") : dashboard())),
      mock(api.routes.listValuations, { items: VALUATIONS }),
    ]);
    expect(await screen.findByText("Couldn't load this page")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Total capital contribution")).toBeTruthy());
  });

  it("processes due items on request and reads the dashboard again", async () => {
    let reads = 0;
    const { callsTo } = renderPage("dashboard", [
      mock(api.routes.getDashboard, () => (++reads, dashboard())),
      mock(api.routes.listValuations, { items: VALUATIONS }),
      mock(api.routes.processDue, { localDate: TODAY, appliedTerminations: 1, expiredSecurities: 0, proposedExpirations: 2, remainingExpirations: 0, failures: 0 }),
    ], { role: "admin_rw" });
    fireEvent.click(await screen.findByRole("button", { name: "Process due items" }));
    expect(await screen.findByText("Due items processed: 1 scheduled termination recorded, 2 expiries waiting for review.")).toBeTruthy();
    const [call] = callsTo(api.routes.processDue);
    expect(call!.url.pathname).toBe(`/api/orgs/${ORG_ID}/process-due`);
    expect(call!.headers.get("Idempotency-Key")).toBeNull();
    await waitFor(() => expect(reads).toBe(2));
  });

  it("words what processing found, failures included", () => {
    const result = { localDate: TODAY, appliedTerminations: 0, expiredSecurities: 0, proposedExpirations: 0, remainingExpirations: 0, failures: 0 };
    expect(processedMessage(result)).toBe("Nothing was due.");
    expect(processedMessage({ ...result, expiredSecurities: 1, failures: 2 })).toBe("Due items processed: 1 security expired. 2 items couldn't be processed; try again later.");
    expect(processedMessage({ ...result, appliedTerminations: 2, expiredSecurities: 3, proposedExpirations: 1 })).toBe(
      "Due items processed: 2 scheduled terminations recorded, 3 securities expired, 1 expiry waiting for review.",
    );
  });

  it("says plainly when due items couldn't be processed", async () => {
    renderPage("dashboard", [...handlers(), mock(api.routes.processDue, () => apiError(404, "not_found", "Unknown API route"))]);
    fireEvent.click(await screen.findByRole("button", { name: "Process due items" }));
    expect(await screen.findByText("Nothing was processed. Processing due items isn't available.")).toBeTruthy();
  });

  it("offers no Process due items to an editor", async () => {
    renderPage("dashboard", handlers(), { role: "admin_ro" });
    await screen.findByText("Total capital contribution");
    expect(screen.queryByRole("button", { name: "Process due items" })).toBeNull();
  });
});
