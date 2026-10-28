import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach } from "vitest";
import { api } from "#shared";
import { AuthProvider } from "../../../src/app/auth/AuthProvider.tsx";
import { routes } from "../../../src/app/router.tsx";
import { me, org, ORG_ID, type Role } from "./acme.ts";
import { mock, mockApi, type MockHandler } from "./mockApi.ts";

// Renders the whole app (router, auth, layout, guards) at a path, as a console user of the synthetic company, with the
// API answered by contract-checked mocks.

beforeEach(() => {
  window.localStorage.clear();
});

export const base = `/companies/${ORG_ID}`;

export interface SetupOptions {
  role?: Role;
  ownStakeholderId?: string;
  /** /api/me says the app runs in the console's preview, without a console identity. */
  preview?: boolean;
  orgOverrides?: Parameters<typeof org>;
  /** Answers GET /api/orgs/:orgId instead of the default org (e.g. with an error). */
  orgResponse?: () => Response;
}

export function renderPage(path: string, handlers: readonly MockHandler[], options: SetupOptions = {}) {
  const session = me(options.role ?? "owner", { ownStakeholderId: options.ownStakeholderId, preview: options.preview });
  const mocks = mockApi([mock(api.routes.getMe, session), mock(api.routes.getOrg, options.orgResponse ?? org(...(options.orgOverrides ?? []))), ...handlers]);
  const router = createMemoryRouter(routes, { initialEntries: [path.startsWith("/") ? path : `${base}/${path}`] });
  render(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>,
  );
  return { router, ...mocks };
}
