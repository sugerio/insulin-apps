import { vi } from "vitest";

// The Insulin Apps gateway's endpoints on the app's host (`/__insulin/me`, `/switch-org`, `/logout`), answered in front
// of the API mocks: install it after mockApi and before rendering. The platform's own pages are on another origin in
// production; here the apex is a local address, so the links stay inside the test.

export const APEX = "http://localhost:8787";

export interface PlatformAccountFixture {
  user: { name: string; email: string };
  organization: { id: string; name: string; role: string; roleLabel: string } | null;
  organizations: { id: string; name: string; role: string; roleLabel: string; active: boolean }[];
  links: Record<string, string | null>;
  /** The apex's origin and the app's settings pages, which a newer gateway also gives. */
  apex?: string;
  settings?: Record<string, string | null>;
}

/** `/__insulin/me` for Rachel, the owner, in Acme Robotics and one other organization. */
export function platformAccount(overrides: Partial<PlatformAccountFixture> = {}): PlatformAccountFixture {
  return {
    user: { name: "Rachel Ostrowski", email: "rachel@acmerobotics.example" },
    organization: { id: "org-acme", name: "Acme Robotics", role: "owner", roleLabel: "Owner" },
    organizations: [
      { id: "org-acme", name: "Acme Robotics", role: "owner", roleLabel: "Owner", active: true },
      { id: "org-nimbus", name: "Nimbus Ledger Labs", role: "viewer", roleLabel: "Viewer", active: false },
    ],
    links: {
      members: `${APEX}/apps/captable/settings/users`,
      integrations: `${APEX}/apps/captable/settings/integrations`,
      connectAi: `${APEX}/apps/captable/settings/connect-ai`,
      organizations: `${APEX}/`,
      account: `${APEX}/account`,
      apps: `${APEX}/`,
    },
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export interface PlatformOptions {
  /** The answer to POST /__insulin/switch-org. */
  switchOrg?: () => Response;
  /** The answer to POST /__insulin/logout. */
  logout?: () => Response;
}

/** Answers `/__insulin/*` with `account` (null: signed out, a 401) and passes everything else to the fetch already stubbed. */
export function mockPlatform(account: PlatformAccountFixture | null, options: PlatformOptions = {}) {
  const inner = globalThis.fetch;
  const requests: { path: string; method: string; headers: Headers; body: string | undefined }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    if (!url.pathname.startsWith("/__insulin/")) return inner(input, init);
    requests.push({ path: url.pathname, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : undefined });
    if (url.pathname === "/__insulin/me") return account ? json(account) : json({ error: "unauthorized" }, 401);
    if (url.pathname === "/__insulin/switch-org") return options.switchOrg?.() ?? json({ ok: true, organization: { id: "org-nimbus", name: "Nimbus Ledger Labs", role: "viewer" } });
    if (url.pathname === "/__insulin/logout") return options.logout?.() ?? json({ ok: true, next: `${APEX}/` });
    return json({ error: "not_found" }, 404);
  }));
  return { requests };
}
