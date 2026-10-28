import "./setup.ts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { api } from "#shared";
import App from "../../src/app/App.tsx";
import { AuthProvider } from "../../src/app/auth/AuthProvider.tsx";
import { routes } from "../../src/app/router.tsx";
import { COMPANY, dashboard, me, org, ORG_ID, VALUATIONS } from "./support/acme.ts";
import { apiError, mock, mockApi, type MockHandler } from "./support/mockApi.ts";
import { COMPANY_RESOURCES, NADIA, holderMe, howToExercise, overview } from "./support/portal.ts";

type Me = api.MeResponse;

// The shell around every page: who the Insulin console says is using the app (/api/me), the full-page message when it
// says no one (a 401), the first-run company setup, the preview-mode strip, and where each kind of access lands.

const DASHBOARD = `/companies/${ORG_ID}/dashboard`;
const PORTFOLIO = `/portfolio/${ORG_ID}`;

function workspaceHandlers(): MockHandler[] {
  return [
    mock(api.routes.getOrg, org()),
    mock(api.routes.getDashboard, dashboard()),
    mock(api.routes.listValuations, { items: VALUATIONS }),
    mock(api.routes.getPortalOverview, overview([NADIA])),
    mock(api.routes.getHowToExercise, howToExercise()),
    mock(api.routes.listPortalDocuments, COMPANY_RESOURCES),
  ];
}

function renderRoute(path: string, session: Me | (() => Me | Response), extra: MockHandler[] = workspaceHandlers()) {
  const mocks = mockApi([mock(api.routes.getMe, session), ...extra]);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<AuthProvider><RouterProvider router={router} /></AuthProvider>);
  return { router, ...mocks };
}

const unauthenticated = () => apiError(401, "unauthenticated", "No console identity");

describe("the React root that src/main.tsx mounts", () => {
  it("asks /api/me who is using the app and routes from the page's own address", async () => {
    const { callsTo } = mockApi([mock(api.routes.getMe, unauthenticated)]);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Open this app from the Insulin console" })).toBeTruthy();
    expect(callsTo(api.routes.getMe).length).toBeGreaterThan(0);
  });
});

describe("opened outside the Insulin console", () => {
  it("shows one full-page message on a 401 from /api/me, with no link out of the frame", async () => {
    const { callsTo } = renderRoute(`${DASHBOARD}?asOf=2026-10-22`, unauthenticated);
    expect(await screen.findByRole("heading", { name: "Open this app from the Insulin console" })).toBeTruthy();
    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(screen.queryByText("ESSENTIALS")).toBeNull();
    expect(callsTo(api.routes.getDashboard)).toHaveLength(0);
    // "Try again" asks /api/me once more, in place: the console may have renewed its session meanwhile.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(callsTo(api.routes.getMe)).toHaveLength(2));
  });

  it("loads the app when a retry finds the console identity again", async () => {
    let reads = 0;
    const { router } = renderRoute(DASHBOARD, () => (++reads === 1 ? unauthenticated() : me("owner")));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("ESSENTIALS")).toBeTruthy();
    expect(router.state.location.pathname).toBe(DASHBOARD);
  });

  it("swaps whatever page is open for the message when a later call answers 401", async () => {
    const extra = [...workspaceHandlers().filter((handler) => handler.route !== api.routes.getDashboard), mock(api.routes.getDashboard, unauthenticated)];
    renderRoute(DASHBOARD, me("owner"), extra);
    expect(await screen.findByRole("heading", { name: "Open this app from the Insulin console" })).toBeTruthy();
    expect(screen.queryByText("ESSENTIALS")).toBeNull();
  });

  it("never navigates the window or opens another one", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderRoute(DASHBOARD, unauthenticated);
    await screen.findByRole("heading", { name: "Open this app from the Insulin console" });
    expect(open).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
  });
});

describe("the shell", () => {
  it("shows the product and the company's name, the person's console role, and no sign-in or sign-out", async () => {
    renderRoute(DASHBOARD, me("owner"));
    const banner = await screen.findByRole("banner");
    expect(within(banner).getByText("Cap Table")).toBeTruthy();
    expect(within(banner).getByText("Acme Robotics")).toBeTruthy();
    expect(within(banner).getByText("Rachel Ostrowski")).toBeTruthy();
    expect(within(banner).getByText("Owner")).toBeTruthy();
    expect(screen.getByText("ESSENTIALS")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /New/ })).toBeTruthy();
    expect(screen.queryByText(/sign (in|out)/i)).toBeNull();
  });

  it("offers no write entry points to an editor", async () => {
    renderRoute(DASHBOARD, me("admin_ro"));
    expect(await screen.findByText("Editor")).toBeTruthy();
    await screen.findByText("ESSENTIALS");
    await screen.findByRole("heading", { name: "Acme Robotics, Inc." });
    expect(screen.queryByRole("button", { name: /New/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Process due items" })).toBeNull();
  });

  it("marks preview mode, when the app runs without a console identity in the console's preview", async () => {
    renderRoute(DASHBOARD, me("owner", { preview: true }));
    expect(await screen.findByText("Preview mode.")).toBeTruthy();
    expect(screen.getByText(/stand-in owner/)).toBeTruthy();
  });

  it("shows no preview strip for a real console user", async () => {
    renderRoute(DASHBOARD, me("owner"));
    await screen.findByText("ESSENTIALS");
    expect(screen.queryByText(/Preview mode/)).toBeNull();
  });
});

describe("where each kind of access lands", () => {
  it("routes home to the dashboard for admins and editors, the portfolio for holders, and no-access otherwise", async () => {
    const admin = renderRoute("/", me("admin_rw"));
    await waitFor(() => expect(admin.router.state.location.pathname).toBe(DASHBOARD));

    const editor = renderRoute("/", me("admin_ro"));
    await waitFor(() => expect(editor.router.state.location.pathname).toBe(DASHBOARD));

    const holder = renderRoute("/", holderMe([NADIA]));
    await waitFor(() => expect(holder.router.state.location.pathname).toBe(PORTFOLIO));

    const none = renderRoute("/", holderMe([], { email: "visitor@example.test", name: "Visitor" }));
    await waitFor(() => expect(none.router.state.location.pathname).toBe("/no-access"));
    expect((await screen.findAllByRole("heading", { name: "No access" })).length).toBeGreaterThan(0);
    expect(screen.getByText(/visitor@example\.test/)).toBeTruthy();
  });

  it("sends a holder who opens a company page to the no-access page", async () => {
    const { router, callsTo } = renderRoute(DASHBOARD, holderMe([NADIA]));
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
    expect(callsTo(api.routes.getOrg)).toHaveLength(0);
  });

  it("sends refused portfolio routes to the no-access page", async () => {
    const { router } = renderRoute(PORTFOLIO, me("admin_rw"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
  });
});

describe("first run: no company yet", () => {
  it("shows owners and admins the setup form and opens the dashboard once the company exists", async () => {
    let company: Me["company"] = null;
    const session = () => me("owner", { company });
    const extra = [
      ...workspaceHandlers(),
      mock(api.routes.createOrg, () => {
        company = COMPANY;
        return org();
      }),
    ];
    const { router, callsTo } = renderRoute(DASHBOARD, session, extra);
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    fireEvent.click(await screen.findByRole("link", { name: "Start with an empty company" }));
    fireEvent.change(await screen.findByLabelText(/Company name/), { target: { value: "Acme Robotics" } });
    fireEvent.change(screen.getByLabelText(/Legal name/), { target: { value: "Acme Robotics, Inc." } });
    fireEvent.change(screen.getByLabelText(/Time zone/), { target: { value: "America/Los_Angeles" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up company" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(DASHBOARD));
    const [call] = callsTo(api.routes.createOrg);
    expect(call!.body).toEqual({
      orgKey: "acme-robotics", displayName: "Acme Robotics", legalName: "Acme Robotics, Inc.", jurisdiction: "US-DE", timezone: "America/Los_Angeles",
      fiscalYearEnd: "12-31",
    });
    expect(call!.headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("checks the form before anything is sent", async () => {
    const { callsTo } = renderRoute("/setup?start=empty", me("admin_rw", { company: null }), [...workspaceHandlers(), mock(api.routes.createOrg, () => org())]);
    fireEvent.click(await screen.findByRole("button", { name: "Set up company" }));
    expect(await screen.findByText("Enter the company name.")).toBeTruthy();
    expect(callsTo(api.routes.createOrg)).toHaveLength(0);
  });

  it("marks preview mode on the setup page too, where the stand-in owner first writes", async () => {
    renderRoute("/setup", me("owner", { company: null, preview: true }), [...workspaceHandlers(), mock(api.routes.createOrg, () => org())]);
    expect(await screen.findByRole("link", { name: "Start with an empty company" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Preview mode.");
  });

  it("tells everyone else to wait for an owner or admin", async () => {
    const { router } = renderRoute("/", { ...holderMe([]), company: null });
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    expect(await screen.findByRole("heading", { name: "Cap Table isn't set up yet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up company" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Import from/ })).toBeNull();
  });
});
