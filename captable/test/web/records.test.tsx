import "./setup.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { auditEvent, IDS, SEED_CLASS, securityList, stockClass, TODAY, uuid } from "./support/acme.ts";
import { mock, type MockRequest } from "./support/mockApi.ts";
import { base, renderPage } from "./support/render.tsx";

const ECHO = { asOf: TODAY, asKnownAt: 412, ledgerSeq: 412, ledgerHeadHash: "ab".repeat(32), engineVersion: "1.0.0" };

function rowOf(table: HTMLElement, text: string) {
  return within(table).getAllByRole("row").find((row) => within(row).queryByText(text)) as HTMLElement;
}

describe("certificates, legends and terms", () => {
  const certificates = [
    { id: uuid(13, 1), securityId: IDS.cs1, certificateNumber: "CS-1", status: "ISSUED", issuedDate: "2021-02-15", cancelledDate: null, cancelReason: null, documentId: IDS.doc2, signatories: [], legends: [], renderingNote: null, importedFromPulley: true },
    { id: uuid(13, 7), securityId: IDS.cs7, certificateNumber: "CS-7", status: "VOID", issuedDate: "2026-03-20", cancelledDate: null, cancelReason: null, documentId: null, signatories: [], legends: [], renderingNote: null, importedFromPulley: true },
  ];
  const handlers = [
    mock(api.routes.listCertificates, { items: certificates }),
    mock(api.routes.listSecurities, securityList()),
    mock(api.routes.listStockClasses, { ...ECHO, items: [stockClass(), SEED_CLASS] }),
  ];

  it("lists migrated certificates with the no-signature banner", async () => {
    renderPage("certificates", handlers);
    expect(await screen.findByText("No officer signature is recorded on migrated certificates")).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Certificates" });
    const cs1 = rowOf(table, "CS-1");
    expect(within(cs1).getByText("Unsigned PDF (migrated)")).toBeTruthy();
    expect(within(cs1).getByRole("button", { name: "Download certificate CS-1" })).toBeTruthy();
    expect(await within(cs1).findByText("Freya Lindqvist")).toBeTruthy();
    expect(await within(cs1).findByText("Common Stock")).toBeTruthy();
    expect(within(cs1).getByText("4,000,000")).toBeTruthy();
    expect(within(rowOf(table, "CS-7")).getByText("Voided (migrated)")).toBeTruthy();
    const subnav = screen.getByRole("navigation", { name: "Certificates" });
    expect(within(subnav).getByRole("link", { name: "Certificates", current: "page" })).toBeTruthy();
    expect(within(subnav).getByRole("link", { name: "Legends" }).getAttribute("href")).toBe(`${base}/certificates/legends`);
  });

  it("lists legends and shows certificate terms with a sample", async () => {
    const legend = { id: uuid(18, 1), kind: "LEGEND", name: "L1 · Securities Act legend", text: "THE SHARES HAVE NOT BEEN REGISTERED UNDER THE SECURITIES ACT.", archivedAt: null, version: 1 };
    const terms = { id: uuid(18, 9), kind: "CERTIFICATE_TERMS", name: "Common stock certificate", text: "This certifies that {{holder_name}} owns {{quantity}} shares of {{share_class}}.", archivedAt: null, version: 1 };
    renderPage("certificates/legends", [mock(api.routes.listLegends, { items: [legend] })]);
    const table = await screen.findByRole("table", { name: "Legends" });
    expect(within(table).getByText("THE SHARES HAVE NOT BEEN REGISTERED UNDER THE SECURITIES ACT.")).toBeTruthy();
    expect(within(table).getByText("Active")).toBeTruthy();
    renderPage("certificates/terms", [mock(api.routes.listCertificateTerms, { items: [terms] })]);
    expect(await screen.findByText("This certifies that Jane Example owns 10,000 shares of Common Stock.")).toBeTruthy();
    expect(screen.getByText(terms.text)).toBeTruthy();
  });

  it("shows the empty states", async () => {
    renderPage("certificates", [mock(api.routes.listCertificates, { items: [] }), ...handlers.slice(1)]);
    expect(await screen.findByText("No certificates were migrated.")).toBeTruthy();
    renderPage("certificates/terms", [mock(api.routes.listCertificateTerms, { items: [] })]);
    expect(await screen.findByText("No certificate terms were migrated.")).toBeTruthy();
  });
});

describe("recent activity", () => {
  const events = [
    auditEvent(1, { details: { summary: "OPT-26 updated", changes: [{ field: "Vesting stopped", old: null, new: "Oct 1, 2026" }, { field: "Contractual deadline", old: null, new: "Jan 1, 2027" }], commandId: uuid(9, 30) } }),
    auditEvent(2, { action: "stakeholder.update", targetType: "stakeholder", targetId: IDS.nadia, actor: { kind: "user", userId: null, email: "nadia.ps@mailbox.example", authMethod: null }, details: { summary: "Nadia Pereira-Stone updated" } }),
    auditEvent(3, { action: "system.expiry_run_confirmed", actor: { kind: "system", userId: null, email: null, authMethod: null }, details: null }),
    auditEvent(4, { action: "import.commit", actor: { kind: "import", userId: null, email: null, authMethod: null }, details: { summary: "Pulley import recorded" } }),
  ];

  it("lists the audit log with descriptions, field changes and who acted", async () => {
    renderPage("activity", [mock(api.routes.listOrgAudit, { items: events, nextCursor: null })]);
    const table = await screen.findByRole("table", { name: "Audit log" });
    const updated = rowOf(table, "OPT-26 updated");
    expect(within(updated).getByText("Vesting stopped: — → Oct 1, 2026")).toBeTruthy();
    expect(within(updated).getByText("morgan@acmerobotics.example")).toBeTruthy();
    expect(within(rowOf(table, "Nadia Pereira-Stone updated")).getByText("nadia.ps@mailbox.example")).toBeTruthy();
    expect(within(rowOf(table, "Expiry run confirmed (system)")).getByText("System")).toBeTruthy();
    expect(within(rowOf(table, "Pulley import recorded")).getByText("Imported from Pulley")).toBeTruthy();
  });

  it("opens the field-level diff with the command id", async () => {
    renderPage("activity", [mock(api.routes.listOrgAudit, { items: events, nextCursor: null })]);
    const table = await screen.findByRole("table", { name: "Audit log" });
    fireEvent.click(rowOf(table, "OPT-26 updated"));
    const drawer = screen.getByRole("dialog", { name: "Activity detail" });
    expect(within(drawer).getByText(uuid(9, 30))).toBeTruthy();
    const changes = within(drawer).getByRole("table", { name: "Changes" });
    expect(within(changes).getByText("Contractual deadline")).toBeTruthy();
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters by actor type and loads older activity by cursor", async () => {
    const older = auditEvent(9, { details: { summary: "Older event" } });
    const { callsTo } = renderPage("activity", [
      mock(api.routes.listOrgAudit, (request: MockRequest) => (request.query.get("cursor") ? { items: [older], nextCursor: null } : { items: events, nextCursor: "page-2" })),
    ]);
    const table = await screen.findByRole("table", { name: "Audit log" });
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Actor type" }), { target: { value: "system" } });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
    await waitFor(() => expect(callsTo(api.routes.listOrgAudit).at(-1)?.query.get("cursor")).toBe("page-2"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search audit log" }), { target: { value: "Older" } });
    expect(await within(table).findByText("Older event")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older activity" })).toBeNull();
  });

  it("masks personal addresses of actors for read-only admins", async () => {
    renderPage("activity", [mock(api.routes.listOrgAudit, { items: events, nextCursor: null })], { role: "admin_ro" });
    const table = await screen.findByRole("table", { name: "Audit log" });
    expect(within(table).getByText("n•••@mailbox.example")).toBeTruthy();
    expect(within(table).queryByText("nadia.ps@mailbox.example")).toBeNull();
  });

  it("shows the empty state", async () => {
    renderPage("activity", [mock(api.routes.listOrgAudit, { items: [], nextCursor: null })]);
    expect(await screen.findByText("No activity yet.")).toBeTruthy();
  });
});

describe("company profile and settings", () => {
  const payment = {
    details: { bankName: "First Example Bank", beneficiaryName: "Acme Robotics, Inc.", beneficiaryAddress: "400 Harbor Way, Suite 12, Oakland, CA", accountNumber: "••••4321", routingNumber: "000000000", swift: "EXMPUS00", referenceFormat: "EX-<grant>-<initials>" },
    updatedBy: "Rachel Ostrowski", updatedAt: Date.UTC(2026, 9, 2, 17),
  };
  const handlers = [mock(api.routes.getPaymentInstructions, payment), mock(api.routes.listSignatories, { items: [] })];

  it("shows the profile, the holder contact, the payment instructions and the display settings", async () => {
    renderPage("company", handlers);
    const profile = (await screen.findByRole("heading", { name: "Company Profile" })).closest("section")!;
    expect(within(profile).getByText("Acme Robotics, Inc.")).toBeTruthy();
    expect(screen.getByText("Delaware")).toBeTruthy();
    expect(screen.getByText("December 31")).toBeTruthy();
    expect(screen.getByText("••-•••0000")).toBeTruthy();
    expect(await screen.findByText("First Example Bank")).toBeTruthy();
    expect(screen.getByText("••••4321")).toBeTruthy();
    expect(screen.getByText(/by Rachel Ostrowski/)).toBeTruthy();
    expect(screen.getByText("equity@acmerobotics.example")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
    for (const name of ["Edit the company profile", "Edit the company contact", "Edit the display decimals"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("gives every admin the edit buttons, and no payment-instruction approvals", async () => {
    renderPage("company", handlers, { role: "admin_rw" });
    expect(await screen.findByText("Owners and admins edit; editors view.")).toBeTruthy();
    await screen.findByText("First Example Bank");
    expect(screen.getByRole("button", { name: "Edit the company profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit the payment instructions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Propose a change|confirm|Reject|Withdraw/i })).toBeNull();
  });

  it("is reachable from the sidebar's Company group", async () => {
    renderPage("company", handlers, { role: "admin_ro" });
    await screen.findByRole("heading", { name: "Company Profile" });
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Company" }).getAttribute("href")).toBe(`${base}/company`);
    expect(within(nav).getByRole("link", { name: "Recent Activity" }).getAttribute("href")).toBe(`${base}/activity`);
  });
});
