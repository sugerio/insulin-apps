import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, STAKEHOLDERS, VALUATIONS, VESTING_TERMS, capTable, dashboard, securityList, stakeholder, stakeholderList, stockPlan, TODAY, uuid, valuation } from "./support/acme.ts";
import { DIFF_A, DIFF_B, attach, click, commandRoute, dryRuns, errorOf, field, keysOf, realCalls, refused, result, stale, type, unavailable, uploads, waitForCalls, LOST, expectSentAsPreviewed } from "./support/flows.ts";
import { mock, type MockHandler } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

// Record options: the wizard's checks, the server's preview figure for figure, the real call with
// the reviewed seq and diff, violations on their fields, the same key on retry, the stale-ledger path, role gating.

const NEW = uuid(6, 157);
const THEO = uuid(3, 41);
const ECHO = { asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0" };

const preview = (overrides: Partial<api.CommandResult> = {}) => result({
  transactions: [
    { id: null, seq: null, type: "TX_EQUITY_COMPENSATION_ISSUANCE", effectiveDate: "2026-10-20", securityId: NEW, quantity: "40000" },
    { id: null, seq: null, type: "TX_VESTING_START", effectiveDate: "2026-10-20", securityId: NEW, quantity: null },
  ],
  created: { securityIds: [NEW], scheduledTerminationIds: [], vestingTermsIds: [] },
  changes: [
    { entity: "security", id: NEW, before: null, after: { displayId: "OPT-57", status: "OUTSTANDING", executionStatus: "executed", outstanding: "40000", vested: "0", unvested: "40000" } },
    { entity: "vesting", id: NEW, before: null, after: { events: [
      { date: "2027-10-20", quantity: "10000", cumulative: "10000", kind: "CLIFF" },
      { date: "2027-11-20", quantity: "833", cumulative: "10833", kind: "SCHEDULED" },
      { date: "2030-10-20", quantity: "834", cumulative: "40000", kind: "SCHEDULED" },
    ] } },
    { entity: "pool", id: IDS.plan, before: { poolSize: "4500000", equityOutstanding: "4039250", equityRetired: "0", availableToGrant: "460750" }, after: { poolSize: "4500000", equityOutstanding: "4079250", equityRetired: "0", availableToGrant: "420750" } },
  ],
  ...overrides,
});
const recorded = result({ ...preview(), commandId: uuid(30, 1), dryRun: false, ledgerSeq: 413 }, true);

function handlers(grant: MockHandler, fmv: api.FmvResponse["fmv"] = { valuationId: IDS.v5, valuationName: "Nov 2025 Valuation", pricePerShare: "0.95", splitAdjusted: false, status: "expiring_soon" }): MockHandler[] {
  return [
    mock(api.routes.listStockPlans, { ...ECHO, items: [stockPlan()] }),
    mock(api.routes.listStakeholders, stakeholderList()),
    mock(api.routes.listVestingTerms, { items: VESTING_TERMS }),
    mock(api.routes.listValuations, { items: VALUATIONS }),
    mock(api.routes.listSecurities, securityList()),
    mock(api.routes.getFmv, { date: "2026-10-20", stockClassId: IDS.common, fmv }),
    mock(api.routes.previewVesting, { events: [
      { date: "2027-10-20", quantity: "10000", cumulative: "10000", state: "ACTIVE", kind: "CLIFF", source: "computed" },
      { date: "2027-11-20", quantity: "833", cumulative: "10833", state: "ACTIVE", kind: "SCHEDULED", source: "computed" },
      { date: "2027-12-20", quantity: "834", cumulative: "11667", state: "ACTIVE", kind: "SCHEDULED", source: "computed" },
    ], total: "40000" }),
    mock(api.routes.getIsoSplit, { stakeholderId: IDS.daniel, years: [] }),
    uploads(),
    grant,
  ];
}

async function fillGrant() {
  await screen.findByRole("heading", { name: "Record options", level: 1 });
  const holder = await screen.findByLabelText(/Stakeholder/);
  await waitFor(() => expect(within(holder).getByRole("option", { name: /Daniel Achterberg/ })).toBeTruthy());
  fireEvent.change(holder, { target: { value: IDS.daniel } });
  type("Number of options", "40,000");
  type(/Board approval date/, "2026-10-20");
  await attach(/Signed board consent/, "BA-19 New-hire grant consent.pdf");
  fireEvent.click(screen.getByLabelText(/employee at grant/));
  fireEvent.click(screen.getByLabelText(/Matches the signed agreement/));
  await waitFor(() => expect(field("Exercise price").value).toBe("0.95"));
  await attach(/Executed agreement/, "OPT-57 Option Agreement (signed).pdf");
  fireEvent.click(screen.getByLabelText(/signed by both the holder and the company signatory/));
}

describe("record options", () => {
  it("checks the required answers before anything is sent", async () => {
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: preview() });
    const { callsTo } = renderPage("issue/options", handlers(grant), { role: "admin_rw" });
    await screen.findByRole("heading", { name: /1\. Equity plan/ });
    click("Review");
    expect(errorOf(/Stakeholder/)).toBe("Choose who the grant is for, or save the new stakeholder first.");
    expect(errorOf("Number of options")).toBe("Enter the number of options.");
    expect(errorOf(/Board approval date/)).toBe("Enter the board approval date.");
    expect(screen.getAllByText("A new grant needs the signed board consent.").length).toBeGreaterThan(0);
    type("Number of options", "40000.5");
    click("Review");
    expect(errorOf("Number of options")).toBe("Use whole options.");
    expect(callsTo(api.routes.grantEquityCompensation)).toHaveLength(0);
  }, 60_000);

  it("prefills the price from the 409A, shows the summary's hints, then the server's preview figure for figure", async () => {
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: preview() });
    const { callsTo } = renderPage("issue/options", handlers(grant), { role: "admin_rw" });
    await fillGrant();
    expect(screen.getByText(/FMV \$0\.95 · presumptively valid until Nov 5, 2026 \(Nov 2025 Valuation\)/)).toBeTruthy();
    const summary = screen.getByRole("complementary", { name: "Grant summary" });
    expect(within(summary).getByText("460,750 → 420,750")).toBeTruthy();
    expect(within(summary).getByText(/2027: \$11,083\.65 first exercisable → all ISO/)).toBeTruthy();
    expect(screen.getByRole("table", { name: "Generated vesting table" })).toBeTruthy();
    type("Number of options", "600,000");
    expect(within(summary).getByText("Exceeds the plan's availability (460,750).")).toBeTruthy();
    expect(within(summary).getByText("460,750 → −139,250")).toBeTruthy();
    type("Number of options", "40,000");
    click("Review");
    await waitForCalls(() => dryRuns(callsTo(api.routes.grantEquityCompensation)), 1);
    const sent = dryRuns(callsTo(api.routes.grantEquityCompensation))[0]!;
    expect(sent.headers.get("Idempotency-Key")).toBeNull();
    expect(sent.body).toMatchObject({
      stockPlanId: IDS.plan, stakeholderId: IDS.daniel, quantity: "40000", optionType: "ISO", exercisePrice: "0.95", valuationId: IDS.v5, expirationDate: "2036-10-20",
      board: { approvalDate: "2026-10-20" }, isoAttestations: { employeeAtGrant: true, tenPercentHolder: false },
      vesting: { terms: { templateId: IDS.vs1 }, vestingStartDate: "2026-10-20", earlyExercisable: false, accelerationTerms: { kind: "NONE" }, matchesSignedAgreement: true },
      exemption: { federal: "RULE_701", state: "California 25102(o)" }, executedAgreement: { signedByHolderAndSignatory: true },
    });
    const panel = await screen.findByRole("region", { name: "Server preview" });
    const transactions = within(panel).getByRole("table", { name: "Transactions" });
    expect(within(transactions).getAllByRole("row")[1]!.textContent).toBe("Option grantOct 20, 2026OPT-5740,000");
    const pool = within(panel).getByRole("region", { name: "2023 Equity Incentive Plan — pool" });
    expect(pool.textContent).toContain("Available to grant460,750→420,750");
    expect(pool.textContent).toContain("Equity outstanding4,039,250→4,079,250");
    expect(within(panel).getByText("Vesting schedule (3 events, Oct 20, 2027 to Oct 20, 2030)")).toBeTruthy();
  }, 60_000);

  it("records the reviewed grant with its seq and diff, then opens it", async () => {
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: preview(), commit: recorded });
    const { callsTo, router } = renderPage("issue/options", handlers(grant), { role: "admin_rw" });
    await fillGrant();
    click("Review");
    await screen.findByRole("region", { name: "Server preview" });
    click("Record grant");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${NEW}`));
    const real = realCalls(callsTo(api.routes.grantEquityCompensation))[0]!;
    expect(real.body).toMatchObject({ expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A, acknowledge: [], quantity: "40000" });
    expect(real.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText("OPT-57 recorded — outstanding (executed); no e-mail sent")).toBeTruthy();
  }, 60_000);

  it("shows the server's violations next to the fields they name", async () => {
    const grant = commandRoute(api.routes.grantEquityCompensation, {
      preview: refused([
        { code: "EXCEEDS_PLAN_AVAILABLE", message: "Exceeds the plan's available 460750" },
        { code: "DISPLAY_ID_TAKEN", message: "OPT-12 is already used" },
        { code: "DOCUMENT_VISIBLE_TO_ANOTHER_HOLDER", message: "That document is visible to another holder" },
      ]),
    });
    renderPage("issue/options", handlers(grant), { role: "admin_rw" });
    await fillGrant();
    type("ID", "OPT-12");
    click("Review");
    await waitFor(() => expect(errorOf("Number of options")).toBe("Exceeds the plan's available 460750"));
    expect(errorOf("ID")).toBe("OPT-12 is already used");
    expect(screen.getByText("That document is visible to another holder")).toBeTruthy();
    expect(screen.getByText("The server refused this. Fix what it names and review again.")).toBeTruthy();
    expect(field("Number of options").disabled).toBe(false);
  }, 60_000);

  it("retries a lost answer with the same Idempotency-Key", async () => {
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: preview(), commit: [unavailable(), recorded] });
    const { callsTo, router } = renderPage("issue/options", handlers(grant), { role: "admin_rw" });
    await fillGrant();
    click("Review");
    await screen.findByRole("region", { name: "Server preview" });
    click("Record grant");
    expect(await screen.findByText(LOST)).toBeTruthy();
    // Nothing can be changed until the outcome is known, and the page can't be left with the body and key.
    expect((screen.getByRole("button", { name: "Change answers" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "Close" }));
    expect(await screen.findByText(/^A write's outcome isn't known yet/)).toBeTruthy();
    expect(router.state.location.pathname).toBe(`${base}/issue/options`);
    click("Try again");
    // Once it is recorded the page moves on to the grant.
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${NEW}`));
    const real = realCalls(callsTo(api.routes.grantEquityCompensation));
    const keys = keysOf(real);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(real[1]!.body).toEqual(real[0]!.body);
    expectSentAsPreviewed(dryRuns(callsTo(api.routes.grantEquityCompensation))[0]!, real[0]!);
  }, 60_000);

  it("refreshes the preview on a stale ledger and records only what was reviewed again", async () => {
    const fresh = preview({ ledgerSeq: 415, diffSha256: DIFF_B, changes: [
      { entity: "pool", id: IDS.plan, before: { poolSize: "4500000", equityOutstanding: "4089250", equityRetired: "0", availableToGrant: "410750" }, after: { poolSize: "4500000", equityOutstanding: "4129250", equityRetired: "0", availableToGrant: "370750" } },
    ] });
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: [preview(), fresh], commit: [stale(), recorded] });
    const { callsTo, router } = renderPage("issue/options", handlers(grant), { role: "admin_rw" });
    await fillGrant();
    click("Review");
    await screen.findByRole("region", { name: "Server preview" });
    click("Record grant");
    expect(await screen.findByText("Review again")).toBeTruthy();
    await waitForCalls(() => dryRuns(callsTo(api.routes.grantEquityCompensation)), 2);
    expect((await screen.findByRole("region", { name: "2023 Equity Incentive Plan — pool" })).textContent).toContain("410,750→370,750");
    click("Record grant");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${NEW}`));
    const real = realCalls(callsTo(api.routes.grantEquityCompensation));
    expect(real.map((call) => (call.body as { expectedLedgerSeq: number }).expectedLedgerSeq)).toEqual([412, 415]);
    expect((real[1]!.body as { expectedDiffSha256: string }).expectedDiffSha256).toBe(DIFF_B);
  }, 60_000);

  it("acknowledges an NSO priced below FMV and offers the counsel memo", async () => {
    const warned = preview({ warnings: [{ code: "NSO_PRICE_BELOW_FMV", message: "The strike is below the FMV of 0.95 (409A risk)" }] });
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: warned, commit: recorded });
    const { callsTo } = renderPage("issue/options", handlers(grant), { role: "admin_rw" });
    await fillGrant();
    fireEvent.click(screen.getByRole("radio", { name: /NSO/ }));
    type("Exercise price", "0.80");
    expect(await screen.findByLabelText(/Counsel memo/)).toBeTruthy();
    expect(screen.getByText(/The strike is below the FMV \(\$0\.95\): 409A risk/)).toBeTruthy();
    await attach(/Counsel memo/, "Counsel memo - grant pricing.pdf");
    click("Review");
    const record = await screen.findByRole("button", { name: "Record grant" });
    expect((record as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/The strike is below the FMV of 0\.95/));
    expect((record as HTMLButtonElement).disabled).toBe(false);
    click("Record grant");
    await waitForCalls(() => realCalls(callsTo(api.routes.grantEquityCompensation)), 1);
    expect(realCalls(callsTo(api.routes.grantEquityCompensation))[0]!.body).toMatchObject({ optionType: "NSO", exercisePrice: "0.8", acknowledge: ["NSO_PRICE_BELOW_FMV"] });
  }, 60_000);

  it("requires counsel's memo for an NSO priced below the FMV, moves focus to it, and puts the server's NSO_PRICE_BELOW_FMV on it", async () => {
    const memoMissing = refused([{ code: "NSO_PRICE_BELOW_FMV", message: "An NSO priced below FMV needs counsel's memo" }]);
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: memoMissing });
    const { callsTo } = renderPage("issue/options", handlers(grant), { role: "admin_rw" });
    await fillGrant();
    fireEvent.click(screen.getByRole("radio", { name: /NSO/ }));
    type("Exercise price", "0.80");
    click("Review");
    expect(errorOf(/Counsel memo/)).toBe("An NSO priced below the FMV ($0.95) needs counsel's memo.");
    // The first new error takes the focus and is announced once.
    await waitFor(() => expect(document.activeElement).toBe(field(/Counsel memo/)));
    expect(screen.getByText("1 field needs attention. Counsel memo (409A override or NSO below FMV): An NSO priced below the FMV ($0.95) needs counsel's memo.")).toBeTruthy();
    expect(dryRuns(callsTo(api.routes.grantEquityCompensation))).toHaveLength(0);
    await attach(/Counsel memo/, "Pricing memo (signed).pdf");
    click("Review");
    await waitFor(() => expect(errorOf(/Counsel memo/)).toBe("An NSO priced below FMV needs counsel's memo"));
    expect(errorOf("Exercise price")).toBe("");
  }, 60_000);

  it("adds a new hire inline only after reviewing the exact request", async () => {
    const theo = stakeholder({
      id: THEO, displayName: "Theo Marchetti", hireDate: "2026-10-19", provenance: { importedFromPulley: false, pulleyId: null },
      emails: [{ ...STAKEHOLDERS.nadia.emails[0]!, id: uuid(11, 901), email: "theo.marchetti@mailbox.example" }],
    });
    const create = commandRoute(api.routes.createStakeholder, { commit: theo });
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: preview() });
    const { callsTo } = renderPage("issue/options", [...handlers(grant), create], { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Record options", level: 1 });
    const holder = await screen.findByLabelText(/Stakeholder/);
    await waitFor(() => expect(within(holder).getByRole("option", { name: /Daniel Achterberg/ })).toBeTruthy());
    fireEvent.change(holder, { target: { value: "__new" } });
    const card = await screen.findByLabelText("New stakeholder");
    type(/^Legal name/, "Theo Marchetti");
    type(/^E-mail/, "theo.marchetti");
    type("Hire date", "2026-10-19");
    fireEvent.click(within(card).getByRole("button", { name: "Review" }));
    expect(errorOf(/^E-mail/)).toBe("Enter a valid e-mail address.");
    expect(callsTo(api.routes.createStakeholder)).toHaveLength(0);
    type(/^E-mail/, "theo.marchetti@mailbox.example");
    fireEvent.click(within(card).getByRole("button", { name: "Review" }));
    const reviewPanel = within(card).getByLabelText("Review the new stakeholder");
    expect(reviewPanel.textContent).toContain("NameTheo Marchetti");
    expect(reviewPanel.textContent).toContain("E-mailtheo.marchetti@mailbox.example");
    // Nothing is created by the review itself.
    expect(callsTo(api.routes.createStakeholder)).toHaveLength(0);
    fireEvent.click(within(card).getByRole("button", { name: "Add stakeholder" }));
    expect(await screen.findByText("Theo Marchetti added")).toBeTruthy();
    const call = callsTo(api.routes.createStakeholder)[0]!;
    expect(call.body).toEqual({
      kind: "individual", displayName: "Theo Marchetti", legalName: "Theo Marchetti", relationship: "employee", hireDate: "2026-10-19",
      emails: [{ email: "theo.marchetti@mailbox.example", kind: "self" }],
      acknowledge: [],
    });
    expect(call.headers.get("Idempotency-Key")).toBeTruthy();
  }, 60_000);

  it("keeps the stakeholder selector locked while the inline create's outcome is unknown, so its key can't be dropped", async () => {
    const theo = stakeholder({
      id: THEO, displayName: "Theo Marchetti", provenance: { importedFromPulley: false, pulleyId: null },
      emails: [{ ...STAKEHOLDERS.nadia.emails[0]!, id: uuid(11, 901), email: "theo.marchetti@mailbox.example" }],
    });
    const create = commandRoute(api.routes.createStakeholder, { commit: [unavailable(), theo] });
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: preview() });
    const { callsTo } = renderPage("issue/options", [...handlers(grant), create], { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Record options", level: 1 });
    const holder = await screen.findByLabelText(/^Stakeholder/) as HTMLSelectElement;
    await waitFor(() => expect(within(holder).getByRole("option", { name: /Daniel Achterberg/ })).toBeTruthy());
    fireEvent.change(holder, { target: { value: "__new" } });
    const card = await screen.findByLabelText("New stakeholder");
    type(/^Legal name/, "Theo Marchetti");
    type(/^E-mail/, "theo.marchetti@mailbox.example");
    fireEvent.click(within(card).getByRole("button", { name: "Review" }));
    fireEvent.click(within(card).getByRole("button", { name: "Add stakeholder" }));
    expect(await within(card).findByText(LOST)).toBeTruthy();
    // Switching to an existing holder would unmount the card with its body and key: the selector is locked.
    expect(holder.disabled).toBe(true);
    expect(screen.getByText("Settle the new stakeholder first: Try again, or Check what was recorded.")).toBeTruthy();
    fireEvent.change(holder, { target: { value: IDS.daniel } });
    expect(holder.value).toBe("__new");
    expect(screen.getByLabelText("New stakeholder")).toBe(card);
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Theo Marchetti added")).toBeTruthy();
    await waitFor(() => expect(holder.disabled).toBe(false));
    const calls = callsTo(api.routes.createStakeholder);
    expect(calls).toHaveLength(2);
    expect(keysOf(calls)[1]).toBe(keysOf(calls)[0]);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
  }, 60_000);

  it("is closed to read-only admins and never offers the admin's own record", async () => {
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: preview() });
    renderPage("issue/options", handlers(grant), { role: "admin_ro" });
    expect(await screen.findByText("You have read-only access")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    renderPage("issue/options", handlers(grant), { role: "admin_rw", ownStakeholderId: IDS.daniel });
    const holder = await screen.findByLabelText(/Stakeholder/);
    await waitFor(() => expect(within(holder).getByRole("option", { name: /Freya Lindqvist/ })).toBeTruthy());
    expect(within(holder).queryByRole("option", { name: /Daniel Achterberg/ })).toBeNull();
    expect(within(holder).queryByRole("option", { name: new RegExp(STAKEHOLDERS.nadia.displayName) })).toBeNull();
  }, 60_000);

  it("opens from + New's Add contracts panel", async () => {
    const { router } = renderPage("captable", [...handlers(commandRoute(api.routes.grantEquityCompensation, {})), mock(api.routes.getCapTable, capTable()), mock(api.routes.getDashboard, dashboard())], { role: "admin_rw" });
    fireEvent.click(await screen.findByRole("button", { name: /New/ }));
    const panel = await screen.findByRole("dialog", { name: "Add contracts" });
    expect(within(panel).getByText("Add a signed agreement to the cap table")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("link", { name: /Options/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/issue/options`));
    expect(router.state.location.search).toBe("?mode=existing");
    expect(screen.queryByRole("dialog", { name: "Add contracts" })).toBeNull();
  }, 60_000);

  it("overrides with the latest final 409A, never a newer valuation of another type or a draft report", async () => {
    const other = valuation({ id: uuid(8, 7), name: "Sep 2026 Token Valuation", valuationType: "OTHER", effectiveDate: "2026-09-01", expirationDate: null, status: "not_409a", presumptivelyValidUntil: null });
    const draft = valuation({ id: uuid(8, 8), name: "Oct 2026 Draft", reportVersion: "DRAFT", effectiveDate: "2026-10-01", expirationDate: "2027-10-01", status: "draft", presumptivelyValidUntil: null });
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: preview() });
    const list = handlers(grant, null).map((handler) => (handler.route === api.routes.listValuations ? mock(api.routes.listValuations, { items: [...VALUATIONS, other, draft] }) : handler));
    const { callsTo } = renderPage("issue/options", list);
    const holder = await screen.findByLabelText(/Stakeholder/);
    await waitFor(() => expect(within(holder).getByRole("option", { name: /Daniel Achterberg/ })).toBeTruthy());
    fireEvent.change(holder, { target: { value: IDS.daniel } });
    type("Number of options", "40,000");
    type(/Board approval date/, "2026-10-20");
    // The block names the final 409A, not the newer token valuation or the draft.
    expect(await screen.findByText(/No presumptively valid 409A on Oct 20, 2026 \(Nov 2025 Valuation: expiring soon\)/, { selector: ".err-inline" })).toBeTruthy();
    await attach(/Signed board consent/, "BA-19 New-hire grant consent.pdf");
    fireEvent.click(screen.getByLabelText(/employee at grant/));
    fireEvent.click(screen.getByLabelText(/Matches the signed agreement/));
    type("Exercise price", "0.95");
    await attach(/Executed agreement/, "OPT-57 Option Agreement (signed).pdf");
    fireEvent.click(screen.getByLabelText(/signed by both the holder and the company signatory/));
    await attach(/Counsel memo/, "Counsel memo - grant pricing.pdf");
    click("Review");
    await waitForCalls(() => dryRuns(callsTo(api.routes.grantEquityCompensation)), 1);
    // The admin's override carries the final 409A in effect before the grant date.
    expect(dryRuns(callsTo(api.routes.grantEquityCompensation))[0]!.body).toMatchObject({ valuationId: IDS.v5 });
  }, 60_000);

  it("blocks a grant without a valid 409A and offers the counsel-memo override", async () => {
    const grant = commandRoute(api.routes.grantEquityCompensation, { preview: preview() });
    renderPage("issue/options", handlers(grant, null));
    const holder = await screen.findByLabelText(/Stakeholder/);
    await waitFor(() => expect(within(holder).getByRole("option", { name: /Daniel Achterberg/ })).toBeTruthy());
    fireEvent.change(holder, { target: { value: IDS.daniel } });
    type(/Board approval date/, "2026-10-20");
    expect(await screen.findByText(/No presumptively valid 409A on Oct 20, 2026 \(Nov 2025 Valuation: expiring soon\)/, { selector: ".err-inline" })).toBeTruthy();
    expect(screen.getByLabelText(/Counsel memo/)).toBeTruthy();
  }, 60_000);
});
