import "./setup.ts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { api } from "#shared";
import { AuthProvider } from "../../src/app/auth/AuthProvider.tsx";
import { routes } from "../../src/app/router.tsx";
import { IDS, ORG_ID, org, uuid } from "./support/acme.ts";
import { apiError, mock, mockApi, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import {
  COMPANY_RESOURCES, DANIEL, DANIEL_OPTION, DANIEL_SHARES, DANIEL_WARRANT, MARCUS, MARCUS_SAFES, MARCUS_SHARES, NADIA, NADIA_OPTION,
  PRIVACY_NOTICE, detailOf, holderMe, howToExercise, overview, portalDocument, portalSecurity, securityDetail,
} from "./support/portal.ts";
import "./support/render.tsx";

type Me = api.MeResponse;

// The holder portal: every page renders only what the strict portal schemas carry, and a
// response with any other key fails the page instead of reaching it. The admin preview shows the same pages.

const PORTFOLIO = `/portfolio/${ORG_ID}`;
const PREVIEW = `/companies/${ORG_ID}/stakeholders/${IDS.nadia}/preview`;

function respondJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

interface Extra {
  howTo?: api.HowToExercise;
  documents?: api.PortalDocument[];
  details?: readonly api.PortalSecurityDetail[];
  asOf?: string;
}

function documentsOf(holdings: readonly api.PortalHolding[]): api.PortalDocument[] {
  return [...holdings.flatMap((holding) => holding.securities.flatMap((security) => security.documents)), ...COMPANY_RESOURCES];
}

/** The detail the portal answers for a security id: one given, else the persona's (support/portal.ts). */
function detailFor(holdings: readonly api.PortalHolding[], extra: Extra, id: string): api.PortalSecurityDetail | Response {
  const given = extra.details?.find((detail) => detail.id === id);
  if (given) return given;
  const security = holdings.flatMap((holding) => holding.securities).find((item) => item.id === id);
  return security ? detailOf(security) : apiError(404, "not_found", "Not found");
}

function portalHandlers(holdings: readonly api.PortalHolding[], extra: Extra = {}): MockHandler[] {
  return [
    mock(api.routes.getPortalOverview, overview(holdings, extra.asOf)),
    mock(api.routes.getPortalSecurity, (request: MockRequest) => detailFor(holdings, extra, request.params.id!)),
    mock(api.routes.getHowToExercise, extra.howTo ?? howToExercise()),
    mock(api.routes.listPortalDocuments, extra.documents ?? documentsOf(holdings)),
  ];
}

function renderPortal(path: string, holdings: readonly api.PortalHolding[], options: { handlers?: MockHandler[]; me?: Me } = {}) {
  const handlers = options.handlers ?? portalHandlers(holdings);
  const mocks = mockApi([mock(api.routes.getMe, options.me ?? holderMe(holdings)), ...handlers]);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<AuthProvider><RouterProvider router={router} /></AuthProvider>);
  return { router, ...mocks };
}

const ADMIN = holderMe([], { email: "rachel@acmerobotics.example", name: "Rachel Ostrowski", access: "admin_rw", consoleRole: "OWNER" });

/** The admin's preview of Nadia: the preview routes answer exactly what her portal routes answer. */
function previewHandlers(holding: api.PortalHolding, extra: Extra = {}): MockHandler[] {
  return [
    mock(api.routes.getOrg, org()),
    mock(api.routes.previewAsStakeholder, overview([holding], extra.asOf)),
    mock(api.routes.previewPortalSecurity, (request: MockRequest) => detailFor([holding], extra, request.params.securityId!)),
    mock(api.routes.previewPortalDocuments, extra.documents ?? documentsOf([holding])),
    mock(api.routes.previewHowToExercise, extra.howTo ?? howToExercise()),
  ];
}

function renderPreview(path: string, holding: api.PortalHolding = NADIA, extra: Extra = {}) {
  return renderPortal(`${PREVIEW}${path}`, [holding], { me: ADMIN, handlers: previewHandlers(holding, extra) });
}

/** The page itself, without the shell's navigation. */
function main(): HTMLElement {
  return document.getElementById("main")!;
}

function definitionOf(label: string, within_: HTMLElement = document.body): HTMLElement {
  const term = within(within_).getAllByRole("term").find((item) => item.textContent === label);
  if (!term) throw new Error(`No term ${label}`);
  return term.nextElementSibling as HTMLElement;
}

function rowOf(table: HTMLElement, text: string) {
  return within(table).getAllByRole("row").find((row) => within(row).queryByText(text)) as HTMLElement;
}

/** Nothing a holder may not see: no percentages, no fully diluted figures, no other holder. */
function expectNoForbiddenFigures() {
  const text = document.getElementById("main")?.textContent ?? "";
  expect(text).not.toMatch(/%/);
  expect(text).not.toMatch(/fully diluted/i);
}

describe("portfolio overview", () => {
  it("shows a former employee's exit window, tiles, vesting status and grants", async () => {
    renderPortal(PORTFOLIO, [NADIA]);
    const title = await screen.findByRole("heading", { name: "Acme Robotics", level: 1 });
    expect(within(title.closest("[data-portfolio-hero]") as HTMLElement).getByText("Nadia Pereira-Stone")).toBeTruthy();
    const banner = screen.getByText("You can exercise 60,000 vested options until Feb 28, 2027 (130 days). Exercises after Nov 30, 2026 (40 days) are taxed as NSOs.").closest("[data-slot=alert]") as HTMLElement;
    expect(within(banner).getByRole("link", { name: "How to exercise" }).getAttribute("href")).toBe(`${PORTFOLIO}/how-to-exercise`);
    const tiles = screen.getByRole("list", { name: "Holdings summary" });
    expect(within(tiles).getByText("Options")).toBeTruthy();
    expect(within(tiles).getByText("60,000")).toBeTruthy();
    expect(within(tiles).getByText("60,000 vested and unexercised · 0 unvested")).toBeTruthy();
    expect(screen.getByRole("img", { name: "60,000 vested and unexercised, 0 unvested, 60,000 cancelled" })).toBeTruthy();
    // The Vesting status card explains vesting and exercising in plain words, with the way to How to exercise.
    const explainer = screen.getByText(/^Your equity vests over time, on the schedule in your grant agreement\./);
    expect(explainer.textContent).toBe(
      "Your equity vests over time, on the schedule in your grant agreement. Exercising an option means buying its shares at the exercise price: "
      + "you can exercise vested options until they expire or, if you leave, until your exercise deadline. How to exercise explains the steps.",
    );
    expect(within(explainer).getByRole("link", { name: "How to exercise" }).getAttribute("href")).toBe(`${PORTFOLIO}/how-to-exercise`);
    expect(screen.getByText("No upcoming vesting events.")).toBeTruthy();
    const grants = screen.getByRole("table", { name: "My grants and shares" });
    expect(within(grants).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "ID", "Type", "Status", "Grant / issue date", "Expiration", "Quantity", "Vested", "Exercisable", "Exercise price",
    ]);
    const row = rowOf(grants, "OPT-20");
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "OPT-20", "ISO option", "Outstanding", "Aug 15, 2024", "Aug 15, 2034", "120,000", "60,000", "60,000How to exercise for OPT-20", "$0.31",
    ]);
    expect(within(row).getByRole("link", { name: "OPT-20" }).getAttribute("href")).toBe(`${PORTFOLIO}/securities/${NADIA_OPTION.id}`);
    // Each exercisable grant links to How to exercise, with the grant chosen.
    expect(within(row).getByRole("link", { name: "How to exercise for OPT-20" }).getAttribute("href")).toBe(`${PORTFOLIO}/how-to-exercise?grant=${NADIA_OPTION.id}`);
    expect(await screen.findByRole("button", { name: "2023 Equity Incentive Plan.pdf" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "How to exercise your options" })).toBeTruthy();
    expectNoForbiddenFigures();
  });

  it("states each grant's own exit window when grants end on different dates, never one sum under the first date", async () => {
    const nso = portalSecurity({
      ...NADIA_OPTION, id: uuid(6, 125), displayId: "OPT-25", optionType: "NSO", issueDate: "2025-02-01", contractualDeadline: "2027-01-08", isoDeadline: null,
      numbers: { ...NADIA_OPTION.numbers, granted: "20000", outstanding: "10000", vested: "10000", exercisable: "10000", cancelled: "10000" },
    });
    renderPortal(PORTFOLIO, [{ ...NADIA, securities: [NADIA_OPTION, nso] }]);
    const banner = (await screen.findByText("You can exercise vested options before these deadlines:")).closest("[data-slot=alert]") as HTMLElement;
    expect(within(banner).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "You can exercise 10,000 vested options (OPT-25) until Jan 8, 2027 (79 days).",
      "You can exercise 60,000 vested options (OPT-20) until Feb 28, 2027 (130 days). Exercises after Nov 30, 2026 (40 days) are taxed as NSOs.",
    ]);
    expect(banner.textContent).not.toContain("70,000");
  });

  it("keeps a passed ISO deadline in view while the contractual window is still open", async () => {
    renderPortal(PORTFOLIO, [NADIA], { handlers: portalHandlers([NADIA], { asOf: "2026-12-15" }) });
    expect(await screen.findByText("You can exercise 60,000 vested options until Feb 28, 2027 (75 days). The ISO deadline passed on Nov 30, 2026: exercises from now on are taxed as NSOs.")).toBeTruthy();
  });

  it("says whose signature a grant awaits, and that only the holder's own holds up exercising", async () => {
    const pending = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 140), displayId: "OPT-40", issueDate: "2026-09-01", executionPending: "pending_holder", numbers: { ...DANIEL_OPTION.numbers, exercisable: "0" } });
    const both = portalSecurity({ ...pending, id: uuid(6, 141), displayId: "OPT-41", executionPending: "pending_both" });
    const company = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 142), displayId: "OPT-42", issueDate: "2026-09-02", executionPending: "pending_company" });
    renderPortal(PORTFOLIO, [{ ...DANIEL, securities: [pending, both, company, DANIEL_WARRANT, DANIEL_SHARES] }], { me: holderMe([DANIEL], { email: "daniel@acmerobotics.example" }) });
    const grants = await screen.findByRole("table", { name: "My grants and shares" });
    const cells = (id: string) => within(rowOf(grants, id)).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells("OPT-40")[2]).toBe("Outstanding Awaiting your signature");
    expect(cells("OPT-40")[7]).toBe("Awaiting your signature");
    expect(cells("OPT-41")[2]).toBe("Outstanding Awaiting signatures");
    expect(cells("OPT-41")[7]).toBe("Awaiting your signature");
    // Awaiting only the company: exercisable as any other grant, with its link.
    expect(cells("OPT-42")[2]).toBe("Outstanding Awaiting the company's signature");
    expect(cells("OPT-42")[7]).toBe("218,750How to exercise for OPT-42");
    expect(within(rowOf(grants, "OPT-40")).queryByRole("link", { name: /How to exercise/ })).toBeNull();
    // A warrant shows what is exercisable (exercised through the company, so no link); shares have nothing to exercise.
    expect(cells("WAR-1")[7]).toBe("60,000");
    expect(cells("CS-7")[7]).toBe("—");
  });

  it("keeps a leaver's deadline in view for a grant awaiting their signature, never saying they can exercise it", async () => {
    const unsigned = portalSecurity({ ...NADIA_OPTION, id: uuid(6, 140), displayId: "OPT-40", executionPending: "pending_holder", numbers: { ...NADIA_OPTION.numbers, exercisable: "0" } });
    renderPortal(PORTFOLIO, [{ ...NADIA, securities: [unsigned] }]);
    const statement = "Your signature is still needed on OPT-40 before you can exercise its 60,000 vested options. Its exercise window closes on Feb 28, 2027 (130 days). Exercises after Nov 30, 2026 (40 days) are taxed as NSOs.";
    expect(await screen.findByText(statement)).toBeTruthy();
    expect(screen.queryByText(/You can exercise/)).toBeNull();
    cleanup();
    renderPortal(PORTFOLIO, [{ ...NADIA, securities: [NADIA_OPTION, unsigned] }]);
    const banner = (await screen.findByText("Your exercise deadlines:")).closest("[data-slot=alert]") as HTMLElement;
    expect(within(banner).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "You can exercise 60,000 vested options (OPT-20) until Feb 28, 2027 (130 days). Exercises after Nov 30, 2026 (40 days) are taxed as NSOs.",
      statement,
    ]);
  });

  it("shows an investor's vested shares, and their SAFEs counted with each one's status", async () => {
    renderPortal(PORTFOLIO, [MARCUS], { me: holderMe([MARCUS], { email: "marcus.oyelaran@kensington.example" }) });
    const tiles = await screen.findByRole("list", { name: "Holdings summary" });
    expect(within(tiles).getByText("Series Seed Preferred")).toBeTruthy();
    expect(within(tiles).getByText("91,145")).toBeTruthy();
    expect(within(tiles).getByText("2 records")).toBeTruthy();
    expect(within(tiles).getByText("2 SAFEs")).toBeTruthy();
    expect(within(tiles).getByText("2 converted")).toBeTruthy();
    expect(screen.queryByText("Vesting status")).toBeNull();
    expect(screen.queryByText(/You can exercise/)).toBeNull();
    const grants = screen.getByRole("table", { name: "My grants and shares" });
    expect(within(rowOf(grants, "SAFE-3")).getByText("Converted")).toBeTruthy();
    expect(within(rowOf(grants, "SAFE-3")).getByRole("link", { name: "SAFE-3" }).getAttribute("href")).toBe(`${PORTFOLIO}/convertibles/${MARCUS_SAFES[0]!.id}`);
    expect(within(rowOf(grants, "PS-3")).getAllByText("52,083")).toHaveLength(2);
    expectNoForbiddenFigures();
  });

  it("counts a SAFE that hasn't converted as outstanding, never as converted", async () => {
    const open = portalSecurity({ id: uuid(6, 207), displayId: "SAFE-7", family: "CONVERTIBLE", className: null, issueDate: "2026-02-01", status: "OUTSTANDING" });
    const marcus = { ...MARCUS, securities: [...MARCUS.securities, open] };
    renderPortal(PORTFOLIO, [marcus], { me: holderMe([marcus], { email: "marcus.oyelaran@kensington.example" }) });
    const tiles = await screen.findByRole("list", { name: "Holdings summary" });
    expect(within(tiles).getByText("3 SAFEs")).toBeTruthy();
    expect(within(tiles).getByText("1 outstanding · 2 converted")).toBeTruthy();
    expect(within(tiles).queryByText(/^\d+ converted$/)).toBeNull();
    const grants = screen.getByRole("table", { name: "My grants and shares" });
    expect(within(rowOf(grants, "SAFE-7")).getByText("Outstanding")).toBeTruthy();
  });

  it("lists a current employee's next six vest events across grants, in date order", async () => {
    const later = portalSecurity({
      ...DANIEL_OPTION, id: uuid(6, 137), displayId: "OPT-37", issueDate: "2025-11-20", exercisePrice: "0.95",
      numbers: { ...DANIEL_OPTION.numbers, granted: "120000", outstanding: "120000", vested: "0", unvested: "120000", exercised: "0", exercisable: "0" },
      vesting: Array.from({ length: 4 }, (_, index) => ({ date: new Date(Date.UTC(2026, 10 + index, 20)).toISOString().slice(0, 10), quantity: "2500", cumulative: String(2500 * (index + 1)), status: "UPCOMING" as const })),
    });
    const daniel = { ...DANIEL, securities: [...DANIEL.securities, later] };
    renderPortal(PORTFOLIO, [daniel], { me: holderMe([daniel], { email: "daniel@acmerobotics.example" }) });
    const upcoming = await screen.findByRole("table", { name: "Upcoming vest events" });
    const rows = within(upcoming).getAllByRole("row").slice(1).map((row) => row.textContent);
    expect(rows).toEqual([
      "Nov 1, 2026" + "6,250 options (OPT-1) vest",
      "Nov 20, 2026" + "2,500 options (OPT-37) vest",
      "Dec 1, 2026" + "6,250 options (OPT-1) vest",
      "Dec 20, 2026" + "2,500 options (OPT-37) vest",
      "Jan 1, 2027" + "6,250 options (OPT-1) vest",
      "Jan 20, 2027" + "2,500 options (OPT-37) vest",
    ]);
    expect(screen.getByText("218,750 vested and unexercised · 151,250 unvested")).toBeTruthy();
  });

  it("says so when nothing is held", async () => {
    renderPortal(PORTFOLIO, [{ ...NADIA, securities: [] }]);
    const tiles = await screen.findByRole("list", { name: "Holdings summary" });
    expect(within(tiles).getByText("None outstanding")).toBeTruthy();
    expect(screen.getByText("No grants or shares.")).toBeTruthy();
    expect(screen.queryByText("Vesting status")).toBeNull();
  });

  it("shows each of the holder's records separately (an individual and their trust)", async () => {
    const trust: api.PortalHolding = { ...MARCUS, stakeholderId: uuid(3, 38), stakeholderName: "Oyelaran Family Trust", securities: [portalSecurity({ id: uuid(6, 26), displayId: "PS-6", className: "Series Seed Preferred", numbers: { asOf: "2026-10-21", granted: "10000", outstanding: "10000", vested: "10000", unvested: null, exercised: null, exercisable: null, cancelled: null } })] };
    const { router } = renderPortal(PORTFOLIO, [MARCUS, trust]);
    const switcher = await screen.findByRole("group", { name: "Your records" });
    expect(within(switcher).getByText("You hold equity under 2 records:")).toBeTruthy();
    expect(within(switcher).getByRole("button", { name: "Marcus Oyelaran" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(switcher).getByRole("button", { name: "Oyelaran Family Trust" }));
    await waitFor(() => expect(router.state.location.search).toBe(`?holder=${trust.stakeholderId}`));
    const grants = screen.getByRole("table", { name: "My grants and shares" });
    expect(within(grants).getByText("PS-6")).toBeTruthy();
    expect(within(grants).queryByText("PS-3")).toBeNull();
  });

  it("goes straight to the only company's portfolio", async () => {
    const { router } = renderPortal("/portfolio", [NADIA]);
    await waitFor(() => expect(router.state.location.pathname).toBe(PORTFOLIO));
    expect(await screen.findByText(/You can exercise 60,000 vested options/)).toBeTruthy();
  });

  it("ends every page with the company contact and the company's privacy notice, which opens through the portal download", async () => {
    const headers = {
      "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename*=UTF-8''Acme%20Robotics%20Privacy%20Notice.pdf", "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store", "Content-Security-Policy": "sandbox; default-src 'none'", Digest: `sha-256=${"A".repeat(43)}=`,
    };
    const { callsTo } = renderPortal(PORTFOLIO, [NADIA], { handlers: [...portalHandlers([NADIA]), mock(api.routes.downloadPortalDocument, () => new Response("%PDF", { status: 200, headers }))] });
    const footer = (await screen.findByText(/Questions about your equity\? Equity team/)).closest("footer")!;
    // Shown as text to copy: the console's sandboxed frame can't open a mail program.
    expect(within(footer).getByText("equity@acmerobotics.example").tagName).toBe("SPAN");
    expect(within(footer).queryByRole("link", { name: "equity@acmerobotics.example" })).toBeNull();
    // No notice text is written into the app: counsel's notice is the document the company designated.
    expect(footer.textContent).toBe(["Questions about your equity? Equity team · equity@acmerobotics.example", "Privacy notice"].join(""));
    expect(within(footer).queryByRole("link", { name: "Privacy notice" })).toBeNull();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:notice"), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(within(footer).getByRole("button", { name: "Privacy notice" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(callsTo(api.routes.downloadPortalDocument).map((call) => call.url.pathname)).toEqual([`/api/portal/documents/${PRIVACY_NOTICE.id}/download`]);
  });

  it("says the privacy notice isn't published yet when the company hasn't designated one, linking nowhere", async () => {
    renderPortal(PORTFOLIO, [NADIA], { handlers: portalHandlers([NADIA], { howTo: howToExercise({ privacyNotice: null }) }) });
    const footer = (await screen.findByText(/Questions about your equity\? Equity team/)).closest("footer")!;
    expect(within(footer).getByText("Privacy notice not yet published").className).toContain("muted");
    expect(within(footer).queryByRole("button", { name: /Privacy notice/ })).toBeNull();
    expect(within(footer).queryByRole("link", { name: /Privacy notice/ })).toBeNull();
  });

  it("shows nothing about the privacy notice while How to exercise is still loading", async () => {
    const handlers = [...portalHandlers([NADIA]).filter((handler) => handler.route !== api.routes.getHowToExercise), mock(api.routes.getHowToExercise, () => new Promise<never>(() => {}))];
    renderPortal(PORTFOLIO, [NADIA], { handlers });
    const footer = (await screen.findByText(/Questions about your equity\?/)).closest("footer")!;
    expect(within(footer).getByRole("status", { name: "Loading the company contact" })).toBeTruthy();
    expect(footer.textContent).not.toContain("Privacy notice");
  });
});

describe("holding detail", () => {
  it("shows an option's numbers, deadlines, vesting schedule, ISO/NSO split, post-termination periods and documents", async () => {
    renderPortal(`${PORTFOLIO}/securities/${NADIA_OPTION.id}`, [NADIA]);
    expect(await screen.findByRole("heading", { name: /^OPT-20 Options/, level: 1 })).toBeTruthy();
    expect(definitionOf("Granted").textContent).toBe("120,000 options");
    expect(definitionOf("Exercisable now").textContent).toBe("60,000");
    expect(definitionOf("Exercise price").textContent).toBe("$0.31");
    expect(definitionOf("Option type").textContent).toBe("ISO");
    expect(definitionOf("Contractual deadline").textContent).toBe("Feb 28, 2027 (130 days)");
    expect(definitionOf("ISO deadline").textContent).toBe("Nov 30, 2026 (40 days) — exercises after it are taxed as NSOs");
    expect(definitionOf("Early exercise allowed", screen.getByLabelText("Overview")).textContent).toBe("No");
    expect(definitionOf("Board approval date").textContent).toBe("Not recorded");
    expect(definitionOf("Acceleration").textContent).toBe("Not recorded");
    expect(within(main()).getByRole("link", { name: "How to exercise" }).getAttribute("href")).toBe(`${PORTFOLIO}/how-to-exercise?grant=${NADIA_OPTION.id}`);
    // One line above the chart: the start, the 1-year cliff the events show, and the last vest before the termination.
    expect(screen.getByText(/^Vesting start /).textContent).toBe("Vesting start Aug 1, 2024 · Cliff: 30,000 options on Aug 1, 2025 · Vesting stopped: last vest on Aug 1, 2026");
    fireEvent.click(screen.getByRole("button", { name: /^Full schedule \(\d+ events\)$/ }));
    const schedule = screen.getByRole("table", { name: "Vesting schedule" });
    expect(within(rowOf(schedule, "Aug 1, 2025")).getByText("Vested")).toBeTruthy();
    expect(within(rowOf(schedule, "Sep 1, 2026")).getByText("Cancelled")).toBeTruthy();
    expect(within(rowOf(schedule, "Dec 1, 2026")).getByText("Won't vest")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Cumulative vested options over time for OPT-20" })).toBeTruthy();
    const split = screen.getByRole("table", { name: "ISO/NSO split" });
    expect(within(split).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["2025", "40,000", "$12,400.00", "40,000", "0"],
      ["2026", "20,000", "$6,200.00", "20,000", "0"],
    ]);
    const periods = screen.getByLabelText("Post-termination exercise periods");
    expect(within(periods).getAllByRole("term").map((term) => `${term.textContent}: ${term.nextElementSibling!.textContent}`)).toEqual([
      "Voluntary: 3 months", "Involuntary: 3 months", "With cause: 0 days", "Death: 12 months", "Disability: 12 months", "Retirement: 3 months",
    ]);
    expect(screen.queryByRole("heading", { name: "Exercise history" })).toBeNull();
    expect(screen.getByRole("button", { name: "Separation agreement.pdf" })).toBeTruthy();
    expect(screen.getByText(/There is no Exercise button yet/)).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Acme RoboticsOPT-20");
    expectNoForbiddenFigures();
  });

  it("lists the holder's exercises with links to the shares they received", async () => {
    renderPortal(`${PORTFOLIO}/securities/${DANIEL_OPTION.id}`, [DANIEL], { me: holderMe([DANIEL], { email: "daniel@acmerobotics.example" }) });
    expect(await screen.findByRole("heading", { name: "Exercise history" })).toBeTruthy();
    const history = screen.getByLabelText("Exercise history");
    expect(definitionOf("Mar 20, 2026", history).textContent).toBe("50,000 ISO → CS-7");
    expect(within(history).getByRole("link", { name: "CS-7" }).getAttribute("href")).toBe(`${PORTFOLIO}/securities/${DANIEL_SHARES.id}`);
    expect(screen.getByText(/^Vesting start /).textContent).toBe("Vesting start Mar 1, 2023 · Cliff: 75,000 options on Mar 1, 2024 · Fully vests on Mar 1, 2027");
  });

  it("shows the grant's board approval date and acceleration terms as recorded", async () => {
    const detail = securityDetail(DANIEL_OPTION, {
      boardApprovalDate: "2023-04-14", acceleration: { kind: "DOUBLE_TRIGGER", text: "Full acceleration on a change of control followed by a termination without cause." },
    });
    renderPortal(`${PORTFOLIO}/securities/${DANIEL_OPTION.id}`, [DANIEL], { handlers: portalHandlers([DANIEL], { details: [detail] }) });
    await screen.findByRole("heading", { name: /^OPT-1 Options/, level: 1 });
    expect(definitionOf("Board approval date").textContent).toBe("Apr 14, 2023");
    expect(definitionOf("Acceleration").textContent).toBe("Double trigger: Full acceleration on a change of control followed by a termination without cause.");
    cleanup();
    renderPortal(`${PORTFOLIO}/securities/${DANIEL_OPTION.id}`, [DANIEL], {
      handlers: portalHandlers([DANIEL], { details: [securityDetail(DANIEL_OPTION, { acceleration: { kind: "NONE", text: null } })] }),
    });
    await screen.findByRole("heading", { name: /^OPT-1 Options/, level: 1 });
    expect(definitionOf("Acceleration").textContent).toBe("None");
  });

  it("never gives irregular vesting events a cliff, and says when a grant vests in full at once", async () => {
    const irregular = portalSecurity({
      ...DANIEL_OPTION, id: uuid(6, 150), displayId: "OPT-50", vestingStartDate: "2024-01-15",
      vesting: [
        { date: "2025-01-15", quantity: "100000", cumulative: "100000", status: "VESTED" },
        { date: "2025-06-03", quantity: "100000", cumulative: "200000", status: "VESTED" },
        { date: "2026-12-20", quantity: "100000", cumulative: "300000", status: "UPCOMING" },
      ],
    });
    const once = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 151), displayId: "OPT-51", vestingStartDate: null, vesting: [{ date: "2023-04-14", quantity: "300000", cumulative: "300000", status: "VESTED" }] });
    const holding = { ...DANIEL, securities: [irregular, once] };
    renderPortal(`${PORTFOLIO}/securities/${irregular.id}`, [holding], { handlers: portalHandlers([holding]) });
    expect((await screen.findByText(/^Vesting start /)).textContent).toBe("Vesting start Jan 15, 2024 · First vest: 100,000 options on Jan 15, 2025 · Fully vests on Dec 20, 2026");
    cleanup();
    renderPortal(`${PORTFOLIO}/securities/${once.id}`, [holding], { handlers: portalHandlers([holding]) });
    expect(await screen.findByText("Vested in full on Apr 14, 2023")).toBeTruthy();
  });

  it("says the holder's own signature comes first, and when early exercise is allowed", async () => {
    const pending = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 140), displayId: "OPT-40", executionPending: "pending_holder", numbers: { ...DANIEL_OPTION.numbers, exercisable: "0" } });
    const holding = { ...DANIEL, securities: [pending] };
    renderPortal(`${PORTFOLIO}/securities/${pending.id}`, [holding], {
      me: holderMe([DANIEL], { email: "daniel@acmerobotics.example" }),
      handlers: portalHandlers([holding], { details: [securityDetail(pending, { earlyExerciseAllowed: true })] }),
    });
    await screen.findByRole("heading", { name: /^OPT-40 Options/, level: 1 });
    expect(screen.getByText("Awaiting your signature", { selector: "[data-slot=badge]" })).toBeTruthy();
    const banner = screen.getByText("Awaiting your signature", { selector: "[data-slot=alert-title]" }).closest("[data-slot=alert]") as HTMLElement;
    expect(banner.textContent).toBe("Awaiting your signatureYou can exercise this grant once you have signed its agreement.");
    expect(screen.getByText("Early exercise allowed by your grant — contact the company to exercise early.")).toBeTruthy();
    expect(definitionOf("Early exercise allowed").textContent).toBe("Yes — contact the company to exercise early");
    expect(definitionOf("Exercisable now").textContent).toBe("0");
    expect(screen.queryByText(/There is no Exercise button yet/)).toBeNull();
  });

  it("says when both signatures are missing, and that a company-only countersignature doesn't hold up exercise", async () => {
    const both = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 141), displayId: "OPT-41", executionPending: "pending_both", numbers: { ...DANIEL_OPTION.numbers, exercisable: "0" } });
    const company = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 142), displayId: "OPT-42", executionPending: "pending_company" });
    const holding = { ...DANIEL, securities: [both, company] };
    renderPortal(`${PORTFOLIO}/securities/${both.id}`, [holding], { handlers: portalHandlers([holding]) });
    await screen.findByRole("heading", { name: /^OPT-41 Options/, level: 1 });
    expect(screen.getByText("Awaiting signatures", { selector: "[data-slot=badge]" })).toBeTruthy();
    expect(screen.getByText(/^You can exercise this grant once you have signed its agreement/).textContent)
      .toBe("You can exercise this grant once you have signed its agreement; the company's countersignature is still pending too.");
    cleanup();
    renderPortal(`${PORTFOLIO}/securities/${company.id}`, [holding], { handlers: portalHandlers([holding]) });
    await screen.findByRole("heading", { name: /^OPT-42 Options/, level: 1 });
    expect(screen.getByText("Awaiting the company's signature", { selector: "[data-slot=badge]" })).toBeTruthy();
    expect(screen.getByText("The company's countersignature is pending — you can still exercise")).toBeTruthy();
    expect(screen.queryByText("Awaiting your signature")).toBeNull();
    expect(definitionOf("Exercisable now").textContent).toBe("218,750");
    expect(screen.getByText(/There is no Exercise button yet/)).toBeTruthy();
  });

  it("marks a passed ISO deadline on the grant while the contractual window is open", async () => {
    renderPortal(`${PORTFOLIO}/securities/${NADIA_OPTION.id}`, [NADIA], { handlers: portalHandlers([NADIA], { asOf: "2026-12-15" }) });
    await screen.findByRole("heading", { name: /^OPT-20 Options/, level: 1 });
    expect(definitionOf("Contractual deadline").textContent).toBe("Feb 28, 2027 (75 days)");
    expect(definitionOf("ISO deadline").textContent).toBe("Nov 30, 2026 — passed: exercises from now on are taxed as NSOs");
  });

  it("downloads a linked document through the audited portal route", async () => {
    const headers = {
      "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename*=UTF-8''Separation%20agreement.pdf", "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store", "Content-Security-Policy": "sandbox; default-src 'none'", Digest: `sha-256=${"A".repeat(43)}=`,
    };
    const { callsTo } = renderPortal(`${PORTFOLIO}/securities/${NADIA_OPTION.id}`, [NADIA], {
      handlers: [...portalHandlers([NADIA]), mock(api.routes.downloadPortalDocument, () => new Response("%PDF", { status: 200, headers }))],
    });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:doc"), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(await screen.findByRole("button", { name: "Separation agreement.pdf" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(callsTo(api.routes.downloadPortalDocument)[0]?.url.pathname).toBe(`/api/portal/documents/${uuid(10, 121)}/download`);
  });

  it("shows no deadlines for a current employee", async () => {
    const nso = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 116), displayId: "OPT-16", optionType: "NSO", contractualDeadline: "2027-01-01", isoDeadline: null });
    renderPortal(`${PORTFOLIO}/securities/${DANIEL_OPTION.id}`, [{ ...DANIEL, securities: [DANIEL_OPTION, nso] }]);
    await screen.findByRole("heading", { name: /^OPT-1 Options/, level: 1 });
    expect(screen.getAllByRole("term").map((term) => term.textContent)).not.toContain("Contractual deadline");
    expect(screen.getAllByRole("term").map((term) => term.textContent)).not.toContain("ISO deadline");
  });

  it("marks an NSO with a deadline as having no ISO deadline", async () => {
    const nso = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 116), displayId: "OPT-16", optionType: "NSO", contractualDeadline: "2027-01-01", isoDeadline: null });
    renderPortal(`${PORTFOLIO}/securities/${nso.id}`, [{ ...DANIEL, securities: [nso] }]);
    await screen.findByRole("heading", { name: /^OPT-16 Options/, level: 1 });
    expect(definitionOf("Contractual deadline").textContent).toBe("Jan 1, 2027 (72 days)");
    expect(definitionOf("ISO deadline").textContent).toBe("— (NSO)");
  });

  it("shows shares with their price, form, legends, 83(b) and origin", async () => {
    renderPortal(`${PORTFOLIO}/securities/${DANIEL_SHARES.id}`, [{ ...DANIEL, securities: [DANIEL_SHARES, DANIEL_OPTION, DANIEL_WARRANT] }]);
    await screen.findByRole("heading", { name: /^CS-7 Shares/, level: 1 });
    expect(definitionOf("Quantity").textContent).toBe("50,000 shares");
    expect(definitionOf("Class").textContent).toBe("Common Stock");
    expect(definitionOf("Issue date").textContent).toBe("Mar 20, 2026");
    expect(definitionOf("Price per share").textContent).toBe("$0.10");
    expect(definitionOf("Form").textContent).toBe("Book entry");
    expect(definitionOf("Legends").textContent).toBe("Rule 144 legend, ISO disqualifying disposition legend");
    expect(definitionOf("Holding start date").textContent).toBe("Not recorded");
    expect(definitionOf("83(b)").textContent).toBe("Not required");
    expect(definitionOf("Origin").textContent).toBe("Exercise of OPT-1");
    expect(within(definitionOf("Origin")).getByRole("link", { name: "OPT-1" }).getAttribute("href")).toBe(`${PORTFOLIO}/securities/${DANIEL_OPTION.id}`);
    // A book entry says where the shares are held.
    expect(screen.getByText("These shares are held in book entry on the company's records.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Vesting and repurchase" })).toBeNull();
    expect(screen.getByText("No documents.")).toBeTruthy();
  });

  it("shows a migrated lot's holding start, and no book-entry line for shares that aren't one", async () => {
    renderPortal(`${PORTFOLIO}/securities/${MARCUS_SHARES[0]!.id}`, [MARCUS], {
      handlers: portalHandlers([MARCUS], { details: [securityDetail(MARCUS_SHARES[0]!, { pricePerShare: "1.92", form: "uncertificated", holdingStartDate: "2021-06-01" })] }),
    });
    await screen.findByRole("heading", { name: /^PS-3 Shares/, level: 1 });
    expect(definitionOf("Holding start date").textContent).toBe("Jun 1, 2021");
    expect(screen.queryByText(/held in book entry/)).toBeNull();
  });

  it("states the company's repurchase right on restricted shares, before and after the holder leaves", async () => {
    const restricted = portalSecurity({
      id: uuid(6, 61), displayId: "CS-61", issueDate: "2025-11-01",
      numbers: { asOf: "2026-10-21", granted: "4000", outstanding: "4000", vested: "2000", unvested: "2000", exercised: null, exercisable: null, cancelled: "0" },
      vesting: [{ date: "2026-05-01", quantity: "2000", cumulative: "2000", status: "VESTED" }, { date: "2027-05-01", quantity: "2000", cumulative: "4000", status: "UPCOMING" }],
    });
    const holding = { ...DANIEL, securities: [restricted] };
    const employed = securityDetail(restricted, { pricePerShare: "0.1", election83b: { status: "FILED", filedOn: "2025-11-20" }, repurchase: { price: "0.1", window: { period: "90", unit: "DAYS" }, lastDate: null, status: null } });
    renderPortal(`${PORTFOLIO}/securities/${restricted.id}`, [holding], { handlers: portalHandlers([holding], { details: [employed] }) });
    expect(await screen.findByRole("heading", { name: "Vesting and repurchase" })).toBeTruthy();
    expect(screen.getByText("2,000 of 4,000 shares have vested.")).toBeTruthy();
    expect(screen.getByText("If you leave before these shares vest, the company may buy back the unvested shares at $0.10 per share within 90 days.")).toBeTruthy();
    expect(definitionOf("83(b)").textContent).toBe("Filed on Nov 20, 2025");
    cleanup();
    const left = securityDetail(restricted, { pricePerShare: "0.1", election83b: { status: "PROOF_MISSING", filedOn: null }, repurchase: { price: "0.1", window: { period: "90", unit: "DAYS" }, lastDate: "2026-12-01", status: "open" } });
    renderPortal(`${PORTFOLIO}/securities/${restricted.id}`, [holding], { handlers: portalHandlers([holding], { details: [left] }) });
    expect(await screen.findByText("The company may repurchase 2,000 unvested shares at $0.10 per share until Dec 1, 2026.")).toBeTruthy();
    expect(definitionOf("83(b)").textContent).toBe("Proof missing");
    cleanup();
    // The holder's agreement sets no deadline: the right stands, undated.
    const agreed = securityDetail(restricted, { pricePerShare: "0.1", repurchase: { price: "0.1", window: null, lastDate: null, status: "no_deadline" } });
    renderPortal(`${PORTFOLIO}/securities/${restricted.id}`, [holding], { handlers: portalHandlers([holding], { details: [agreed] }) });
    expect(await screen.findByText("The company may repurchase 2,000 unvested shares at $0.10 per share; your agreement sets no deadline.")).toBeTruthy();
    cleanup();
    // Restricted shares with no 83(b) record: "Not recorded", never "Not required".
    const unrecorded = securityDetail(restricted, { election83b: { status: "NOT_RECORDED", filedOn: null }, repurchase: { price: "0.1", window: null, lastDate: null, status: null } });
    renderPortal(`${PORTFOLIO}/securities/${restricted.id}`, [holding], { handlers: portalHandlers([holding], { details: [unrecorded] }) });
    expect(await screen.findByRole("heading", { name: "Vesting and repurchase" })).toBeTruthy();
    expect(definitionOf("83(b)").textContent).toBe("Not recorded");
    expect(screen.getByText(/^Vesting start |^First vest|^Cliff/).textContent).toBe("First vest: 2,000 shares on May 1, 2026 · Fully vests on May 1, 2027");
  });

  it("tells a warrant holder whom to contact to exercise", async () => {
    renderPortal(`${PORTFOLIO}/securities/${DANIEL_WARRANT.id}`, [{ ...DANIEL, securities: [DANIEL_WARRANT] }]);
    await screen.findByRole("heading", { name: /^WAR-1 Warrant/, level: 1 });
    expect(definitionOf("Exercise price").textContent).toBe("$0.31");
    expect(definitionOf("Expiration").textContent).toBe("May 1, 2031");
    await waitFor(() => expect(screen.getByText(/^Contact the company to exercise/).textContent).toBe("Contact the company to exercise: equity@acmerobotics.example."));
  });

  it("shows a converted SAFE's principal, terms as recorded and what it converted into", async () => {
    renderPortal(`${PORTFOLIO}/convertibles/${MARCUS_SAFES[0]!.id}`, [MARCUS]);
    expect(await screen.findByText("Converted to PS-3")).toBeTruthy();
    const banner = screen.getByText(/^Converted on/).closest("[data-slot=alert]") as HTMLElement;
    expect(banner.textContent).toBe("Converted on Mar 1, 2023 into PS-3 (52,083 Series Seed Preferred).");
    expect(within(banner).getByRole("link", { name: "PS-3" }).getAttribute("href")).toBe(`${PORTFOLIO}/securities/${MARCUS_SHARES[0]!.id}`);
    expect(definitionOf("Principal").textContent).toBe("$100,000");
    expect(definitionOf("SAFE form (as recorded)").textContent).toBe("Post-money valuation cap");
    expect(definitionOf("Valuation cap").textContent).toBe("$8,000,000");
    // The SAFE's own contractual discount; no ownership or fully diluted figure is anywhere on the page.
    expect(definitionOf("Discount").textContent).toBe("20%");
    expect(main().textContent).not.toMatch(/fully diluted|ownership/i);
    expect(screen.getByRole("button", { name: "SAFE-3 - Marcus Oyelaran.pdf" })).toBeTruthy();
  });

  it("shows the share origin of a converted SAFE's lot", async () => {
    renderPortal(`${PORTFOLIO}/securities/${MARCUS_SHARES[1]!.id}`, [MARCUS]);
    await screen.findByRole("heading", { name: /^PS-5 Shares/, level: 1 });
    expect(definitionOf("Form").textContent).toBe("Uncertificated");
    expect(definitionOf("Origin").textContent).toBe("Conversion of SAFE-5");
    expect(within(definitionOf("Origin")).getByRole("link", { name: "SAFE-5" }).getAttribute("href")).toBe(`${PORTFOLIO}/convertibles/${MARCUS_SAFES[1]!.id}`);
  });

  it("says a holding isn't in the portfolio when the portal answers 404 for one the overview doesn't list", async () => {
    renderPortal(`${PORTFOLIO}/securities/${uuid(6, 999)}`, [NADIA]);
    expect(await screen.findByText("This holding was not found in your portfolio.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to portfolio" }).getAttribute("href")).toBe(PORTFOLIO);
  });
});

describe("how to exercise", () => {
  it("walks through the offline process with the grant's figures and the payment instructions", async () => {
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [NADIA]);
    expect(await screen.findByText("We never send bank details by e-mail. If you receive bank details by e-mail, don't pay — contact us.")).toBeTruthy();
    const steps = await screen.findByRole("list", { name: "How to exercise, step by step" });
    const items = within(steps).getAllByRole("listitem").map((item) => item.textContent);
    expect(items[0]).toBe("Check your exercisable amount and deadline. OPT-20: 60,000 options exercisable now at $0.31 · contractual deadline Feb 28, 2027 · ISO deadline Nov 30, 2026.");
    expect(items[1]).toBe("Download and sign counsel's notice of exercise. Notice of exercise (counsel form).docx");
    expect(items[2]).toBe("Send it to the company contact: Equity team, equity@acmerobotics.example.");
    // All the exercisable options to start with, costed exactly.
    expect((screen.getByRole("textbox", { name: "Options to exercise" }) as HTMLInputElement).value).toBe("60000");
    expect(screen.getByRole("status", { name: "Exercise cost" }).textContent).toBe("60,000 × $0.31 = $18,600.00");
    expect(items[3]).toBe("The equity team confirms the total due. Exercise cost = strike × quantity.Options to exerciseMax60,000 × $0.31 = $18,600.00 For employees and former employees, payroll confirms any tax withholding.");
    // Pay only once the equity team has confirmed the amount.
    expect(items[4]).toBe("Pay only after the equity team confirms the amount due: by ACH credit or wire to the account below (international payments: use the SWIFT and intermediary details), or by check, quoting your reference.");
    expect(definitionOf("Your reference").textContent).toBe("EX-OPT-20-NPS");
    expect(definitionOf("Account number").textContent).toBe("000123454321");
    expect(definitionOf("Routing number (ACH and domestic wires)").textContent).toBe("000000000");
    expect(definitionOf("Intermediary bank (international wires)").textContent).toBe("Example Correspondent Bank, SWIFT EXCOUS00");
    expect(definitionOf("Checks").textContent).toBe("Payable to Acme Robotics, Inc., mailed to 400 Harbor Way, Suite 12, Oakland, CA 94607");
    expect(screen.queryByText(/Instructions from/)).toBeNull();
    expect(screen.getByText("Exercises are requested offline, with the steps above.")).toBeTruthy();
  });

  it("computes the cost exactly and shows it rounded half-even to the cent, saying so", async () => {
    const odd = portalSecurity({ ...NADIA_OPTION, exercisePrice: "0.185", numbers: { ...NADIA_OPTION.numbers, exercisable: "833" } });
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [{ ...NADIA, securities: [odd] }]);
    // 833 × 0.185 = 154.105 exactly: half a cent, rounded to the even cent.
    expect((await screen.findByRole("status", { name: "Exercise cost" })).textContent).toBe("833 × $0.185 = $154.10, rounded to the cent");
    cleanup();
    const up = portalSecurity({ ...NADIA_OPTION, exercisePrice: "0.195", numbers: { ...NADIA_OPTION.numbers, exercisable: "833" } });
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [{ ...NADIA, securities: [up] }]);
    expect((await screen.findByRole("status", { name: "Exercise cost" })).textContent).toBe("833 × $0.195 = $162.44, rounded to the cent");
  });

  it("costs the number of options the holder chooses, whole options up to what is exercisable, with Max", async () => {
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [NADIA]);
    const quantity = await screen.findByRole("textbox", { name: "Options to exercise" }) as HTMLInputElement;
    const cost = () => screen.queryByRole("status", { name: "Exercise cost" })?.textContent ?? null;
    fireEvent.change(quantity, { target: { value: "1500" } });
    expect(cost()).toBe("1,500 × $0.31 = $465.00");
    fireEvent.change(quantity, { target: { value: "12.5" } });
    expect(cost()).toBeNull();
    expect(within(quantity.closest("li")!).getByRole("alert").textContent).toBe("Enter a whole number of options.");
    expect(quantity.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(quantity, { target: { value: "60001" } });
    expect(within(quantity.closest("li")!).getByRole("alert").textContent).toBe("You can exercise at most 60,000 options of this grant.");
    fireEvent.change(quantity, { target: { value: "0" } });
    expect(within(quantity.closest("li")!).getByRole("alert").textContent).toBe("Enter at least 1 option.");
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(quantity.value).toBe("60000");
    expect(cost()).toBe("60,000 × $0.31 = $18,600.00");
    // No tax estimate and no per-quantity ISO/NSO split: the equity team and payroll confirm those.
    expect(main().textContent).not.toMatch(/estimated tax|withholding estimate/i);
  });

  it("starts each grant from its own exercisable options, and offers no cost for a grant with nothing to exercise", async () => {
    const second = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 116), displayId: "OPT-16", exercisePrice: "0.18", numbers: { ...DANIEL_OPTION.numbers, exercisable: "64583" } });
    const unvested = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 137), displayId: "OPT-37", numbers: { ...DANIEL_OPTION.numbers, vested: "0", unvested: "250000", exercisable: "0" } });
    const holding = { ...DANIEL, securities: [DANIEL_OPTION, second, unvested] };
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [holding], { handlers: portalHandlers([holding]), me: holderMe([DANIEL], { email: "daniel@acmerobotics.example" }) });
    const quantity = await screen.findByRole("textbox", { name: "Options to exercise" }) as HTMLInputElement;
    fireEvent.change(quantity, { target: { value: "10" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Choose a grant" }), { target: { value: second.id } });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Options to exercise" }) as HTMLInputElement).value).toBe("64583"));
    expect(screen.getByRole("status", { name: "Exercise cost" }).textContent).toBe("64,583 × $0.18 = $11,624.94");
    fireEvent.change(screen.getByRole("combobox", { name: "Choose a grant" }), { target: { value: unvested.id } });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Options to exercise" })).toBeNull());
    expect(screen.queryByRole("status", { name: "Exercise cost" })).toBeNull();
  });

  it("says an ISO deadline has passed, and that a grant awaiting the holder's signature can't be exercised yet", async () => {
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [NADIA], { handlers: portalHandlers([NADIA], { asOf: "2026-12-15" }) });
    const steps = await screen.findByRole("list", { name: "How to exercise, step by step" });
    expect(within(steps).getAllByRole("listitem")[0]!.textContent).toBe(
      "Check your exercisable amount and deadline. OPT-20: 60,000 options exercisable now at $0.31 · contractual deadline Feb 28, 2027 · ISO deadline Nov 30, 2026 (passed: exercises from now on are taxed as NSOs).",
    );
    cleanup();
    const pending = portalSecurity({ ...DANIEL_OPTION, executionPending: "pending_holder", numbers: { ...DANIEL_OPTION.numbers, exercisable: "0" } });
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [{ ...DANIEL, securities: [pending] }], { me: holderMe([DANIEL], { email: "daniel@acmerobotics.example" }) });
    const pendingSteps = await screen.findByRole("list", { name: "How to exercise, step by step" });
    expect(within(pendingSteps).getAllByRole("listitem")[0]!.textContent).toBe(
      "Check your exercisable amount and deadline. OPT-1: 0 options exercisable now at $0.10 · expires Apr 14, 2033. (Awaiting your signature — you can exercise once you have signed the grant agreement.)",
    );
    expect(screen.queryByRole("textbox", { name: "Options to exercise" })).toBeNull();
    cleanup();
    // Awaiting only the company's countersignature: nothing holds the holder back.
    const company = portalSecurity({ ...DANIEL_OPTION, executionPending: "pending_company" });
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [{ ...DANIEL, securities: [company] }], { me: holderMe([DANIEL], { email: "daniel@acmerobotics.example" }) });
    const companySteps = await screen.findByRole("list", { name: "How to exercise, step by step" });
    expect(within(companySteps).getAllByRole("listitem")[0]!.textContent).toBe(
      "Check your exercisable amount and deadline. OPT-1: 218,750 options exercisable now at $0.10 · expires Apr 14, 2033.",
    );
  });

  it("switches to another grant and shows the company's own instructions", async () => {
    const second = portalSecurity({ ...DANIEL_OPTION, id: uuid(6, 116), displayId: "OPT-16", exercisePrice: "0.18", numbers: { ...DANIEL_OPTION.numbers, exercisable: "64583" } });
    const { router } = renderPortal(`${PORTFOLIO}/how-to-exercise`, [{ ...DANIEL, securities: [DANIEL_OPTION, second] }], {
      handlers: portalHandlers([{ ...DANIEL, securities: [DANIEL_OPTION, second] }], { howTo: howToExercise({ text: "Send the signed notice and your payment confirmation together.\nWe confirm within two business days." }) }),
      me: holderMe([DANIEL], { email: "daniel@acmerobotics.example" }),
    });
    const select = await screen.findByRole("combobox", { name: "Choose a grant" });
    expect((select as HTMLSelectElement).value).toBe(DANIEL_OPTION.id);
    fireEvent.change(select, { target: { value: second.id } });
    await waitFor(() => expect(router.state.location.search).toBe(`?grant=${second.id}`));
    expect(screen.getByText(/OPT-16: /)).toBeTruthy();
    expect(definitionOf("Your reference").textContent).toBe("EX-OPT-16-DA");
    expect(screen.getByRole("heading", { name: "Instructions from Acme Robotics" })).toBeTruthy();
    expect(screen.getByText(/We confirm within two business days\./).hasAttribute("data-howto-text")).toBe(true);
  });

  it("says when there's nothing to exercise and no payment instructions yet", async () => {
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [MARCUS], { handlers: portalHandlers([MARCUS], { howTo: howToExercise({ paymentInstructions: null, noticeForm: null }) }) });
    expect(await screen.findByText("You have no options to exercise.")).toBeTruthy();
    expect(screen.getByText("The company hasn't published payment instructions here yet. Contact equity@acmerobotics.example before you pay.")).toBeTruthy();
    expect(screen.getByText(/Ask the company contact for the form\./)).toBeTruthy();
  });
});

describe("documents", () => {
  it("separates the holder's own documents from company resources", async () => {
    renderPortal(`${PORTFOLIO}/documents`, [NADIA]);
    expect(await screen.findByRole("heading", { name: "My documents" })).toBeTruthy();
    const cards = screen.getAllByRole("button").map((button) => button.textContent);
    expect(cards).toEqual(expect.arrayContaining(["OPT-20 Option Agreement.pdf", "Separation agreement.pdf", "Notice of exercise (counsel form).docx", "2023 Equity Incentive Plan.pdf"]));
    const resources = screen.getByRole("heading", { name: "Company resources" });
    expect(resources.compareDocumentPosition(screen.getByRole("button", { name: "2023 Equity Incentive Plan.pdf" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(resources.compareDocumentPosition(screen.getByRole("button", { name: "Separation agreement.pdf" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.getAllByText(/^Separation agreement · /)).toHaveLength(1);
  });

  it("leads the company resources with the designated privacy notice, marked as such", async () => {
    renderPortal(`${PORTFOLIO}/documents`, [NADIA]);
    const resources = await screen.findByRole("heading", { name: "Company resources" });
    const cards = [...document.querySelectorAll("[data-slot=item]")].filter((card) => resources.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(cards[0]!.querySelector("[data-slot=item-title]")!.textContent).toBe("Acme Robotics Privacy Notice.pdfPrivacy notice");
    expect(cards.slice(1).map((card) => card.querySelector("[data-slot=item-title]")!.textContent)).toEqual(["Notice of exercise (counsel form).docx", "2023 Equity Incentive Plan.pdf"]);
    expect(screen.getAllByText("Privacy notice", { selector: "[data-slot=badge]" })).toHaveLength(1);
  });

  it("shows only what the portal lists, with empty states", async () => {
    renderPortal(`${PORTFOLIO}/documents`, [NADIA], { handlers: portalHandlers([NADIA], { documents: [] }) });
    expect(await screen.findByText("No documents of yours have been shared here yet.")).toBeTruthy();
    expect(screen.getByText("No company resources yet.")).toBeTruthy();
  });

  it("names the grant each document belongs to and dates an imported one by its original upload, never as signed", async () => {
    const migrated = portalDocument({ id: uuid(10, 125), filename: "OPT-25 agreement (imported).pdf", createdAt: Date.UTC(2026, 9, 20), sourceCreatedAt: Date.UTC(2025, 1, 3, 18) });
    const nso = portalSecurity({ ...NADIA_OPTION, id: uuid(6, 125), displayId: "OPT-25", optionType: "NSO", documents: [migrated, NADIA_OPTION.documents[1]!] });
    const holding = { ...NADIA, securities: [NADIA_OPTION, nso] };
    renderPortal(`${PORTFOLIO}/documents`, [holding], { handlers: portalHandlers([holding], { documents: [...NADIA_OPTION.documents, migrated, ...COMPANY_RESOURCES] }) });
    await screen.findByRole("heading", { name: "My documents" });
    const meta = (filename: string) => screen.getByRole("button", { name: filename }).closest("[data-slot=item]")!.querySelector("[data-slot=item-description]")!.textContent;
    expect(meta("OPT-20 Option Agreement.pdf")).toBe("Grant agreement · OPT-20 · Oct 1, 2026");
    // A document linked to two of the holder's grants names both.
    expect(meta("Separation agreement.pdf")).toBe("Separation agreement · OPT-20, OPT-25 · Oct 1, 2026");
    expect(meta("OPT-25 agreement (imported).pdf")).toBe("Grant agreement · OPT-25 · Originally uploaded Feb 3, 2025");
    expect(document.getElementById("main")!.textContent).not.toMatch(/signed on/i);
    // Newest first, an imported document by its original upload.
    const mine = [...document.querySelectorAll("[data-slot=item] [data-slot=item-title]")].map((card) => card.textContent).filter((name) => !/Notice of exercise|Plan|Privacy/.test(name ?? ""));
    expect(mine).toEqual(["OPT-20 Option Agreement.pdf", "Separation agreement.pdf", "OPT-25 agreement (imported).pdf"]);
    // The holding detail dates it the same way.
    cleanup();
    renderPortal(`${PORTFOLIO}/securities/${nso.id}`, [holding]);
    await screen.findByRole("heading", { name: /^OPT-25 Options/ });
    expect(screen.getByRole("button", { name: "OPT-25 agreement (imported).pdf" }).closest("[data-slot=item]")!.querySelector("[data-slot=item-description]")!.textContent).toBe("Grant agreement · Originally uploaded Feb 3, 2025");
  });

  it("searches the documents as the holder types, by name, kind or grant", async () => {
    renderPortal(`${PORTFOLIO}/documents`, [NADIA]);
    const search = await screen.findByRole("searchbox", { name: "Search documents" });
    const names = () => [...document.querySelectorAll("[data-slot=item] [data-slot=item-title]")].map((card) => card.textContent);
    fireEvent.change(search, { target: { value: "separation" } });
    expect(names()).toEqual(["Separation agreement.pdf"]);
    expect(screen.getByText("No company resources match.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "opt-20 grant" } });
    expect(names()).toEqual(["OPT-20 Option Agreement.pdf"]);
    fireEvent.change(search, { target: { value: "plan" } });
    expect(names()).toEqual(["2023 Equity Incentive Plan.pdf"]);
    expect(screen.getByText("None of your documents match.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(names()).toHaveLength(5);
  });
});

describe("strict portal schemas", () => {
  const silence = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("refuses an overview carrying a key the allowlist doesn't contain, and shows none of it", async () => {
    silence();
    const leaky = { ...overview([NADIA]), holdings: [{ ...NADIA, securities: [{ ...NADIA_OPTION, fullyDilutedPct: "1/400" }] }] };
    renderPortal(PORTFOLIO, [NADIA], { handlers: [mock(api.routes.getPortalOverview, () => respondJson(leaky)), ...portalHandlers([NADIA]).slice(1)] });
    expect(await screen.findByText("Couldn't load this page")).toBeTruthy();
    expect(screen.getByText("The server's answer didn't match the API contract.")).toBeTruthy();
    expect(screen.queryByText("OPT-20")).toBeNull();
    expect(screen.queryByText(/0\.25/)).toBeNull();
  });

  it("refuses a holding detail with an extra key, at the top or inside its detail", async () => {
    silence();
    const top = { ...detailOf(NADIA_OPTION), otherHolders: [] };
    renderPortal(`${PORTFOLIO}/securities/${NADIA_OPTION.id}`, [NADIA], {
      handlers: [...portalHandlers([NADIA]).filter((handler) => handler.route !== api.routes.getPortalSecurity), mock(api.routes.getPortalSecurity, () => respondJson(top))],
    });
    expect(await screen.findByText("The server's answer didn't match the API contract.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /OPT-20 Options/ })).toBeNull();
    cleanup();
    const detail = detailOf(NADIA_OPTION);
    const inner = { ...detail, detail: { ...detail.detail, optioneeIsoTotal: "143750" } };
    renderPortal(`${PORTFOLIO}/securities/${NADIA_OPTION.id}`, [NADIA], {
      handlers: [...portalHandlers([NADIA]).filter((handler) => handler.route !== api.routes.getPortalSecurity), mock(api.routes.getPortalSecurity, () => respondJson(inner))],
    });
    expect(await screen.findByText("The server's answer didn't match the API contract.")).toBeTruthy();
    expect(screen.queryByText("143,750")).toBeNull();
  });

  it("refuses How to exercise payment details with an extra field", async () => {
    silence();
    const leaky = { ...howToExercise(), paymentInstructions: { ...howToExercise().paymentInstructions, proposedBy: "Rachel Ostrowski" } };
    renderPortal(`${PORTFOLIO}/how-to-exercise`, [NADIA], { handlers: [...portalHandlers([NADIA]).filter((handler) => handler.route !== api.routes.getHowToExercise), mock(api.routes.getHowToExercise, () => respondJson(leaky))] });
    expect(await screen.findByText("The server's answer didn't match the API contract.")).toBeTruthy();
    expect(screen.queryByText("First Example Bank")).toBeNull();
    expect(screen.queryByText("Rachel Ostrowski")).toBeNull();
  });

  it("refuses a document list item with an extra field", async () => {
    silence();
    renderPortal(`${PORTFOLIO}/documents`, [NADIA], { handlers: [...portalHandlers([NADIA]).filter((handler) => handler.route !== api.routes.listPortalDocuments), mock(api.routes.listPortalDocuments, () => respondJson([{ ...COMPANY_RESOURCES[0], holderVisible: true }]))] });
    expect(await screen.findByText("The server's answer didn't match the API contract.")).toBeTruthy();
    expect(screen.queryByText("Notice of exercise (counsel form).docx")).toBeNull();
  });
});

describe("when the portal can't serve a page", () => {
  /** What the server answers for a portal route it doesn't serve. */
  const unmounted = () => apiError(404, "not_found", "Unknown API route");

  it("says the portfolio isn't available, not that the holder has no access, while /api/me still lists the company", async () => {
    const handlers = [
      mock(api.routes.getPortalOverview, unmounted), mock(api.routes.getPortalSecurity, unmounted),
      mock(api.routes.getHowToExercise, unmounted), mock(api.routes.listPortalDocuments, unmounted),
    ];
    const { router, callsTo } = renderPortal(PORTFOLIO, [NADIA], { handlers });
    expect(await screen.findByText("Your portfolio isn't available right now")).toBeTruthy();
    expect(screen.getByText(/Your access hasn't changed/)).toBeTruthy();
    expect(router.state.location.pathname).toBe(PORTFOLIO);
    // /api/me was read again before saying anything about access.
    expect(callsTo(api.routes.getMe)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(callsTo(api.routes.getPortalOverview)).toHaveLength(2));
    expect(await screen.findByText("Your portfolio isn't available right now")).toBeTruthy();
  });

  it("says a page isn't available when only its own route answers 404", async () => {
    const handlers = [...portalHandlers([NADIA]).filter((handler) => handler.route !== api.routes.listPortalDocuments), mock(api.routes.listPortalDocuments, unmounted)];
    const { router } = renderPortal(`${PORTFOLIO}/documents`, [NADIA], { handlers });
    expect(await screen.findByText("Documents isn't available right now")).toBeTruthy();
    expect(router.state.location.pathname).toBe(`${PORTFOLIO}/documents`);
  });

  it("says a listed holding isn't available instead of calling it someone else's", async () => {
    const handlers = [...portalHandlers([NADIA]).filter((handler) => handler.route !== api.routes.getPortalSecurity), mock(api.routes.getPortalSecurity, unmounted)];
    renderPortal(`${PORTFOLIO}/securities/${NADIA_OPTION.id}`, [NADIA], { handlers });
    expect(await screen.findByText("This holding isn't available right now")).toBeTruthy();
    expect(screen.queryByText("This holding was not found in your portfolio.")).toBeNull();
  });
});

describe("preview as stakeholder (admin)", () => {
  it("shows the holder's whole portal in the admin shell, from the preview routes, with every portal action disabled", async () => {
    const { callsTo, router } = renderPreview("");
    expect(await screen.findByText(/You are previewing the portal as/)).toBeTruthy();
    expect(screen.getByText(/Every portal action is disabled\./)).toBeTruthy();
    expect(screen.getByText(/It shows this one stakeholder record/)).toBeTruthy();
    expect(await screen.findByText(/You can exercise 60,000 vested options/)).toBeTruthy();
    expect(await screen.findByText("2023 Equity Incentive Plan.pdf")).toBeTruthy();
    expect(screen.getByText("2023 Equity Incentive Plan.pdf").tagName).toBe("SPAN");
    fireEvent.click(within(main()).getAllByRole("link", { name: "How to exercise" })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`${PREVIEW}/how-to-exercise`));
    expect(await screen.findByRole("list", { name: "How to exercise, step by step" })).toBeTruthy();
    expect(screen.getByText("Notice of exercise (counsel form).docx").tagName).toBe("SPAN");
    // The footer's privacy notice is disabled here, as every document is; the banner leads to the portal's pages.
    expect(screen.getByText("Privacy notice", { selector: "footer span" }).getAttribute("title")).toBe("Disabled in the preview");
    fireEvent.click(within(screen.getByRole("note")).getByRole("link", { name: "Documents" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${PREVIEW}/documents`));
    expect(await screen.findByRole("heading", { name: "My documents" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Portfolio" }));
    fireEvent.click(within(await screen.findByRole("table", { name: "My grants and shares" })).getByRole("link", { name: "OPT-20" }));
    expect(await screen.findByRole("heading", { name: /^OPT-20 Options/ })).toBeTruthy();
    expect((screen.getByRole("button", { name: "How to exercise" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Separation agreement.pdf").tagName).toBe("SPAN");
    expect(callsTo(api.routes.previewPortalSecurity)[0]?.url.pathname).toBe(`/api/orgs/${ORG_ID}/stakeholders/${IDS.nadia}/preview/securities/${NADIA_OPTION.id}`);
    expect(callsTo(api.routes.previewPortalDocuments).length).toBeGreaterThan(0);
    expect(callsTo(api.routes.previewHowToExercise).length).toBeGreaterThan(0);
    for (const route of [api.routes.getPortalOverview, api.routes.getPortalSecurity, api.routes.listPortalDocuments, api.routes.getHowToExercise, api.routes.downloadPortalDocument]) expect(callsTo(route)).toHaveLength(0);
  });

  it("says plainly that the preview isn't available when the server answers 404", async () => {
    // The server answers 404 for a stakeholder that isn't one of this company's.
    renderPortal(PREVIEW, [NADIA], { me: ADMIN, handlers: [mock(api.routes.getOrg, org()), mock(api.routes.previewAsStakeholder, () => apiError(404, "not_found", "Stakeholder not found"))] });
    expect(await screen.findByText("This portal preview isn't available. The stakeholder may not be in this company.")).toBeTruthy();
    expect(screen.queryByText(/does not exist/)).toBeNull();
    expect(screen.getByRole("link", { name: "Back to stakeholders" }).getAttribute("href")).toBe(`/companies/${ORG_ID}/stakeholders`);
  });

  /** The portal page's own text: the holder's page section, or the preview frame's. */
  async function pageText(render_: () => unknown, ready: () => Promise<unknown>, preview: boolean): Promise<string> {
    render_();
    await ready();
    await waitFor(() => expect(document.querySelectorAll('#main [role="status"]')).toHaveLength(0));
    const section = document.querySelector(preview ? "[data-preview-frame] [data-portal-page]" : "#main > [data-portal-page]");
    const text = section?.textContent ?? "";
    cleanup();
    return text;
  }

  it.each([
    ["the overview", "", () => screen.findByRole("table", { name: "My grants and shares" })],
    ["an option", `/securities/${NADIA_OPTION.id}`, () => screen.findByRole("table", { name: "ISO/NSO split" })],
    ["How to exercise", "/how-to-exercise", () => screen.findByRole("list", { name: "How to exercise, step by step" })],
    ["the documents", "/documents", () => screen.findByText("2023 Equity Incentive Plan.pdf")],
  ])("shows %s exactly as the holder sees it", async (_name, path, ready) => {
    const holder = await pageText(() => renderPortal(`${PORTFOLIO}${path}`, [NADIA]), ready, false);
    const preview = await pageText(() => renderPreview(path), ready, true);
    expect(holder.length).toBeGreaterThan(100);
    expect(preview).toBe(holder);
  });

  it("shows a read-only admin the holder's page without the admin's read-only badge", async () => {
    const ready = () => screen.findByRole("list", { name: "How to exercise, step by step" });
    const readOnlyAdmin = holderMe([], { email: "rachel@acmerobotics.example", name: "Rachel Ostrowski", access: "admin_ro" });
    const holder = await pageText(() => renderPortal(`${PORTFOLIO}/how-to-exercise`, [NADIA]), ready, false);
    const preview = await pageText(() => renderPortal(`${PREVIEW}/how-to-exercise`, [NADIA], { me: readOnlyAdmin, handlers: previewHandlers(NADIA) }), ready, true);
    expect(preview).toBe(holder);
    expect(preview).not.toContain("Read-only");
  });

  it("shows a SAFE exactly as its holder sees it", async () => {
    const path = `/convertibles/${MARCUS_SAFES[0]!.id}`;
    const ready = () => screen.findByText("Converted to PS-3");
    const marcusPreview = (suffix: string) => renderPortal(`/companies/${ORG_ID}/stakeholders/${IDS.marcus}/preview${suffix}`, [MARCUS], { me: ADMIN, handlers: previewHandlers(MARCUS) });
    const holder = await pageText(() => renderPortal(`${PORTFOLIO}${path}`, [MARCUS]), ready, false);
    const preview = await pageText(() => marcusPreview(path), ready, true);
    expect(preview).toBe(holder);
  });
});
