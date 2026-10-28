import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { IDS, SECURITIES, security, uuid } from "./support/acme.ts";
import { DIFF_A, DIFF_B, attach, choose, click, commandRoute, dryRuns, errorOf, field, keysOf, realCalls, refused, result, stale, type, unavailable, uploads, waitForCalls, LOST, asReviewed } from "./support/flows.ts";
import { deferred, mock, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { DETAILS, detailOf, securityHandlers, STAKEHOLDER_DETAILS } from "./support/securities.ts";
import { CHANGED_MESSAGE } from "../../src/app/lib/flow.ts";
import { base, renderPage } from "./support/render.tsx";

// Record exercise: the exercise date from the notice and the payment, the ISO check, the FMV at
// that date, the tax fields entered, the server's preview of the exercise and its shares, and the write cycle.

const CS9 = uuid(6, 9);
const preview = (overrides: Partial<api.CommandResult> = {}) => result({
  transactions: [
    { id: null, seq: null, type: "TX_EQUITY_COMPENSATION_EXERCISE", effectiveDate: "2026-10-20", securityId: IDS.opt1, quantity: "30000" },
    { id: null, seq: null, type: "TX_STOCK_ISSUANCE", effectiveDate: "2026-10-20", securityId: CS9, quantity: "30000" },
  ],
  created: { securityIds: [CS9], scheduledTerminationIds: [], vestingTermsIds: [] },
  changes: [
    { entity: "security", id: IDS.opt1, before: { displayId: "OPT-1", status: "OUTSTANDING", outstanding: "250000", exercised: "50000" }, after: { displayId: "OPT-1", status: "OUTSTANDING", outstanding: "220000", exercised: "80000" } },
    { entity: "security", id: CS9, before: null, after: { displayId: "CS-9", status: "OUTSTANDING", outstanding: "30000" } },
    { entity: "stock_class", id: IDS.common, before: { issuedAndOutstanding: "9743000", fullyDiluted: "9743000", authorized: "30000000" }, after: { issuedAndOutstanding: "9773000", fullyDiluted: "9773000", authorized: "30000000" } },
    { entity: "capital", id: uuid(1, 1), before: { capitalContribution: "16147718.6" }, after: { capitalContribution: "16150718.6" } },
  ],
  // The server's split for the exercise date: ISO lots first, with the share ID the lot will have.
  exercise: { date: "2026-10-20", isoAvailable: "231250", lots: { iso: "30000", nso: "0" }, portions: [{ portion: "ISO", quantity: "30000", reason: null, displayId: "CS-9" }] },
  ...overrides,
});
const recorded = result({ ...preview(), commandId: uuid(30, 2), dryRun: false, ledgerSeq: 413 }, true);

/** The real call is the previewed request plus the server's split (its lots and share IDs) and the confirmation. */
function expectSentWithServerSplit(dryRun: MockRequest, real: MockRequest, split: NonNullable<api.CommandResult["exercise"]>) {
  const { lots, resultingShares, ...rest } = asReviewed(real.body);
  const { lots: _lots, resultingShares: _shares, ...previewed } = asReviewed(dryRun.body);
  expect(rest).toEqual(previewed);
  expect(lots).toEqual([
    ...(split.lots.iso !== "0" ? [{ portion: "ISO", quantity: split.lots.iso }] : []),
    ...(split.lots.nso !== "0" ? [{ portion: "NSO", quantity: split.lots.nso }] : []),
  ]);
  expect(resultingShares).toEqual(split.portions.map(({ portion, displayId }) => ({ portion, displayId })));
}

const instructions = mock(api.routes.getPaymentInstructions, {
  details: { bankName: "First Example Bank", beneficiaryName: "Acme Robotics, Inc.", beneficiaryAddress: "400 Harbor Way, Oakland, CA", accountNumber: "••••4321", routingNumber: "000000000", referenceFormat: "EX-<grant>-<initials>" },
  updatedBy: "Rachel Ostrowski", updatedAt: Date.UTC(2026, 9, 2),
});

function handlers(exercise: MockHandler, details: Record<string, api.SecurityDetail> = DETAILS): MockHandler[] {
  return [
    mock(api.routes.getSecurity, (request: MockRequest) => details[request.params.id!] ?? DETAILS[request.params.id!]),
    ...securityHandlers.filter((handler) => handler.route !== api.routes.getSecurity),
    instructions,
    uploads(),
    exercise,
  ];
}

async function fillExercise(quantity = "30,000") {
  await screen.findByRole("heading", { name: "Record exercise — OPT-1", level: 1 });
  await attach(/Signed notice/, "OPT-1 Notice of Exercise - signed.pdf");
  type(/Date received/, "2026-10-19");
  type(/Date full payment received/, "2026-10-20");
  type(/Options exercised/, quantity);
  await waitFor(() => expect(field(/Reference/).placeholder).toBe("EX-OPT-1-DA"));
  type(/Reference/, "EX-OPT-1-DA");
  await screen.findByText(/\$0\.95/, { selector: "b" });
}

describe("record exercise", () => {
  it("disables Review while the exercise-date FMV is loading, then enables it once the FMV arrives", async () => {
    const fmv = deferred<api.FmvResponse>();
    const exercise = commandRoute(api.routes.exerciseOption, { preview: preview() });
    renderPage(`securities/${IDS.opt1}/exercise`, [
      ...handlers(exercise).filter((handler) => handler.route !== api.routes.getFmv),
      mock(api.routes.getFmv, () => fmv.promise),
    ], { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Record exercise — OPT-1", level: 1 });
    type(/Date received/, "2026-10-19");
    type(/Date full payment received/, "2026-10-20");

    const review = screen.getByRole("button", { name: "Review" }) as HTMLButtonElement;
    await waitFor(() => expect(review.disabled).toBe(true));
    expect(screen.getByText("Loading the FMV for Oct 20, 2026…")).toBeTruthy();

    fmv.resolve({ date: "2026-10-20", stockClassId: IDS.common, fmv: { valuationId: IDS.v5, valuationName: "Nov 2025 Valuation", pricePerShare: "0.95", splitAdjusted: false, status: "expiring_soon" } });
    await waitFor(() => expect(review.disabled).toBe(false));
    expect(screen.queryByText("Loading the FMV for Oct 20, 2026…")).toBeNull();
  }, 60_000);

  it("checks the notice, payment and quantity before anything is sent, and a W-2 NSO spread's $0 withholding", async () => {
    const exercise = commandRoute(api.routes.exerciseOption, { preview: preview() });
    const { callsTo } = renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Record exercise — OPT-1", level: 1 });
    click("Review");
    expect(errorOf(/Signed notice/)).toBe("Upload the holder's signed notice of exercise.");
    expect(errorOf(/Date received/)).toBe("Enter the date the notice was received.");
    expect(errorOf(/Amount received/)).toBe("Enter the amount received.");
    expect(errorOf(/Date full payment received/)).toBe("Enter the date full payment was received.");
    expect(errorOf(/Reference/)).toBe("Enter the payment reference.");
    expect(errorOf(/Options exercised/)).toBe("Enter how many options were exercised.");
    expect(callsTo(api.routes.exerciseOption)).toHaveLength(0);
  }, 60_000);

  it("computes the exercise date and the cost, leaves the lots to the server, then shows its preview and split figure for figure", async () => {
    const exercise = commandRoute(api.routes.exerciseOption, { preview: preview() });
    const { callsTo } = renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_rw" });
    await fillExercise();
    expect(field(/Amount received/).value).toBe("3000");
    expect(screen.getByText("Oct 20, 2026", { selector: "b" })).toBeTruthy();
    expect(screen.getByText("The holder is employed: ISO treatment applies to ISO lots.")).toBeTruthy();
    click("Review");
    await waitForCalls(() => dryRuns(callsTo(api.routes.exerciseOption)), 1);
    expect(dryRuns(callsTo(api.routes.exerciseOption))[0]!.body).toMatchObject({
      securityId: IDS.opt1, quantity: "30000", exerciseDate: "2026-10-20",
      notice: { receivedOn: "2026-10-19" },
      payment: { amount: "3000", receivedOn: "2026-10-20", method: "ACH", reference: "EX-OPT-1-DA", payerIsHolder: true },
      fmv: { source: "valuation", valuationId: IDS.v5 },
      tax: { treatment: "W2" },
    });
    // ISO first is the server's to apply for the date: the request names no lots and no shares.
    const sent = dryRuns(callsTo(api.routes.exerciseOption))[0]!.body as Record<string, unknown>;
    expect("lots" in sent || "resultingShares" in sent).toBe(false);
    const split = await screen.findByRole("region", { name: "Lots and resulting shares" });
    expect(within(split).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "ISO lots still exercisable as ISO on that date: 231,250", "Lots used: 30,000 ISO · 0 NSO", "CS-9: 30,000 ISO shares",
    ]);
    const panel = await screen.findByRole("region", { name: "Server preview" });
    const rows = within(within(panel).getByRole("table", { name: "Transactions" })).getAllByRole("row").map((row) => row.textContent);
    expect(rows.slice(1)).toEqual(["ExerciseOct 20, 2026OPT-130,000", "Share issuance (book entry)Oct 20, 2026CS-930,000"]);
    expect(within(panel).getByRole("region", { name: "Company" }).textContent).toContain("Capital contribution$16,147,718.60→$16,150,718.60");
    expect(within(panel).getByRole("region", { name: "OPT-1" }).textContent).toContain("Outstanding250,000→220,000");
    // The app sends no e-mail: the server's notice list isn't shown.
    expect(within(panel).queryByText(/recipient/)).toBeNull();
  }, 60_000);

  it("records the reviewed exercise with its seq, diff and key, then returns to the option", async () => {
    const exercise = commandRoute(api.routes.exerciseOption, { preview: preview(), commit: recorded });
    const { callsTo, router } = renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_rw" });
    await fillExercise();
    click("Review");
    await screen.findByRole("region", { name: "Server preview" });
    click("Record exercise");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${IDS.opt1}`));
    const real = realCalls(callsTo(api.routes.exerciseOption))[0]!;
    expect(real.body).toMatchObject({ expectedLedgerSeq: 412, expectedDiffSha256: DIFF_A, acknowledge: [], lots: [{ portion: "ISO", quantity: "30000" }], resultingShares: [{ portion: "ISO", displayId: "CS-9" }] });
    expectSentWithServerSplit(dryRuns(callsTo(api.routes.exerciseOption))[0]!, real, preview().exercise!);
    expect(real.headers.get("Idempotency-Key")).toBeTruthy();
    expect(await screen.findByText("Exercise recorded — CS-9 issued (book entry)")).toBeTruthy();
  }, 60_000);

  it("shows the server's violations next to the quantity, the payment and the date", async () => {
    const exercise = commandRoute(api.routes.exerciseOption, {
      preview: refused([
        { code: "EXCEEDS_VESTED_UNEXERCISED", message: "Exercises 300000 with 218750 vested and unexercised on 2026-10-20" },
        { code: "PAYMENT_BELOW_COST", message: "The payment is below the exercise cost of 30000" },
        { code: "EXERCISE_DATE_MISMATCH", message: "The exercise date is 2026-10-20" },
      ]),
    });
    renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_rw" });
    await fillExercise("300,000");
    click("Review");
    await waitFor(() => expect(errorOf(/Options exercised/)).toBe("Exercises 300000 with 218750 vested and unexercised on 2026-10-20"));
    expect(errorOf(/Amount received/)).toBe("The payment is below the exercise cost of 30000");
    expect(errorOf(/Date full payment received/)).toBe("The exercise date is 2026-10-20");
  }, 60_000);

  it("offers the deadline extension when the exercise is after the contractual deadline", async () => {
    const late = detailOf(security({ ...SECURITIES.opt1, deadlines: { contractual: "2026-10-01", iso: "2026-10-01", reason: "3 months after voluntary termination" } }));
    const exercise = commandRoute(api.routes.exerciseOption, { preview: refused([{ code: "AFTER_CONTRACTUAL_DEADLINE", message: "The exercise date is after the contractual deadline" }]) });
    renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise, { [IDS.opt1]: late }));
    await fillExercise();
    expect(screen.getByText(/Exercise date is after the ISO deadline \(Oct 1, 2026\)/)).toBeTruthy();
    // After the ISO deadline every share is NSO, so the W-2 spread needs its withholding or a reason.
    type("Reason if $0", "Collected by payroll later");
    click("Review");
    expect(await screen.findByText("An admin can extend the contractual deadline")).toBeTruthy();
    click("Extend exercise deadline");
    expect(await screen.findByRole("dialog", { name: "Extend the exercise deadline — OPT-1" })).toBeTruthy();
  }, 60_000);

  it("retries a lost answer with the same Idempotency-Key", async () => {
    const exercise = commandRoute(api.routes.exerciseOption, { preview: preview(), commit: [unavailable(), recorded] });
    const { callsTo, router } = renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_rw" });
    await fillExercise();
    click("Review");
    await screen.findByRole("region", { name: "Server preview" });
    click("Record exercise");
    expect(await screen.findByText(LOST)).toBeTruthy();
    // Nothing can be changed until the outcome is known.
    expect((screen.getByRole("button", { name: "Change answers" }) as HTMLButtonElement).disabled).toBe(true);
    click("Try again");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${IDS.opt1}`));
    const real = realCalls(callsTo(api.routes.exerciseOption));
    const keys = keysOf(real);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(real[1]!.body).toEqual(real[0]!.body);
    expectSentWithServerSplit(dryRuns(callsTo(api.routes.exerciseOption))[0]!, real[0]!, preview().exercise!);
  }, 60_000);

  it("refreshes the preview on a stale ledger and confirms the new one", async () => {
    const fresh = preview({ ledgerSeq: 414, diffSha256: DIFF_B, changes: [
      { entity: "security", id: IDS.opt1, before: { displayId: "OPT-1", outstanding: "240000" }, after: { displayId: "OPT-1", outstanding: "210000" } },
    ] });
    const exercise = commandRoute(api.routes.exerciseOption, { preview: [preview(), fresh], commit: [stale(), recorded] });
    const { callsTo, router } = renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_rw" });
    await fillExercise();
    click("Review");
    await screen.findByRole("region", { name: "Server preview" });
    click("Record exercise");
    expect(await screen.findByText("Review again")).toBeTruthy();
    expect((await screen.findByRole("region", { name: "OPT-1" })).textContent).toContain("240,000→210,000");
    click("Record exercise");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${IDS.opt1}`));
    expect(realCalls(callsTo(api.routes.exerciseOption)).map((call) => (call.body as { expectedLedgerSeq: number }).expectedLedgerSeq)).toEqual([412, 414]);
  }, 60_000);

  it("enters W-2 withholding for an NSO spread and asks a reason for $0", async () => {
    const exercise = commandRoute(api.routes.exerciseOption, { preview: preview() });
    const { callsTo } = renderPage(`securities/${IDS.opt21}/exercise`, handlers(exercise), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "Record exercise — OPT-21", level: 1 });
    await attach(/Signed notice/, "OPT-21 Notice of Exercise - signed.pdf");
    type(/Date received/, "2026-10-20");
    type(/Date full payment received/, "2026-10-20");
    type(/Options exercised/, "10,000");
    type(/Reference/, "CHK-1042");
    choose(/Treatment/, "W2");
    expect(await screen.findByText(/NSO spread:/)).toBeTruthy();
    expect(screen.getByText("$6,400.00", { selector: "b" })).toBeTruthy();
    click("Review");
    expect(errorOf("Reason if $0")).toBe("$0 withheld on a W-2 NSO spread needs a reason.");
    type("Reason if $0", "Withheld through payroll in November");
    type("Federal income tax withheld", "1,408.00");
    click("Review");
    await waitForCalls(() => dryRuns(callsTo(api.routes.exerciseOption)), 1);
    expect(dryRuns(callsTo(api.routes.exerciseOption))[0]!.body).toMatchObject({
      quantity: "10000", tax: { treatment: "W2", withholding: { federalIncome: "1408", socialSecurity: "0", medicare: "0", state: [] }, zeroReason: "Withheld through payroll in November" },
    });
  }, 60_000);

  it("drops the preview when the holder's record arrives late and changes the tax treatment, and sends exactly the new review", async () => {
    const late = deferred<api.StakeholderDetail>();
    const exercise = commandRoute(api.routes.exerciseOption, { preview: [preview(), preview({ diffSha256: DIFF_B })], commit: recorded });
    const { callsTo, router } = renderPage(`securities/${IDS.opt1}/exercise`, [
      mock(api.routes.getStakeholder, () => late.promise),
      ...handlers(exercise).filter((handler) => handler.route !== api.routes.getStakeholder),
    ], { role: "admin_rw" });
    await fillExercise();
    click("Review");
    await screen.findByRole("region", { name: "Server preview" });
    // Until the record says otherwise, the holder isn't known to be an employee: 1099-NEC.
    expect(dryRuns(callsTo(api.routes.exerciseOption))[0]!.body).toMatchObject({ tax: { treatment: "FORM_1099_NEC" } });
    late.resolve(STAKEHOLDER_DETAILS[IDS.daniel]!);
    expect(await screen.findByText(CHANGED_MESSAGE)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Server preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Record exercise" })).toBeNull();
    click("Review");
    await waitForCalls(() => dryRuns(callsTo(api.routes.exerciseOption)), 2);
    await screen.findByRole("region", { name: "Server preview" });
    click("Record exercise");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${IDS.opt1}`));
    const second = dryRuns(callsTo(api.routes.exerciseOption))[1]!;
    const real = realCalls(callsTo(api.routes.exerciseOption))[0]!;
    expect(second.body).toMatchObject({ tax: { treatment: "W2" } });
    expectSentWithServerSplit(second, real, preview().exercise!);
    expect(real.body).toMatchObject({ expectedDiffSha256: DIFF_B });
  }, 60_000);

  it("asks for W-2 withholding when the $100,000 limit makes part NSO, and sends the server's two lots and share IDs", async () => {
    const twoLots = { date: "2026-10-20", isoAvailable: "20000", lots: { iso: "20000", nso: "10000" }, portions: [
      { portion: "ISO" as const, quantity: "20000", reason: null, displayId: "CS-9" },
      { portion: "NSO" as const, quantity: "10000", reason: "ISO_LIMIT" as const, displayId: "CS-10" },
    ] };
    const zero = refused([{ code: "ZERO_WITHHOLDING_NEEDS_REASON", message: "Say why nothing was withheld on a W-2 NSO spread above zero" }]);
    const exercise = commandRoute(api.routes.exerciseOption, { preview: [zero, preview({ exercise: twoLots })], commit: recorded });
    const { callsTo, router } = renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_rw" });
    await fillExercise();
    expect(screen.queryByLabelText("Reason if $0")).toBeNull();
    click("Review");
    // The server applied the limit and refused the $0 withholding: the field it names appears with its message.
    await waitFor(() => expect(errorOf("Reason if $0")).toBe("Say why nothing was withheld on a W-2 NSO spread above zero"));
    type("Reason if $0", "Withheld through payroll in November");
    click("Review");
    const split = await screen.findByRole("region", { name: "Lots and resulting shares" });
    expect(within(split).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "ISO lots still exercisable as ISO on that date: 20,000", "Lots used: 20,000 ISO · 10,000 NSO", "CS-9: 20,000 ISO shares", "CS-10: 10,000 NSO shares, NSO beyond the $100,000 ISO limit",
    ]);
    click("Record exercise");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${IDS.opt1}`));
    const real = realCalls(callsTo(api.routes.exerciseOption))[0]!;
    expect(real.body).toMatchObject({
      lots: [{ portion: "ISO", quantity: "20000" }, { portion: "NSO", quantity: "10000" }],
      resultingShares: [{ portion: "ISO", displayId: "CS-9" }, { portion: "NSO", displayId: "CS-10" }],
      tax: { treatment: "W2", zeroReason: "Withheld through payroll in November" },
    });
    expectSentWithServerSplit(dryRuns(callsTo(api.routes.exerciseOption))[1]!, real, twoLots);
  }, 60_000);

  it("sends a split the admin chose with its reason, and the server's echo of it on the real call", async () => {
    const chosen = { date: "2026-10-20", isoAvailable: "231250", lots: { iso: "0", nso: "30000" }, portions: [
      { portion: "NSO" as const, quantity: "30000", reason: "LOT_CHOICE" as const, displayId: "CS-9" },
    ] };
    const exercise = commandRoute(api.routes.exerciseOption, { preview: preview({ exercise: chosen }), commit: recorded });
    const { callsTo, router } = renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_rw" });
    await fillExercise();
    fireEvent.click(screen.getByRole("radio", { name: /Choose the lots/ }));
    type("NSO lots", "20,000");
    type("Reason if $0", "Collected by payroll later");
    click("Review");
    expect(errorOf("ISO lots")).toBe("The lots must add up to the 30,000 options exercised.");
    expect(errorOf(/Reason for this split/)).toBe("Say why the lots differ from ISO first (audited).");
    expect(dryRuns(callsTo(api.routes.exerciseOption))).toHaveLength(0);
    type("NSO lots", "30,000");
    type(/Reason for this split/, "Holder asked to exercise the NSO portion first");
    click("Review");
    await waitForCalls(() => dryRuns(callsTo(api.routes.exerciseOption)), 1);
    expect(dryRuns(callsTo(api.routes.exerciseOption))[0]!.body).toMatchObject({ lots: [{ portion: "NSO", quantity: "30000" }], lotReason: "Holder asked to exercise the NSO portion first" });
    await screen.findByRole("region", { name: "Lots and resulting shares" });
    click("Record exercise");
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/securities/${IDS.opt1}`));
    const real = realCalls(callsTo(api.routes.exerciseOption))[0]!;
    expect(real.body).toMatchObject({ lots: [{ portion: "NSO", quantity: "30000" }], lotReason: "Holder asked to exercise the NSO portion first", resultingShares: [{ portion: "NSO", displayId: "CS-9" }] });
  }, 60_000);

  it("is closed to read-only admins, on the admin's own option, and for a grant awaiting signatures", async () => {
    const exercise = commandRoute(api.routes.exerciseOption, { preview: preview() });
    renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_ro" });
    expect(await screen.findByText("You have read-only access")).toBeTruthy();
    renderPage(`securities/${IDS.opt1}/exercise`, handlers(exercise), { role: "admin_rw", ownStakeholderId: IDS.daniel });
    expect(await screen.findByText("This is your own record")).toBeTruthy();
    renderPage(`securities/${IDS.opt49}/exercise`, handlers(exercise), { role: "admin_rw" });
    expect(await screen.findByText("This grant cannot be exercised until it is marked executed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  }, 60_000);
});

describe("the option's Actions open the exercise", () => {
  it("links Record exercise to its page", async () => {
    renderPage(`securities/${IDS.opt1}`, handlers(commandRoute(api.routes.exerciseOption, {})), { role: "admin_rw" });
    await screen.findByRole("heading", { name: "OPT-1 Options", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Record exercise/ }).getAttribute("href")).toBe(`${base}/securities/${IDS.opt1}/exercise`);
  }, 60_000);
});
