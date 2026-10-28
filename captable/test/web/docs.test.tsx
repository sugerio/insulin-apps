import "./setup.ts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { api } from "#shared";
import { AuthProvider } from "../../src/app/auth/AuthProvider.tsx";
import { Docs } from "../../src/app/components/Docs.tsx";
import { TOPIC_SLUGS } from "../../src/app/pages/docs/parts.tsx";
import { DOC_TOPICS } from "../../src/app/pages/docs/topics.ts";
import { routes } from "../../src/app/router.tsx";
import { dashboard, me, org, ORG_ID, stakeholderList, VALUATIONS } from "./support/acme.ts";
import { mock, mockApi, type MockHandler } from "./support/mockApi.ts";
import { COMPANY_RESOURCES, NADIA, holderMe, howToExercise, overview } from "./support/portal.ts";
import { base, renderPage } from "./support/render.tsx";

type Me = api.MeResponse;

// The in-app Docs: a Docs entry at the end of every navigation (the admin workspace's sidebar, the holder's portfolio,
// and the standalone pages for someone without a company yet), one shared Docs component with its topic list and
// "On this page" links, the frame's own "not found" for a topic that doesn't exist, and static content that links only
// within the docs.

const DOCS = `${base}/docs`;
const PORTFOLIO = `/portfolio/${ORG_ID}`;

function portalHandlers(): MockHandler[] {
  return [
    mock(api.routes.getPortalOverview, overview([NADIA])),
    mock(api.routes.getHowToExercise, howToExercise()),
    mock(api.routes.listPortalDocuments, COMPANY_RESOURCES),
  ];
}

/** The whole app at `path`, as `session` (a holder, or someone without a company), with the given API answers. */
function renderAt(path: string, session: Me, handlers: MockHandler[] = []) {
  const mocks = mockApi([mock(api.routes.getMe, session), ...handlers]);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<AuthProvider><RouterProvider router={router} /></AuthProvider>);
  return { router, ...mocks };
}

function topicList(): HTMLElement {
  return screen.getByRole("navigation", { name: "Docs topics" });
}

async function title(name: string): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 1, name });
}

describe("the Docs entry", () => {
  it("is the last item of an owner's sidebar, in a section of its own, and opens the docs in the workspace", async () => {
    const { router } = renderPage("dashboard", [mock(api.routes.getDashboard, dashboard()), mock(api.routes.listValuations, { items: VALUATIONS })]);
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    const help = screen.getByRole("navigation", { name: "Help" });
    expect(within(primary).queryByRole("link", { name: "Docs" })).toBeNull();
    // After every cap-table item, not among them.
    expect(primary.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const entry = within(help).getByRole("link", { name: "Docs" });
    expect(entry.getAttribute("href")).toBe(DOCS);
    expect(entry.querySelector("svg")).toBeTruthy();
    expect(entry.getAttribute("aria-current")).toBeNull();
    fireEvent.click(entry);
    await waitFor(() => expect(router.state.location.pathname).toBe(DOCS));
    expect(await title("Getting started")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Help" })).getByRole("link", { name: "Docs" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Acme RoboticsDocsGetting started");
    expect(document.title).toBe("Getting started — Docs · Cap Table");
  });

  it("is in an editor's sidebar too", async () => {
    renderPage("stakeholders", [mock(api.routes.listStakeholders, stakeholderList())], { role: "admin_ro" });
    await screen.findByRole("navigation", { name: "Primary" });
    expect(within(screen.getByRole("navigation", { name: "Help" })).getByRole("link", { name: "Docs" }).getAttribute("href")).toBe(DOCS);
  });

  it("follows a holder's portfolio navigation and opens the docs in the portfolio, on the holders' topic", async () => {
    const { router, callsTo } = renderAt(PORTFOLIO, holderMe([NADIA]), portalHandlers());
    const portfolio = await screen.findByRole("navigation", { name: "Portfolio" });
    expect(within(portfolio).getAllByRole("link").map((link) => link.textContent)).toEqual(["Portfolio", "How to exercise", "Documents"]);
    const help = screen.getByRole("navigation", { name: "Help" });
    expect(portfolio.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const entry = within(help).getByRole("link", { name: "Docs" });
    expect(entry.getAttribute("href")).toBe(`${PORTFOLIO}/docs`);
    fireEvent.click(entry);
    await waitFor(() => expect(router.state.location.pathname).toBe(`${PORTFOLIO}/docs`));
    expect(await title("For stakeholders")).toBeTruthy();
    // Inside the holder's own frame: their breadcrumb and the company contact, never an admin route.
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Acme RoboticsDocs");
    expect(await screen.findByText("equity@acmerobotics.example")).toBeTruthy();
    expect(callsTo(api.routes.getOrg)).toHaveLength(0);
  });
});

describe("the topics", () => {
  it.each(DOC_TOPICS.map((topic) => [topic.title, topic] as const))("%s renders its title, its sections and their links", async (_name, topic) => {
    renderPage(`docs/${topic.slug}`, []);
    const heading = await title(topic.title);
    expect(heading.id).toBe("docs-title");
    const article = heading.closest("article")!;
    const contents = within(article).getByRole("navigation", { name: "On this page" });
    for (const section of topic.sections) {
      const h2 = within(article).getByRole("heading", { level: 2, name: section.title });
      expect(h2.id).toBe(section.id);
      expect(within(contents).getByRole("link", { name: section.title }).getAttribute("href")).toBe(`${DOCS}/${topic.slug}#${section.id}`);
    }
    // Headings in order: one title, then sections, then their parts.
    const levels = within(article).getAllByRole("heading").map((item) => Number(item.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    levels.forEach((level, index) => expect(level - (levels[index - 1] ?? 0)).toBeLessThanOrEqual(1));
    expect(within(topicList()).getByRole("link", { name: topic.title }).getAttribute("aria-current")).toBe("page");
    const note = within(article).queryByText("General information, not advice");
    expect(note !== null).toBe(topic.generalInformation === true);
  });

  it("puts the general-information note on the equity topics", async () => {
    renderPage("docs/equity-basics", []);
    await title("Equity basics");
    const note = screen.getByText("General information, not advice").closest(".banner") as HTMLElement;
    expect(note.getAttribute("role")).toBe("note");
    expect(note.textContent).toContain("It isn't legal, tax or financial advice.");
    expect(note.textContent).toContain("Rules differ from country to country and change over time");
    expect(note.textContent).toContain("talk to the company's counsel or a tax advisor");
  });

  it("states the facts it was written to state", async () => {
    renderPage("docs/equity-basics", []);
    const article = (await title("Equity basics")).closest("article")!;
    const text = article.textContent ?? "";
    expect(text).toContain("within 30 days after you receive the shares");
    expect(text).toContain("Options are ISOs only for shares worth up to $100,000 (valued on the grant date)");
    expect(text).toContain("within three months after employment ends");
    expect(text).toContain("alternative minimum tax (AMT)");
    expect(text).toContain("There are now 10,000,000 shares, and the founder's 2,000,000 are 20%.");
  });
});

describe("moving around the docs", () => {
  it("opens a topic from the topic list, marks it and moves the focus to its title", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { router } = renderPage("docs", []);
    expect(await title("Getting started")).toBeTruthy();
    const list = topicList();
    expect(within(list).getAllByRole("link").map((link) => link.textContent)).toEqual(DOC_TOPICS.map((topic) => topic.title));
    expect(within(list).getByRole("link", { name: "Getting started" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(list).getByRole("link", { name: "Equity basics" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${DOCS}/equity-basics`));
    const heading = await title("Equity basics");
    expect(within(topicList()).getByRole("link", { name: "Equity basics" }).getAttribute("aria-current")).toBe("page");
    expect(within(topicList()).getByRole("link", { name: "Getting started" }).getAttribute("aria-current")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading));
    // Previous and Next follow the topic list's order.
    const pager = screen.getByRole("navigation", { name: "Previous and next topics" });
    expect(within(pager).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([`${DOCS}/for-stakeholders`, `${DOCS}/glossary`]);
    fireEvent.click(within(pager).getByRole("link", { name: /Next/ }));
    expect(await title("Glossary")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it("jumps to a section from On this page and from another topic, and gives it the focus", async () => {
    const { router } = renderPage("docs/everyday-tasks", []);
    const article = (await title("Everyday tasks")).closest("article")!;
    fireEvent.click(within(within(article).getByRole("navigation", { name: "On this page" })).getByRole("link", { name: "Process due items" }));
    await waitFor(() => expect(router.state.location.hash).toBe("#due-items"));
    await waitFor(() => expect(document.activeElement?.id).toBe("due-items"));
    fireEvent.click(within(article).getByRole("link", { name: "Equity basics" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${DOCS}/equity-basics`));
    expect(router.state.location.hash).toBe("#exercise-windows");
    await waitFor(() => expect(document.activeElement?.id).toBe("exercise-windows"));
    expect(document.activeElement?.textContent).toBe("Leaving the company: exercise windows");
  });

  it("opens a deep link on its section or glossary term, and takes a malformed one as no section", async () => {
    renderPage("docs/equity-basics#safes", []);
    await title("Equity basics");
    await waitFor(() => expect(document.activeElement?.id).toBe("safes"));
    cleanup();
    renderPage("docs/glossary#cliff", []);
    await title("Glossary");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cliff"));
    cleanup();
    renderPage("docs/glossary#%E0%A4%A", []);
    expect(await title("Glossary")).toBeTruthy();
  });
});

describe("a topic that doesn't exist", () => {
  it("is the workspace's Page not found", async () => {
    renderPage("docs/settings", []);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go home" }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("navigation", { name: "Docs topics" })).toBeNull();
  });

  it("is the portfolio's own not found for a holder", async () => {
    renderAt(`${PORTFOLIO}/docs/settings`, holderMe([NADIA]), portalHandlers());
    expect(await screen.findByText("This page isn't in your portfolio.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to portfolio" }).getAttribute("href")).toBe(PORTFOLIO);
  });

  it("is Page not found on the standalone pages", async () => {
    renderAt("/docs/settings", me("owner", { company: null }));
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});

describe("the standalone docs", () => {
  it("work for an owner without a company, with the docs as the sidebar's only section and the way back to setup", async () => {
    const { router, callsTo } = renderAt("/docs", me("owner", { company: null }));
    expect(await title("Getting started")).toBeTruthy();
    expect(screen.queryByText("ESSENTIALS")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    const entry = within(screen.getByRole("navigation", { name: "Help" })).getByRole("link", { name: "Docs" });
    expect(entry.getAttribute("href")).toBe("/docs");
    expect(entry.getAttribute("aria-current")).toBe("page");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Set up your company" }).getAttribute("href")).toBe("/setup");
    fireEvent.click(within(topicList()).getByRole("link", { name: "Glossary" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/docs/glossary"));
    expect(await title("Glossary")).toBeTruthy();
    expect(callsTo(api.routes.getOrg)).toHaveLength(0);
  });

  it("lead home for someone else without a company", async () => {
    renderAt("/docs/equity-basics", { ...holderMe([]), company: null });
    expect(await title("Equity basics")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
  });

  it("send someone with a workspace or a portfolio to the docs there, section included", async () => {
    const admin = renderAt("/docs/equity-basics#vesting", me("admin_ro"), [mock(api.routes.getOrg, org())]);
    await waitFor(() => expect(admin.router.state.location.pathname).toBe(`${DOCS}/equity-basics`));
    expect(admin.router.state.location.hash).toBe("#vesting");
    expect(await title("Equity basics")).toBeTruthy();
    cleanup();
    const holder = renderAt("/docs", holderMe([NADIA]), portalHandlers());
    await waitFor(() => expect(holder.router.state.location.pathname).toBe(`${PORTFOLIO}/docs`));
    expect(await title("For stakeholders")).toBeTruthy();
  });
});

describe("the setup page", () => {
  it("links an owner setting up to the docs", async () => {
    const { router } = renderAt("/setup", me("owner", { company: null }));
    const link = await screen.findByRole("link", { name: "Learn about cap tables" });
    expect(link.getAttribute("href")).toBe("/docs");
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/docs"));
    expect(await title("Getting started")).toBeTruthy();
  });

  it("offers the docs to everyone waiting for the company to be set up", async () => {
    renderAt("/setup", { ...holderMe([]), company: null });
    expect(await screen.findByRole("heading", { name: "Cap Table isn't set up yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Learn about cap tables" }).getAttribute("href")).toBe("/docs");
  });
});

describe("the content", () => {
  it("links only within the docs, to topics and sections that exist, and opens nothing outside the app", () => {
    const ids = new Map<string, Set<string>>();
    const links: [from: string, href: string][] = [];
    for (const topic of DOC_TOPICS) {
      render(<MemoryRouter><Docs base="/docs" topic={topic} /></MemoryRouter>);
      const article = screen.getByRole("article");
      ids.set(topic.slug, new Set([...article.querySelectorAll("[id]")].map((element) => element.id)));
      for (const anchor of article.querySelectorAll("a")) {
        expect(anchor.getAttribute("target")).toBeNull();
        links.push([topic.slug, anchor.getAttribute("href") ?? ""]);
      }
      // Plain language: no codes from the API, no addresses of other sites.
      expect(article.textContent).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
      expect(article.innerHTML).not.toMatch(/https?:/);
      cleanup();
    }
    expect(links.length).toBeGreaterThan(50);
    for (const [from, href] of links) {
      const match = /^\/docs\/([a-z-]+)(?:#(.+))?$/.exec(href);
      expect(match, `${from}: ${href}`).not.toBeNull();
      const [, slug, section] = match!;
      expect(TOPIC_SLUGS as readonly string[], `${from}: ${href}`).toContain(slug);
      if (section) expect(ids.get(slug!)?.has(section), `${from}: ${href}`).toBe(true);
    }
  });

  it("gives every heading and glossary term an id of its own", () => {
    for (const topic of DOC_TOPICS) {
      render(<MemoryRouter><Docs base="/docs" topic={topic} /></MemoryRouter>);
      const found = [...screen.getByRole("article").querySelectorAll("[id]")].map((element) => element.id);
      expect(new Set(found).size, topic.slug).toBe(found.length);
      cleanup();
    }
  });
});
