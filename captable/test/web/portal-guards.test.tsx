import "./setup.ts";
import { render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { AuthProvider } from "../../src/app/auth/AuthProvider.tsx";
import { routes } from "../../src/app/router.tsx";
import { dashboard, ORG_ID, org, VALUATIONS } from "./support/acme.ts";
import { apiError, mock, mockApi, type MockHandler } from "./support/mockApi.ts";
import { COMPANY_RESOURCES, DANIEL, NADIA, OTHER_ORG_ID, holderMe, howToExercise, overview } from "./support/portal.ts";
import "./support/render.tsx";

type Me = api.MeResponse;

// Routing guards for holders: the server answers /api/me with the access a console role gives here. Holder access (a
// console USER or VIEWER whose e-mail matches a stakeholder) never reaches the company workspace; an admin or editor
// who also holds equity reaches both. A holder whose access has ended, or who asks for another company, gets the
// shell's no-access page.

const PORTFOLIO = `/portfolio/${ORG_ID}`;
const DASHBOARD = `/companies/${ORG_ID}/dashboard`;

function handlers(holdings: readonly api.PortalHolding[]): MockHandler[] {
  return [
    mock(api.routes.getPortalOverview, overview(holdings)),
    mock(api.routes.getHowToExercise, howToExercise()),
    mock(api.routes.listPortalDocuments, COMPANY_RESOURCES),
    mock(api.routes.getOrg, org()),
    mock(api.routes.getDashboard, dashboard()),
    mock(api.routes.listValuations, { items: VALUATIONS }),
  ];
}

function renderAt(path: string, me: Me | (() => Me), extra: MockHandler[] = handlers(typeof me === "function" || me.portal.matches.length ? [NADIA] : [])) {
  const mocks = mockApi([mock(api.routes.getMe, me), ...extra]);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<AuthProvider><RouterProvider router={router} /></AuthProvider>);
  return { router, ...mocks };
}

describe("holder access", () => {
  it.each(["USER", "VIEWER"] as const)("sends a console %s who holds equity from / to the company's portfolio", async (consoleRole) => {
    const { router } = renderAt("/", holderMe([NADIA], { consoleRole }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PORTFOLIO));
    expect(await screen.findByText(/You can exercise 60,000 vested options/)).toBeTruthy();
    expect(screen.getByText(consoleRole === "USER" ? "User" : "Viewer")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Portfolio" });
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["Portfolio", "How to exercise", "Documents"]);
    expect(screen.queryByRole("link", { name: "Admin workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New/ })).toBeNull();
  });

  it("sends a holder who opens a company URL to the no-access page", async () => {
    const { router, callsTo } = renderAt(DASHBOARD, holderMe([NADIA]));
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
    expect(callsTo(api.routes.getDashboard)).toHaveLength(0);
  });

  it("follows the server's access, never the console role alone", async () => {
    const odd = holderMe([NADIA], { consoleRole: "ADMIN" });
    const { router, callsTo } = renderAt(DASHBOARD, odd);
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
    expect(callsTo(api.routes.getOrg)).toHaveLength(0);
    const home = renderAt("/", odd);
    await waitFor(() => expect(home.router.state.location.pathname).toBe(PORTFOLIO));
  });
});

describe("admins and editors who hold equity", () => {
  it("lets an editor who holds equity switch between the workspace and their portfolio", async () => {
    const adminHolder = holderMe([DANIEL], { email: "daniel@acmerobotics.example", access: "admin_ro" });
    const { router } = renderAt("/", adminHolder, handlers([DANIEL]));
    await waitFor(() => expect(router.state.location.pathname).toBe(DASHBOARD));
    expect((await screen.findAllByRole("link", { name: "My portfolio" })).map((link) => link.getAttribute("href"))).toContain(PORTFOLIO);
    const portfolio = renderAt(PORTFOLIO, adminHolder, handlers([DANIEL]));
    expect(await screen.findAllByRole("heading", { name: "Acme Robotics", level: 1 })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Admin workspace" }).length).toBeGreaterThan(0);
    expect(portfolio.router.state.location.pathname).toBe(PORTFOLIO);
  });

  it("offers no portfolio to an admin whose e-mail matches no stakeholder", async () => {
    const admin = holderMe([], { email: "morgan@acmerobotics.example", access: "admin_rw" });
    const { router } = renderAt(PORTFOLIO, admin, handlers([]));
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
  });
});

describe("holders whose access has ended", () => {
  it("sends a holder with no open access to the no-access page", async () => {
    const ended = holderMe([], { email: "marcus.oyelaran@kensington.example", name: "Marcus Oyelaran" });
    const { router, callsTo } = renderAt(PORTFOLIO, ended, handlers([]));
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
    expect(await screen.findByText("You don't have access to this page.")).toBeTruthy();
    // The page names the console account the app sees: what the equity team needs to connect it to a record.
    expect(screen.getByText("marcus.oyelaran@kensington.example")).toBeTruthy();
    expect(screen.queryByText(/sign out/i)).toBeNull();
    expect(callsTo(api.routes.getPortalOverview)).toHaveLength(0);
  });

  /** /api/me as the server answers it before and after the holder's access ends mid-session. */
  function accessEndsAfterFirstRead(): () => Me {
    let reads = 0;
    return () => (++reads === 1 ? holderMe([NADIA]) : holderMe([]));
  }

  it("goes to the no-access page when the portal stops serving the holder mid-session (404, and /api/me agrees)", async () => {
    const extra = [...handlers([NADIA]).filter((handler) => handler.route !== api.routes.getPortalOverview), mock(api.routes.getPortalOverview, () => apiError(404, "not_found", "Not found"))];
    const { router, callsTo } = renderAt(PORTFOLIO, accessEndsAfterFirstRead(), extra);
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
    expect(callsTo(api.routes.getMe)).toHaveLength(2);
  });

  it("goes to the no-access page when a company's page answers 404 and /api/me no longer lists the company", async () => {
    const extra = [...handlers([NADIA]).filter((handler) => handler.route !== api.routes.listPortalDocuments), mock(api.routes.listPortalDocuments, () => apiError(404, "not_found", "Not found"))];
    const { router } = renderAt(`${PORTFOLIO}/documents`, accessEndsAfterFirstRead(), extra);
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
  });

  it("refuses another company's portfolio", async () => {
    const { router, callsTo } = renderAt(`/portfolio/${OTHER_ORG_ID}`, holderMe([NADIA]));
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
    expect(callsTo(api.routes.getPortalOverview)).toHaveLength(0);
  });
});
