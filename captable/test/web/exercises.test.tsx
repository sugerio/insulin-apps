import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, securityList, stakeholderList, TODAY, uuid } from "./support/acme.ts";
import { apiError, mock } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

function exercise(overrides: Partial<api.ExerciseRecord> = {}): api.ExerciseRecord {
  return api.exerciseRecordSchema.parse({
    transactionId: uuid(17, 1), commandId: uuid(9, 7), exerciseDate: "2026-03-20", stakeholderId: IDS.daniel, stakeholderName: "Daniel Achterberg",
    securityId: IDS.opt1, grantDisplayId: "OPT-1", quantity: "50000", isoQuantity: "50000", nsoQuantity: "0", exercisePrice: "0.1", cost: "5000",
    paymentMethod: "CHECK", paymentReference: "1042", fmvPerShare: "0.44", taxTreatment: null, withholding: null,
    resultingShares: [{ securityId: IDS.cs7, displayId: "CS-7", portion: "ISO" }], source: { kind: "recorded", requestNumber: null }, reversed: false,
    ...overrides,
  });
}

const EXERCISES = [
  exercise(),
  exercise({
    transactionId: uuid(17, 2), exerciseDate: "2026-08-12", stakeholderId: IDS.nadia, stakeholderName: "Nadia Pereira-Stone", securityId: IDS.opt21, grantDisplayId: "OPT-21",
    quantity: "19000", isoQuantity: "0", nsoQuantity: "19000", exercisePrice: "0.31", cost: "5890", paymentMethod: "ACH", paymentReference: "EX-OPT-21-NPS",
    fmvPerShare: "0.95", taxTreatment: "W2", withholding: { federalIncome: "2675.2", socialSecurity: "753.92", medicare: "176.32", state: [{ code: "CA", amount: "1094.4" }] },
    resultingShares: [{ securityId: uuid(6, 8), displayId: "CS-8", portion: "NSO" }], source: { kind: "request", requestNumber: 2 },
  }),
  exercise({ transactionId: uuid(17, 3), exerciseDate: "2025-08-20", paymentMethod: "WIRE", source: { kind: "migrated", requestNumber: null } }),
];

const REQUEST: api.ExerciseRequest = api.exerciseRequestSchema.parse({
  id: uuid(22, 2), requestNumber: 2, securityId: IDS.opt21, stakeholderId: IDS.nadia, quantity: "19000", isoQuantity: "0", nsoQuantity: "19000",
  exercisePrice: "0.31", fmvPerShare: "0.95", valuationId: IDS.v5, estimatedWithholding: "4699.84", totalCost: "10589.84", currency: "USD", paymentMethod: "ACH",
  status: "EXERCISED", pulleyStatus: "EXERCISED", paymentDueDate: "2026-08-10", paymentReceivedOn: "2026-08-11", exerciseDate: "2026-08-12",
  completedCommandId: uuid(9, 20), decidedAt: Date.UTC(2026, 7, 3, 17), cancelledAt: null,
  documents: [{ id: uuid(10, 20), filename: "ER-2 Notice of exercise.pdf", kind: "NOTICE_OF_EXERCISE" }], importedFromPulley: true, createdAt: Date.UTC(2026, 7, 1, 17),
});

const handlers = [
  mock(api.routes.listExercises, { items: EXERCISES }),
  mock(api.routes.listExerciseRequests, { items: [REQUEST, { ...REQUEST, id: uuid(22, 3), requestNumber: 3, status: "REJECTED", pulleyStatus: "REJECTED", exerciseDate: null, documents: [] }] }),
  mock(api.routes.listStakeholders, stakeholderList()),
  mock(api.routes.listSecurities, securityList()),
];

function rowOf(table: HTMLElement, text: string) {
  return within(table).getAllByRole("row").find((row) => within(row).queryByText(text)) as HTMLElement;
}

describe("exercise requests", () => {
  it("shows the not-yet banner, the KPI tiles and every exercise", async () => {
    renderPage("exercise-requests", handlers);
    expect(await screen.findByText("Holders can't request an exercise in the app yet")).toBeTruthy();
    const tiles = await screen.findByRole("list", { name: "Exercise summary" });
    expect(within(tiles).getByText("Exercises in 2026")).toBeTruthy();
    expect(within(tiles).getByText("2")).toBeTruthy();
    expect(within(tiles).getByText("ISO 1 · NSO 1")).toBeTruthy();
    expect(within(tiles).getByText("ACH 1 · Check 1")).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Exercises" });
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("Aug 12, 2026");
    const nso = rowOf(table, "OPT-21");
    expect(within(nso).getByText("19,000")).toBeTruthy();
    expect(within(nso).getByText("$5,890.00")).toBeTruthy();
    expect(within(nso).getByText("W-2")).toBeTruthy();
    expect(within(nso).getByText("$4,699.84")).toBeTruthy();
    expect(within(nso).getByText("Request ER-2")).toBeTruthy();
    expect(within(rowOf(table, "Aug 20, 2025")).getByText("Imported from Pulley")).toBeTruthy();
    expect(await within(nso).findByText("Terminated")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Exercises (3)" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens an exercise in a drawer with payment, tax and withholding entered", async () => {
    renderPage("exercise-requests", handlers);
    const table = await screen.findByRole("table", { name: "Exercises" });
    fireEvent.click(within(rowOf(table, "OPT-21")).getByRole("button", { name: /View/ }));
    const drawer = screen.getByRole("dialog", { name: "Exercise — OPT-21 · Aug 12, 2026" });
    expect(within(drawer).getByText("0 ISO · 19,000 NSO")).toBeTruthy();
    expect(within(drawer).getByText("$12,160.00")).toBeTruthy();
    expect(within(drawer).getByText("ACH · ref EX-OPT-21-NPS")).toBeTruthy();
    expect(within(drawer).getByText("Federal $2,675.20 · Social Security $753.92 · Medicare $176.32 · State $1,094.40 (CA)")).toBeTruthy();
    expect(within(drawer).getByText("Former")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters exercises by payment method", async () => {
    renderPage("exercise-requests", handlers);
    const table = await screen.findByRole("table", { name: "Exercises" });
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Payment method" }), { target: { value: "ACH" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  it("shows the migrated requests with Pulley's statuses and their history", async () => {
    const { router } = renderPage(`${base}/exercise-requests?tab=requests`, handlers);
    const table = await screen.findByRole("table", { name: "Requests (migrated)" });
    expect(router.state.location.search).toBe("?tab=requests");
    const exercised = rowOf(table, "ER-2");
    expect(within(exercised).getByText("Exercised")).toBeTruthy();
    expect(within(exercised).getByText("NSO")).toBeTruthy();
    expect(within(exercised).getByText("$10,589.84")).toBeTruthy();
    expect(within(exercised).getByRole("button", { name: "Notice" })).toBeTruthy();
    expect(await within(exercised).findByText("OPT-21")).toBeTruthy();
    expect(within(rowOf(table, "ER-3")).getByText("Rejected")).toBeTruthy();
    fireEvent.click(within(exercised).getByRole("button", { name: /History/ }));
    const drawer = screen.getByRole("dialog", { name: "ER-2 — history (Pulley)" });
    expect(within(drawer).getByText("Payment received")).toBeTruthy();
    expect(within(drawer).getByText(/Pulley: EXERCISED/)).toBeTruthy();
    expect(within(drawer).getByText("Migrated history, read-only.")).toBeTruthy();
  });

  it("shows a migrated request on its own page", async () => {
    renderPage(`exercise-requests/${REQUEST.id}`, [
      mock(api.routes.getExerciseRequest, REQUEST),
      mock(api.routes.getStakeholder, { ...stakeholderList().items.find((item) => item.id === IDS.nadia)!, asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0", exercises: [] }),
      mock(api.routes.getSecurity, () => apiError(404, "not_found", "Not found")),
    ]);
    expect(await screen.findByRole("heading", { name: /ER-2/, level: 1 })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("link", { name: "Nadia Pereira-Stone" })).toBeTruthy());
  });

  it("shows the empty states", async () => {
    renderPage("exercise-requests", [mock(api.routes.listExercises, { items: [] }), mock(api.routes.listExerciseRequests, { items: [] }), ...handlers.slice(2)]);
    expect(await screen.findByText("No exercises yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Requests (migrated) (0)" }));
    expect(await screen.findByText("No exercise requests were migrated.")).toBeTruthy();
  });
});
