import "./setup.ts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, matchRoutes, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { api } from "#shared";
import packageJson from "../../package.json";
import { AuthProvider } from "../../src/app/auth/AuthProvider.tsx";
import { Icon, NAV_ICON } from "../../src/app/components/Icon.tsx";
import {
  NAVIGATION, NAV_ICONS, NAV_STORAGE_KEY, appRootPath, groupNavigation, isPortfolioPath, matchNavigation, navigationFor,
  navigationPaths, navigationRole, navigationSchema, readNavCollapse, resolveNavPath, type NavItem, type NavLink,
} from "../../src/app/lib/navigation.ts";
import { browser, settingsLinks } from "../../src/app/lib/platform.ts";
import { routes } from "../../src/app/router.tsx";
import { dashboard, me, ORG_ID, VALUATIONS } from "./support/acme.ts";
import { apiError, mock, mockApi, type MockHandler } from "./support/mockApi.ts";
import { APEX, mockPlatform, platformAccount, type PlatformAccountFixture } from "./support/platform.ts";
import { COMPANY_RESOURCES, DANIEL, NADIA, holderMe, howToExercise, overview } from "./support/portal.ts";
import { base, renderPage } from "./support/render.tsx";

type Me = api.MeResponse;

// The two-level navigation (DESIGN.md §3.2 at the repository's root): the manifest in package.json that Cap Table and the
// Insulin Apps gateway both render, who sees which items, the shell around the pages (the organization switcher, the
// sections, Docs and Settings, the person), each level's collapse remembered in this browser, Settings' links to the
// platform's pages, and the app-root paths the gateway links to, which lead to the person's page in the company.

const PORTFOLIO = `/portfolio/${ORG_ID}`;
const DASHBOARD = `${base}/dashboard`;
const WORKSPACE_KEYS = ["dashboard", "cap-table", "compliance", "hire-and-retain", "stakeholders", "company", "certificates"];
const HOLDER_KEYS = ["portfolio", "how-to-exercise", "my-documents"];

function dashboardHandlers(): MockHandler[] {
  return [mock(api.routes.getDashboard, dashboard()), mock(api.routes.listValuations, { items: VALUATIONS })];
}

function portalHandlers(holdings: readonly api.PortalHolding[] = [NADIA]): MockHandler[] {
  return [
    mock(api.routes.getPortalOverview, overview(holdings)),
    mock(api.routes.getHowToExercise, howToExercise()),
    mock(api.routes.listPortalDocuments, COMPANY_RESOURCES),
  ];
}

/** The whole app at `path` as `session`, optionally served by Insulin Apps with `account` at /__insulin/me. */
function renderAt(path: string, session: Me, handlers: MockHandler[] = [], account?: PlatformAccountFixture) {
  const mocks = mockApi([mock(api.routes.getMe, session), ...handlers]);
  const platform = account ? mockPlatform(account) : { requests: [] };
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<AuthProvider><RouterProvider router={router} /></AuthProvider>);
  return { router, platformRequests: platform.requests, ...mocks };
}

const primary = () => screen.getByRole("navigation", { name: "Primary" });
const primaryLinks = () => within(primary()).getAllByRole("link").map((link) => link.textContent);
const shell = () => document.querySelector<HTMLElement>("[data-insulin-shell]")!;

describe("the navigation manifest", () => {
  it("is valid: at most 12 items and 12 children, known icons, unique keys, app paths, labels of at most 40 characters", () => {
    const parsed = navigationSchema.safeParse(packageJson.insulin.navigation);
    expect(parsed.success).toBe(true);
    expect(NAVIGATION.length).toBeLessThanOrEqual(12);
    const links = NAVIGATION.flatMap((item) => [item, ...(item.children ?? [])]);
    for (const item of NAVIGATION) expect((item.children ?? []).length).toBeLessThanOrEqual(12);
    expect(new Set(links.map((link) => link.key)).size).toBe(links.length);
    for (const link of links) {
      expect(link.key).toMatch(/^[a-z0-9-]+$/);
      expect(NAV_ICONS).toContain(link.icon);
      expect(link.label.length).toBeGreaterThan(0);
      expect(link.label.length).toBeLessThanOrEqual(40);
      expect(link.path).toMatch(/^\/(?!__insulin|settings|mcp|\.well-known)/);
    }
  });

  it("lists the workspace's sections for editors and up, then the holder's own items for viewers", () => {
    expect(NAVIGATION.map((item) => item.key)).toEqual([...WORKSPACE_KEYS, ...HOLDER_KEYS]);
    for (const item of NAVIGATION) expect(item.role).toBe(HOLDER_KEYS.includes(item.key) ? "VIEWER" : "EDITOR");
    // Only Viewers hold equity here: editors and admins never get holdings (see resolveAccess on the server).
    for (const item of NAVIGATION) expect(item.maxRole).toBe(HOLDER_KEYS.includes(item.key) ? "VIEWER" : undefined);
    // Every item names its group: the gateway shows a heading only over items that carry one.
    for (const item of NAVIGATION) expect(item.group).toBe(HOLDER_KEYS.includes(item.key) ? "My equity" : "Essentials");
    expect(NAVIGATION.find((item) => item.key === "cap-table")!.children!.map((child) => child.label)).toEqual(["Cap Table", "Share Classes", "Equity Plans", "Securities Status", "Vesting"]);
  });

  it("leads every path to a page of the app, in the company or in the portfolio", () => {
    for (const path of navigationPaths()) {
      const resolved = resolveNavPath(path, ORG_ID);
      expect(resolved.startsWith(isPortfolioPath(path) ? PORTFOLIO : base)).toBe(true);
      const matched = matchRoutes(routes, resolved);
      expect(matched?.at(-1)?.route.path, `${path} → ${resolved}`).not.toBe("*");
      expect(appRootPath(resolved, ORG_ID)).toBe(path);
    }
  });

  it("has an icon of Cap Table's own for every icon name the gateway bundles", () => {
    for (const name of NAV_ICONS) {
      const { container, unmount } = render(<Icon name={NAV_ICON[name]} />);
      expect(container.querySelector("svg")?.childElementCount, name).toBeGreaterThan(0);
      unmount();
    }
  });

  it.each<[string, (items: NavItem[]) => unknown]>([
    ["a gateway path", (items) => [{ ...items[0], path: "/settings/users" }]],
    ["the gateway's own endpoints", (items) => [{ ...items[0], path: "/__insulin/me" }]],
    ["the MCP server", (items) => [{ ...items[0], path: "/mcp" }]],
    ["OAuth metadata", (items) => [{ ...items[0], path: "/.well-known/oauth-protected-resource" }]],
    ["a path on another host", (items) => [{ ...items[0], path: "//elsewhere.example/" }]],
    ["a key with capitals", (items) => [{ ...items[0], key: "Dashboard" }]],
    ["an icon the gateway doesn't bundle", (items) => [{ ...items[0], icon: "rocket" }]],
    ["a label over 40 characters", (items) => [{ ...items[0], label: "x".repeat(41) }]],
    ["a blank label", (items) => [{ ...items[0], label: "  " }]],
    ["a role that isn't an app role", (items) => [{ ...items[0], role: "OWNER" }]],
    ["a field the manifest doesn't have", (items) => [{ ...items[0], badge: "new" }]],
    ["a third level", (items) => [{ ...items[1], children: [{ ...items[1]!.children![0], children: [] }] }]],
    ["a key used twice", (items) => [items[0], { ...items[2], key: items[0]!.key }]],
    ["more than 12 items", (items) => Array.from({ length: 13 }, (_, index) => ({ ...items[0], key: `item-${index}` }))],
    ["more than 12 children", (items) => [{ ...items[1], children: Array.from({ length: 13 }, (_, index) => ({ ...items[1]!.children![0], key: `child-${index}` })) }]],
  ])("refuses %s", (_name, make) => {
    expect(navigationSchema.safeParse(make(structuredClone([...NAVIGATION]))).success).toBe(false);
  });
});

describe("who sees which items", () => {
  it("takes the person's role, lowered by what their permissions leave them", () => {
    expect(navigationRole({ consoleRole: "OWNER", access: "admin_rw" })).toBe("ADMIN");
    expect(navigationRole({ consoleRole: "ADMIN", access: "admin_rw" })).toBe("ADMIN");
    expect(navigationRole({ consoleRole: "EDITOR", access: "admin_rw" })).toBe("EDITOR");
    expect(navigationRole({ consoleRole: "ADMIN", access: "admin_ro" })).toBe("EDITOR");
    // A custom role that only sees its own holdings is a Viewer here, whatever its base role.
    expect(navigationRole({ consoleRole: "EDITOR", access: "holder" })).toBe("VIEWER");
    expect(navigationRole({ consoleRole: "VIEWER", access: "holder" })).toBe("VIEWER");
    expect(navigationRole({ consoleRole: "USER", access: "none" })).toBe("VIEWER");
  });

  it("shows the workspace's sections to editors and admins who have it, and the holder's items to whoever holds equity", () => {
    const keys = (items: NavItem[]) => items.map((item) => item.key);
    expect(keys(navigationFor(NAVIGATION, "ADMIN", { workspace: true, portfolio: false }))).toEqual(WORKSPACE_KEYS);
    // A holder's own pages are for Viewers only (maxRole), so an editor or admin never sees them, whatever the data says.
    expect(keys(navigationFor(NAVIGATION, "ADMIN", { workspace: true, portfolio: true }))).toEqual(WORKSPACE_KEYS);
    expect(keys(navigationFor(NAVIGATION, "EDITOR", { workspace: true, portfolio: true }))).toEqual(WORKSPACE_KEYS);
    expect(keys(navigationFor(NAVIGATION, "VIEWER", { workspace: false, portfolio: true }))).toEqual(HOLDER_KEYS);
    // The role decides even where the data would allow more, and nothing is left before setup.
    expect(keys(navigationFor(NAVIGATION, "VIEWER", { workspace: true, portfolio: false }))).toEqual([]);
    expect(keys(navigationFor(NAVIGATION, "ADMIN", { workspace: false, portfolio: false }))).toEqual([]);
  });

  it("filters level 2 by each item's own role, and hides an item's children with it", () => {
    const items: NavItem[] = [
      { key: "reports", label: "Reports", icon: "file-text", path: "/reports", children: [
        { key: "summary", label: "Summary", icon: "list", path: "/reports/summary" },
        { key: "audit", label: "Audit", icon: "shield", path: "/reports/audit", role: "ADMIN" },
      ] },
      { key: "admin-only", label: "Admin only", icon: "key", path: "/admin-only", role: "ADMIN", children: [{ key: "inner", label: "Inner", icon: "key", path: "/admin-only/inner" }] },
    ];
    const editor = navigationFor(items, "EDITOR", { workspace: true, portfolio: false });
    expect(editor.map((item) => item.key)).toEqual(["reports"]);
    expect(editor[0]!.children!.map((child) => child.key)).toEqual(["summary"]);
    expect(navigationFor(items, "ADMIN", { workspace: true, portfolio: false })[0]!.children!.map((child) => child.key)).toEqual(["summary", "audit"]);
  });

  it("puts consecutive items with the same group under one heading, as the gateway does", () => {
    const heads = (items: readonly NavLink[]) => groupNavigation(items).map((group) => [group.heading, group.items.map((item) => item.key)]);
    expect(heads(navigationFor(NAVIGATION, "VIEWER", { workspace: false, portfolio: true }))).toEqual([["My equity", HOLDER_KEYS]]);
    const workspace = navigationFor(NAVIGATION, "EDITOR", { workspace: true, portfolio: true });
    expect(heads(workspace)).toEqual([["Essentials", WORKSPACE_KEYS]]);
    expect(heads(workspace.filter((item) => item.key !== "dashboard"))).toEqual([["Essentials", WORKSPACE_KEYS.slice(1)]]);
    // An item without a group has no heading, and a group that comes back after another starts a new heading.
    const link = (key: string, group?: string): NavLink => ({ key, label: key, icon: "list", path: `/${key}`, ...(group ? { group } : {}) });
    expect(heads([link("a"), link("b", "One"), link("c", "One"), link("d"), link("e", "One")]))
      .toEqual([[null, ["a"]], ["One", ["b", "c"]], [null, ["d"]], ["One", ["e"]]]);
  });
});

describe("where a page sits in the navigation", () => {
  // Every item, whoever sees it: where a page sits doesn't depend on the role.
  const items = NAVIGATION;
  const at = (root: string, preferred: string | null = null) => {
    const found = matchNavigation(items, root, preferred);
    return found ? [found.section.key, found.child?.key ?? null] : null;
  };

  it("finds the section and item, the longest path winning", () => {
    expect(at("/dashboard")).toEqual(["dashboard", null]);
    expect(at("/captable")).toEqual(["cap-table", "cap-table-view"]);
    expect(at("/share-classes/abc")).toEqual(["cap-table", "share-classes"]);
    expect(at("/certificates/legends")).toEqual(["certificates", "legends"]);
    expect(at("/certificates")).toEqual(["certificates", "certificate-list"]);
    expect(at("/compliance/409a/new")).toEqual(["compliance", null]);
    expect(at("/stakeholders/abc/preview/documents")).toEqual(["stakeholders", null]);
    expect(at("/portfolio")).toEqual(["portfolio", null]);
    expect(at("/portfolio/securities/abc")).toEqual(["portfolio", null]);
    expect(at("/portfolio/how-to-exercise")).toEqual(["how-to-exercise", null]);
  });

  it("puts pages that only belong to a section in it, without marking an item, and others nowhere", () => {
    expect(at("/securities/abc")).toEqual(["cap-table", null]);
    expect(at("/convertibles/abc")).toEqual(["cap-table", null]);
    expect(at("/issue/options")).toEqual(["cap-table", null]);
    expect(at("/expiry-runs")).toEqual(["cap-table", null]);
    expect(at("/import")).toBeNull();
    expect(at("/docs/glossary")).toBeNull();
  });

  it("keeps a page that two sections list in the one chosen last", () => {
    expect(at("/equity-plans")).toEqual(["cap-table", "equity-plans"]);
    expect(at("/equity-plans/abc", "hire-and-retain")).toEqual(["hire-and-retain", "hire-equity-plans"]);
    expect(at("/vesting", "hire-and-retain")).toEqual(["cap-table", "vesting"]);
  });

  it("turns app-root paths into the company's and the portfolio's, and back", () => {
    expect(resolveNavPath("/vesting", ORG_ID)).toBe(`${base}/vesting`);
    expect(resolveNavPath("/compliance/409a?tab=history#latest", ORG_ID)).toBe(`${base}/compliance/409a?tab=history#latest`);
    expect(resolveNavPath("/portfolio", ORG_ID)).toBe(PORTFOLIO);
    expect(resolveNavPath("/portfolio/documents", ORG_ID)).toBe(`${PORTFOLIO}/documents`);
    expect(appRootPath(`${base}/share-classes/abc`, ORG_ID)).toBe("/share-classes/abc");
    expect(appRootPath(`${PORTFOLIO}/documents`, ORG_ID)).toBe("/portfolio/documents");
    expect(appRootPath("/companies/another-company/dashboard", ORG_ID)).toBeNull();
    expect(appRootPath("/docs", ORG_ID)).toBeNull();
  });
});

describe("the shell", () => {
  it("marks its root for the account bar, which then stays out of the way", async () => {
    renderPage("dashboard", dashboardHandlers());
    await screen.findByRole("navigation", { name: "Primary" });
    expect(shell().hasAttribute("data-insulin-shell")).toBe(true);
    expect(shell().dataset.l1).toBe("expanded");
  });

  it("gives an owner the switcher, every section, + New, Docs, Settings and the person, with the platform's account", async () => {
    renderPage("dashboard", dashboardHandlers(), { platform: platformAccount() });
    const switcher = await screen.findByRole("button", { name: /Organization: Acme Robotics/ });
    expect(primaryLinks()).toEqual(["Dashboard", "Cap Table", "Compliance & Tax", "Hire and Retain", "Stakeholders", "Company", "Certificates", "Docs"]);
    expect(within(primary()).getByText("Essentials")).toBeTruthy();
    expect(within(primary()).queryByText("My equity")).toBeNull();
    expect(within(primary()).getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "New" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rachel Ostrowski/ }).textContent).toContain("RORachel OstrowskiOwner");
    expect(switcher.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(switcher.getAttribute("aria-controls")!)).toBeTruthy();
  });

  it("gives an editor the same sections and + New", async () => {
    renderPage("dashboard", dashboardHandlers(), { role: "editor" });
    await screen.findByRole("navigation", { name: "Primary" });
    expect(primaryLinks()).toEqual(["Dashboard", "Cap Table", "Compliance & Tax", "Hire and Retain", "Stakeholders", "Company", "Certificates", "Docs"]);
    expect(await screen.findByRole("button", { name: "New" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Elena Park/ }).textContent).toContain("Editor");
  });

  it("gives a custom role that only views the cap table the sections, without + New", async () => {
    renderPage("dashboard", dashboardHandlers(), { role: "admin_ro" });
    await screen.findByRole("heading", { name: "Acme Robotics, Inc." });
    expect(primaryLinks()).toContain("Certificates");
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  });

  it.each(["VIEWER", "USER"] as const)("gives a %s who holds equity only their own items, Docs and Settings", async (consoleRole) => {
    renderAt(PORTFOLIO, holderMe([NADIA], { consoleRole }), portalHandlers());
    await screen.findByRole("navigation", { name: "Primary" });
    expect(primaryLinks()).toEqual(["Portfolio", "How to exercise", "Documents", "Docs"]);
    expect(within(primary()).getByText("My equity")).toBeTruthy();
    expect(within(primary()).getByRole("link", { name: "How to exercise" }).getAttribute("href")).toBe(`${PORTFOLIO}/how-to-exercise`);
    expect(within(primary()).getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Section" })).toBeNull();
  });

  it("shows the preview strip once, at the top of the page's column beside the navigation, and above setup", async () => {
    renderPage("dashboard", dashboardHandlers(), { preview: true });
    const strip = await screen.findByText("Preview mode.");
    expect(screen.getAllByText("Preview mode.")).toHaveLength(1);
    expect(strip.closest(".content")?.firstElementChild?.contains(strip)).toBe(true);
    cleanup();
    renderAt("/setup", me("owner", { company: null, preview: true }));
    const above = await screen.findByText("Preview mode.");
    expect(screen.getAllByText("Preview mode.")).toHaveLength(1);
    expect(above.closest("[data-insulin-shell]")).toBeNull();
  });

  it("shows the page's breadcrumb in the header above it", async () => {
    renderPage("reports", []);
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Acme RoboticsCompanyReports");
    expect(crumbs.closest("header.shell-header")).toBeTruthy();
    expect(document.getElementById("main")!.contains(crumbs)).toBe(false);
  });
});

describe("the organization switcher", () => {
  it("names the company, with nothing to switch, without Insulin Apps around the app", async () => {
    const { calls } = renderPage("dashboard", dashboardHandlers());
    await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() => expect(calls.some((call) => call.url.pathname === "/__insulin/me")).toBe(true));
    expect(document.querySelector(".org-switcher")?.textContent).toBe("Acme RoboticsCap Table");
    expect(screen.queryByRole("button", { name: /Organization:/ })).toBeNull();
  });

  it("lists the person's organizations, All apps and the link to create one, and switches through the gateway", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => {});
    const { platformRequests } = renderPage("dashboard", dashboardHandlers(), { platform: platformAccount() });
    const switcher = await screen.findByRole("button", { name: /Organization: Acme Robotics/ });
    fireEvent.click(switcher);
    expect(switcher.getAttribute("aria-expanded")).toBe("true");
    const menu = document.getElementById("insulin-org-menu")!;
    expect(within(menu).getByRole("button", { name: /Acme Robotics/ }).getAttribute("aria-current")).toBe("true");
    expect(within(menu).getByRole("link", { name: "All apps" }).getAttribute("href")).toBe(`${APEX}/`);
    expect(within(menu).getByRole("link", { name: "Create organization" }).getAttribute("href")).toBe(`${APEX}/orgs/new`);
    fireEvent.click(within(menu).getByRole("button", { name: /Nimbus Ledger Labs/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    const sent = platformRequests.find((request) => request.path === "/__insulin/switch-org")!;
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(sent.body!)).toEqual({ orgId: "org-nimbus" });
  });

  it("says so when the switch fails, and stays", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => {});
    renderPage("dashboard", dashboardHandlers(), { platform: platformAccount(), platformOptions: { switchOrg: () => new Response("{}", { status: 404 }) } });
    fireEvent.click(await screen.findByRole("button", { name: /Organization: Acme Robotics/ }));
    fireEvent.click(screen.getByRole("button", { name: /Nimbus Ledger Labs/ }));
    expect(await screen.findByText("Couldn’t switch organization. Please try again.")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("closes on Escape, giving the focus back to its button", async () => {
    renderPage("dashboard", dashboardHandlers(), { platform: platformAccount() });
    const switcher = await screen.findByRole("button", { name: /Organization: Acme Robotics/ });
    fireEvent.click(switcher);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(switcher.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(switcher);
  });
});

describe("the person", () => {
  it("offers Account and Sign out on Insulin Apps, and signs out through the gateway", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => {});
    const { platformRequests } = renderPage("dashboard", dashboardHandlers(), { platform: platformAccount() });
    await screen.findByRole("button", { name: /Organization: Acme Robotics/ });
    fireEvent.click(screen.getByRole("button", { name: /Rachel Ostrowski/ }));
    const menu = document.getElementById("insulin-person-menu")!;
    expect(within(menu).getByText("rachel@acmerobotics.example")).toBeTruthy();
    expect(within(menu).getByRole("link", { name: "Account" }).getAttribute("href")).toBe(`${APEX}/account`);
    fireEvent.click(within(menu).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`${APEX}/`));
    const sent = platformRequests.find((request) => request.path === "/__insulin/logout")!;
    expect(sent.method).toBe("POST");
  });

  it("refuses to follow a sign-out answer to anything but a web address", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => {});
    const logout = () => new Response(JSON.stringify({ ok: true, next: "javascript:alert(1)" }), { headers: { "Content-Type": "application/json" } });
    renderPage("dashboard", dashboardHandlers(), { platform: platformAccount(), platformOptions: { logout } });
    await screen.findByRole("button", { name: /Organization: Acme Robotics/ });
    fireEvent.click(screen.getByRole("button", { name: /Rachel Ostrowski/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("switches the theme", async () => {
    renderPage("dashboard", dashboardHandlers());
    fireEvent.click(await screen.findByRole("button", { name: /Rachel Ostrowski/ }));
    const before = document.documentElement.dataset.theme;
    fireEvent.click(screen.getByRole("button", { name: "Switch theme" }));
    expect(document.documentElement.dataset.theme).not.toBe(before);
    delete document.documentElement.dataset.theme;
  });
});

describe("Settings", () => {
  async function openSettings() {
    const settings = within(await screen.findByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Settings" });
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(settings);
    expect(settings.getAttribute("aria-expanded")).toBe("true");
    expect(settings.getAttribute("aria-controls")).toBe("insulin-nav-section");
    return screen.getByRole("navigation", { name: "Section" });
  }

  it("links People, Integrations, API access and Connect AI to the app's pages on Insulin Apps", async () => {
    renderPage("share-classes", [], { platform: platformAccount() });
    await screen.findByRole("button", { name: /Organization: Acme Robotics/ });
    const section = await openSettings();
    expect(document.getElementById("insulin-nav-section")?.textContent).toContain("Settings");
    expect(within(section).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["People", `${APEX}/apps/captable/settings/users`],
      ["Integrations", `${APEX}/apps/captable/settings/integrations`],
      // The gateway gives no API access link: it is the same page on the apex.
      ["API access", `${APEX}/apps/captable/settings/api`],
      ["Connect AI", `${APEX}/apps/captable/settings/connect-ai`],
    ]);
  });

  it("closes when another page opens, giving the section's items back", async () => {
    const { router } = renderPage("share-classes", [], { platform: platformAccount() });
    await screen.findByRole("button", { name: /Organization: Acme Robotics/ });
    await openSettings();
    fireEvent.click(within(primary()).getByRole("link", { name: "Stakeholders" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/stakeholders`));
    expect(within(primary()).getByRole("button", { name: "Settings" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("navigation", { name: "Section" })).toBeNull();
  });

  it("is there for a holder too", async () => {
    renderAt(PORTFOLIO, holderMe([NADIA]), portalHandlers(), platformAccount({ links: { ...platformAccount().links, members: `${APEX}/apps/captable/settings/users` } }));
    await screen.findByRole("button", { name: /Organization: Acme Robotics/ });
    const section = await openSettings();
    expect(within(section).getAllByRole("link")).toHaveLength(4);
  });

  it("says where these pages are when the app runs without Insulin Apps around it", async () => {
    const { calls } = renderPage("dashboard", dashboardHandlers());
    await waitFor(() => expect(calls.some((call) => call.url.pathname === "/__insulin/me")).toBe(true));
    const section = await openSettings();
    expect(within(section).queryAllByRole("link")).toEqual([]);
    expect(within(section).getByText("People").closest("[aria-disabled='true']")).toBeTruthy();
    expect(within(section).getByText(/managed on Insulin Apps \(insulinapps\.com\)/)).toBeTruthy();
  });

  it("uses the gateway's links, and the app's own people page over the organization's", () => {
    const given = platformAccount({
      links: {
        ...platformAccount().links,
        members: `${APEX}/settings/users?org=org-acme`,
        api: `${APEX}/apps/captable/settings/api`,
        integrations: "javascript:alert(1)",
      },
    });
    expect(settingsLinks(given).map((link) => link.href)).toEqual([
      `${APEX}/apps/captable/settings/users`,
      `${APEX}/apps/captable/settings/integrations`,
      `${APEX}/apps/captable/settings/api`,
      `${APEX}/apps/captable/settings/connect-ai`,
    ]);
    expect(settingsLinks(null).map((link) => link.href)).toEqual([null, null, null, null]);
  });

  it("prefers the settings pages and the apex the gateway names, as Esign does", () => {
    const other = "http://localhost:9090";
    const named = platformAccount({
      apex: other,
      settings: { users: `${other}/apps/captable/settings/users`, integrations: null, api: `${other}/apps/captable/settings/api` },
      links: { account: `${APEX}/account`, apps: `${APEX}/` },
    });
    expect(settingsLinks(named).map((link) => link.href)).toEqual([
      `${other}/apps/captable/settings/users`,
      `${other}/apps/captable/settings/integrations`,
      `${other}/apps/captable/settings/api`,
      `${other}/apps/captable/settings/connect-ai`,
    ]);
    // Only the origin of the apps link, with no settings at all: the pages on that origin.
    expect(settingsLinks(platformAccount({ links: { apps: `${APEX}/` } })).map((link) => link.href)).toEqual([
      `${APEX}/apps/captable/settings/users`,
      `${APEX}/apps/captable/settings/integrations`,
      `${APEX}/apps/captable/settings/api`,
      `${APEX}/apps/captable/settings/connect-ai`,
    ]);
  });
});

describe("collapsing each level", () => {
  it("collapses level 1 to its icons with the labels as tooltips, and remembers it in this browser", async () => {
    renderPage("share-classes", []);
    await screen.findByRole("navigation", { name: "Primary" });
    const toggle = screen.getByRole("button", { name: "Collapse navigation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("insulin-nav-primary");
    expect(document.getElementById("insulin-nav-primary")).toBeTruthy();
    fireEvent.click(toggle);
    expect(shell().dataset.l1).toBe("collapsed");
    expect(JSON.parse(window.localStorage.getItem(NAV_STORAGE_KEY)!)).toEqual({ l1: "collapsed", l2: "expanded" });
    const dashboardLink = within(primary()).getByRole("link", { name: "Dashboard" });
    expect(dashboardLink.getAttribute("title")).toBe("Dashboard");
    expect(within(primary()).getByRole("button", { name: "Settings" }).getAttribute("title")).toBe("Settings");
    // The switcher shows the organization's initial; the person their initials.
    expect(document.querySelector(".org-switcher .org-initial")?.textContent).toBe("A");
    expect(screen.getByRole("button", { name: "Rachel Ostrowski, Owner" }).getAttribute("title")).toBe("Rachel Ostrowski");
    expect(screen.getByRole("button", { name: "Expand navigation" }).getAttribute("aria-expanded")).toBe("false");

    cleanup();
    renderPage("share-classes", []);
    await screen.findByRole("navigation", { name: "Primary" });
    expect(shell().dataset.l1).toBe("collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
    expect(shell().dataset.l1).toBe("expanded");
    expect(within(primary()).getByRole("link", { name: "Dashboard" }).hasAttribute("title")).toBe(false);
    expect(readNavCollapse()).toEqual({ l1: "expanded", l2: "expanded" });
  });

  it("collapses level 2 on its own", async () => {
    renderPage("share-classes", []);
    const section = await screen.findByRole("navigation", { name: "Section" });
    const toggle = screen.getByRole("button", { name: "Collapse Cap Table" });
    expect(toggle.getAttribute("aria-controls")).toBe("insulin-nav-section");
    fireEvent.click(toggle);
    expect(shell().dataset.l2).toBe("collapsed");
    expect(shell().dataset.l1).toBe("expanded");
    expect(within(section).getByRole("link", { name: "Vesting" }).getAttribute("title")).toBe("Vesting");
    expect(JSON.parse(window.localStorage.getItem(NAV_STORAGE_KEY)!)).toEqual({ l1: "expanded", l2: "collapsed" });
    expect(screen.getByRole("button", { name: "Expand Cap Table" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("reads only what it wrote, and keeps working when the browser stores nothing", async () => {
    window.localStorage.setItem(NAV_STORAGE_KEY, "{not json");
    expect(readNavCollapse()).toEqual({ l1: "expanded", l2: "expanded" });
    window.localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ l1: "collapsed", l2: "sideways" }));
    expect(readNavCollapse()).toEqual({ l1: "collapsed", l2: "expanded" });
    window.localStorage.clear();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    renderPage("dashboard", dashboardHandlers());
    fireEvent.click(await screen.findByRole("button", { name: "Collapse navigation" }));
    expect(shell().dataset.l1).toBe("collapsed");
  });
});

describe("narrow screens", () => {
  it("opens both levels from the menu button, and closes them on Escape or when a page opens", async () => {
    const { router } = renderPage("share-classes", []);
    const button = await screen.findByRole("button", { name: "Open navigation" });
    expect(button.getAttribute("aria-controls")).toBe("insulin-nav");
    expect(document.getElementById("insulin-nav")?.contains(screen.getByRole("navigation", { name: "Section" }))).toBe(true);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(shell().dataset.menu).toBe("open");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(shell().dataset.menu).toBe("closed");
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Section" })).getByRole("link", { name: "Vesting" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/vesting`));
    expect(shell().dataset.menu).toBe("closed");
  });
});

describe("the navigation's app-root paths", () => {
  it.each(navigationPaths().filter((path) => !isPortfolioPath(path)))("send an admin from %s to the company's page", async (path) => {
    const { router } = renderAt(path, me("owner"));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}${path}`));
  });

  it("keep the query and the section of the page", async () => {
    const { router } = renderAt("/compliance/409a?tab=history#latest", me("admin_ro"));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${base}/compliance/409a`));
    expect(router.state.location.search).toBe("?tab=history");
    expect(router.state.location.hash).toBe("#latest");
  });

  it.each([["/portfolio", PORTFOLIO], ["/portfolio/how-to-exercise", `${PORTFOLIO}/how-to-exercise`], ["/portfolio/documents", `${PORTFOLIO}/documents`]])(
    "send a holder from %s to their own page",
    async (path, target) => {
      const { router } = renderAt(path, holderMe([NADIA]), portalHandlers());
      await waitFor(() => expect(router.state.location.pathname).toBe(target));
    },
  );

  it("send an admin who also holds equity to their portfolio, and one who doesn't home", async () => {
    const holderAdmin = renderAt("/portfolio/documents", holderMe([DANIEL], { email: "daniel@acmerobotics.example", access: "admin_rw" }), portalHandlers([DANIEL]));
    await waitFor(() => expect(holderAdmin.router.state.location.pathname).toBe(`${PORTFOLIO}/documents`));
    cleanup();
    const admin = renderAt("/portfolio/documents", me("admin_rw"), dashboardHandlers());
    await waitFor(() => expect(admin.router.state.location.pathname).toBe(DASHBOARD));
  });

  it("send a holder who opens a company section home, which is their portfolio", async () => {
    const { router, callsTo } = renderAt("/vesting", holderMe([NADIA]), portalHandlers());
    await waitFor(() => expect(router.state.location.pathname).toBe(PORTFOLIO));
    expect(callsTo(api.routes.getOrg)).toHaveLength(0);
  });

  it("send everyone to setup before the company exists", async () => {
    const { router } = renderAt("/dashboard", me("owner", { company: null }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
  });

  it("send someone with no access to the no-access page", async () => {
    const { router } = renderAt("/portfolio", holderMe([], { email: "visitor@example.test", name: "Visitor" }), [mock(api.routes.getPortalOverview, () => apiError(404, "not_found", "Nothing"))]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/no-access"));
  });
});
