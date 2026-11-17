import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, vi } from "vitest";
import { AuthProvider } from "../../src/app/auth/AuthProvider.tsx";
import { routes } from "../../src/app/router.tsx";
import { ORIGIN, OWNER, identityHeaders, startServer, type Identity, type TestServer } from "../support/server.ts";

// Renders the whole app (router, auth, shell) at a path, with the browser's fetch answered by the real server and a
// fresh database in this process: what the page sends is what the API receives, with no mocked answers.

let server: TestServer | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  window.localStorage.clear();
});

export async function renderApp(path: string, options: { as?: Identity; seed?: (server: TestServer) => Promise<void> } = {}) {
  server = await startServer({ enforceSameOrigin: false });
  await options.seed?.(server);
  const as = options.as ?? OWNER;
  const app = server;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(identityHeaders(as))) headers.set(name, value);
    return app.app.fetch(new Request(url, { method: init.method ?? "GET", headers, body: init.body ?? null }), { DB: app.db });
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  return { router, server: app };
}
