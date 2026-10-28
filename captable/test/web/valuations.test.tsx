import "./setup.ts";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, SEED_CLASS, stakeholderList, stockClass, TODAY, uuid, valuation, VALUATIONS } from "./support/acme.ts";
import { apiError, mock } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

const ECHO = { asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0" };
const classes = mock(api.routes.listStockClasses, { ...ECHO, items: [stockClass(), SEED_CLASS] });
const event = (overrides: Partial<api.ValuationEvent> = {}): api.ValuationEvent => ({
  id: uuid(21, 1), kind: "MATERIAL_EVENT", eventDate: "2026-10-10", description: "Series B term sheet signed", documentId: null, reversesEventId: null,
  createdBy: "Rachel Ostrowski", createdAt: Date.UTC(2026, 9, 10, 17), ...overrides,
});

function rowOf(table: HTMLElement, text: string) {
  return within(table).getAllByRole("row").find((row) => within(row).queryByText(text)) as HTMLElement;
}

describe("409A valuations", () => {
  it("lists valuations with their computed status and warns that the current one expires soon", async () => {
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: VALUATIONS }), classes]);
    expect(await screen.findByText("The current 409A (Nov 5, 2025) is presumptively valid until Nov 5, 2026 — 15 days left")).toBeTruthy();
    expect(screen.getByText("New grants after that date need a new valuation.")).toBeTruthy();
    const table = screen.getByRole("table", { name: "409A valuations" });
    const current = rowOf(table, "Nov 2025 Valuation");
    expect(within(current).getByText("Presumptively valid — 15 days left")).toBeTruthy();
    expect(within(current).getByText("$0.95")).toBeTruthy();
    expect(within(current).getByText("Carver Valuation Advisors")).toBeTruthy();
    expect(within(current).getByRole("button", { name: "Download the report of Nov 2025 Valuation" })).toBeTruthy();
    expect(within(rowOf(table, "Mar 2025 Valuation")).getByText("Superseded")).toBeTruthy();
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("Nov 2025 Valuation");
    expect(screen.getByRole("tab", { name: "409A Valuations" }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows a review-required valuation in red, its open material event, and the confirmation action", async () => {
    const flagged = valuation({ status: "review_required", events: [event()] });
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: [flagged] }), classes]);
    expect(await screen.findByText("Nov 2025 Valuation needs review — material event on Oct 10, 2026")).toBeTruthy();
    const events = screen.getByRole("table", { name: "Material events" });
    expect(within(events).getByText("Series B term sheet signed")).toBeTruthy();
    expect(within(events).getByText("Open — review required")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Record written confirmation" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("link", { name: "Record FMV" }).getAttribute("href")).toBe(`${base}/compliance/409a/new`);
  });

  it("shows an expired valuation and the empty state", async () => {
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: [valuation({ status: "expired", presumptivelyValidUntil: null })] }), classes]);
    expect(await screen.findByText("The current 409A expired on Nov 5, 2026")).toBeTruthy();
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: [] }), classes]);
    expect(await screen.findByText("No 409A recorded")).toBeTruthy();
    expect(screen.getByText("No 409A valuations recorded yet.")).toBeTruthy();
  });

  it("hides the write buttons from editors and gives every admin the confirmation", async () => {
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: [valuation({ status: "review_required", events: [event()] })] }), classes], { role: "admin_ro" });
    await screen.findByRole("table", { name: "409A valuations" });
    expect(screen.queryByRole("link", { name: "Record FMV" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Flag a material event" })).toBeNull();
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: [valuation({ status: "review_required", events: [event()] })] }), classes], { role: "admin_rw" });
    expect(await screen.findByRole("link", { name: "Record FMV" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Record written confirmation" })).toBeTruthy();
  });

  it("shows a valuation's FMV per class, status history, documents and the grants priced with it", async () => {
    const detail = { ...valuation({ events: [event(), event({ id: uuid(21, 2), kind: "REVIEW_CLEARED", eventDate: "2026-10-15", description: "Provider confirmed the value holds" })] }), documents: [{ id: IDS.doc1, filename: "Nov 2025 Valuation.pdf", kind: "VALUATION_REPORT" as const }], grants: [{ securityId: IDS.opt49, displayId: "OPT-49", stakeholderId: IDS.daniel, grantDate: "2026-09-04", exercisePrice: "0.95" }, { securityId: uuid(6, 150), displayId: "OPT-50", stakeholderId: IDS.daniel, grantDate: "2026-09-04", exercisePrice: "0.9" }] };
    renderPage(`compliance/409a/${IDS.v5}`, [mock(api.routes.getValuation, detail), classes, mock(api.routes.listStakeholders, stakeholderList())]);
    expect(await screen.findByRole("heading", { name: /Nov 2025 Valuation/, level: 1 })).toBeTruthy();
    expect(await screen.findByText("Not valued")).toBeTruthy();
    const history = screen.getByRole("list", { name: "Status history" });
    expect(within(history).getByText("Review required — Series B term sheet signed")).toBeTruthy();
    expect(within(history).getByText("Review cleared — Provider confirmed the value holds")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nov 2025 Valuation.pdf" })).toBeTruthy();
    const grants = screen.getByRole("table", { name: "Grants priced with this valuation" });
    expect(within(rowOf(grants, "OPT-49")).getByText("Yes")).toBeTruthy();
    expect(within(rowOf(grants, "OPT-50")).getByText("No")).toBeTruthy();
    expect(await within(grants).findAllByRole("link", { name: "Daniel Achterberg" })).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Grants priced with this valuation (2)" })).toBeTruthy();
  });

  it("never presents another valuation type or a draft 409A as the 409A in effect", async () => {
    const other = valuation({ id: uuid(8, 7), name: "Sep 2026 Token Valuation", valuationType: "OTHER", effectiveDate: "2026-09-01", expirationDate: null, status: "not_409a", presumptivelyValidUntil: null, prices: [{ stockClassId: IDS.common, pricePerShare: "1.2" }], reportDocumentId: null });
    const draft = valuation({ id: uuid(8, 8), name: "Oct 2026 Draft", reportVersion: "DRAFT", effectiveDate: "2026-10-01", expirationDate: "2027-10-01", status: "draft", presumptivelyValidUntil: null, events: [event({ id: uuid(21, 9), description: "Flag recorded on a draft" })], reportDocumentId: null });
    renderPage("compliance/409a", [mock(api.routes.listValuations, { items: [...VALUATIONS, other, draft] }), classes]);
    // The banner is the final 409A's, not the later token valuation's or the draft's.
    expect(await screen.findByText("The current 409A (Nov 5, 2025) is presumptively valid until Nov 5, 2026 — 15 days left")).toBeTruthy();
    const table = screen.getByRole("table", { name: "409A valuations" });
    expect(within(rowOf(table, "Sep 2026 Token Valuation")).getByText("Not a 409A — never in effect for grants")).toBeTruthy();
    expect(within(rowOf(table, "Sep 2026 Token Valuation")).getByText("Other valuation")).toBeTruthy();
    expect(within(rowOf(table, "Oct 2026 Draft")).getByText("Draft report — not in effect")).toBeTruthy();
    // Only a final 409A carries material events.
    expect(screen.queryByRole("table", { name: "Material events" })).toBeNull();
  });

  it("says on its page that another valuation type never counts as the 409A", async () => {
    const other = { ...valuation({ id: uuid(8, 7), name: "Sep 2026 Token Valuation", valuationType: "OTHER", effectiveDate: "2026-09-01", expirationDate: null, status: "not_409a", presumptivelyValidUntil: null, reportDocumentId: null }), documents: [], grants: [] };
    renderPage(`compliance/409a/${uuid(8, 7)}`, [mock(api.routes.getValuation, other), classes]);
    expect(await screen.findByText("Not a 409A valuation")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Status history" })).getByText("Effective (not a 409A)")).toBeTruthy();
    expect(screen.queryByText("Presumptively valid")).toBeNull();
  });

  it("never describes a draft 409A's events, validity or grants in 409A terms", async () => {
    const draft = {
      // Even with a validity date in the record, a draft shows none.
      ...valuation({ id: uuid(8, 8), name: "Oct 2026 Draft", reportVersion: "DRAFT", effectiveDate: "2026-10-01", expirationDate: "2027-10-01", status: "draft", presumptivelyValidUntil: "2027-10-01", events: [event({ id: uuid(21, 9), description: "Flag recorded on the draft" })], reportDocumentId: null }),
      documents: [],
      grants: [{ securityId: IDS.opt49, displayId: "OPT-49", stakeholderId: IDS.daniel, grantDate: "2026-10-05", exercisePrice: "0.5", stockClassId: IDS.common }],
    };
    renderPage(`compliance/409a/${uuid(8, 8)}`, [mock(api.routes.getValuation, draft), classes, mock(api.routes.listStakeholders, stakeholderList())]);
    expect(await screen.findByText("A draft 409A report")).toBeTruthy();
    const history = screen.getByRole("list", { name: "Status history" });
    expect(within(history).getByText("Material event recorded (no effect: not a final 409A) — Flag recorded on the draft")).toBeTruthy();
    expect(within(history).queryByText(/Review required/)).toBeNull();
    expect(screen.queryByText("Presumptively valid until")).toBeNull();
    expect(screen.getByRole("heading", { name: "Grants that name this valuation (1)" })).toBeTruthy();
    const grants = await screen.findByRole("table", { name: "Grants that name this valuation" });
    expect(within(grants).queryByText("Strike ≥ FMV")).toBeNull();
    expect(screen.queryByText(/priced with this valuation/)).toBeNull();
  });

  it("answers an unknown valuation with the not-found state", async () => {
    renderPage(`compliance/409a/${uuid(8, 99)}`, [mock(api.routes.getValuation, () => apiError(404, "not_found", "Not found")), classes]);
    expect(await screen.findByText("This valuation does not exist.")).toBeTruthy();
  });
});
