import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { auditEvent, document, IDS, SECURITIES, STAKEHOLDERS, stakeholder, stakeholderList, TODAY, uuid, VESTING_TERMS } from "./support/acme.ts";
import { apiError, mock, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

function rowOf(table: HTMLElement, text: string) {
  return within(table).getAllByRole("row").find((row) => within(row).queryByText(text)) as HTMLElement;
}

describe("stakeholders list", () => {
  const list = mock(api.routes.listStakeholders, stakeholderList());

  it("lists stakeholders with their e-mails, relationship and holdings", async () => {
    renderPage("stakeholders", [list]);
    const table = await screen.findByRole("table", { name: "Stakeholders" });
    const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent?.replace(/[▲▼]/, ""));
    expect(headers).toEqual(["Name", "E-mail", "Relationship", "Type", "Fully diluted shares", "Ownership", "Actions"]);
    const northgate = rowOf(table, "Northgate Ventures Fund II, L.P.");
    expect(within(northgate).getByText("ops@northgate.example")).toBeTruthy();
    expect(within(northgate).getByText("+1")).toBeTruthy();
    expect(within(northgate).getByText("Institution")).toBeTruthy();
    expect(within(northgate).getByText("3,858,173")).toBeTruthy();
    expect(within(northgate).getByText("15.87%")).toBeTruthy();
    expect(within(rowOf(table, "Nadia Pereira-Stone")).getByText("Former Employee")).toBeTruthy();
    expect(within(table).queryByText(/Invited|Not invited|Google/)).toBeNull();
    expect(within(table).getByRole("link", { name: "Preview Freya Lindqvist as stakeholder" }).getAttribute("href")).toBe(`${base}/stakeholders/${IDS.freya}/preview`);
  });

  it("names current employees with no e-mail, who can't see their holdings", async () => {
    const withEmail = stakeholder({ id: uuid(3, 90), displayName: "Leila Farahani", totals: { issuedAndOutstanding: "0", fullyDiluted: "105000", fullyDilutedPct: "0", capitalContribution: "0" } });
    const noEmail = stakeholder({ id: uuid(3, 91), displayName: "Mina Rahman", emails: [], totals: { issuedAndOutstanding: "1", fullyDiluted: "1", fullyDilutedPct: "0", capitalContribution: "0" } });
    renderPage("stakeholders", [mock(api.routes.listStakeholders, stakeholderList([...Object.values(STAKEHOLDERS), withEmail, noEmail]))]);
    expect(await screen.findByText("1 stakeholder has no holdings")).toBeTruthy();
    expect(screen.getByText("1 current employee has no e-mail address — they can't see their holdings")).toBeTruthy();
    expect(screen.getByText(/matches a console account to a stakeholder by e-mail/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Mina Rahman" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Leila Farahani" })).toHaveLength(1);
  });

  it("flags duplicate e-mails for admins who see personal data", async () => {
    const twin = stakeholder({ id: uuid(3, 91), displayName: "Daniel Achterberg (duplicate)", emails: STAKEHOLDERS.daniel.emails });
    renderPage("stakeholders", [mock(api.routes.listStakeholders, stakeholderList([STAKEHOLDERS.daniel, twin]))]);
    const table = await screen.findByRole("table", { name: "Stakeholders" });
    expect(within(table).getAllByText("Duplicate")).toHaveLength(2);
  });

  it("filters by status and searches by e-mail", async () => {
    renderPage("stakeholders", [list]);
    const table = await screen.findByRole("table", { name: "Stakeholders" });
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "terminated" } });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search stakeholders" }), { target: { value: "kensington" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Marcus Oyelaran")).toBeTruthy();
  });

  it("masks e-mails for editors without personal data, won't search them, and offers only Download", async () => {
    renderPage("stakeholders", [list], { role: "admin_ro" });
    const table = await screen.findByRole("table", { name: "Stakeholders" });
    expect(within(table).getByText("o•••@northgate.example")).toBeTruthy();
    expect(within(table).queryByText("ops@northgate.example")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search stakeholders" }), { target: { value: "kensington" } });
    expect(within(table).getByText("No results match.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Download"]);
    expect(screen.getByText("Read-only")).toBeTruthy();
  });

  it("offers owners and admins Add stakeholder and Download, and no portal invitations", async () => {
    renderPage("stakeholders", [list], { role: "admin_rw" });
    await screen.findByRole("table", { name: "Stakeholders" });
    expect(screen.queryByRole("link", { name: "Invite to portal" })).toBeNull();
    expect(screen.queryByRole("button", { name: /to the portal$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const add = within(screen.getByRole("menu")).getByRole("menuitem", { name: /Add stakeholder/ });
    expect(add.getAttribute("href")).toBe(`${base}/stakeholders/new`);
  });

  it("shows ten rows a page", async () => {
    const many = Array.from({ length: 12 }, (_, index) => stakeholder({ id: uuid(3, 200 + index), displayName: `Holder ${String(index + 1).padStart(2, "0")}` }));
    renderPage("stakeholders", [mock(api.routes.listStakeholders, stakeholderList(many))]);
    await screen.findByRole("table", { name: "Stakeholders" });
    expect(screen.getByText(/Showing/).textContent).toBe("Showing 1 to 10 of 12 results");
  });
});

describe("stakeholder detail", () => {
  const detail = (overrides: Partial<api.StakeholderDetail> = {}) => ({
    ...STAKEHOLDERS.daniel,
    asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0",
    exercises: [{
      transactionId: uuid(17, 1), commandId: uuid(9, 7), exerciseDate: "2026-03-20", stakeholderId: IDS.daniel, stakeholderName: "Daniel Achterberg",
      securityId: IDS.opt1, grantDisplayId: "OPT-1", quantity: "50000", isoQuantity: "50000", nsoQuantity: "0", exercisePrice: "0.1", cost: "5000",
      paymentMethod: "CHECK", paymentReference: "1042", fmvPerShare: "0.44", taxTreatment: null, withholding: null,
      resultingShares: [{ securityId: IDS.cs7, displayId: "CS-7", portion: "ISO" }], source: { kind: "recorded", requestNumber: null }, reversed: false,
    }],
    ...overrides,
  });
  const handlers = (overrides: Partial<api.StakeholderDetail> = {}, holdings = [SECURITIES.opt1, SECURITIES.opt49, SECURITIES.cs7]) => [
    mock(api.routes.getStakeholder, detail(overrides)),
    mock(api.routes.getStakeholderHoldings, { asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0", items: holdings }),
    mock(api.routes.listVestingTerms, { items: VESTING_TERMS }),
    mock(api.routes.listDocuments, { items: [document({ id: IDS.doc2, filename: "OPT-1 Option Agreement.pdf", kind: "GRANT_AGREEMENT", holderVisible: true })], nextCursor: null }),
    mock(api.routes.listOrgAudit, { items: [auditEvent(5, { targetId: IDS.daniel, details: { summary: "Daniel Achterberg updated" } })], nextCursor: null }),
  ];

  it("shows the overview, details, e-mails, holdings, exercises, documents and activity", async () => {
    renderPage(`stakeholders/${IDS.daniel}`, handlers());
    expect(await screen.findByRole("heading", { name: /Daniel Achterberg/, level: 1 })).toBeTruthy();
    const overview = screen.getAllByRole("definition");
    expect(overview.some((cell) => cell.textContent === "300,000 (1.23%)")).toBe(true);
    expect(screen.getByText("$5,000.00")).toBeTruthy();
    expect(screen.getByText("+1 510 555 0100")).toBeTruthy();
    expect(screen.getByText("120 Larkspur Ln, Oakland, CA 94610, US")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "E-mails" })).toBeTruthy();
    const emails = screen.getByRole("table", { name: "E-mails" });
    expect(within(emails).getByText("daniel.achterberg@mailbox.example")).toBeTruthy();
    expect(within(emails).getAllByText("Own address").length).toBeGreaterThan(0);
    // An owner removes an address row by row and adds one below the table.
    expect(within(emails).getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Add an e-mail to Daniel Achterberg" })).toBeTruthy();
    const options = await screen.findByRole("table", { name: "Options" });
    expect(within(rowOf(options, "OPT-49")).getByText("Execution pending")).toBeTruthy();
    expect(within(rowOf(options, "OPT-1")).getByText("4 years monthly, 1-year cliff (25%)")).toBeTruthy();
    expect(within(rowOf(options, "OPT-1")).getByText("218,750")).toBeTruthy();
    const shares = screen.getByRole("table", { name: "Shares" });
    expect(within(shares).getByText("CS-7")).toBeTruthy();
    const exercises = screen.getByRole("table", { name: "Exercises" });
    expect(within(exercises).getByText("Mar 20, 2026")).toBeTruthy();
    expect(within(exercises).getByText("Check")).toBeTruthy();
    const documents = await screen.findByRole("table", { name: "Documents" });
    expect(within(documents).getByRole("button", { name: "Download OPT-1 Option Agreement.pdf" })).toBeTruthy();
    expect(within(documents).getByText("Yes")).toBeTruthy();
    expect(await screen.findByText("Daniel Achterberg updated")).toBeTruthy();
  });

  it("masks personal data for editors without personal data", async () => {
    renderPage(`stakeholders/${IDS.daniel}`, handlers(), { role: "admin_ro" });
    await screen.findByRole("heading", { name: /Daniel Achterberg/, level: 1 });
    expect(screen.queryByText("+1 510 555 0100")).toBeNull();
    expect(screen.queryByText(/Larkspur/)).toBeNull();
    expect(screen.getAllByText("•••• (masked)").length).toBeGreaterThanOrEqual(3);
    const emails = screen.getByRole("table", { name: "E-mails" });
    expect(within(emails).getByText("d•••@mailbox.example")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("shows editors granted personal data the personal data", async () => {
    renderPage(`stakeholders/${IDS.daniel}`, handlers(), { role: "admin_ro_pii" });
    expect(await screen.findByText("+1 510 555 0100")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("refuses writes on the admin's own record", async () => {
    renderPage(`stakeholders/${IDS.daniel}`, handlers(), { role: "admin_rw", ownStakeholderId: IDS.daniel });
    expect(await screen.findByText("This is your own record")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("gives every owner and admin the Actions menu, Reverse and Merge included, and no e-mail resends", async () => {
    renderPage(`stakeholders/${IDS.nadia}`, handlers({ ...STAKEHOLDERS.nadia, exercises: [] }, [SECURITIES.opt21]), { role: "admin_rw" });
    await screen.findByRole("heading", { name: /Nadia Pereira-Stone/, level: 1 });
    expect(screen.getByText("Terminated on Aug 31, 2026 (Involuntary)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const labels = within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent ?? "");
    expect(labels.some((label) => label.startsWith("Resend exit summary"))).toBe(false);
    expect(labels.some((label) => label.startsWith("Upload document"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Terminate stakeholder"))).toBe(false);
    expect(labels.some((label) => label.startsWith("Reverse termination"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Merge into another stakeholder"))).toBe(true);
  });

  it("shows a scheduled termination's effects from the termination preview", async () => {
    const preview = (request: MockRequest) => ({
      securityId: request.params.id!, terminationDate: "2026-12-04", terminationType: "voluntary", vestingStopDate: "2026-12-04",
      vested: "64166", unvested: "75834", exercisable: "64166", repurchaseable: "0", contractualDeadline: "2027-03-04", isoDeadline: "2027-03-04",
    });
    const { callsTo } = renderPage(`stakeholders/${IDS.mateo}`, [
      ...handlers({ ...STAKEHOLDERS.mateo, exercises: [] }, [SECURITIES.opt18]),
      mock(api.routes.getTerminationPreview, preview),
    ], { role: "owner" });
    expect(await screen.findByRole("heading", { name: "On Dec 4, 2026" })).toBeTruthy();
    const effects = await screen.findByRole("table", { name: "Effects of Mateo Villalobos's scheduled termination" });
    expect(within(effects).getAllByText("75,834")).toHaveLength(2);
    expect(within(effects).getAllByText("Mar 4, 2027")).toHaveLength(2);
    expect(callsTo(api.routes.getTerminationPreview)[0]?.query.get("terminationType")).toBe("voluntary");
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Reverse scheduled termination/ })).toBeTruthy();
  });

  it("lists every e-mail on the record with whose it is", async () => {
    renderPage(`stakeholders/${IDS.freya}`, handlers({ ...STAKEHOLDERS.freya, exercises: [] }, [SECURITIES.cs1]));
    const emails = await screen.findByRole("table", { name: "E-mails" });
    expect(within(emails).getByText("freya@acmerobotics.example")).toBeTruthy();
    expect(within(emails).getByText("freya.lindqvist@mailbox.example")).toBeTruthy();
    expect(within(emails).getAllByText("Own address")).toHaveLength(2);
    expect(screen.queryByText(/Google only|E-mailed link/)).toBeNull();
  });

  it("answers an unknown or malformed stakeholder with the not-found state", async () => {
    renderPage(`stakeholders/${uuid(3, 999)}`, [mock(api.routes.getStakeholder, () => apiError(404, "not_found", "Not found")), ...handlers().slice(1)]);
    expect(await screen.findByText("This stakeholder does not exist.")).toBeTruthy();
    renderPage("stakeholders/not-a-uuid", handlers());
    await waitFor(() => expect(screen.getAllByText("This stakeholder does not exist.")).toHaveLength(2));
  });
});
