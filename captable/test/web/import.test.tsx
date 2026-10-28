import "./setup.ts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { api } from "#shared";
import { AuthProvider } from "../../src/app/auth/AuthProvider.tsx";
import { routes } from "../../src/app/router.tsx";
import { COMPANY, dashboard, me, org, ORG_ID, stakeholderList, uuid, VALUATIONS, type Role } from "./support/acme.ts";
import { apiError, deferred, mock, mockApi, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { holderMe, NADIA } from "./support/portal.ts";
import { base, renderPage } from "./support/render.tsx";

type Me = api.MeResponse;

// The company import wizard: the setup page's three ways in, the wizard's steps (source → upload → preview → import →
// done), its problems and totals, the disabled Import, re-uploads, a lost answer, the template download, who may use it
// and when it isn't available. Every request and answer goes through the contract-checked fetch mock; the files are
// synthetic in-memory Files (the server, not the browser, reads workbooks).

const NEW_ORG_ID = uuid(1, 2);
const RUN_1 = uuid(50, 1);
const RUN_2 = uuid(50, 2);
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const RAW = "Acme Robotics Raw Cap Table.xlsx";
const VESTING = "Acme Robotics Vesting Details.xlsx";
const EXERCISED = "Acme Robotics Exercised Options.xlsx";
const ISO = "Acme Robotics ISO NSO Details.xlsx";
const SHEET = "acme-cap-table.xlsx";
const EMPTY_COMPANY = { asOf: "2026-10-21", asKnownAt: 0, ledgerSeq: 0, ledgerHeadHash: null, engineVersion: "1.0.0", items: [] };

const xlsx = (name: string, text = "PK synthetic workbook") => new File([text], name, { type: XLSX });

const COUNTS: api.ImportCounts = { stakeholders: 4, shareClasses: 2, equityPlans: 1, securities: 6, commands: 9, transactions: 12 };

function preview(overrides: Partial<api.ImportPreview> = {}): api.ImportPreview {
  return api.importPreviewSchema.parse({
    detectedFiles: [
      { name: RAW, kind: "raw-cap-table", format: "xlsx", sheets: ["Company", "Securities"], warnings: [] },
      { name: VESTING, kind: "vesting-details", format: "xlsx", sheets: ["Vest Events"], warnings: [] },
      { name: EXERCISED, kind: null, format: "xlsx", sheets: ["Sheet1"], warnings: [] },
    ],
    problems: [],
    currency: "USD",
    openingBalances: [],
    assumptions: [],
    totals: {
      uploaded: null,
      app: { fullyDiluted: "1500000", issuedAndOutstanding: "1200000", byClass: {}, byPlan: {}, byHolder: {}, bySecurity: {} },
      reconciliation: [],
    },
    canImport: true,
    suggestedAsOfDate: "2026-10-20",
    counts: COUNTS,
    ...overrides,
  });
}

const PROBLEMS: api.ImportProblem[] = [
  { severity: "warning", message: "A blank row was skipped.", file: VESTING, sheet: "Vest Events", row: 30, column: null },
  { severity: "error", message: "IssuedAmount isn't a number. Enter the number of shares, without text.", file: RAW, sheet: "Securities", row: 14, column: "IssuedAmount" },
  { severity: "error", message: "Add Pulley's ISO/NSO Details report.", file: null, sheet: null, row: null, column: null },
];

/** A preview with blocking problems, warnings, an opening balance, assumptions and totals that partly differ. */
const BLOCKED = preview({
  problems: PROBLEMS,
  openingBalances: [{ displayId: "OPT-3", date: "2024-01-15", reason: "The exports show the exercised quantity but not the exercise behind it.", file: RAW, sheet: "Securities", row: 9, column: null }],
  assumptions: ["Equity plan pool sizes are imported as current totals, effective on the plan's approval date."],
  totals: {
    uploaded: null,
    app: { fullyDiluted: "1500000", issuedAndOutstanding: "1200000", byClass: {}, byPlan: {}, byHolder: {}, bySecurity: {} },
    reconciliation: [
      { scope: "company", sourceId: null, name: "Acme Robotics", metric: "fully diluted shares", uploaded: "1500000", app: "1500000", matches: true, file: RAW, sheet: "Company", row: 2, column: null },
      { scope: "class", sourceId: "class-common", name: "Common", metric: "outstanding shares", uploaded: "1000000", app: "990000", matches: false, file: RAW, sheet: "ShareClasses", row: 2, column: null },
    ],
  },
  canImport: false,
});
const CLEAN = preview({ detectedFiles: [...preview().detectedFiles.slice(0, 2), { name: ISO, kind: "iso-nso-details", format: "xlsx", sheets: ["ISO NSO Details"], warnings: [] }] });

function importRun(overrides: Partial<api.ImportRun> = {}): api.ImportRun {
  return api.importRunSchema.parse({
    runId: RUN_1, source: "pulley", status: "previewed", asOfDate: "2026-10-20", fileHashes: ["cd".repeat(32)], counts: COUNTS, orgId: null,
    errorMessage: null, createdAt: Date.UTC(2026, 9, 21, 17), updatedAt: Date.UTC(2026, 9, 21, 17), ...overrides,
  });
}

function templateFile(): Response {
  return new Response("PK", {
    status: 200,
    headers: {
      "Content-Type": XLSX,
      "Content-Disposition": "attachment; filename*=UTF-8''cap-table-template.xlsx",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}

/** The console identity, with the company the server holds now: an import replaces it. */
function server(role: Role = "owner", company: Me["company"] = null) {
  const state = { company };
  return {
    state,
    session: () => me(role, { company: state.company }),
    /** The commit as the server answers it once the import is written: the new company becomes the app's. */
    commit: () => {
      state.company = { ...COMPANY, id: NEW_ORG_ID };
      return { orgId: NEW_ORG_ID, counts: COUNTS };
    },
  };
}

function renderAt(path: string, session: () => Me | Response, handlers: readonly MockHandler[]) {
  const mocks = mockApi([mock(api.routes.getMe, session), mock(api.routes.getOrg, (request: MockRequest) => org({ id: request.params.orgId! })), ...handlers]);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<AuthProvider><RouterProvider router={router} /></AuthProvider>);
  return { router, ...mocks };
}

const form = (call: MockRequest | undefined) => call!.body as FormData;
const sentNames = (call: MockRequest | undefined) => form(call).getAll("files").map((file) => (file as File).name);

function drop(files: File[]) {
  fireEvent.drop(screen.getByRole("group", { name: "Upload area" }), { dataTransfer: { files } });
}
function pick(files: File[], label: RegExp = /^Choose (files|a file)$/) {
  fireEvent.change(screen.getByLabelText(label), { target: { files } });
}
function chosen(): string[] {
  const list = screen.queryByRole("list", { name: "Chosen files" });
  return list ? within(list).getAllByRole("listitem").map((item) => item.querySelector(".fl-name")?.textContent ?? "") : [];
}
function currentStep(): string | null | undefined {
  return screen.getByRole("list", { name: "Import steps" }).querySelector('[aria-current="step"]')?.textContent;
}
function importButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;
}
function items(name: string): string[] {
  return within(screen.getByRole("list", { name })).getAllByRole("listitem").map((item) => item.textContent ?? "");
}
/** Whether the elements appear in this order in the page. */
function inOrder(...elements: Element[]): boolean {
  return elements.every((element, index) => index === 0 || Boolean(elements[index - 1]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
}

/** Drops Pulley's three files on the setup wizard and asks for the preview. */
async function uploadAndCheck(files = [xlsx(RAW), xlsx(VESTING), xlsx(EXERCISED)]) {
  await screen.findByRole("heading", { name: "Upload Pulley's exports" });
  drop(files);
  fireEvent.click(screen.getByRole("button", { name: "Check the files" }));
  await screen.findByRole("heading", { name: "Review the import" });
}

describe("the setup page's three ways in", () => {
  it("offers an empty company, an import from Pulley, and an import from a spreadsheet with its template", async () => {
    const { session } = server();
    renderAt("/setup", session, []);
    const choices = await screen.findByRole("list", { name: "Ways to set up the company" });
    expect(within(choices).getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Start with an empty company", "Import from Pulley", "Import from a spreadsheet",
    ]);
    expect(within(choices).getByRole("link", { name: "Start with an empty company" }).getAttribute("href")).toBe("/setup?start=empty");
    expect(within(choices).getByRole("link", { name: "Import from Pulley" }).getAttribute("href")).toBe("/setup?start=pulley");
    expect(within(choices).getByRole("link", { name: "Import from a spreadsheet" }).getAttribute("href")).toBe("/setup?start=spreadsheet");
    expect(within(choices).getByRole("button", { name: "Download the template" })).toBeTruthy();
  });

  it("opens the existing form for an empty company, and each import in the wizard, with the way back", async () => {
    const { session } = server();
    const { router } = renderAt("/setup", session, []);
    fireEvent.click(await screen.findByRole("link", { name: "Import from Pulley" }));
    expect(await screen.findByRole("heading", { name: "Upload Pulley's exports" })).toBeTruthy();
    expect(currentStep()).toBe("Upload the files");
    fireEvent.click(screen.getByRole("button", { name: "All ways to start" }));
    fireEvent.click(await screen.findByRole("link", { name: "Import from a spreadsheet" }));
    expect(await screen.findByRole("heading", { name: "Upload the Cap Table spreadsheet" })).toBeTruthy();
    await act(() => router.navigate("/setup?start=empty"));
    expect(await screen.findByRole("button", { name: "Set up company" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "← All ways to start" }).getAttribute("href")).toBe("/setup");
  });

  it("downloads the template through a blob URL and an <a download>, never another window", async () => {
    const createObjectURL = vi.fn(() => "blob:template");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const saved: { name: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, href: this.href });
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { session } = server();
    const { callsTo } = renderAt("/setup", session, [mock(api.routes.downloadImportTemplate, () => templateFile())]);
    fireEvent.click(await screen.findByRole("button", { name: "Download the template" }));
    await waitFor(() => expect(saved).toEqual([{ name: "cap-table-template.xlsx", href: "blob:template" }]));
    expect(callsTo(api.routes.downloadImportTemplate)).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("says when the template couldn't be downloaded", async () => {
    const { session } = server();
    renderAt("/setup?start=spreadsheet", session, [mock(api.routes.downloadImportTemplate, () => apiError(503, "unavailable", "D1 is unavailable"))]);
    fireEvent.click(await screen.findByRole("button", { name: "Download the template" }));
    expect(await screen.findByText(/^Couldn't download the template\. Cap Table is briefly unavailable/)).toBeTruthy();
  });

  it("shows editors and holders no way in, the wizard included", async () => {
    renderAt("/setup?start=pulley", () => me("admin_ro", { company: null }), []);
    expect(await screen.findByRole("heading", { name: "Cap Table isn't set up yet" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Upload area" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download the template" })).toBeNull();
  });
});

describe("uploading", () => {
  it("takes Pulley's exports by drag and drop or the file picker, replaces a corrected file, and keeps them in memory", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { session } = server();
    renderAt("/setup?start=pulley", session, []);
    expect(await screen.findByRole("heading", { name: "Upload Pulley's exports" })).toBeTruthy();
    expect(items("Pulley reports")).toEqual([
      "Raw Cap Table", "Detailed Cap Table", "Stakeholders", "Vesting Details", "Exercised Options", "ISO/NSO Details", "Stakeholder Transactions (optional)",
    ]);
    expect((screen.getByRole("button", { name: "Check the files" }) as HTMLButtonElement).disabled).toBe(true);
    drop([xlsx(RAW), xlsx(VESTING)]);
    pick([xlsx(EXERCISED)]);
    expect(chosen()).toEqual([RAW, VESTING, EXERCISED]);
    drop([xlsx(RAW, "PK corrected"), new File(["%PDF"], "Board consent.pdf", { type: "application/pdf" })]);
    expect(chosen()).toEqual([RAW, VESTING, EXERCISED]);
    expect(screen.getByText("Board consent.pdf: choose the Excel (.xlsx) or CSV file Pulley exported.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Remove ${VESTING}` }));
    expect(chosen()).toEqual([RAW, EXERCISED]);
    expect((screen.getByRole("button", { name: "Check the files" }) as HTMLButtonElement).disabled).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps the file picker reachable by keyboard inside the label that looks like a button (the label shows its focus)", async () => {
    const { session } = server();
    renderAt("/setup?start=pulley", session, []);
    const input = await screen.findByLabelText("Choose files");
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(input.closest("label")?.classList.contains("btn")).toBe(true);
  });

  it("says how much the files may add up to, honestly", async () => {
    const { session } = server();
    renderAt("/setup?start=pulley", session, []);
    const each = `${api.IMPORT_LIMITS.fileBytes / (1024 * 1024)} MiB`;
    const together = `${((api.IMPORT_LIMITS.requestBytes - 64 * 1024) / (1024 * 1024)).toFixed(1)} MiB`;
    expect([each, together]).toEqual(["5 MiB", "9.9 MiB"]);
    expect(await screen.findByText(`Excel or CSV, up to ${each} each and ${together} together`)).toBeTruthy();
  });

  it("takes one spreadsheet, a newer choice replacing it, and sends it with the as-of date entered", async () => {
    const { session } = server();
    const { callsTo } = renderAt("/setup?start=spreadsheet", session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: preview({ detectedFiles: [{ name: SHEET, kind: "template", format: "xlsx", sheets: ["Company", "Stakeholders"], warnings: [] }] }) }),
    ]);
    expect(await screen.findByRole("heading", { name: "Upload the Cap Table spreadsheet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download the template" })).toBeTruthy();
    drop([xlsx("one.xlsx"), xlsx("two.xlsx")]);
    expect(screen.getByText("Choose one file: the Cap Table spreadsheet is a single workbook.")).toBeTruthy();
    expect(chosen()).toEqual([]);
    pick([xlsx("draft.xlsx")]);
    pick([xlsx(SHEET)]);
    expect(chosen()).toEqual([SHEET]);
    fireEvent.change(screen.getByLabelText("As-of date"), { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Check the files" }));
    expect(await screen.findByRole("heading", { name: "Review the import" })).toBeTruthy();
    const [call] = callsTo(api.routes.previewImport);
    expect(form(call).get("source")).toBe("template");
    expect(sentNames(call)).toEqual([SHEET]);
    expect(form(call).get("asOfDate")).toBe("2026-09-30");
    expect(screen.getByText(/As of Sep 30, 2026/)).toBeTruthy();
    expect(items("Files checked")).toEqual([`${SHEET}Cap Table spreadsheet`]);
    expect(screen.getByText("The spreadsheet states no totals to compare: check the figures above against your own records.")).toBeTruthy();
    // "Change the date" goes back to the files, the date kept, for a fresh preview.
    fireEvent.click(screen.getByRole("button", { name: "Change the date" }));
    expect(await screen.findByRole("heading", { name: "Upload the Cap Table spreadsheet" })).toBeTruthy();
    expect((screen.getByLabelText("As-of date") as HTMLInputElement).value).toBe("2026-09-30");
    expect(chosen()).toEqual([SHEET]);
  });

  it("says why the files couldn't be checked, and keeps them for another try", async () => {
    const { session } = server();
    renderAt("/setup?start=pulley", session, [mock(api.routes.previewImport, () => apiError(413, "payload_too_large", "The request is too large"))]);
    await screen.findByRole("heading", { name: "Upload Pulley's exports" });
    drop([xlsx(RAW)]);
    fireEvent.click(screen.getByRole("button", { name: "Check the files" }));
    expect(await screen.findByText("The files couldn't be checked")).toBeTruthy();
    expect(screen.getByText("The files are too large. Each file can be up to 5 MiB, and all of them together up to 9.9 MiB.")).toBeTruthy();
    expect(chosen()).toEqual([RAW]);
    expect(currentStep()).toBe("Upload the files");
  });
});

describe("the preview", () => {
  it("lists blocking problems first, with where they are and the fix, then warnings, opening balances, assumptions and totals", async () => {
    const { session } = server();
    const { callsTo } = renderAt("/setup?start=pulley", session, [mock(api.routes.previewImport, { runId: RUN_1, preview: BLOCKED }), mock(api.routes.getImportRun, importRun())]);
    await uploadAndCheck();
    expect(currentStep()).toBe("Review the preview");
    // No date was entered: the review shows the one the server took from the files (stored with the run).
    expect(await screen.findByText(/As of Oct 20, 2026, from your files/)).toBeTruthy();
    expect(screen.getByText(/Currency USD/)).toBeTruthy();
    // The step that replaced the button is where focus goes.
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review the import" }));
    const [call] = callsTo(api.routes.previewImport);
    expect(form(call).get("source")).toBe("pulley");
    expect(sentNames(call)).toEqual([RAW, VESTING, EXERCISED]);
    expect(form(call).has("asOfDate")).toBe(false);
    // A preview writes nothing: no Idempotency-Key, and the browser writes the multipart Content-Type itself.
    expect(call!.headers.get("Idempotency-Key")).toBeNull();
    expect(call!.headers.get("Content-Type")).toBeNull();

    expect(items("Files checked")).toEqual([`${RAW}Raw Cap Table`, `${VESTING}Vesting Details`, `${EXERCISED}Not recognized`]);
    expect(items("Problems to fix")).toEqual([
      "Add Pulley's ISO/NSO Details report.",
      `${RAW} › Securities › row 14 › column IssuedAmountIssuedAmount isn't a number. Enter the number of shares, without text.`,
    ]);
    expect(items("Warnings")).toEqual([`${VESTING} › Vest Events › row 30A blank row was skipped.`]);
    const balances = within(screen.getByRole("table", { name: "Opening balances" })).getAllByRole("row").slice(1);
    expect(balances.map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["OPT-3", "Jan 15, 2024", "The exports show the exercised quantity but not the exercise behind it.", `${RAW} › Securities › row 9`],
    ]);
    expect(screen.getByText("Equity plan pool sizes are imported as current totals, effective on the plan's approval date.")).toBeTruthy();
    expect(inOrder(
      screen.getByRole("heading", { name: /^Problems to fix/ }),
      screen.getByRole("heading", { name: /^Warnings/ }),
      screen.getByRole("heading", { name: "Opening balances" }),
      screen.getByRole("heading", { name: "Assumptions" }),
      screen.getByRole("heading", { name: "Totals" }),
    )).toBe(true);

    expect(screen.getByLabelText("What will be imported").textContent).toBe("Stakeholders4Share classes2Equity plans1Securities6Ledger transactions12");
    expect(screen.getByLabelText("The company after the import").textContent).toBe("Fully diluted shares1,500,000Issued and outstanding shares1,200,000");
    expect(screen.getByText("1 of 2 totals differ from Pulley's reports; each one is also listed as a problem above.")).toBeTruthy();
    const classes = within(screen.getByRole("table", { name: "Share classes compared" }));
    expect(classes.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Total", "Pulley", "Imported", "Result"]);
    expect(classes.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Common", "Outstanding shares", "1,000,000", "990,000", "Differs"]);
    expect(within(screen.getByRole("table", { name: "Company compared" })).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "Acme Robotics", "Fully diluted shares", "1,500,000", "1,500,000", "Matches",
    ]);
  });

  it("shows the spreadsheet's precision warnings in the warnings, with the file and the cell", async () => {
    const { session } = server();
    renderAt("/setup?start=spreadsheet", session, [
      mock(api.routes.previewImport, {
        runId: RUN_1,
        // The spreadsheet's reader puts these on the file only; the problems don't list them.
        preview: preview({ detectedFiles: [{ name: SHEET, kind: "template", format: "xlsx", sheets: ["Company", "Shares"], warnings: ["B14 has 17 significant digits."] }] }),
      }),
      mock(api.routes.getImportRun, importRun({ source: "template" })),
    ]);
    await screen.findByRole("heading", { name: "Upload the Cap Table spreadsheet" });
    pick([xlsx(SHEET)]);
    fireEvent.click(screen.getByRole("button", { name: "Check the files" }));
    await screen.findByRole("heading", { name: "Review the import" });
    expect(items("Warnings")).toEqual([`${SHEET} › row 14 › column BB14 has 17 significant digits.`]);
    expect(screen.getByText("Excel keeps 15 significant digits, so a longer number may already be rounded in the file: check it against your records.")).toBeTruthy();
    expect(importButton().disabled).toBe(false);
  });

  it("lists a Pulley report's warning once, though both the file and the problems carry it", async () => {
    const { session } = server();
    const warning = "Securities: C9 has 16 significant digits.";
    const detectedFiles = preview().detectedFiles.map((file) => (file.name === RAW ? { ...file, warnings: [warning] } : file));
    renderAt("/setup?start=pulley", session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: preview({ detectedFiles, problems: [{ severity: "warning", message: warning, file: RAW, sheet: "Securities", row: 9, column: "C" }] }) }),
    ]);
    await uploadAndCheck();
    expect(items("Warnings")).toEqual([`${RAW} › Securities › row 9 › column C${warning}`]);
  });

  it("keeps Import off while any blocking problem remains", async () => {
    const { session } = server();
    // Even a preview the server marks importable stays off while it lists a blocking problem.
    renderAt("/setup?start=pulley", session, [mock(api.routes.previewImport, { runId: RUN_1, preview: { ...BLOCKED, canImport: true } })]);
    await uploadAndCheck();
    expect(importButton().disabled).toBe(true);
    expect(screen.getByText("Import is off until the 2 problems above are fixed.")).toBeTruthy();
    expect(importButton().getAttribute("aria-describedby")).toBe("import-blocked");
  });

  it("says so when the server can't prepare an import although it lists no blocking problem", async () => {
    const { session } = server();
    renderAt("/setup?start=pulley", session, [mock(api.routes.previewImport, { runId: RUN_1, preview: preview({ canImport: false }) })]);
    await uploadAndCheck();
    expect(screen.getByText("These files can't be imported")).toBeTruthy();
    expect(screen.queryByText("Nothing blocks the import")).toBeNull();
    expect(importButton().disabled).toBe(true);
    expect(screen.getByText("This preview can't be imported. Upload corrected files.")).toBeTruthy();
  });

  it("shows the first 50 lines of a long list until asked for all of them", async () => {
    const { session } = server();
    const warnings = Array.from({ length: 60 }, (_, index) => ({ severity: "warning" as const, message: `Row ${index + 2} has a rounded value.`, file: RAW, sheet: "Securities", row: index + 2, column: "IssuedAmount" }));
    renderAt("/setup?start=pulley", session, [mock(api.routes.previewImport, { runId: RUN_1, preview: preview({ problems: warnings }) })]);
    await uploadAndCheck();
    expect(items("Warnings")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show all 60" }));
    expect(items("Warnings")).toHaveLength(60);
    expect(importButton().disabled).toBe(false);
  });

  it("restarts with corrected files for a fresh preview, and imports once nothing blocks", async () => {
    const remote = server();
    let previews = 0;
    const { router, callsTo } = renderAt("/setup?start=pulley", remote.session, [
      mock(api.routes.previewImport, () => (++previews === 1 ? { runId: RUN_1, preview: BLOCKED } : { runId: RUN_2, preview: CLEAN })),
      mock(api.routes.getImportRun, importRun({ runId: RUN_2 })),
      mock(api.routes.commitImport, remote.commit),
    ]);
    await uploadAndCheck();
    expect(importButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Upload corrected files" }));
    expect(await screen.findByRole("heading", { name: "Upload Pulley's exports" })).toBeTruthy();
    // The checked files are still here, each with what the preview recognized it as.
    expect(items("Chosen files").map((item) => item.replace(/\d+ KiB/, ""))).toEqual([`${RAW}Raw Cap Table`, `${VESTING}Vesting Details`, `${EXERCISED}Not recognized`]);
    // The date the files suggest is offered, not applied: left empty, the files' own date applies.
    expect(screen.getByRole("button", { name: "Use Oct 20, 2026, the date your files suggest" })).toBeTruthy();
    expect((screen.getByLabelText("As-of date") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: `Remove ${EXERCISED}` }));
    drop([xlsx(RAW, "PK corrected"), xlsx(ISO)]);
    expect(chosen()).toEqual([RAW, VESTING, ISO]);
    fireEvent.click(screen.getByRole("button", { name: "Check the files" }));
    expect(await screen.findByText("Nothing blocks the import")).toBeTruthy();
    expect(callsTo(api.routes.previewImport)).toHaveLength(2);
    expect(importButton().disabled).toBe(false);

    fireEvent.click(importButton());
    expect(await screen.findByRole("heading", { name: "Import complete" })).toBeTruthy();
    expect(currentStep()).toBe("Done");
    // No date was entered: each preview's run is read for the date the server took from the files, and the commit names it.
    expect(callsTo(api.routes.getImportRun).map((call) => call.params.runId)).toEqual([RUN_1, RUN_2]);
    const [commit] = callsTo(api.routes.commitImport);
    expect(commit!.params.runId).toBe(RUN_2);
    expect(sentNames(commit)).toEqual([RAW, VESTING, ISO]);
    expect(await (form(commit).getAll("files")[0] as File).text()).toBe("PK corrected");
    expect(form(commit).get("asOfDate")).toBe("2026-10-20");
    expect(commit!.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByLabelText("Imported").textContent).toBe("Stakeholders4Share classes2Equity plans1Securities6Ledger transactions12");

    // The app switches to the new company, then opens its cap table.
    const open = await screen.findByRole("link", { name: "Open the cap table" });
    expect(screen.getByText("Acme Robotics is set up with the records below.")).toBeTruthy();
    expect(open.getAttribute("href")).toBe(`/companies/${NEW_ORG_ID}/captable`);
    expect(screen.getByRole("link", { name: "Go to the dashboard" }).getAttribute("href")).toBe(`/companies/${NEW_ORG_ID}/dashboard`);
    expect(callsTo(api.routes.getMe).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(open);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/companies/${NEW_ORG_ID}/captable`));
  });

  it("returns to the preview with the reason when the server refuses the import", async () => {
    const { session } = server();
    const { router } = renderAt("/setup?start=pulley", session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.getImportRun, importRun()),
      mock(api.routes.commitImport, () => apiError(409, "conflict", "The company already has stakeholders, so nothing can be imported into it.", { reason: "state_changed" })),
    ]);
    await uploadAndCheck([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    fireEvent.click(importButton());
    expect(await screen.findByText("Nothing was imported")).toBeTruthy();
    expect(screen.getByText("The company already has stakeholders, so nothing can be imported into it. Nothing was imported.")).toBeTruthy();
    expect(currentStep()).toBe("Review the preview");
    expect(importButton().disabled).toBe(false);
    // Nothing is running any more: the app may be left.
    await act(() => router.navigate("/no-access"));
    expect(router.state.location.pathname).toBe("/no-access");
  });
});

describe("a refusal with the server's reasons", () => {
  it("shows what the server listed", async () => {
    const { session } = server();
    renderAt("/setup?start=pulley", session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.getImportRun, importRun()),
      mock(api.routes.commitImport, () => apiError(422, "invariant_violation", "The import was refused.", {
        violations: [{ code: "IMPORT_FILES_CHANGED", message: "The files differ from the ones previewed. Check them again." }],
      })),
    ]);
    await uploadAndCheck([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    fireEvent.click(importButton());
    expect(await screen.findByText("The import was refused. The files differ from the ones previewed. Check them again. Nothing was imported.")).toBeTruthy();
    // The reason is in words: the code the server uses for it is never shown.
    expect(screen.queryByText(/IMPORT_FILES_CHANGED/)).toBeNull();
  });
});

describe("importing", () => {
  it("shows progress and holds in-app navigation until the import finishes, with no browser prompt", async () => {
    const listen = vi.spyOn(window, "addEventListener");
    const remote = server();
    const release = deferred<api.ImportCommitResponse>();
    const { router } = renderAt("/setup?start=pulley", remote.session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.commitImport, () => release.promise),
    ]);
    await screen.findByRole("heading", { name: "Upload Pulley's exports" });
    drop([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    fireEvent.change(screen.getByLabelText("As-of date"), { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Check the files" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    expect(await screen.findByRole("progressbar", { name: "Import progress" })).toBeTruthy();
    expect(currentStep()).toBe("Import");
    expect(screen.getByText("Importing 4 stakeholders, 6 securities and 12 transactions…")).toBeTruthy();

    await act(() => router.navigate("/no-access"));
    expect(await screen.findByText("The import is still running. Stay on this page until it finishes.")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/setup");
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
    expect(listen.mock.calls.filter(([event]) => event === "beforeunload")).toEqual([]);

    release.resolve(remote.commit());
    expect(await screen.findByRole("heading", { name: "Import complete" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("link", { name: "Open the cap table" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/companies/${NEW_ORG_ID}/captable`));
  });

  it("after a lost answer, retries with the same files and key once the run shows it isn't done", async () => {
    const remote = server();
    let attempts = 0;
    const { router, callsTo } = renderAt("/setup?start=pulley", remote.session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.getImportRun, importRun()),
      mock(api.routes.commitImport, () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return remote.commit();
      }),
    ]);
    await screen.findByRole("heading", { name: "Upload Pulley's exports" });
    drop([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    fireEvent.change(screen.getByLabelText("As-of date"), { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Check the files" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    expect(await screen.findByText("The import's outcome isn't known yet")).toBeTruthy();
    expect(screen.getByText(/^The connection dropped before the server answered\. The import may have finished anyway\./)).toBeTruthy();
    // The outcome is unknown: the page holds on to the files and the key.
    await act(() => router.navigate("/no-access"));
    expect(router.state.location.pathname).toBe("/setup");

    fireEvent.click(screen.getByRole("button", { name: "Check the import" }));
    expect(await screen.findByText(/^The server hasn't finished this import\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Import complete" })).toBeTruthy();
    const calls = callsTo(api.routes.commitImport);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get("Idempotency-Key")).toBe(calls[0]!.headers.get("Idempotency-Key"));
    expect(sentNames(calls[1])).toEqual(sentNames(calls[0]));
    expect(form(calls[1]).get("asOfDate")).toBe("2026-10-20");
    // The date was entered, so the run was read only to check on the lost answer.
    expect(callsTo(api.routes.getImportRun)).toHaveLength(1);
  });

  it("after a server error, learns from the run that the import failed, and imports again with the same key", async () => {
    const remote = server();
    let attempts = 0;
    let runStatus: api.ImportRunStatus = "previewed";
    const { callsTo } = renderAt("/setup?start=pulley", remote.session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.getImportRun, () => importRun({ status: runStatus, errorMessage: runStatus === "failed" ? "The import could not be completed. You can retry it." : null })),
      mock(api.routes.commitImport, () => {
        attempts += 1;
        if (attempts === 1) {
          runStatus = "failed";
          return apiError(500, "internal", "The import could not be completed. You can retry it.");
        }
        return remote.commit();
      }),
    ]);
    await uploadAndCheck([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    fireEvent.click(importButton());
    expect(await screen.findByText(/^The server didn't confirm the import\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check the import" }));
    expect(await screen.findByText("The import stopped before it finished, and nothing was added to the cap table. The import could not be completed. You can retry it.")).toBeTruthy();
    expect(currentStep()).toBe("Review the preview");
    fireEvent.click(importButton());
    expect(await screen.findByRole("heading", { name: "Import complete" })).toBeTruthy();
    const calls = callsTo(api.routes.commitImport);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get("Idempotency-Key")).toBe(calls[0]!.headers.get("Idempotency-Key"));
    // The date read from the run after the preview is the one both attempts name.
    expect(form(calls[0]).get("asOfDate")).toBe("2026-10-20");
    expect(form(calls[1]).get("asOfDate")).toBe("2026-10-20");
  });

  it("reads the run's date again at import when it couldn't be read after the preview", async () => {
    const remote = server();
    let reads = 0;
    const { callsTo } = renderAt("/setup?start=pulley", remote.session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.getImportRun, () => (++reads === 1 ? apiError(503, "unavailable", "D1 is unavailable") : importRun())),
      mock(api.routes.commitImport, remote.commit),
    ]);
    await uploadAndCheck([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    expect(screen.getByText(/As of the date your files give/)).toBeTruthy();
    fireEvent.click(importButton());
    expect(await screen.findByRole("heading", { name: "Import complete" })).toBeTruthy();
    expect(callsTo(api.routes.getImportRun)).toHaveLength(2);
    expect(form(callsTo(api.routes.commitImport)[0]).get("asOfDate")).toBe("2026-10-20");
  });

  // A run without an as-of date exists once the contract lets the run's date be null.
  it.runIf(api.importRunSchema.shape.asOfDate.safeParse(null).success)("asks for the as-of date when neither the admin nor the files gave one", async () => {
    const { session } = server();
    const { callsTo } = renderAt("/setup?start=pulley", session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.getImportRun, () => ({ ...importRun(), asOfDate: null })),
      mock(api.routes.commitImport, () => apiError(500, "internal", "unexpected")),
    ]);
    await uploadAndCheck([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    fireEvent.click(importButton());
    expect(await screen.findByText("The files don't say which date they show. Enter the as-of date, check the files again, then import.")).toBeTruthy();
    expect(callsTo(api.routes.commitImport)).toHaveLength(0);
  });

  it("after a lost answer, learns from the run that the import finished", async () => {
    const remote = server();
    const { callsTo } = renderAt("/setup?start=pulley", remote.session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.getImportRun, () => {
        remote.commit();
        return importRun({ status: "committed", orgId: NEW_ORG_ID, counts: { ...COUNTS, stakeholders: 5 } });
      }),
      mock(api.routes.commitImport, () => apiError(503, "unavailable", "D1 is unavailable")),
    ]);
    await screen.findByRole("heading", { name: "Upload Pulley's exports" });
    drop([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    fireEvent.change(screen.getByLabelText("As-of date"), { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Check the files" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    expect(await screen.findByText(/^The server didn't confirm the import\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check the import" }));
    expect(await screen.findByRole("heading", { name: "Import complete" })).toBeTruthy();
    expect(screen.getByLabelText("Imported").textContent).toContain("Stakeholders5");
    expect(callsTo(api.routes.commitImport)).toHaveLength(1);
    expect((await screen.findByRole("link", { name: "Open the cap table" })).getAttribute("href")).toBe(`/companies/${NEW_ORG_ID}/captable`);
  });
});

describe("leaving the result", () => {
  it("opens the new company's dashboard when the setup page is left another way", async () => {
    const remote = server();
    const { router } = renderAt("/setup?start=pulley", remote.session, [
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.getImportRun, importRun()),
      mock(api.routes.commitImport, remote.commit),
    ]);
    await uploadAndCheck([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    fireEvent.click(importButton());
    await screen.findByRole("link", { name: "Open the cap table" });
    // The setup choices are behind it now: the company exists.
    await act(() => router.navigate("/setup"));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/companies/${NEW_ORG_ID}/dashboard`));
  });

  it("sends an admin who opens the retired company's address home, to the company the app has now", async () => {
    const { router } = renderAt(`/companies/${uuid(1, 9)}/captable`, () => me("owner"), []);
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/dashboard`));
  });
});

describe("Import for an existing company", () => {
  it("offers owners and admins the wizard while the company is empty, starting with the source", async () => {
    const { callsTo } = renderAt(`${base}/import`, () => me("admin_rw"), [mock(api.routes.listStakeholders, EMPTY_COMPANY)]);
    expect(await screen.findByRole("heading", { name: "Where is the cap table now?" })).toBeTruthy();
    expect(currentStep()).toBe("Choose the source");
    expect(callsTo(api.routes.listStakeholders).map((call) => call.params.orgId)).toEqual([ORG_ID]);
    const sources = screen.getByRole("list", { name: "Sources" });
    expect(within(sources).getByRole("button", { name: "Download the template" })).toBeTruthy();
    fireEvent.click(within(sources).getByRole("button", { name: "Import from a spreadsheet" }));
    expect(await screen.findByRole("heading", { name: "Upload the Cap Table spreadsheet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import from Pulley" }));
    expect(await screen.findByRole("heading", { name: "Upload Pulley's exports" })).toBeTruthy();
  });

  it("explains why import isn't available once the company has stakeholders or transactions", async () => {
    renderAt(`${base}/import`, () => me("owner"), [mock(api.routes.listStakeholders, { ...EMPTY_COMPANY, ledgerSeq: 412, asKnownAt: 412 })]);
    expect(await screen.findByText("Import isn't available for this company")).toBeTruthy();
    expect(screen.getByText(/This one already has recorded transactions, and importing on top of them could duplicate or contradict what is recorded\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the dashboard" }).getAttribute("href")).toBe(`${base}/dashboard`);
    expect(screen.queryByRole("group", { name: "Upload area" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import from/ })).toBeNull();
  });

  it("names the stakeholders a company already has", async () => {
    const stakeholders = stakeholderList();
    renderAt(`${base}/import`, () => me("owner"), [mock(api.routes.listStakeholders, { ...stakeholders, ledgerSeq: 0, asKnownAt: 0 })]);
    expect(await screen.findByText(new RegExp(`This one already has ${stakeholders.items.length} stakeholders, and importing`))).toBeTruthy();
  });

  it("tells editors who can import, and shows them no import action", async () => {
    const { callsTo } = renderAt(`${base}/import`, () => me("admin_ro"), [mock(api.routes.listStakeholders, EMPTY_COMPANY)]);
    expect(await screen.findByText("Only owners and admins can import")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Import from|Download the template/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Upload area" })).toBeNull();
    expect(callsTo(api.routes.listStakeholders)).toHaveLength(0);
  });

  it("sends holders to the no-access page", async () => {
    const { router, callsTo } = renderAt(`${base}/import`, () => holderMe([NADIA]), [mock(api.routes.listStakeholders, EMPTY_COMPANY)]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
    expect(callsTo(api.routes.listStakeholders)).toHaveLength(0);
  });

  it("switches the app to the company the import created and keeps the result on screen meanwhile", async () => {
    const remote = server("owner", COMPANY);
    const { router, callsTo } = renderAt(`${base}/import`, remote.session, [
      mock(api.routes.listStakeholders, EMPTY_COMPANY),
      mock(api.routes.previewImport, { runId: RUN_1, preview: CLEAN }),
      mock(api.routes.getImportRun, importRun()),
      mock(api.routes.commitImport, remote.commit),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Import from Pulley" }));
    await uploadAndCheck([xlsx(RAW), xlsx(VESTING), xlsx(ISO)]);
    fireEvent.click(importButton());
    const open = await screen.findByRole("link", { name: "Open the cap table" });
    // /api/me now names the new company; the page stays, though its address names the old one.
    expect(router.state.location.pathname).toBe(`${base}/import`);
    expect(screen.getByRole("heading", { name: "Import complete" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Acme Robotics" }).getAttribute("href")).toBe(`/companies/${NEW_ORG_ID}/dashboard`);
    expect(callsTo(api.routes.listStakeholders)).toHaveLength(1);
    fireEvent.click(open);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/companies/${NEW_ORG_ID}/captable`));
  });
});

describe("the dashboard of an empty company", () => {
  const handlers = () => [mock(api.routes.getDashboard, dashboard()), mock(api.routes.listValuations, { items: VALUATIONS })];

  it("offers owners and admins the import while nothing is recorded", async () => {
    renderPage("dashboard", handlers(), { role: "admin_rw", orgOverrides: [{ ledgerSeq: 0, ledgerHeadHash: null }] });
    const link = await screen.findByRole("link", { name: "Import the cap table" });
    expect(link.getAttribute("href")).toBe(`${base}/import`);
  });

  it("never offers it to editors", async () => {
    renderPage("dashboard", handlers(), { role: "admin_ro", orgOverrides: [{ ledgerSeq: 0, ledgerHeadHash: null }] });
    await screen.findByText("ESSENTIALS");
    await screen.findByRole("heading", { name: "Acme Robotics, Inc." });
    expect(screen.queryByRole("link", { name: "Import the cap table" })).toBeNull();
  });

  it("stops offering it once the ledger records anything", async () => {
    renderPage("dashboard", handlers(), { role: "owner" });
    await screen.findByRole("heading", { name: "Acme Robotics, Inc." });
    expect(screen.queryByRole("link", { name: "Import the cap table" })).toBeNull();
  });
});
