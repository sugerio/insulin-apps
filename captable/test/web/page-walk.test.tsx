import "./setup.ts";
import { act, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { api } from "#shared";
import { AuthProvider } from "../../src/app/auth/AuthProvider.tsx";
import { routes } from "../../src/app/router.tsx";
import { IDS, uuid } from "./support/acme.ts";
import { allRoutes, REQUEST_ID } from "./support/allRoutes.ts";
import { NADIA_OPTION } from "./support/portal.ts";
import { apiError, mock, mockApi, type MockHandler, type MockRequest } from "./support/mockApi.ts";
import { base } from "./support/render.tsx";

// The page walk: every admin page is rendered complete, then once per route it calls with that route
// never answering and once with it failing. Each time the page must say so (a loading or an error state), and every
// figure it still shows must be one the complete page shows too: nothing is computed from a missing answer — no zero,
// no partial sum, no default precision or time zone. Loading and error messages themselves carry no figures.

const PAGES: readonly [name: string, path: string][] = [
  ["dashboard", "dashboard"],
  ["cap table", "captable"],
  ["cap table options", "captable?tab=options"],
  ["cap table SAFEs", "captable?tab=safes"],
  ["share classes", "share-classes"],
  ["share class", `share-classes/${IDS.common}`],
  ["equity plans", "equity-plans"],
  ["equity plan", `equity-plans/${IDS.plan}`],
  ["securities status", "securities-status"],
  ["vesting", "vesting"],
  ["vesting schedule", `vesting/schedules/${IDS.vs1}`],
  ["stakeholders", "stakeholders"],
  ["stakeholder with a scheduled termination", `stakeholders/${IDS.mateo}`],
  ["option", `securities/${IDS.opt1}`],
  ["share", `securities/${IDS.cs1}`],
  ["warrant", `securities/${IDS.war1}`],
  ["SAFE", `convertibles/${IDS.safe1}`],
  ["exercises", "exercise-requests"],
  ["migrated exercise requests", "exercise-requests?tab=requests"],
  ["exercise request", `exercise-requests/${REQUEST_ID}`],
  ["409A valuations", "compliance/409a"],
  ["409A valuation", `compliance/409a/${IDS.v5}`],
  ["certificates", "certificates"],
  ["legends", "certificates/legends"],
  ["certificate terms", "certificates/terms"],
  ["company", "company"],
  ["documents", "documents"],
  ["document", `documents/${uuid(10, 4)}`],
  ["stakeholder portal settings", "stakeholder-portal"],
  ["expiry runs", "expiry-runs"],
  ["activity", "activity"],
  ["preview as stakeholder", `stakeholders/${IDS.nadia}/preview`],
  ["preview of a holding", `stakeholders/${IDS.nadia}/preview/securities/${NADIA_OPTION.id}`],
  ["preview of How to exercise", `stakeholders/${IDS.nadia}/preview/how-to-exercise`],
  ["preview of documents", `stakeholders/${IDS.nadia}/preview/documents`],
];

/** The figures a page shows: numbers outside loading and error messages, with IDs and product names ("409A") removed. */
function figures(): string[] {
  const main = document.getElementById("main");
  if (!main) return [];
  const clone = main.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[role="alert"], [role="status"]').forEach((node) => node.remove());
  // Text node by text node, so figures in neighbouring cells never run together.
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node.textContent ?? "");
  return texts.flatMap((text) => text
    .replace(/\b[A-Z][A-Z0-9]{0,5}-\d+\b/g, " ")
    .replace(/409A|83\(b\)|Rule 701|Form 3921|W-2|1099-NEC/g, " ")
    .match(/(?<![\p{L}\d])\$?\d[\d,]*(?:\.\d+)?%?(?![\p{L}\d])/gu) ?? []);
}

/** The figures of `partial` that the complete page doesn't show (as many times). */
function invented(complete: readonly string[], partial: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const figure of complete) counts.set(figure, (counts.get(figure) ?? 0) + 1);
  return partial.filter((figure) => {
    const left = counts.get(figure) ?? 0;
    if (left === 0) return true;
    counts.set(figure, left - 1);
    return false;
  });
}

/** Waits until no request is added for a while (each answered one may start another). */
async function settle(calls: () => number) {
  let last = -1;
  let quiet = 0;
  while (quiet < 3) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const now = calls();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
}

function show(path: string, handlers: readonly MockHandler[]) {
  const mocks = mockApi(handlers);
  const router = createMemoryRouter(routes, { initialEntries: [`${base}/${path}`] });
  const view = render(<AuthProvider><RouterProvider router={router} /></AuthProvider>);
  return { ...mocks, unmount: view.unmount };
}

const never = () => new Promise<never>(() => {});
const failing = () => apiError(500, "internal", "The read model is rebuilding.");

/** The handlers, each noting when it answers a request (so a route is walked only if the page really calls it). */
function tracked(handlers: readonly MockHandler[], served: Set<api.AnyRoute>): MockHandler[] {
  return handlers.map((handler) => ({
    route: handler.route,
    respond: (request: MockRequest) => {
      served.add(handler.route);
      return typeof handler.respond === "function" ? (handler.respond as (request: MockRequest) => unknown)(request) : handler.respond;
    },
  }));
}

describe("every admin page with a missing dependency", () => {
  it.each(PAGES)("%s never shows a figure computed from a missing answer", async (_name, path) => {
    const handlers = allRoutes();
    const served = new Set<api.AnyRoute>();
    const complete = show(path, tracked(handlers, served));
    await settle(() => complete.calls.length);
    await waitFor(() => expect(document.querySelectorAll('#main [role="status"]')).toHaveLength(0));
    const full = figures();
    const used = handlers.map((handler) => handler.route).filter((route) => route !== api.routes.getMe && served.has(route));
    expect(used.length, "the page calls the API").toBeGreaterThan(1);
    complete.unmount();

    for (const route of used) {
      for (const [mode, respond] of [["never answers", never], ["fails", failing]] as const) {
        const partial = show(path, handlers.map((handler) => (handler.route === route ? mock(route, respond) : handler)));
        await settle(() => partial.calls.length);
        const indicator = document.querySelectorAll(`#main [role="${mode === "fails" ? "alert" : "status"}"]`);
        expect(indicator.length, `${route.id} ${mode}: the page says so`).toBeGreaterThan(0);
        expect(invented(full, figures()), `${route.id} ${mode}: figures the complete page doesn't show`).toEqual([]);
        partial.unmount();
      }
    }
  }, 120_000);
});

describe("plain-language admin copy", () => {
  it.each(PAGES)("%s shows no raw codes", async (_name, path) => {
    const page = show(path, allRoutes());
    await settle(() => page.calls.length);
    await waitFor(() => expect(document.querySelectorAll('#main [role="status"]')).toHaveLength(0));
    // Codes such as TX_STOCK_ISSUANCE or SECURITY_NOT_OUTSTANDING are the API's: the page says what they mean.
    expect(document.getElementById("main")?.textContent ?? "").not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
    page.unmount();
  }, 30_000);
});
