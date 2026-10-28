import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, SEED_CLASS, VALUATIONS, stockClass, TODAY, uuid, valuation } from "./support/acme.ts";
import { attach, commandRoute, errorOf, keysOf, type, unavailable, uploads, LOST } from "./support/flows.ts";
import { apiError, mock, type MockHandler } from "./support/mockApi.ts";
import { ECHO } from "./support/securities.ts";
import { base, renderPage } from "./support/render.tsx";

// 409A: Record FMV, flag a material event, the written confirmation, voiding
// a valuation and reversing a flag. No dry run exists for these routes: the review is the form's summary, and the
// rest of the cycle (one key per intent, the server's issues on their fields, retries) is the commands'.

const classes = mock(api.routes.listStockClasses, { ...ECHO, items: [stockClass(), SEED_CLASS] });
const V6 = uuid(8, 6);
const recordedValuation = valuation({ id: V6, name: "Oct 2026 Valuation", provider: "Harborline Valuation Partners", effectiveDate: TODAY, expirationDate: "2027-10-21", status: "presumptively_valid", presumptivelyValidUntil: "2027-10-21", prices: [{ stockClassId: IDS.common, pricePerShare: "1.12" }], importedFromPulley: false });
const event = (overrides: Partial<api.ValuationEvent> = {}): api.ValuationEvent => ({
  id: uuid(21, 1), kind: "MATERIAL_EVENT", eventDate: "2026-10-10", description: "Series B term sheet signed", documentId: null, reversesEventId: null, createdBy: "Rachel Ostrowski", createdAt: Date.UTC(2026, 9, 10, 17), ...overrides,
});
const flagged = valuation({ status: "review_required", events: [event()] });

function handlers(...extra: MockHandler[]): MockHandler[] {
  return [classes, mock(api.routes.listValuations, { items: VALUATIONS }), uploads(), ...extra];
}

async function fillValuation() {
  await screen.findByRole("heading", { name: "Record FMV", level: 1 });
  type(/Provider/, "Harborline Valuation Partners");
  type(/FMV per share — Common Stock/, "1.12");
  type(/FMV per share — Series Seed Preferred/, "1.60");
  await attach(/Valuation report/, "Oct 2026 Valuation.pdf");
}

describe("record FMV", () => {
  it("checks the provider, the common FMV, the report and a duplicate effective date", async () => {
    const record = commandRoute(api.routes.recordValuation, { commit: recordedValuation });
    const { callsTo } = renderPage("compliance/409a/new", handlers(record), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Record FMV", level: 1 });
    expect((screen.getByLabelText(/Expiration date/) as HTMLInputElement).value).toBe("2027-10-21");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(errorOf(/Provider/)).toBe("Provider is required.");
    expect(errorOf(/FMV per share — Common Stock/)).toBe("Enter the FMV of common.");
    expect(errorOf(/Valuation report/)).toBe("Upload the valuation report (PDF).");
    type(/Effective date/, "2025-11-05");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(errorOf(/Effective date/)).toBe("Nov 2025 Valuation is already recorded with the effective date Nov 5, 2025. Void it first if it was recorded in error.");
    expect(callsTo(api.routes.recordValuation)).toHaveLength(0);
  }, 60_000);

  it("reviews the valuation exactly as entered, records it with a key and retries with the same one", async () => {
    const record = commandRoute(api.routes.recordValuation, { commit: [unavailable(), recordedValuation] });
    const { callsTo, router } = renderPage("compliance/409a/new", handlers(record), { role: "admin_rw" });
    await fillValuation();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const review = await screen.findByLabelText("Review");
    expect(review.textContent).toContain("Record Oct 2026 Valuation from Harborline Valuation Partners: effective Oct 21, 2026, presumptively valid until Oct 21, 2027 at the latest.");
    expect(within(screen.getByRole("list", { name: "FMV per class" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Common Stock: $1.12", "Series Seed Preferred: $1.60"]);
    expect(review.textContent).toContain("Nov 2025 Valuation is superseded from Oct 21, 2026");
    fireEvent.click(screen.getByRole("button", { name: "Record valuation" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/compliance/409a`));
    expect(await screen.findByText("Oct 2026 Valuation recorded")).toBeTruthy();
    const calls = callsTo(api.routes.recordValuation);
    expect(keysOf(calls)[0]).toBe(keysOf(calls)[1]);
    expect(calls[1]!.body).toMatchObject({
      provider: "Harborline Valuation Partners", effectiveDate: TODAY, expirationDate: "2027-10-21",
      prices: [{ stockClassId: IDS.common, pricePerShare: "1.12" }, { stockClassId: IDS.seed, pricePerShare: "1.6" }],
    });
  }, 60_000);

  it("shows the server's issues on the fields and explains a reused key", async () => {
    const issues = apiError(400, "validation_failed", "Some fields are invalid", { issues: [{ path: "prices.0.pricePerShare", message: "Must be greater than 0" }, { path: "provider", message: "At most 200 characters" }] });
    const reused = apiError(409, "conflict", "Idempotency-Key was already used for a different request", { reason: "idempotency_key_reused" });
    const record = commandRoute(api.routes.recordValuation, { commit: [issues, reused] });
    renderPage("compliance/409a/new", handlers(record), { role: "admin_rw" });
    await fillValuation();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Record valuation" }));
    await waitFor(() => expect(errorOf(/FMV per share — Common Stock/)).toBe("Must be greater than 0"));
    expect(errorOf(/Provider/)).toBe("At most 200 characters");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Record valuation" }));
    expect(await screen.findByText(/This was already submitted with different details/)).toBeTruthy();
  }, 60_000);

  it("is closed to read-only admins", async () => {
    renderPage("compliance/409a/new", handlers(), { role: "admin_ro" });
    expect(await screen.findByText("You have read-only access")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  }, 60_000);
});

describe("409A events", () => {
  it("flags a material event after reviewing it, with the date's violation on its field and a retry with the same key", async () => {
    const noValuation = apiError(422, "invariant_violation", "Refused", { violations: [{ code: "NO_PRESUMPTIVELY_VALID_409A", message: "No valuation is presumptively valid on 2020-01-01" }] });
    const flag = commandRoute(api.routes.flagMaterialEvent, { commit: [noValuation, unavailable(), flagged] });
    const { callsTo } = renderPage("compliance/409a", handlers(flag), { role: "admin_rw" });
    fireEvent.click(await screen.findByRole("button", { name: "Flag a material event" }));
    await screen.findByRole("dialog", { name: "Flag a material event" });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(errorOf(/Description/)).toBe("Describe it.");
    type(/Date of the event/, "2020-01-01");
    type(/Description/, "Series B term sheet signed");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByLabelText("Review").textContent).toContain("Flag “Series B term sheet signed” on Jan 1, 2020.");
    fireEvent.click(screen.getByRole("button", { name: "Flag event" }));
    await waitFor(() => expect(errorOf(/Date of the event/)).toBe("No valuation is presumptively valid on 2020-01-01"));
    type(/Date of the event/, "2026-10-19");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Flag event" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Material event flagged — Nov 2025 Valuation: review required")).toBeTruthy();
    const calls = callsTo(api.routes.flagMaterialEvent);
    expect(calls.at(-1)!.body).toEqual({ eventDate: "2026-10-19", description: "Series B term sheet signed" });
    // The refused request leaves no receipt; the corrected one has its own key, reused by the retry of the lost answer.
    expect(keysOf(calls)[2]).toBe(keysOf(calls)[1]);
    expect(keysOf(calls)[1]).not.toBe(keysOf(calls)[0]);
  }, 60_000);

  it("records the written confirmation with its required letter", async () => {
    const clear = commandRoute(api.routes.clearValuationReview, { commit: valuation() });
    const { callsTo } = renderPage("compliance/409a", [classes, mock(api.routes.listValuations, { items: [flagged] }), uploads(), clear]);
    fireEvent.click(await screen.findByRole("button", { name: "Record written confirmation" }));
    await screen.findByRole("dialog", { name: "Record written confirmation" });
    type(/Description/, "Provider's bring-down letter");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(errorOf(/Confirmation letter/)).toBe("Upload the written confirmation.");
    await attach(/Confirmation letter/, "Provider confirmation letter.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Record confirmation" }));
    expect(await screen.findByText("Confirmation recorded — Nov 2025 Valuation is presumptively valid again")).toBeTruthy();
    const call = callsTo(api.routes.clearValuationReview)[0]!;
    expect(call.params.id).toBe(IDS.v5);
    expect(call.body).toMatchObject({ eventDate: TODAY, description: "Provider's bring-down letter" });
    expect(call.headers.get("Idempotency-Key")).toBeTruthy();
  }, 60_000);

  it("reverses a flag raised in error with a reason and the valuation's name typed", async () => {
    const reverse = commandRoute(api.routes.reverseValuationEvent, { commit: valuation({ events: [event(), event({ id: uuid(21, 9), kind: "EVENT_REVERSED", reversesEventId: uuid(21, 1), description: "Flagged on the wrong company" })] }) });
    const { callsTo } = renderPage("compliance/409a", [classes, mock(api.routes.listValuations, { items: [flagged] }), reverse]);
    const events = await screen.findByRole("table", { name: "Material events" });
    fireEvent.click(within(events).getByRole("button", { name: "Reverse the material event “Series B term sheet signed”" }));
    await screen.findByRole("dialog", { name: "Reverse a material-event flag" });
    type(/Reason/, "Flagged on the wrong company");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const confirm = screen.getByRole("button", { name: "Reverse flag" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "Nov 2025 Valuation" } });
    fireEvent.click(confirm);
    expect(await screen.findByText("Material event reversed — Nov 2025 Valuation")).toBeTruthy();
    const call = callsTo(api.routes.reverseValuationEvent)[0]!;
    expect(call.params).toMatchObject({ id: IDS.v5, eventId: uuid(21, 1) });
    expect(call.body).toEqual({ note: "Flagged on the wrong company", confirmation: "Nov 2025 Valuation" });
  }, 60_000);

  it("confirms a flag's reversal with the valuation's name exactly, and shows the server's refusal of anything else", async () => {
    // The confirmation is the valuation's name, case-sensitive; anything else is 400 on `confirmation`.
    const typo = apiError(400, "validation_failed", "Invalid", { issues: [{ path: "confirmation", message: "Type Nov 2025 Valuation to confirm" }] });
    const reverse = commandRoute(api.routes.reverseValuationEvent, { commit: [typo, valuation()] });
    const { callsTo } = renderPage("compliance/409a", [classes, mock(api.routes.listValuations, { items: [flagged] }), reverse]);
    fireEvent.click(within(await screen.findByRole("table", { name: "Material events" })).getByRole("button", { name: /Reverse the material event/ }));
    await screen.findByRole("dialog", { name: "Reverse a material-event flag" });
    type(/Reason/, "Flagged on the wrong company");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const confirm = screen.getByRole("button", { name: "Reverse flag" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "nov 2025 valuation" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: " Nov 2025 Valuation " } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(await screen.findByText("Type Nov 2025 Valuation to confirm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Reverse flag" }));
    expect(await screen.findByText("Material event reversed — Nov 2025 Valuation")).toBeTruthy();
    expect(callsTo(api.routes.reverseValuationEvent).map((call) => (call.body as { confirmation: string }).confirmation)).toEqual(["Nov 2025 Valuation", "Nov 2025 Valuation"]);
  }, 60_000);

  it("voids a valuation from its page", async () => {
    const detail = { ...valuation(), documents: [], grants: [] };
    const voided = commandRoute(api.routes.voidValuation, { commit: valuation({ status: "voided" }) });
    const { callsTo } = renderPage(`compliance/409a/${IDS.v5}`, [classes, mock(api.routes.getValuation, detail), voided]);
    await screen.findByRole("heading", { name: /Nov 2025 Valuation/, level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Void valuation/ }));
    await screen.findByRole("dialog", { name: "Void Nov 2025 Valuation" });
    type(/Why it is void/, "Recorded against the draft report");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Void valuation" }));
    expect(await screen.findByText("Nov 2025 Valuation voided")).toBeTruthy();
    expect(callsTo(api.routes.voidValuation)[0]!.body).toEqual({ eventDate: TODAY, description: "Recorded against the draft report" });
  }, 60_000);

  it.each([
    ["clear", "Record written confirmation", "Record confirmation", "Confirmation recorded — Nov 2025 Valuation is presumptively valid again"],
    ["void", "Void Nov 2025 Valuation", "Void valuation", "Nov 2025 Valuation voided"],
    ["reverse", "Reverse a material-event flag", "Reverse flag", "Material event reversed — Nov 2025 Valuation"],
  ] as const)("%s: shows the server's issue on its field and retries a lost answer with the same key", async (kind, title, confirm, done) => {
    const route = kind === "clear" ? api.routes.clearValuationReview : kind === "void" ? api.routes.voidValuation : api.routes.reverseValuationEvent;
    const issue = apiError(400, "validation_failed", "Invalid", { issues: [{ path: kind === "reverse" ? "note" : "description", message: "At most 2,000 characters" }] });
    const write = commandRoute(route, { commit: [issue, unavailable(), valuation()] });
    const detail = { ...flagged, documents: [], grants: [] };
    const { callsTo } = renderPage(kind === "void" ? `compliance/409a/${IDS.v5}` : "compliance/409a", [classes, mock(api.routes.listValuations, { items: [flagged] }), mock(api.routes.getValuation, detail), uploads(), write]);
    if (kind === "clear") fireEvent.click(await screen.findByRole("button", { name: "Record written confirmation" }));
    if (kind === "void") {
      await screen.findByRole("heading", { name: /Nov 2025 Valuation/, level: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Actions" }));
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Void valuation/ }));
    }
    if (kind === "reverse") fireEvent.click(within(await screen.findByRole("table", { name: "Material events" })).getByRole("button", { name: /Reverse the material event/ }));
    await screen.findByRole("dialog", { name: title });
    const text = kind === "reverse" ? /Reason/ : kind === "void" ? /Why it is void/ : /Description/;
    type(text, "Provider's letter");
    if (kind === "clear") await attach(/Confirmation letter/, "Provider confirmation letter.pdf");
    const submit = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      if (kind === "reverse") fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "Nov 2025 Valuation" } });
      fireEvent.click(screen.getByRole("button", { name: confirm }));
    };
    await submit();
    await waitFor(() => expect(errorOf(text)).toBe("At most 2,000 characters"));
    await submit();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(done)).toBeTruthy();
    expect(callsTo(route)).toHaveLength(3);
    expect(keysOf(callsTo(route))[2]).toBe(keysOf(callsTo(route))[1]);
  }, 60_000);

  it("gives every admin the event writes, and keeps every write from editors", async () => {
    renderPage("compliance/409a", [classes, mock(api.routes.listValuations, { items: [flagged] })], { role: "admin_rw" });
    const events = await screen.findByRole("table", { name: "Material events" });
    expect(within(events).getByRole("button", { name: /Reverse/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Flag a material event" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record written confirmation" })).toBeTruthy();
    renderPage("compliance/409a", [classes, mock(api.routes.listValuations, { items: [flagged] })], { role: "admin_ro" });
    await waitFor(() => expect(screen.getAllByRole("table", { name: "Material events" })).toHaveLength(2));
    expect(screen.getAllByRole("button", { name: "Flag a material event" })).toHaveLength(1);
  }, 60_000);
});
