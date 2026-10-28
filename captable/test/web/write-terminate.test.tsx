import "./setup.ts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, securitiesStatus, securityList, stockPlan, uuid } from "./support/acme.ts";
import { DIFF_A, DIFF_B, attach, choose, click, commandRoute, dryRuns, errorOf, field, keysOf, realCalls, refused, result, stale, staleVersion, type, unavailable, uploads, waitForCalls, LOST, expectSentAsPreviewed } from "./support/flows.ts";
import { mock, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { ECHO, STAKEHOLDER_DETAILS } from "./support/securities.ts";
import { base, renderPage } from "./support/render.tsx";

// Terminate stakeholder: the four steps, the server's termination preview per security, the dry
// run of the command (or of the schedule for a future date), and the write cycle; and cancelling a scheduled one.

const previews: Record<string, api.TerminationPreview> = {
  [IDS.opt1]: { securityId: IDS.opt1, terminationDate: "2026-10-21", terminationType: "voluntary", vestingStopDate: "2026-10-21", vested: "268750", unvested: "31250", exercisable: "218750", repurchaseable: "0", contractualDeadline: "2027-01-21", isoDeadline: "2027-01-21" },
  [IDS.opt49]: { securityId: IDS.opt49, terminationDate: "2026-10-21", terminationType: "voluntary", vestingStopDate: "2026-10-21", vested: "0", unvested: "50000", exercisable: "0", repurchaseable: "0", contractualDeadline: null, isoDeadline: null },
};

const preview = (overrides: Partial<api.CommandResult> = {}) => result({
  transactions: [
    { id: null, seq: null, type: "X_STAKEHOLDER_TERMINATION", effectiveDate: "2026-10-21", securityId: null, quantity: null },
    { id: null, seq: null, type: "TX_EQUITY_COMPENSATION_CANCELLATION", effectiveDate: "2026-10-21", securityId: IDS.opt1, quantity: "31250" },
    { id: null, seq: null, type: "TX_EQUITY_COMPENSATION_CANCELLATION", effectiveDate: "2026-10-21", securityId: IDS.opt49, quantity: "50000" },
  ],
  changes: [
    { entity: "deadline", id: IDS.opt1, before: null, after: { contractual: "2027-01-21", iso: "2027-01-21", repurchase: null } },
    { entity: "stakeholder", id: IDS.daniel, before: { relationship: "employee", termination: null, leaves: [] }, after: { relationship: "ex_employee", termination: { date: "2026-10-21", type: "voluntary", vestingStopDate: "2026-10-21" }, leaves: [] } },
    { entity: "pool", id: IDS.plan, before: { poolSize: "4500000", equityOutstanding: "4039250", equityRetired: "0", availableToGrant: "460750" }, after: { poolSize: "4500000", equityOutstanding: "3958000", equityRetired: "0", availableToGrant: "542000" } },
  ],
  ...overrides,
});
const recorded = result({ ...preview(), commandId: uuid(30, 3), dryRun: false, ledgerSeq: 413 }, true);

function handlers(...routes: MockHandler[]): MockHandler[] {
  return [
    mock(api.routes.getStakeholder, (request: MockRequest) => STAKEHOLDER_DETAILS[request.params.id!]),
    mock(api.routes.getStakeholderHoldings, (request: MockRequest) => ({ ...ECHO, items: securityList().items.filter((item) => item.stakeholderId === request.params.id) })),
    mock(api.routes.getTerminationPreview, (request: MockRequest) => ({ ...previews[request.params.id!]!, terminationDate: request.query.get("terminationDate")!, vestingStopDate: request.query.get("vestingStopDate")! })),
    mock(api.routes.getStockPlan, stockPlan()),
    uploads(),
    ...routes,
  ];
}

async function toStep4(date = "2026-10-21") {
  await screen.findByRole("heading", { name: "Terminate Daniel Achterberg", level: 1 });
  type(/Termination date/, date);
  click("Next");
  await screen.findByRole("table", { name: "Vesting outcome" });
  click("Next");
  await screen.findByRole("table", { name: "Windows" });
  click("Next");
  await screen.findByRole("heading", { name: /4\. Review/ });
}

describe("terminate stakeholder", () => {
  it("checks each step before moving on, and asks nothing about e-mails", async () => {
    const terminate = commandRoute(api.routes.terminateStakeholder, { preview: preview() });
    const { callsTo } = renderPage(`stakeholders/${IDS.daniel}/terminate`, handlers(terminate), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Terminate Daniel Achterberg", level: 1 });
    type(/Vesting stop date/, "2026-10-25");
    expect(screen.queryByLabelText(/e-mail/i)).toBeNull();
    click("Next");
    expect(errorOf(/Vesting stop date/)).toBe("The vesting stop date may be earlier than the termination date, never later.");
    type(/Vesting stop date/, "2026-10-21");
    click("Next");
    const outcome = await screen.findByRole("table", { name: "Vesting outcome" });
    expect(within(outcome).getAllByRole("row")[1]!.textContent).toContain("268,750");
    expect(within(outcome).getAllByRole("row")[2]!.textContent).toContain("50,000 (whole grant)");
    choose("Acceleration for OPT-1", "manual");
    click("Next");
    expect(await screen.findByText("Enter the quantity to accelerate.")).toBeTruthy();
    expect(callsTo(api.routes.terminateStakeholder)).toHaveLength(0);
  }, 60_000);

  it("shows the windows from the server's termination preview, then the dry run figure for figure", async () => {
    const terminate = commandRoute(api.routes.terminateStakeholder, { preview: preview() });
    const { callsTo } = renderPage(`stakeholders/${IDS.daniel}/terminate`, handlers(terminate), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Terminate Daniel Achterberg", level: 1 });
    click("Next");
    await screen.findByRole("table", { name: "Vesting outcome" });
    click("Next");
    const windows = await screen.findByRole("table", { name: "Windows" });
    expect(field("Contractual deadline OPT-1").value).toBe("2027-01-21");
    expect(within(windows).getByText("Same date")).toBeTruthy();
    expect(within(windows).getByText("3 months after voluntary termination (grant)")).toBeTruthy();
    expect(within(windows).getByText("Cancelled in full")).toBeTruthy();
    click("Next");
    await waitForCalls(() => dryRuns(callsTo(api.routes.terminateStakeholder)), 1);
    expect(dryRuns(callsTo(api.routes.terminateStakeholder))[0]!.body).toEqual({
      stakeholderId: IDS.daniel, terminationDate: "2026-10-21", terminationType: "voluntary", vestingStopDate: "2026-10-21", relationshipAfter: "ex_employee",
      accelerations: [], deadlineExtensions: [], repurchaseDeadlines: [],
    });
    const panel = await screen.findByRole("region", { name: "Server preview" });
    const rows = within(within(panel).getByRole("table", { name: "Transactions" })).getAllByRole("row").map((row) => row.textContent);
    expect(rows.slice(1)).toEqual(["TerminationOct 21, 2026——", "Option cancellationOct 21, 2026OPT-131,250", "Option cancellationOct 21, 2026OPT-4950,000"]);
    expect(within(panel).getByRole("region", { name: "2023 Equity Incentive Plan — pool" }).textContent).toContain("Available to grant460,750→542,000");
    expect(within(panel).getByRole("region", { name: "Daniel Achterberg" }).textContent).toContain("RelationshipEmployee→Ex Employee");
    expect(within(panel).getByRole("region", { name: "OPT-1 — exercise deadlines" }).textContent).toContain("Contractual deadline—→Jan 21, 2027");
    // The app sends no e-mail: whatever the server's preview says about notices isn't shown.
    expect(within(panel).queryByRole("region", { name: "E-mails" })).toBeNull();
    expect(screen.queryByLabelText(/exit summary/i)).toBeNull();
  }, 60_000);

  it("terminates with the reviewed seq, diff and key", async () => {
    const terminate = commandRoute(api.routes.terminateStakeholder, { preview: preview(), commit: recorded });
    const { callsTo, router } = renderPage(`stakeholders/${IDS.daniel}/terminate`, handlers(terminate), { role: "admin_rw" });
    await toStep4();
    await screen.findByRole("region", { name: "Server preview" });
    click("Terminate");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${IDS.daniel}`));
    const real = realCalls(callsTo(api.routes.terminateStakeholder))[0]!;
    expect(real.body).toMatchObject({ expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A, acknowledge: [] });
    expect("exitSummary" in (real.body as object)).toBe(false);
    expect(real.headers.get("Idempotency-Key")).toBeTruthy();
    expect(await screen.findByText("Daniel Achterberg terminated — 81,250 options cancelled")).toBeTruthy();
  }, 60_000);

  it("sends a refused dry run back to the step whose field the violation names", async () => {
    const terminate = commandRoute(api.routes.terminateStakeholder, { preview: refused([{ code: "ACCELERATION_EXCEEDS_UNVESTED", message: "OPT-1 accelerates more than its 31250 unvested", securityId: IDS.opt1 }]) });
    renderPage(`stakeholders/${IDS.daniel}/terminate`, handlers(terminate), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Terminate Daniel Achterberg", level: 1 });
    click("Next");
    await screen.findByRole("table", { name: "Vesting outcome" });
    choose("Acceleration for OPT-1", "manual");
    type("Quantity to accelerate (OPT-1)", "1,000");
    type("Reason (OPT-1)", "Board approved a partial acceleration");
    await attach(/Acceleration document \(OPT-1\)/, "OPT-1 acceleration consent.pdf", "%PDF");
    click("Next");
    await screen.findByRole("table", { name: "Windows" });
    click("Next");
    expect(await screen.findByText("OPT-1 accelerates more than its 31250 unvested")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Vesting outcome" })).toBeTruthy();
  }, 60_000);

  it("retries a lost answer with the same Idempotency-Key", async () => {
    const terminate = commandRoute(api.routes.terminateStakeholder, { preview: preview(), commit: [unavailable(), recorded] });
    const { callsTo, router } = renderPage(`stakeholders/${IDS.daniel}/terminate`, handlers(terminate), { role: "admin_rw" });
    await toStep4();
    await screen.findByRole("region", { name: "Server preview" });
    click("Terminate");
    expect(await screen.findByText(LOST)).toBeTruthy();
    // Nothing can be changed until the outcome is known.
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    click("Try again");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${IDS.daniel}`));
    const real = realCalls(callsTo(api.routes.terminateStakeholder));
    const keys = keysOf(real);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(real[1]!.body).toEqual(real[0]!.body);
    expectSentAsPreviewed(dryRuns(callsTo(api.routes.terminateStakeholder))[0]!, real[0]!);
  }, 60_000);

  it("refreshes the preview on a stale ledger before terminating", async () => {
    const fresh = preview({ ledgerSeq: 416, diffSha256: DIFF_B, changes: [
      { entity: "pool", id: IDS.plan, before: { poolSize: "4500000", equityOutstanding: "4049250", equityRetired: "0", availableToGrant: "450750" }, after: { poolSize: "4500000", equityOutstanding: "3968000", equityRetired: "0", availableToGrant: "532000" } },
    ] });
    const terminate = commandRoute(api.routes.terminateStakeholder, { preview: [preview(), fresh], commit: [stale(), recorded] });
    const { callsTo, router } = renderPage(`stakeholders/${IDS.daniel}/terminate`, handlers(terminate), { role: "admin_rw" });
    await toStep4();
    await screen.findByRole("region", { name: "Server preview" });
    click("Terminate");
    expect(await screen.findByText("Review again")).toBeTruthy();
    expect((await screen.findByRole("region", { name: "2023 Equity Incentive Plan — pool" })).textContent).toContain("450,750→532,000");
    click("Terminate");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders/${IDS.daniel}`));
    expect(realCalls(callsTo(api.routes.terminateStakeholder)).map((call) => (call.body as { expectedDiffSha256: string }).expectedDiffSha256)).toEqual([DIFF_A, DIFF_B]);
  }, 60_000);

  it("schedules a future termination through schedule-termination", async () => {
    const schedule = commandRoute(api.routes.scheduleTermination, {
      preview: { scheduledTerminationId: null, preview: preview() },
      commit: { scheduledTerminationId: uuid(12, 9), preview: preview({ created: { securityIds: [], scheduledTerminationIds: [uuid(12, 9)], vestingTermsIds: [] } }) },
    });
    const { callsTo } = renderPage(`stakeholders/${IDS.daniel}/terminate`, handlers(schedule), { role: "admin_rw" });
    await toStep4("2026-12-04");
    expect(screen.getByText("Scheduled termination — Dec 4, 2026")).toBeTruthy();
    // No scheduler: the termination is recorded once its date arrives, when an admin opens the app or processes due items.
    expect(screen.getByText(/recorded once that date arrives, the next time an admin opens Cap Table/)).toBeTruthy();
    expect(await screen.findByText("What happens on Dec 4, 2026")).toBeTruthy();
    click("Schedule termination");
    expect(await screen.findByText("Termination scheduled for Dec 4, 2026 — TERMINATING badge shown")).toBeTruthy();
    const real = realCalls(callsTo(api.routes.scheduleTermination))[0]!;
    expect(real.body).toMatchObject({ terminationDate: "2026-12-04", vestingStopDate: "2026-12-04", expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A });
  }, 60_000);

  it("is closed to read-only admins, on the admin's own record, and when a termination is scheduled", async () => {
    renderPage(`stakeholders/${IDS.daniel}/terminate`, handlers(), { role: "admin_ro" });
    expect(await screen.findByText("You have read-only access")).toBeTruthy();
    renderPage(`stakeholders/${IDS.daniel}/terminate`, handlers(), { role: "admin_rw", ownStakeholderId: IDS.daniel });
    expect(await screen.findByText("This is your own record")).toBeTruthy();
    renderPage(`stakeholders/${IDS.mateo}/terminate`, handlers(), { role: "admin_rw" });
    expect(await screen.findByText("A termination is already scheduled")).toBeTruthy();
  }, 60_000);
});

describe("cancel a scheduled termination", () => {
  const status = (version: number) => securitiesStatus({ scheduledTerminations: [{ id: uuid(12, 1), stakeholderId: IDS.mateo, terminationDate: "2026-12-04", type: "voluntary", securitiesAffected: 3, unvestedToCancel: "89375", version }] });
  const cancelled = (version: number): api.ScheduledTermination => ({
    id: uuid(12, 1), stakeholderId: IDS.mateo, terminationDate: "2026-12-04", terminationType: "voluntary", vestingStopDate: "2026-12-04", status: "CANCELLED",
    appliedCommandId: null, cancelledBy: "Rachel Ostrowski", cancelledAt: Date.UTC(2026, 9, 21), cancelNote: "Employee decided to stay", createdBy: "Morgan Ellis", createdAt: Date.UTC(2026, 9, 15), version,
  });

  it("cancels with the version read and a reason, and reads the version again after a stale answer", async () => {
    let reads = 0;
    const cancel = commandRoute(api.routes.cancelScheduledTermination, { commit: [staleVersion(), cancelled(3)] });
    const { callsTo } = renderPage(`stakeholders/${IDS.mateo}`, [
      mock(api.routes.getStakeholder, (request: MockRequest) => STAKEHOLDER_DETAILS[request.params.id!]),
      mock(api.routes.getStakeholderHoldings, { ...ECHO, items: [] }),
      mock(api.routes.listVestingTerms, { items: [] }),
      mock(api.routes.listDocuments, { items: [], nextCursor: null }),
      mock(api.routes.listOrgAudit, { items: [], nextCursor: null }),
      mock(api.routes.getSecuritiesStatus, () => status(++reads === 1 ? 1 : 2)),
      cancel,
    ]);
    await screen.findByRole("heading", { name: /Mateo Villalobos/, level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Reverse scheduled termination/ }));
    // The dialog reads the queue first, then shows its form.
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByText("A reason is required.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Employee decided to stay" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText(/the 89,375 unvested options it would cancel stay outstanding/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled termination" }));
    expect(await screen.findByText("Review again")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled termination" }));
    expect(await screen.findByText("Scheduled termination cancelled — Mateo Villalobos stays active")).toBeTruthy();
    const calls = callsTo(api.routes.cancelScheduledTermination);
    expect(calls.map((call) => call.body)).toEqual([
      { scheduledTerminationId: uuid(12, 1), version: 1, note: "Employee decided to stay" },
      { scheduledTerminationId: uuid(12, 1), version: 2, note: "Employee decided to stay" },
    ]);
    // The version read again makes a new body, so it gets a new key.
    expect(keysOf(calls)[1]).not.toBe(keysOf(calls)[0]);
  }, 60_000);

  it("is offered to every admin, and to no editor", async () => {
    const pageHandlers = [
      mock(api.routes.getStakeholder, (request: MockRequest) => STAKEHOLDER_DETAILS[request.params.id!]),
      mock(api.routes.getStakeholderHoldings, { ...ECHO, items: [] }),
      mock(api.routes.listVestingTerms, { items: [] }),
    ];
    renderPage(`stakeholders/${IDS.mateo}`, pageHandlers, { role: "admin_rw" });
    await screen.findByRole("heading", { name: /Mateo Villalobos/, level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Reverse scheduled termination/ })).toBeTruthy();
    cleanup();
    renderPage(`stakeholders/${IDS.mateo}`, pageHandlers, { role: "admin_ro" });
    await screen.findByRole("heading", { name: /Mateo Villalobos/, level: 1 });
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  }, 60_000);
});
