import "./setup.ts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, capTable, securitiesStatus, securityList, stakeholderList, uuid } from "./support/acme.ts";
import { DIFF_A, DIFF_B, EFFECT_B, asReviewed, attach, choose, commandRoute, dryRuns, errorOf, expectNotDismissible, keysOf, realCalls, refused, result, stale, type, unavailable, uploads, waitForCalls, LOST, expectSentAsPreviewed } from "./support/flows.ts";
import { apiError, mock, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { DETAILS, securityHandlers } from "./support/securities.ts";
import { base, renderPage } from "./support/render.tsx";

// The security dialogs: Cancel, the cap table's bulk cancel,
// Mark executed, Extend exercise deadline and Reverse. Each runs its dry run (or the reversal preview), shows the
// server's figures, asks for the typed ID, and records with one key per intent.

function handlers(...extra: MockHandler[]): MockHandler[] {
  const routes = new Set(extra.map((handler) => handler.route));
  return [...securityHandlers.filter((handler) => !routes.has(handler.route)), uploads(), ...extra];
}

async function openAction(securityId: string, heading: string, item: RegExp) {
  await screen.findByRole("heading", { name: heading, level: 1 });
  fireEvent.click(screen.getByRole("button", { name: "Actions" }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: item }));
  void securityId;
}

const cancelPreview = (overrides: Partial<api.CommandResult> = {}) => result({
  transactions: [{ id: null, seq: null, type: "TX_EQUITY_COMPENSATION_CANCELLATION", effectiveDate: "2026-10-21", securityId: IDS.opt1, quantity: "250000" }],
  changes: [
    { entity: "security", id: IDS.opt1, before: { displayId: "OPT-1", status: "OUTSTANDING", outstanding: "250000", cancelled: "0" }, after: { displayId: "OPT-1", status: "CANCELLED", outstanding: "0", cancelled: "250000" } },
    { entity: "pool", id: IDS.plan, before: { availableToGrant: "460750" }, after: { availableToGrant: "710750" } },
  ],
  ...overrides,
});

describe("cancel security", () => {
  it("checks the quantity and the document before the dry run", async () => {
    const cancel = commandRoute(api.routes.cancelSecurity, { preview: cancelPreview() });
    const { callsTo } = renderPage(`securities/${IDS.opt1}`, handlers(cancel), { role: "admin_rw" });
    await openAction(IDS.opt1, "OPT-1 Options", /^Cancel/);
    const dialog = await screen.findByRole("dialog", { name: "Cancel OPT-1" });
    expect((within(dialog).getByLabelText(/Quantity/) as HTMLInputElement).value).toBe("250000");
    fireEvent.change(within(dialog).getByLabelText(/Quantity/), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    expect(errorOf(/Quantity/)).toBe("Enter the quantity to cancel.");
    expect(errorOf(/Supporting document/)).toBe("Upload the waiver, agreement or evidence that the grant will not be executed.");
    // The first field with an error takes the focus, and the errors are announced once.
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText(/Quantity/)));
    expect(screen.getByText("2 fields need attention. Quantity: Enter the quantity to cancel.")).toBeTruthy();
    expect(callsTo(api.routes.cancelSecurity)).toHaveLength(0);
  }, 60_000);

  it("previews the cancellation, asks for the typed ID and records it with the reviewed seq, diff and key", async () => {
    const cancel = commandRoute(api.routes.cancelSecurity, { preview: cancelPreview(), commit: result({ ...cancelPreview(), commandId: uuid(30, 4), dryRun: false, ledgerSeq: 413 }, true) });
    const { callsTo } = renderPage(`securities/${IDS.opt1}`, handlers(cancel), { role: "admin_rw" });
    await openAction(IDS.opt1, "OPT-1 Options", /^Cancel/);
    await screen.findByRole("dialog", { name: "Cancel OPT-1" });
    await attach(/Supporting document/, "OPT-1 waiver.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitForCalls(() => dryRuns(callsTo(api.routes.cancelSecurity)), 1);
    const sent = dryRuns(callsTo(api.routes.cancelSecurity))[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ securityId: IDS.opt1, effectiveDate: "2026-10-21", reason: "HOLDER_WAIVER" });
    // The dry run needs no typed ID (the contract made it optional); the real call carries the one typed.
    expect("confirmation" in sent).toBe(false);
    expect("quantity" in sent).toBe(false);
    const panel = await screen.findByRole("region", { name: "Server preview" });
    expect(within(within(panel).getByRole("table", { name: "Transactions" })).getAllByRole("row")[1]!.textContent).toBe("Option cancellationOct 21, 2026OPT-1250,000");
    expect(within(panel).getByRole("region", { name: "OPT-1" }).textContent).toContain("StatusOutstanding→Cancelled");
    expect(within(panel).getByRole("region", { name: "2023 Equity Incentive Plan — pool" }).textContent).toContain("Available to grant460,750→710,750");
    const confirm = screen.getByRole("button", { name: "Cancel security" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "OPT-1" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(await screen.findByText("OPT-1 cancelled — 250,000 options")).toBeTruthy();
    const real = realCalls(callsTo(api.routes.cancelSecurity))[0]!;
    expect(real.body).toMatchObject({ confirmation: "OPT-1", expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A, acknowledge: [] });
    expect(real.headers.get("Idempotency-Key")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }, 60_000);

  it("shows a violation on the quantity, retries with the same key and refreshes a stale preview", async () => {
    const fresh = cancelPreview({ ledgerSeq: 420, diffSha256: DIFF_B });
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: [refused([{ code: "EXCEEDS_OUTSTANDING", message: "Cancels 300000 of 250000 outstanding" }]), cancelPreview(), fresh],
      commit: [unavailable(), stale(), result({ ...fresh, commandId: uuid(30, 4), dryRun: false }, true)],
    });
    const { callsTo } = renderPage(`securities/${IDS.opt1}`, handlers(cancel), { role: "admin_rw" });
    await openAction(IDS.opt1, "OPT-1 Options", /^Cancel/);
    await screen.findByRole("dialog", { name: "Cancel OPT-1" });
    type(/Quantity/, "300,000");
    await attach(/Supporting document/, "OPT-1 waiver.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(errorOf(/Quantity/)).toBe("Cancels 300000 of 250000 outstanding"));
    type(/Quantity/, "250,000");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("region", { name: "Server preview" });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "OPT-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel security" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Review again")).toBeTruthy();
    await waitForCalls(() => dryRuns(callsTo(api.routes.cancelSecurity)), 3);
    fireEvent.click(screen.getByRole("button", { name: "Cancel security" }));
    expect(await screen.findByText(/OPT-1 cancelled/)).toBeTruthy();
    const real = realCalls(callsTo(api.routes.cancelSecurity));
    // The lost answer is retried with the same body and key; the request reviewed again after the stale answer is a
    // new body, with a new key.
    expect(real.map((call) => (call.body as { expectedLedgerSeq: number }).expectedLedgerSeq)).toEqual([412, 412, 420]);
    expect(real[1]!.body).toEqual(real[0]!.body);
    expect(keysOf(real)[1]).toBe(keysOf(real)[0]);
    expect(keysOf(real)[2]).not.toBe(keysOf(real)[0]);
    expectSentAsPreviewed(dryRuns(callsTo(api.routes.cancelSecurity))[2]!, real[2]!);
  }, 60_000);

  it("keeps a lost cancellation frozen while the ledger shows it may be recorded, and settles it with a retry", async () => {
    let seq = 412;
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: () => cancelPreview({ ledgerSeq: seq }),
      commit: [() => { seq = 413; return unavailable(); }, result({ ...cancelPreview(), commandId: uuid(30, 4), dryRun: false, ledgerSeq: 413 }, true)],
    });
    const { callsTo } = renderPage(`securities/${IDS.opt1}`, handlers(cancel), { role: "admin_rw" });
    await openAction(IDS.opt1, "OPT-1 Options", /^Cancel/);
    await screen.findByRole("dialog", { name: "Cancel OPT-1" });
    await attach(/Supporting document/, "OPT-1 waiver.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("region", { name: "Server preview" });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "OPT-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel security" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel security" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/to confirm/) as HTMLInputElement).disabled).toBe(true);
    // Escape, the backdrop and the close button can't drop the body and key the retry must resend.
    expectNotDismissible("Cancel OPT-1");
    // The ledger moved since the review, so the cancellation may be this one: the dialog stays frozen.
    fireEvent.click(screen.getByRole("button", { name: "Check what was recorded" }));
    expect(await screen.findByText(/^The server's state changed since your review, so it may be yours/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/OPT-1 cancelled/)).toBeTruthy();
    const real = realCalls(callsTo(api.routes.cancelSecurity));
    expect(real).toHaveLength(2);
    expect(real[1]!.body).toEqual(real[0]!.body);
    expect(keysOf(real)[1]).toBe(keysOf(real)[0]);
  }, 60_000);

  it("opens with its own URL and returns to the security when it closes", async () => {
    const { router } = renderPage(`securities/${IDS.opt1}/cancel`, handlers(commandRoute(api.routes.cancelSecurity, {})), { role: "admin_rw" });
    await screen.findByRole("dialog", { name: "Cancel OPT-1" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${IDS.opt1}`));
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 60_000);

  it("opens from Securities Status with Not executed for a pending grant, and is hidden from read-only admins", async () => {
    const cancel = commandRoute(api.routes.cancelSecurity, { preview: cancelPreview() });
    const status = [
      mock(api.routes.getSecuritiesStatus, securitiesStatus()), mock(api.routes.listSecurities, securityList()), mock(api.routes.listStakeholders, stakeholderList()),
    ];
    renderPage("securities-status", handlers(cancel, ...status), { role: "admin_rw" });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel OPT-49" }));
    await screen.findByRole("dialog", { name: "Cancel OPT-49" });
    expect((screen.getByLabelText(/Reason/) as HTMLSelectElement).value).toBe("NOT_EXECUTED");
    renderPage(`securities/${IDS.opt1}`, handlers(cancel), { role: "admin_ro" });
    await screen.findAllByRole("heading", { name: "OPT-1 Options", level: 1 });
    // A read-only admin's menu would hold only writes, so there is none.
    expect(screen.queryAllByRole("button", { name: "Actions" })).toHaveLength(0);
  }, 60_000);
});

const DIFF_C = "c3".repeat(32);
const EFFECT_C = "e3".repeat(32);

describe("cancel options from the cap table", () => {
  const capHandlers = (cancel: MockHandler) => handlers(
    cancel,
    mock(api.routes.getCapTable, (request: MockRequest) => capTable((request.query.get("tab") ?? "ownership") as "options")),
    mock(api.routes.listSecurities, securityList()),
    mock(api.routes.listStakeholders, stakeholderList()),
  );
  const previewFor = (id: string, quantity: string, display: string) => result({
    transactions: [{ id: null, seq: null, type: "TX_EQUITY_COMPENSATION_CANCELLATION", effectiveDate: "2026-10-21", securityId: id, quantity }],
    changes: [{ entity: "security", id, before: { displayId: display, outstanding: quantity }, after: { displayId: display, outstanding: "0" } }],
  });

  it("previews each grant, asks for the phrase and records one command per grant, each with its own key", async () => {
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: (request: MockRequest) => ((request.body as { securityId: string }).securityId === IDS.opt1 ? previewFor(IDS.opt1, "250000", "OPT-1") : previewFor(IDS.opt21, "60000", "OPT-21")),
      commit: [unavailable(), (request: MockRequest) => result({ ...previewFor((request.body as { securityId: string }).securityId, "1", "X"), commandId: uuid(30, 9), dryRun: false }, true)],
    });
    const { callsTo } = renderPage("captable?tab=options", capHandlers(cancel), { role: "admin_rw" });
    await screen.findByRole("table", { name: "Options" });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Cancel options/ }));
    const grants = await screen.findByRole("table", { name: "Grants to cancel" });
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    expect(screen.getByText("Select at least one grant.")).toBeTruthy();
    fireEvent.click(within(grants).getByLabelText("Select OPT-1"));
    fireEvent.click(within(grants).getByLabelText("Select OPT-21"));
    await attach(/Supporting document/, "Cancellation evidence.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    const review = await screen.findByRole("table", { name: "Cancellation preview" });
    expect(within(review).getAllByRole("row").map((row) => row.textContent)).toEqual([
      "IDStakeholderCancelled (server preview)Status", "OPT-1Daniel Achterberg250,000To cancel", "OPT-21Nadia Pereira-Stone60,000To cancel", "Total310,000",
    ]);
    expect(dryRuns(callsTo(api.routes.cancelSecurity)).map((call) => "confirmation" in (call.body as object))).toEqual([false, false]);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "cancel 2 grants" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel 2 grants" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("2 grants cancelled — each is its own audited command.")).toBeTruthy();
    const real = realCalls(callsTo(api.routes.cancelSecurity));
    const byGrant = (id: string) => real.filter((call) => (call.body as { securityId: string }).securityId === id);
    expect(byGrant(IDS.opt1)).toHaveLength(2);
    expect(new Set(keysOf(byGrant(IDS.opt1))).size).toBe(1);
    expect(keysOf(byGrant(IDS.opt21))[0]).not.toBe(keysOf(byGrant(IDS.opt1))[0]);
    // Each command confirms with its own grant's display ID.
    expect([byGrant(IDS.opt1)[0]!, byGrant(IDS.opt21)[0]!].map((call) => (call.body as { confirmation: string }).confirmation)).toEqual(["OPT-1", "OPT-21"]);
  }, 60_000);

  it("shows a refused grant on its row, and goes on after a stale answer when the grant's effect is unchanged", async () => {
    let fresh = false;
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: (request: MockRequest) => ((request.body as { securityId: string }).securityId === IDS.opt21
        ? refused([{ code: "SECURITY_NOT_OUTSTANDING", message: "OPT-21 is no longer outstanding", securityId: IDS.opt21 }])
        : result({ ...previewFor(IDS.opt1, "250000", "OPT-1"), ...(fresh ? { ledgerSeq: 420, diffSha256: DIFF_B } : {}) })),
      commit: [() => { fresh = true; return stale(); }, result({ ...previewFor(IDS.opt1, "250000", "OPT-1"), commandId: uuid(30, 9), dryRun: false }, true)],
    });
    const { callsTo } = renderPage("captable?tab=options", capHandlers(cancel), { role: "admin_rw" });
    await screen.findByRole("table", { name: "Options" });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Cancel options/ }));
    const grants = await screen.findByRole("table", { name: "Grants to cancel" });
    fireEvent.click(within(grants).getByLabelText("Select OPT-1"));
    fireEvent.click(within(grants).getByLabelText("Select OPT-21"));
    await attach(/Supporting document/, "Cancellation evidence.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    await waitFor(() => expect(errorOf("Select OPT-21")).toBe("OPT-21 is no longer outstanding"));
    expect(screen.getByText(/The server refused the grants marked below/)).toBeTruthy();
    expect(errorOf("Select OPT-1")).toBe("");
    fireEvent.click(within(grants).getByLabelText("Select OPT-21"));
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    const review = await screen.findByRole("table", { name: "Cancellation preview" });
    expect(within(review).getAllByRole("row").map((row) => row.textContent)).toEqual(["IDStakeholderCancelled (server preview)Status", "OPT-1Daniel Achterberg250,000To cancel", "Total250,000"]);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "cancel 1 grant" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel 1 grant" }));
    // 409 stale_ledger: the dry run is run again; the same effect goes on at the new seq and diff without asking.
    expect(await screen.findByText("1 grant cancelled — each is its own audited command.")).toBeTruthy();
    const real = realCalls(callsTo(api.routes.cancelSecurity));
    expect(real.map((call) => call.body)).toMatchObject([
      { securityId: IDS.opt1, expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A }, { securityId: IDS.opt1, expectedLedgerSeq: 420, expectedDiffSha256: DIFF_B },
    ]);
    // The new seq and diff make a new body, so it gets a new key.
    expect(keysOf(real)[1]).not.toBe(keysOf(real)[0]);
  }, 60_000);

  it("freezes the batch after a lost answer: Back waits until the check finds nothing recorded, and a changed batch gets new keys", async () => {
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: () => previewFor(IDS.opt1, "250000", "OPT-1"),
      commit: [unavailable(), (request: MockRequest) => result({ ...previewFor((request.body as { securityId: string }).securityId, "250000", "OPT-1"), commandId: uuid(30, 9), dryRun: false }, true)],
    });
    const { callsTo } = renderPage("captable?tab=options", capHandlers(cancel), { role: "admin_rw" });
    await screen.findByRole("table", { name: "Options" });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Cancel options/ }));
    const grants = await screen.findByRole("table", { name: "Grants to cancel" });
    fireEvent.click(within(grants).getByLabelText("Select OPT-1"));
    await attach(/Supporting document/, "Cancellation evidence.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    await screen.findByRole("table", { name: "Cancellation preview" });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "cancel 1 grant" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel 1 grant" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    expectNotDismissible("Review the cancellation");
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel 1 grant" }) as HTMLButtonElement).disabled).toBe(true);
    // The ledger head is the one reviewed: the cancellation wasn't recorded, so the batch can change.
    fireEvent.click(screen.getByRole("button", { name: "Check what was recorded" }));
    expect(await screen.findByText(/the server has no record of it, so nothing was recorded/)).toBeTruthy();
    await waitFor(() => expect(back.disabled).toBe(false));
    fireEvent.click(back);
    choose(/Reason/, "MUTUAL_AGREEMENT");
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    await screen.findByRole("table", { name: "Cancellation preview" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel 1 grant" }));
    expect(await screen.findByText("1 grant cancelled — each is its own audited command.")).toBeTruthy();
    const real = realCalls(callsTo(api.routes.cancelSecurity));
    expect(real.map((call) => (call.body as { reason: string }).reason)).toEqual(["HOLDER_WAIVER", "MUTUAL_AGREEMENT"]);
    expect(keysOf(real)[1]).not.toBe(keysOf(real)[0]);
  }, 60_000);

  it("sends, refreshes and checks each grant with exactly the request its dry run previewed", async () => {
    let refreshed = false;
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: (request: MockRequest) => result({ ...previewFor((request.body as { securityId: string }).securityId, "250000", "OPT-1"), ...(refreshed ? { ledgerSeq: 420, diffSha256: DIFF_B } : {}) }),
      commit: [() => { refreshed = true; return stale(); }, unavailable(), (request: MockRequest) => result({ ...previewFor((request.body as { securityId: string }).securityId, "250000", "OPT-1"), commandId: uuid(30, 9), dryRun: false }, true)],
    });
    const { callsTo } = renderPage("captable?tab=options", capHandlers(cancel), { role: "admin_rw" });
    await screen.findByRole("table", { name: "Options" });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Cancel options/ }));
    const grants = await screen.findByRole("table", { name: "Grants to cancel" });
    fireEvent.click(within(grants).getByLabelText("Select OPT-1"));
    choose(/Reason/, "MUTUAL_AGREEMENT");
    await attach(/Supporting document/, "Cancellation evidence.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    await screen.findByRole("table", { name: "Cancellation preview" });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "cancel 1 grant" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel 1 grant" }));
    // Stale: the dry run is run again from the reviewed request (not from the form); the effect is unchanged, so the
    // grant is sent again at the new seq, and that answer is lost.
    expect(await screen.findByText(LOST)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check what was recorded" }));
    expect(await screen.findByText(/the server has no record of it, so nothing was recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel 1 grant" }));
    expect(await screen.findByText("1 grant cancelled — each is its own audited command.")).toBeTruthy();
    const reviewed = { securityId: IDS.opt1, effectiveDate: "2026-10-21", reason: "MUTUAL_AGREEMENT", documentId: uuid(40, 1) };
    // The first dry run, the stale refresh and the check: the same request each time.
    expect(dryRuns(callsTo(api.routes.cancelSecurity)).map((call) => call.body)).toEqual([reviewed, reviewed, reviewed]);
    expect(realCalls(callsTo(api.routes.cancelSecurity)).map((call) => asReviewed(call.body))).toEqual([reviewed, reviewed, reviewed]);
  }, 60_000);

  /** Opens Cancel options, selects the grants and reviews them. */
  async function reviewBatch(ids: readonly string[], labels: readonly string[]) {
    await screen.findByRole("table", { name: "Options" });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Cancel options/ }));
    const grants = await screen.findByRole("table", { name: "Grants to cancel" });
    for (const label of labels) fireEvent.click(within(grants).getByLabelText(`Select ${label}`));
    await attach(/Supporting document/, "Cancellation evidence.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Review…" }));
    await screen.findByRole("table", { name: "Cancellation preview" });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: `cancel ${ids.length} grant${ids.length === 1 ? "" : "s"}` } });
  }

  it("cancels a later grant without asking again when its effect is unchanged, at its new seq and diff", async () => {
    let first = true;
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: (request: MockRequest) => {
        const id = (request.body as { securityId: string }).securityId;
        if (id === IDS.opt1) return result({ ...previewFor(IDS.opt1, "250000", "OPT-1") });
        // OPT-21 previewed again after OPT-1 was recorded: a new head and a new exact diff (the pool's absolute values
        // moved), the same effect.
        return first ? result({ ...previewFor(IDS.opt21, "60000", "OPT-21"), diffSha256: DIFF_B, effectSha256: EFFECT_B })
          : result({ ...previewFor(IDS.opt21, "60000", "OPT-21"), ledgerSeq: 413, diffSha256: DIFF_C, effectSha256: EFFECT_B });
      },
      commit: (request: MockRequest) => {
        first = false;
        return result({ ...previewFor((request.body as { securityId: string }).securityId, "1", "X"), commandId: uuid(30, 9), dryRun: false }, true);
      },
    });
    const { callsTo } = renderPage("captable?tab=options", capHandlers(cancel), { role: "admin_rw" });
    await reviewBatch([IDS.opt1, IDS.opt21], ["OPT-1", "OPT-21"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel 2 grants" }));
    expect(await screen.findByText("2 grants cancelled — each is its own audited command.")).toBeTruthy();
    expect(realCalls(callsTo(api.routes.cancelSecurity)).map((call) => call.body)).toMatchObject([
      { securityId: IDS.opt1, expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A },
      { securityId: IDS.opt21, expectedLedgerSeq: 413, expectedDiffSha256: DIFF_C },
    ]);
    // Two reviewed dry runs, and OPT-21's again before it was sent (the effect hash itself is never sent back).
    expect(dryRuns(callsTo(api.routes.cancelSecurity)).map((call) => (call.body as { securityId: string }).securityId)).toEqual([IDS.opt1, IDS.opt21, IDS.opt21]);
    expect(realCalls(callsTo(api.routes.cancelSecurity)).some((call) => "expectedEffectSha256" in (call.body as object) || "effectSha256" in (call.body as object))).toBe(false);
  }, 60_000);

  it("stops at a later grant whose effect changed and shows its changed preview to confirm again", async () => {
    let recorded = 0;
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: (request: MockRequest) => {
        const id = (request.body as { securityId: string }).securityId;
        if (id === IDS.opt1) return result({ ...previewFor(IDS.opt1, "250000", "OPT-1") });
        // Someone exercised part of OPT-21 meanwhile: cancelling it now cancels less.
        return recorded === 0 ? result({ ...previewFor(IDS.opt21, "60000", "OPT-21"), diffSha256: DIFF_B, effectSha256: EFFECT_B })
          : result({ ...previewFor(IDS.opt21, "50000", "OPT-21"), ledgerSeq: 414, diffSha256: DIFF_C, effectSha256: EFFECT_C });
      },
      commit: (request: MockRequest) => {
        recorded += 1;
        return result({ ...previewFor((request.body as { securityId: string }).securityId, "1", "X"), commandId: uuid(30, 9), dryRun: false }, true);
      },
    });
    const { callsTo } = renderPage("captable?tab=options", capHandlers(cancel), { role: "admin_rw" });
    await reviewBatch([IDS.opt1, IDS.opt21], ["OPT-1", "OPT-21"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel 2 grants" }));
    expect(await screen.findByText(/OPT-21: Since you confirmed, what its cancellation does has changed/)).toBeTruthy();
    const review = screen.getByRole("table", { name: "Cancellation preview" });
    expect(within(review).getAllByRole("row").map((row) => row.textContent)).toEqual([
      "IDStakeholderCancelled (server preview)Status", "OPT-1Daniel Achterberg250,000Cancelled", "OPT-21Nadia Pereira-Stone50,000Changed — review again", "Total300,000",
    ]);
    expect(realCalls(callsTo(api.routes.cancelSecurity))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel 2 grants" }));
    expect(await screen.findByText("2 grants cancelled — each is its own audited command.")).toBeTruthy();
    expect(realCalls(callsTo(api.routes.cancelSecurity))[1]!.body).toMatchObject({ securityId: IDS.opt21, expectedLedgerSeq: 414, expectedDiffSha256: DIFF_C });
  }, 60_000);

  it("goes on after 409 stale_ledger when the effect is unchanged, and stops after 409 state_changed when it changed", async () => {
    let answers = 0;
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: () => (answers === 0 ? result({ ...previewFor(IDS.opt1, "250000", "OPT-1") })
        : answers === 1 ? result({ ...previewFor(IDS.opt1, "250000", "OPT-1"), ledgerSeq: 420, diffSha256: DIFF_B })
          : result({ ...previewFor(IDS.opt1, "200000", "OPT-1"), ledgerSeq: 421, diffSha256: DIFF_C, effectSha256: EFFECT_C })),
      commit: () => {
        answers += 1;
        return answers === 1 ? apiError(409, "conflict", "The ledger moved", { reason: "stale_ledger" })
          : apiError(409, "conflict", "The recomputed diff differs", { reason: "state_changed" });
      },
    });
    const { callsTo } = renderPage("captable?tab=options", capHandlers(cancel), { role: "admin_rw" });
    await reviewBatch([IDS.opt1], ["OPT-1"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel 1 grant" }));
    // stale_ledger, same effect: sent again at seq 420 with its new diff; that answer is state_changed, and the dry run
    // run again shows a changed effect, so the batch stops and says why.
    expect(await screen.findByText(/OPT-1: Its recorded changes no longer matched the reviewed ones, and what its cancellation does has changed/)).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Cancellation preview" })).getAllByRole("row").map((row) => row.textContent)).toEqual([
      "IDStakeholderCancelled (server preview)Status", "OPT-1Daniel Achterberg200,000Changed — review again", "Total200,000",
    ]);
    expect(realCalls(callsTo(api.routes.cancelSecurity)).map((call) => call.body)).toMatchObject([
      { expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A }, { expectedLedgerSeq: 420, expectedDiffSha256: DIFF_B },
    ]);
  }, 60_000);

  const OPEN_REQUEST = { code: "EXERCISE_REQUEST_OPEN", message: "OPT-21 has an open exercise request" };

  it("goes on with a later grant whose warning was acknowledged in the review, sending the acknowledged code", async () => {
    let recorded = 0;
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: (request: MockRequest) => {
        const id = (request.body as { securityId: string }).securityId;
        if (id === IDS.opt1) return result({ ...previewFor(IDS.opt1, "250000", "OPT-1") });
        return recorded === 0 ? result({ ...previewFor(IDS.opt21, "60000", "OPT-21"), diffSha256: DIFF_B, effectSha256: EFFECT_B, warnings: [OPEN_REQUEST] })
          : result({ ...previewFor(IDS.opt21, "60000", "OPT-21"), ledgerSeq: 413, diffSha256: DIFF_C, effectSha256: EFFECT_B, warnings: [OPEN_REQUEST] });
      },
      commit: (request: MockRequest) => {
        recorded += 1;
        return result({ ...previewFor((request.body as { securityId: string }).securityId, "1", "X"), commandId: uuid(30, 9), dryRun: false }, true);
      },
    });
    const { callsTo } = renderPage("captable?tab=options", capHandlers(cancel), { role: "admin_rw" });
    await reviewBatch([IDS.opt1, IDS.opt21], ["OPT-1", "OPT-21"]);
    const confirm = screen.getByRole("button", { name: "Cancel 2 grants" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(screen.getByLabelText("Warnings for OPT-21")).getByRole("checkbox"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(await screen.findByText("2 grants cancelled — each is its own audited command.")).toBeTruthy();
    expect(realCalls(callsTo(api.routes.cancelSecurity)).map((call) => call.body)).toMatchObject([
      { securityId: IDS.opt1, acknowledge: [] },
      { securityId: IDS.opt21, expectedLedgerSeq: 413, expectedDiffSha256: DIFF_C, acknowledge: ["EXERCISE_REQUEST_OPEN"] },
    ]);
  }, 60_000);

  it("stops at a later grant that raises a new warning, which can then be acknowledged and committed", async () => {
    let recorded = 0;
    const cancel = commandRoute(api.routes.cancelSecurity, {
      preview: (request: MockRequest) => {
        const id = (request.body as { securityId: string }).securityId;
        if (id === IDS.opt1) return result({ ...previewFor(IDS.opt1, "250000", "OPT-1") });
        // Same effect, but an exercise request was opened on OPT-21 meanwhile.
        return recorded === 0 ? result({ ...previewFor(IDS.opt21, "60000", "OPT-21"), diffSha256: DIFF_B, effectSha256: EFFECT_B })
          : result({ ...previewFor(IDS.opt21, "60000", "OPT-21"), ledgerSeq: 413, diffSha256: DIFF_C, effectSha256: EFFECT_B, warnings: [OPEN_REQUEST] });
      },
      commit: (request: MockRequest) => {
        recorded += 1;
        return result({ ...previewFor((request.body as { securityId: string }).securityId, "1", "X"), commandId: uuid(30, 9), dryRun: false }, true);
      },
    });
    const { callsTo } = renderPage("captable?tab=options", capHandlers(cancel), { role: "admin_rw" });
    await reviewBatch([IDS.opt1, IDS.opt21], ["OPT-1", "OPT-21"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel 2 grants" }));
    expect(await screen.findByText(/OPT-21: its cancellation now raises a warning you haven't acknowledged/)).toBeTruthy();
    expect(realCalls(callsTo(api.routes.cancelSecurity))).toHaveLength(1);
    const confirm = screen.getByRole("button", { name: "Cancel 2 grants" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(screen.getByLabelText("Warnings for OPT-21")).getByRole("checkbox", { name: /OPT-21 has an open exercise request/ }));
    fireEvent.click(confirm);
    expect(await screen.findByText("2 grants cancelled — each is its own audited command.")).toBeTruthy();
    expect(realCalls(callsTo(api.routes.cancelSecurity))[1]!.body).toMatchObject({ securityId: IDS.opt21, expectedLedgerSeq: 413, expectedDiffSha256: DIFF_C, acknowledge: ["EXERCISE_REQUEST_OPEN"] });
  }, 60_000);

  it("isn't offered to read-only admins", async () => {
    renderPage("captable?tab=options", capHandlers(commandRoute(api.routes.cancelSecurity, {})), { role: "admin_ro" });
    await screen.findByRole("table", { name: "Options" });
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  }, 60_000);
});

const executedPreview = (overrides: Partial<api.CommandResult> = {}) => result({
  transactions: [{ id: null, seq: null, type: "X_EXECUTION_STATUS", effectiveDate: "2026-10-20", securityId: IDS.opt49, quantity: null }],
  changes: [{ entity: "security", id: IDS.opt49, before: { displayId: "OPT-49", executionStatus: "pending_both" }, after: { displayId: "OPT-49", executionStatus: "executed" } }],
  ...overrides,
});

describe("mark executed", () => {
  it("checks the agreement, a signature date and the attestation, then confirms the server's preview with the typed ID", async () => {
    const executed = commandRoute(api.routes.markExecuted, { preview: executedPreview(), commit: [unavailable(), result({ ...executedPreview(), commandId: uuid(30, 5), dryRun: false }, true)] });
    const { callsTo } = renderPage(`securities/${IDS.opt49}`, handlers(executed), { role: "admin_rw" });
    await openAction(IDS.opt49, "OPT-49 Options", /Mark executed/);
    await screen.findByRole("dialog", { name: "Mark OPT-49 executed" });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(errorOf(/Fully signed agreement/)).toBe("Upload the agreement signed by both the holder and the company signatory.");
    expect(errorOf("Company signature date")).toBe("Enter at least one signature date.");
    expect(screen.getByText("Confirm that the PDF bears both signatures.")).toBeTruthy();
    expect(callsTo(api.routes.markExecuted)).toHaveLength(0);
    await attach(/Fully signed agreement/, "OPT-49 Option Agreement - fully signed.pdf");
    type("Company signature date", "2026-10-20");
    fireEvent.click(screen.getByLabelText("This PDF bears both signatures"));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const panel = await screen.findByRole("region", { name: "Server preview" });
    expect(within(panel).getByRole("region", { name: "OPT-49" }).textContent).toContain("Execution statusPending — holder + company→Executed");
    expect(dryRuns(callsTo(api.routes.markExecuted))[0]!.body).toEqual({ securityId: IDS.opt49, executedAgreementDocumentId: uuid(40, 1), signatureDates: { company: "2026-10-20" }, attestation: "This PDF bears both signatures" });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "OPT-49" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(LOST)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("OPT-49 marked executed")).toBeTruthy();
    const real = realCalls(callsTo(api.routes.markExecuted));
    expect(keysOf(real)[0]).toBe(keysOf(real)[1]);
    expect(real[1]!.body).toMatchObject({ expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A, confirmation: "OPT-49" });
  }, 60_000);

  it("shows a violation the server can't place on a field, and refreshes a stale preview", async () => {
    const executed = commandRoute(api.routes.markExecuted, {
      preview: [refused([{ code: "NOT_EXECUTION_PENDING", message: "OPT-49 is not execution pending" }]), executedPreview(), executedPreview({ diffSha256: DIFF_B, ledgerSeq: 430 })],
      commit: [stale(), result({ ...executedPreview(), commandId: uuid(30, 5), dryRun: false }, true)],
    });
    const { callsTo } = renderPage(`securities/${IDS.opt49}`, handlers(executed), { role: "admin_rw" });
    await openAction(IDS.opt49, "OPT-49 Options", /Mark executed/);
    await screen.findByRole("dialog", { name: "Mark OPT-49 executed" });
    await attach(/Fully signed agreement/, "OPT-49 Option Agreement - fully signed.pdf");
    type("Holder signature date", "2026-10-19");
    fireEvent.click(screen.getByLabelText("This PDF bears both signatures"));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("OPT-49 is not execution pending")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("region", { name: "Server preview" });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "OPT-49" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Review again")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("OPT-49 marked executed")).toBeTruthy();
    expect(realCalls(callsTo(api.routes.markExecuted)).map((call) => (call.body as { expectedLedgerSeq: number }).expectedLedgerSeq)).toEqual([412, 430]);
  }, 60_000);

  it("isn't offered to read-only admins", async () => {
    renderPage(`securities/${IDS.opt49}`, handlers(), { role: "admin_ro" });
    await screen.findByRole("heading", { name: "OPT-49 Options", level: 1 });
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  }, 60_000);
});

const extendPreview = (overrides: Partial<api.CommandResult> = {}) => result({
  transactions: [{ id: null, seq: null, type: "X_SECURITY_MODIFICATION", effectiveDate: "2026-10-21", securityId: IDS.opt21, quantity: null }],
  changes: [{ entity: "deadline", id: IDS.opt21, before: { contractual: "2026-11-30", iso: null, repurchase: null }, after: { contractual: "2027-02-28", iso: null, repurchase: null } }],
  warnings: [{ code: "ISO_MODIFICATION_RISK", message: "Extending an ISO's window may modify the ISO; counsel decides" }],
  ...overrides,
});

describe("extend exercise deadline", () => {
  it("checks the new date, previews the change and records it", async () => {
    const extend = commandRoute(api.routes.extendExerciseDeadline, {
      preview: [refused([{ code: "EXTENSION_AFTER_EXPIRATION", message: "The extension is after the expiration date" }]), extendPreview(), extendPreview({ diffSha256: DIFF_B })],
      commit: [unavailable(), stale(), result({ ...extendPreview(), commandId: uuid(30, 6), dryRun: false }, true)],
    });
    const { callsTo } = renderPage(`securities/${IDS.opt21}`, handlers(extend));
    await openAction(IDS.opt21, "OPT-21 Options", /Extend exercise deadline/);
    await screen.findByRole("dialog", { name: "Extend the exercise deadline — OPT-21" });
    type(/New contractual deadline/, "2026-11-01");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(errorOf(/New contractual deadline/)).toBe("An extension can't shorten or keep the contractual deadline (Nov 30, 2026).");
    expect(errorOf(/Reason/)).toBe("Say why the deadline is extended.");
    type(/New contractual deadline/, "2027-02-28");
    await attach(/Extension document/, "Separation agreement — signed.pdf");
    type(/Reason/, "Extended to 6 months by the separation agreement");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(errorOf(/New contractual deadline/)).toBe("The extension is after the expiration date"));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    const panel = await screen.findByRole("region", { name: "Server preview" });
    expect(within(panel).getByRole("region", { name: "OPT-21 — exercise deadlines" }).textContent).toContain("Contractual deadlineNov 30, 2026→Feb 28, 2027");
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "OPT-21" } });
    const confirm = screen.getByRole("button", { name: "Extend deadline" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Extending an ISO's window may modify the ISO/));
    fireEvent.click(confirm);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Review again")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Extending an ISO's window may modify the ISO/));
    fireEvent.click(screen.getByRole("button", { name: "Extend deadline" }));
    expect(await screen.findByText("OPT-21: contractual deadline extended to Feb 28, 2027")).toBeTruthy();
    const real = realCalls(callsTo(api.routes.extendExerciseDeadline));
    expect(keysOf(real)[1]).toBe(keysOf(real)[0]);
    expect(keysOf(real)[2]).not.toBe(keysOf(real)[0]);
    expect(real.at(-1)!.body).toMatchObject({ newContractualDeadline: "2027-02-28", note: "Extended to 6 months by the separation agreement", confirmation: "OPT-21", acknowledge: ["ISO_MODIFICATION_RISK"], expectedDiffSha256: DIFF_B });
  }, 60_000);

  it("is offered to every admin, and to no editor", async () => {
    renderPage(`securities/${IDS.opt21}`, handlers(), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "OPT-21 Options", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Extend/ })).toBeTruthy();
    cleanup();
    renderPage(`securities/${IDS.opt21}`, handlers(), { role: "admin_ro" });
    await screen.findByRole("heading", { name: "OPT-21 Options", level: 1 });
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  }, 60_000);
});

describe("reverse", () => {
  const EXERCISE = uuid(9, 30);
  const IMPORTED = uuid(9, 8);
  const timeline = mock(api.routes.getSecurityTimeline, {
    items: [
      { kind: "transaction", at: Date.UTC(2026, 9, 1), effectiveDate: "2023-04-14", transactionId: uuid(19, 1), commandId: IMPORTED, type: "TX_EQUITY_COMPENSATION_ISSUANCE", summary: "Issued — 300,000", actor: "Imported from Pulley", note: null, securityId: IDS.opt1 },
      { kind: "transaction", at: Date.UTC(2026, 9, 20, 17), effectiveDate: "2026-10-20", transactionId: uuid(19, 5), commandId: EXERCISE, type: "TX_EQUITY_COMPENSATION_EXERCISE", summary: "Exercised 30,000 ISO → CS-9", actor: "Morgan Ellis", note: null, securityId: IDS.opt1 },
    ],
  });
  const command = (id: string, type: string, imported: boolean): api.CommandDetail => ({
    id, type, actorKind: imported ? "import" : "user", actor: imported ? "Imported from Pulley" : "Morgan Ellis", authMethod: imported ? null : "console", note: null,
    createdAt: Date.UTC(2026, 9, 20, 17), firstSeq: 400, lastSeq: 402, reversesCommandId: null, reversedByCommandId: null, importedFromPulley: imported,
    transactions: [], dependencies: [], dependents: [],
  });
  const commands = mock(api.routes.getCommand, (request: MockRequest) => (request.params.id === EXERCISE ? command(EXERCISE, "exercise-option", false) : command(IMPORTED, "grant-equity-compensation", true)));
  // The server names the newest command it would reverse now on the security (lastReversibleCommandId).
  const reversible = (id: string | null) => mock(api.routes.getSecurity, (request: MockRequest) => ({ ...DETAILS[request.params.id!]!, lastReversibleCommandId: id }));
  const reversal = (overrides: Partial<api.ReversalPreview> = {}): api.ReversalPreview => ({
    commandId: EXERCISE, commandType: "exercise-option", importedFromPulley: false,
    inverse: [
      { reversesTransactionId: uuid(19, 6), type: "TX_STOCK_ISSUANCE", effectiveDate: "2026-10-20" },
      { reversesTransactionId: uuid(19, 5), type: "TX_EQUITY_COMPENSATION_EXERCISE", effectiveDate: "2026-10-20" },
    ],
    dependents: [],
    changes: [{ entity: "security", id: IDS.opt1, before: { displayId: "OPT-1", outstanding: "220000" }, after: { displayId: "OPT-1", outstanding: "250000" } }],
    workflowEffects: [], violations: [], blocked: false, diffSha256: DIFF_A, ledgerSeq: 412,
    ...overrides,
  });

  async function openReverse() {
    await openAction(IDS.opt1, "OPT-1 Options", /Reverse last transaction/);
    return screen.findByRole("region", { name: "Reversal preview" });
  }

  it("reverses the command the server names, with its reversal preview, a reason and the typed ID", async () => {
    const preview = mock(api.routes.getReversalPreview, reversal());
    const reverse = commandRoute(api.routes.reverseCommand, { commit: [unavailable(), result({ commandId: uuid(30, 7), dryRun: false }, true)] });
    const { callsTo } = renderPage(`securities/${IDS.opt1}`, handlers(reversible(EXERCISE), commands, preview, reverse));
    const panel = await openReverse();
    expect(callsTo(api.routes.getReversalPreview)[0]!.params.id).toBe(EXERCISE);
    // The browser doesn't walk the timeline command by command: it reads the one the server named.
    expect(callsTo(api.routes.getCommand).map((call) => call.params.id)).toEqual([EXERCISE]);
    // The app sends no e-mail: no correction notice is offered, whatever the preview says the original command sent.
    expect(screen.queryByLabelText(/correction notice/)).toBeNull();
    expect(within(panel).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Reverses: Share issuance (book entry) (Oct 20, 2026)", "Reverses: Exercise (Oct 20, 2026)"]);
    expect(screen.getByRole("region", { name: "OPT-1" }).textContent).toContain("Outstanding220,000→250,000");
    const button = screen.getByRole("button", { name: "Reverse" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "OPT-1" } });
    fireEvent.click(button);
    expect(await screen.findByText("A reason is required.")).toBeTruthy();
    type(/Reason/, "Recorded on the wrong grant");
    fireEvent.click(button);
    expect(await screen.findByText(LOST)).toBeTruthy();
    expectNotDismissible("Reverse last transaction");
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Reversed — record exercise (OPT-1)")).toBeTruthy();
    const real = callsTo(api.routes.reverseCommand);
    expect(keysOf(real)[0]).toBe(keysOf(real)[1]);
    expect(real[1]!.body).toEqual({ commandId: EXERCISE, note: "Recorded on the wrong grant", expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A, confirmation: "OPT-1" });
  }, 60_000);

  it("refreshes the reversal preview on a stale ledger and names the commands to reverse first", async () => {
    let previews = 0;
    const preview = mock(api.routes.getReversalPreview, () => (++previews === 1 ? reversal() : reversal({ diffSha256: DIFF_B, ledgerSeq: 425 })));
    const dependents = apiError(409, "conflict", "Reverse the dependent commands first, newest first", { reason: "dependents_exist", dependents: [{ commandId: uuid(9, 31), type: "cancel-security", createdAt: Date.UTC(2026, 9, 21) }] });
    const reverse = commandRoute(api.routes.reverseCommand, { commit: [stale(), dependents] });
    const { callsTo } = renderPage(`securities/${IDS.opt1}`, handlers(reversible(EXERCISE), commands, preview, reverse));
    await openReverse();
    type(/Reason/, "Recorded on the wrong grant");
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "OPT-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
    expect(await screen.findByText("Review again")).toBeTruthy();
    await waitForCalls(() => callsTo(api.routes.getReversalPreview), 2);
    fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
    expect(await screen.findByText("This can't be recorded")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Commands to reverse first" })).getByText(/Cancellation/)).toBeTruthy();
    expect(callsTo(api.routes.reverseCommand).map((call) => (call.body as { expectedDiffSha256: string }).expectedDiffSha256)).toEqual([DIFF_A, DIFF_B]);
  }, 60_000);

  it("blocks a reversal the preview refuses", async () => {
    const blocked = mock(api.routes.getReversalPreview, reversal({ blocked: true, dependents: [{ commandId: uuid(9, 31), type: "cancel-security", createdAt: Date.UTC(2026, 9, 21), kind: "consumes_security" }] }));
    renderPage(`securities/${IDS.opt1}`, handlers(reversible(EXERCISE), commands, blocked));
    await openReverse();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText(/Later commands depend on this one/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reverse" }) as HTMLButtonElement).disabled).toBe(true);
  }, 60_000);

  it("says when nothing is reversible: the server names no command (migrated history, or one others depend on)", async () => {
    const { callsTo } = renderPage(`securities/${IDS.opt1}`, handlers(reversible(null), timeline, commands));
    await openAction(IDS.opt1, "OPT-1 Options", /Reverse last transaction/);
    expect(await screen.findByText("Nothing to reverse")).toBeTruthy();
    expect(callsTo(api.routes.getCommand)).toHaveLength(0);
    expect(callsTo(api.routes.getReversalPreview)).toHaveLength(0);
  }, 60_000);

  it("is offered to every admin", async () => {
    renderPage(`securities/${IDS.opt1}`, handlers(), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "OPT-1 Options", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Reverse/ })).toBeTruthy();
    expect(DETAILS[IDS.opt1]).toBeTruthy();
  }, 60_000);
});
