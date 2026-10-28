import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { dashboard, EXPIRY_PROPOSALS, expiryRun, expiryRunSummary, IDS, SECURITIES, security, securityList, uuid, VALUATIONS } from "./support/acme.ts";
import { EFFECT_A, EFFECT_B, keysOf, LOST, realCalls, dryRuns, refused, result, stale, type, unavailable } from "./support/flows.ts";
import { apiError, mock, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

// Expiry runs, reached from the dashboard's Needs attention. Admins and editors read the runs
// pending confirmation and each run's proposals, with what confirming would cancel today (`confirmable`); an owner or
// admin checks a pending run with the confirmation's dry run (one result per chosen security, never one with nothing
// left to expire or their own) and confirms it with that check's head and each security's effectSha256. A
// stale head re-checks; a lost answer resends the same request and key; a refusal before the run is bound expires
// nothing; any other refusal stops the confirmation, perhaps part-way, and the securities are read again.

const RUN_ID = 41;
const EFFECT_C = "e3".repeat(32);
// The list holds at most the org's newest run (older unconfirmed runs are superseded): today's, pending by default.
const RUN = expiryRun();
const CONFIRMING = expiryRun({ state: "confirming", confirmationStartedAt: Date.UTC(2026, 9, 21, 18), proposals: EXPIRY_PROPOSALS.slice(0, 1) });
const RUNS = { items: [expiryRunSummary(RUN)] };

/** The securities as the ledger has them. */
const SECURITY_LIST = securityList(Object.values(SECURITIES));

const tx = (securityId: string, quantity: string, family: "option" | "warrant" = "option") => ({
  id: null, seq: null, type: family === "option" ? "TX_EQUITY_COMPENSATION_CANCELLATION" : "TX_WARRANT_CANCELLATION", effectiveDate: "2026-10-20", securityId, quantity,
}) as const;

/** One dry-run result per security asked about, in order, at `seq`. */
function checkOf(ids: readonly string[], seq = 412, effects: Record<string, string> = {}): api.ConfirmExpiryRunResponse {
  return {
    runId: RUN_ID,
    expiryMode: "report_only",
    commands: ids.map((id) => result({
      ledgerSeq: seq,
      transactions: [tx(id, id === IDS.war1 ? "100000" : "30000", id === IDS.war1 ? "warrant" : "option")],
      effectSha256: effects[id] ?? (id === IDS.war1 ? EFFECT_B : EFFECT_A),
    })),
  };
}

function confirmedOf(ids: readonly string[], mode: api.ConfirmExpiryRunResponse["expiryMode"] = "report_only"): api.ConfirmExpiryRunResponse {
  return {
    runId: RUN_ID,
    expiryMode: mode,
    commands: ids.map((id, index) => result({ commandId: uuid(30, index + 1), ledgerSeq: 413 + index, transactions: [{ ...tx(id, id === IDS.war1 ? "100000" : "30000", id === IDS.war1 ? "warrant" : "option"), id: uuid(31, index + 1), seq: 413 + index }] }, true)),
  };
}

const bodyOf = (request: MockRequest) => request.body as { securityIds: string[]; switchToAutomatic?: boolean };

function handlers(confirm: (request: MockRequest) => unknown, options: { securities?: () => unknown; detail?: (request: MockRequest) => unknown; run?: api.ExpiryRunDetail } = {}) {
  const run = options.run ?? RUN;
  return [
    mock(api.routes.listExpiryRuns, { items: [expiryRunSummary(run)] }),
    mock(api.routes.getExpiryRun, options.detail ?? ((request: MockRequest) => (Number(request.params.runId) === run.runId ? run : apiError(404, "not_found", "Expiry run not found")))),
    mock(api.routes.listSecurities, options.securities ?? SECURITY_LIST),
    mock(api.routes.confirmExpiryRun, confirm),
  ];
}

const unused = () => apiError(500, "internal", "unused");

async function openRun(action: "Review" | "View" = "Review", date = "Oct 21, 2026") {
  fireEvent.click(await screen.findByRole("button", { name: `${action} the run of ${date}` }));
  return screen.findByRole("table", { name: "Proposed expiries" });
}

function rowOf(table: HTMLElement, displayId: string): HTMLElement {
  return within(table).getAllByRole("row").find((row) => within(row).queryByRole("link", { name: displayId })) as HTMLElement;
}

describe("expiry runs: reading them", () => {
  it("lists the run pending confirmation, with an admin's Review", async () => {
    renderPage("expiry-runs", handlers(unused));
    const table = await screen.findByRole("table", { name: "Expiry runs pending confirmation" });
    const rows = within(table).getAllByRole("row").slice(1) as HTMLTableRowElement[];
    expect(rows.map((row) => row.cells[0]!.textContent)).toEqual(["Run of Oct 21, 2026"]);
    expect(rows[0]!.cells[2]!.textContent).toBe("4");
    expect(rows[0]!.textContent).toContain("Waiting for an admin");
    expect(within(rows[0]!).getByRole("button", { name: "Review the run of Oct 21, 2026" })).toBeTruthy();
    expect(screen.getByText(/Expiry mode:/).textContent).toContain("Report-only");
  });

  it("says when no run is waiting", async () => {
    renderPage("expiry-runs", [mock(api.routes.listExpiryRuns, { items: [] })]);
    expect(await screen.findByText(/No expiry run is waiting for confirmation\./)).toBeTruthy();
  });

  it("shows an editor the runs and their proposals, with nothing to confirm", async () => {
    const { callsTo } = renderPage("expiry-runs", handlers(unused), { role: "admin_ro" });
    expect(await screen.findByText(/Only an owner or admin confirms a run\./)).toBeTruthy();
    const table = await openRun("View");
    expect(screen.getByText("Only an owner or admin can confirm an expiry run. This is what it proposes, and what confirming would cancel today.")).toBeTruthy();
    // What confirming would cancel today, and nothing for the one exercised since.
    expect(within(rowOf(table, "OPT-21")).getAllByText("30,000")).toHaveLength(2);
    expect(rowOf(table, "OPT-18").textContent).toContain("Nothing left to expire");
    expect(rowOf(table, "OPT-21").textContent).toContain("Nadia Pereira-Stone");
    expect(rowOf(table, "OPT-21").textContent).toContain("Exit window ended");
    expect(within(table).queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Check what confirming does" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
    expect(callsTo(api.routes.confirmExpiryRun)).toHaveLength(0);
  });

  it("shows an admin the run read-only while a confirmation is bound to it", async () => {
    renderPage("expiry-runs", handlers(unused, { run: CONFIRMING }));
    const list = await screen.findByRole("table", { name: "Expiry runs pending confirmation" });
    expect(list.textContent).toContain("A confirmation is under way or stopped");
    await openRun("View");
    expect(screen.getByText(/A confirmation of this run is under way or stopped\. Only that confirmation can finish it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check what confirming does" })).toBeNull();
  });

  it("says when a run can't be read, with Try again, and offers nothing until it is", async () => {
    let reads = 0;
    renderPage("expiry-runs", handlers(unused, { detail: () => (++reads === 1 ? apiError(500, "internal", "The read model is rebuilding.") : RUN) }));
    fireEvent.click(await screen.findByRole("button", { name: "Review the run of Oct 21, 2026" }));
    expect(await screen.findByText(/Couldn't load this run/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check what confirming does" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Check what confirming does" })).toBeTruthy();
  });

  it.each(["owner", "admin_ro"] as const)("is reachable from Needs attention for an %s, with the number of runs waiting", async (role) => {
    const withRun = dashboard({ needsAttention: [...dashboard().needsAttention, { kind: "EXPIRY_RUN_TO_CONFIRM", count: 1, dueDate: null, href: api.EXPIRY_RUNS_HREF }] });
    renderPage("dashboard", [mock(api.routes.getDashboard, withRun), mock(api.routes.listValuations, { items: VALUATIONS })], { role });
    const attention = await screen.findByRole("list", { name: "Needs attention" });
    const link = within(attention).getByRole("link", { name: /Expiry run to confirm/ });
    expect(link.textContent).toContain("1 expiry run waiting for an admin");
    expect(link.getAttribute("href")).toBe(`${base}/expiry-runs`);
  });
});

describe("expiry runs: confirming a run", () => {
  it("offers only what is expirable and not the admin's own, checks it, then confirms with the check's head and each effect — one key across a lost answer — and can switch to automatic", async () => {
    let commits = 0;
    const { callsTo } = renderPage("expiry-runs", handlers((request) => {
      if (request.query.get("dryRun") === "true") return checkOf(bodyOf(request).securityIds);
      commits += 1;
      return commits === 1 ? unavailable() : confirmedOf(bodyOf(request).securityIds, "automatic");
    }), { ownStakeholderId: IDS.daniel });
    const table = await openRun();
    // OPT-1 is the admin's own (Daniel's); OPT-18 has nothing left to expire.
    const own = within(rowOf(table, "OPT-1")).getByRole("checkbox", { name: "Expire OPT-1" }) as HTMLInputElement;
    expect(own.disabled).toBe(true);
    expect(own.checked).toBe(false);
    expect(rowOf(table, "OPT-1").textContent).toContain("Your own holding");
    const spent = within(rowOf(table, "OPT-18")).getByRole("checkbox", { name: "Expire OPT-18" }) as HTMLInputElement;
    expect(spent.disabled).toBe(true);
    expect(spent.checked).toBe(false);
    expect(rowOf(table, "OPT-18").textContent).toContain("Nothing left to expire");
    expect((within(rowOf(table, "OPT-21")).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(rowOf(table, "OPT-21").textContent).toContain("Exit window ended");
    expect(rowOf(table, "WAR-1").textContent).toContain("Term ended");
    fireEvent.click(screen.getByLabelText(/Then switch to automatic expiry/));
    fireEvent.click(screen.getByRole("button", { name: "Check what confirming does" }));
    const review = await screen.findByLabelText("Review");
    expect(review.textContent).toContain("Confirming expires 2 securities as you");
    expect(review.textContent).toContain("switches the company to automatic expiry");
    const checked = screen.getByRole("table", { name: "Proposed expiries" });
    expect(within(rowOf(checked, "OPT-21")).getAllByText("30,000").length).toBeGreaterThan(0);
    expect(within(rowOf(checked, "WAR-1")).getAllByText("100,000").length).toBeGreaterThan(0);
    expect(within(checked).queryByRole("link", { name: "OPT-1" })).toBeNull();
    const confirm = screen.getByRole("button", { name: "Confirm 2 expiries" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type(/to confirm/, "EXPIRE 2 SECURITIES");
    fireEvent.click(confirm);
    expect(await screen.findByText(LOST)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check what was recorded" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("2 securities expired — expiry is automatic from now on")).toBeTruthy();
    const calls = callsTo(api.routes.confirmExpiryRun);
    const [check] = dryRuns(calls);
    expect(check!.body).toEqual({ securityIds: [IDS.opt21, IDS.war1], switchToAutomatic: true });
    expect(check!.headers.get("Idempotency-Key")).toBeNull();
    const sent = realCalls(calls);
    expect(sent.map((call) => call.body)).toEqual(Array(2).fill({
      expectedLedgerSeq: 412, securityIds: [IDS.opt21, IDS.war1], expectedEffectSha256s: { [IDS.opt21]: EFFECT_A, [IDS.war1]: EFFECT_B }, switchToAutomatic: true,
    }));
    expect(keysOf(sent)[0]).toBe(keysOf(sent)[1]);
    expect(keysOf(sent)[0]).toBeTruthy();
    const done = screen.getByRole("table", { name: "Proposed expiries" });
    expect(within(rowOf(done, "OPT-21")).getByText("Expired")).toBeTruthy();
    expect(screen.getByText(/Expiry is now/).textContent).toContain("Expiry is now automatic");
    // The org is read again for its new expiry mode.
    await waitFor(() => expect(callsTo(api.routes.getOrg).length).toBeGreaterThan(1));
  }, 60_000);

  it("checks again after a stale head (nothing expired), marks what changed, and confirms at the new head with a new key", async () => {
    let checks = 0;
    let commits = 0;
    const { callsTo } = renderPage("expiry-runs", handlers((request) => {
      const ids = bodyOf(request).securityIds;
      if (request.query.get("dryRun") === "true") {
        checks += 1;
        return checks === 1 ? checkOf(ids) : checkOf(ids, 415, { [IDS.war1]: EFFECT_C });
      }
      commits += 1;
      return commits === 1 ? stale() : confirmedOf(ids);
    }), { ownStakeholderId: IDS.daniel });
    await openRun();
    fireEvent.click(screen.getByRole("button", { name: "Check what confirming does" }));
    await screen.findByLabelText(/to confirm/);
    type(/to confirm/, "EXPIRE 2 SECURITIES");
    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 expiries" }));
    expect(await screen.findByText(/Another write moved the ledger after your check, so nothing was expired/)).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Proposed expiries" });
    await waitFor(() => expect(rowOf(table, "WAR-1").textContent).toContain("Changed since your last check"));
    expect(rowOf(table, "OPT-21").textContent).not.toContain("Changed since your last check");
    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 expiries" }));
    expect(await screen.findByText("2 securities expired")).toBeTruthy();
    const sent = realCalls(callsTo(api.routes.confirmExpiryRun));
    expect(sent.map((call) => call.body)).toEqual([
      { expectedLedgerSeq: 412, securityIds: [IDS.opt21, IDS.war1], expectedEffectSha256s: { [IDS.opt21]: EFFECT_A, [IDS.war1]: EFFECT_B }, switchToAutomatic: false },
      { expectedLedgerSeq: 415, securityIds: [IDS.opt21, IDS.war1], expectedEffectSha256s: { [IDS.opt21]: EFFECT_A, [IDS.war1]: EFFECT_C }, switchToAutomatic: false },
    ]);
    expect(keysOf(sent)[1]).not.toBe(keysOf(sent)[0]);
  }, 60_000);

  it("shows refusals that name securities on their rows, and leaves them out on request", async () => {
    const { callsTo } = renderPage("expiry-runs", handlers((request) => {
      const ids = bodyOf(request).securityIds;
      if (ids.includes(IDS.opt21)) return refused([{ code: "NOT_EXPIRABLE", message: "OPT-21 is not past its last exercise day, or has nothing outstanding", securityId: IDS.opt21 }]);
      return checkOf(ids);
    }), { ownStakeholderId: IDS.daniel });
    const table = await openRun();
    fireEvent.click(screen.getByRole("button", { name: "Check what confirming does" }));
    expect(await screen.findByText("The server refused the securities marked below. Leave them out and check again.")).toBeTruthy();
    expect(rowOf(table, "OPT-21").textContent).toContain("OPT-21 is not past its last exercise day, or has nothing outstanding");
    fireEvent.click(screen.getByRole("button", { name: "Leave the refused ones out and check again" }));
    expect(await screen.findByRole("button", { name: "Confirm 1 expiry" })).toBeTruthy();
    expect(dryRuns(callsTo(api.routes.confirmExpiryRun)).map((call) => bodyOf(call).securityIds)).toEqual([[IDS.opt21, IDS.war1], [IDS.war1]]);
    expect(screen.getByLabelText(/to confirm/).closest(".fld")!.textContent).toContain("EXPIRE 1 SECURITY");
  }, 60_000);

  it("finds the security behind a refusal that names none (self-dealing) by checking each on its own", async () => {
    renderPage("expiry-runs", handlers((request) => {
      const ids = bodyOf(request).securityIds;
      if (ids.includes(IDS.war1)) return apiError(403, "self_dealing", "An administrator cannot record a transaction on their own holdings");
      return checkOf(ids);
    }));
    const table = await openRun();
    // Without a linked stakeholder of their own, OPT-1 is offered too: leave it out.
    fireEvent.click(within(rowOf(table, "OPT-1")).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Check what confirming does" }));
    expect(await screen.findByText(/Admins never record writes on their own holdings/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find which securities the server refuses" }));
    await waitFor(() => expect(rowOf(table, "WAR-1").textContent).toContain("Your own holding (or a linked record's): another admin must confirm it."));
    expect(rowOf(table, "OPT-21").textContent).not.toContain("another admin must confirm");
    fireEvent.click(screen.getByRole("button", { name: "Leave the refused ones out and check again" }));
    expect(await screen.findByRole("button", { name: "Confirm 1 expiry" })).toBeTruthy();
  }, 60_000);

  it("reads the securities again when a confirmation stops part-way, shows each as the ledger has it, and offers nothing more to send", async () => {
    let lists = 0;
    const afterwards = securityList(Object.values(SECURITIES).map((item) => (item.id === IDS.war1 ? security({ ...item, status: "EXPIRED" }) : item)));
    const { callsTo } = renderPage("expiry-runs", handlers((request) => {
      if (request.query.get("dryRun") === "true") return checkOf(bodyOf(request).securityIds);
      return apiError(409, "conflict", "OPT-21's expiry no longer does what was reviewed", { reason: "state_changed" });
    }, { securities: () => (++lists === 1 ? afterwards : afterwards) }), { ownStakeholderId: IDS.daniel });
    await openRun();
    fireEvent.click(screen.getByRole("button", { name: "Check what confirming does" }));
    await screen.findByLabelText(/to confirm/);
    type(/to confirm/, "EXPIRE 2 SECURITIES");
    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 expiries" }));
    expect(await screen.findByText("The confirmation stopped")).toBeTruthy();
    expect(screen.getByText(/409 state_changed\): OPT-21's expiry no longer does what was reviewed\./)).toBeTruthy();
    expect(screen.getByText(/what wasn't expired waits for the next expiry run/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Proposed expiries" });
    await waitFor(() => expect(within(rowOf(table, "WAR-1")).getByText("Expired")).toBeTruthy());
    expect(within(rowOf(table, "OPT-21")).getByText("Not expired (Outstanding)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Back to the runs" })).toBeTruthy();
    expect(realCalls(callsTo(api.routes.confirmExpiryRun))).toHaveLength(1);
    expect(lists).toBe(1);
  }, 60_000);
});

const NOTHING_EXPIRED = /Nothing was expired: the server refused the confirmation before starting it\./;

/** Opens today's run, checks OPT-21 and WAR-1, types the phrase and confirms once. */
async function confirmTwo() {
  await openRun();
  fireEvent.click(screen.getByRole("button", { name: "Check what confirming does" }));
  await screen.findByLabelText(/to confirm/);
  type(/to confirm/, "EXPIRE 2 SECURITIES");
  fireEvent.click(screen.getByRole("button", { name: "Confirm 2 expiries" }));
}

describe("expiry runs: a refusal before the run is bound expires nothing", () => {
  it.each([
    ["403 forbidden (the company refuses changes)", () => apiError(403, "forbidden", "This organization can't be changed right now.", { reason: "org_inactive" }), /This organization can't be changed right now\./],
    ["400 validation_failed", () => apiError(400, "validation_failed", "The request is invalid", { issues: [{ path: "expectedEffectSha256s", message: "Send the reviewed effectSha256 of exactly the securities confirmed" }] }), /Go back and check again\./],
    ["404 not_found (the run)", () => apiError(404, "not_found", "Expiry run not found"), /no longer a report-only run of this company \(Expiry run not found\)/],
    ["422 NOT_IN_EXPIRY_RUN", () => refused([{ code: "NOT_IN_EXPIRY_RUN", message: "That security isn't one of this run's proposals", securityId: IDS.war1 }]), /leave the securities marked below out, and check again\./],
  ] as const)("%s: says nothing was expired, keeps the review and reads nothing again", async (_name, answer, text) => {
    let lists = 0;
    const { callsTo } = renderPage("expiry-runs", handlers((request) => (request.query.get("dryRun") === "true" ? checkOf(bodyOf(request).securityIds) : answer()), {
      securities: () => {
        lists += 1;
        return SECURITY_LIST;
      },
    }), { ownStakeholderId: IDS.daniel });
    await confirmTwo();
    expect((await screen.findAllByText(NOTHING_EXPIRED)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(screen.queryByText("The confirmation stopped")).toBeNull();
    // Still the review: it can be confirmed again once the cause is gone.
    expect(screen.getByRole("button", { name: "Confirm 2 expiries" })).toBeTruthy();
    expect(realCalls(callsTo(api.routes.confirmExpiryRun))).toHaveLength(1);
    expect(lists).toBe(0);
  }, 60_000);

  it("shows NOT_IN_EXPIRY_RUN on the security it names", async () => {
    renderPage("expiry-runs", handlers((request) => (request.query.get("dryRun") === "true" ? checkOf(bodyOf(request).securityIds)
      : refused([{ code: "NOT_IN_EXPIRY_RUN", message: "That security isn't one of this run's proposals", securityId: IDS.war1 }]))), { ownStakeholderId: IDS.daniel });
    await confirmTwo();
    const table = screen.getByRole("table", { name: "Proposed expiries" });
    await waitFor(() => expect(rowOf(table, "WAR-1").textContent).toContain("That security isn't one of this run's proposals"));
    expect(rowOf(table, "OPT-21").textContent).not.toContain("isn't one of this run's proposals");
  }, 60_000);
});

describe("expiry runs: a refusal after the run is bound stops the confirmation", () => {
  it.each([
    ["422 NOT_EXPIRABLE from an expiry", () => refused([{ code: "NOT_EXPIRABLE", message: "OPT-21 is not past its last exercise day, or has nothing outstanding", securityId: IDS.opt21 }]), /The server refused it: OPT-21 is not past its last exercise day/],
    ["403 self_dealing", () => apiError(403, "self_dealing", "An administrator cannot record a transaction on their own holdings"), /refused a security on your own holdings/],
  ] as const)("%s: reads the securities again and offers nothing more to send", async (_name, answer, text) => {
    let lists = 0;
    const { callsTo } = renderPage("expiry-runs", handlers((request) => (request.query.get("dryRun") === "true" ? checkOf(bodyOf(request).securityIds) : answer()), {
      securities: () => {
        lists += 1;
        return SECURITY_LIST;
      },
    }), { ownStakeholderId: IDS.daniel });
    await confirmTwo();
    expect(await screen.findByText("The confirmation stopped")).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText(NOTHING_EXPIRED)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
    await waitFor(() => expect(lists).toBe(1));
    expect(realCalls(callsTo(api.routes.confirmExpiryRun))).toHaveLength(1);
  }, 60_000);
});
