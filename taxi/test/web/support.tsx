import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, onTestFinished, vi } from "vitest";
import { AuthProvider } from "../../src/app/auth/AuthProvider.tsx";
import { routes } from "../../src/app/router.tsx";
import type { AppOptions } from "../../src/app/server/app.ts";
import { ORIGIN, OWNER, identityHeaders, startServer, type Identity, type TestServer } from "../support/server.ts";

// Renders the whole app (router, auth, shell) at a path, with the browser's fetch answered by the real server and a
// fresh database in this process: what the page sends is what the API receives, with no mocked answers.

let server: TestServer | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  window.localStorage.clear();
});

export async function renderApp(path: string, options: { as?: Identity; seed?: (server: TestServer) => Promise<void>; server?: AppOptions } = {}) {
  server = await startServer({ enforceSameOrigin: false, ...options.server });
  await options.seed?.(server);
  const as = options.as ?? OWNER;
  const app = server;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(identityHeaders(as))) headers.set(name, value);
    // A file from jsdom is jsdom's own Blob, which Node's Request can't read: pass its bytes.
    const body = init.body && typeof init.body === "object" && "arrayBuffer" in init.body ? await (init.body as Blob).arrayBuffer() : (init.body ?? null);
    return app.app.fetch(new Request(url, { method: init.method ?? "GET", headers, body }), { DB: app.db });
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  return { router, server: app };
}

/**
 * Holds the page's requests that `match` before they reach the server, until released: what the page does meanwhile is
 * what a slow network shows. Call it after `renderApp`, which answers the page's requests.
 */
export function holdRequests(match: (method: string, path: string) => boolean) {
  const send = globalThis.fetch;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
    if (match(init.method ?? "GET", url.pathname)) {
      held += 1;
      await released;
    }
    return send(input, init);
  });
  return { release, held: () => held };
}

/** Answers the page's next request that `match` with a 500, as a server having trouble would; the ones after reach it. */
export function failRequestOnce(match: (method: string, path: string) => boolean) {
  const send = globalThis.fetch;
  let failed = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
    if (!failed && match(init.method ?? "GET", url.pathname)) {
      failed = true;
      return new Response(JSON.stringify({ error: { code: "internal", message: "Something went wrong" } }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    return send(input, init);
  });
  return { failed: () => failed };
}

/** The files the page hands to the browser's download (a Blob URL and an `<a download>` click): each one's name and bytes. */
export function catchDownloads() {
  const saved: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  const created = URL.createObjectURL;
  const revoked = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:taxi-test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (this.download && blobs.has(this.href)) saved.push({ name: this.download, blob: blobs.get(this.href)! });
  });
  onTestFinished(() => {
    URL.createObjectURL = created;
    URL.revokeObjectURL = revoked;
    click.mockRestore();
  });
  return saved;
}
