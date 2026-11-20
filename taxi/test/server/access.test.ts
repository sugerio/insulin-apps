import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiCatalog, Me, Person } from "#shared";
import { OTHER_ORG, OWNER, VIEWER, startServer, type TestServer } from "../support/server.ts";

let server: TestServer;
beforeEach(async () => {
  server = await startServer();
});
afterEach(() => server.close());

async function seed(): Promise<Person> {
  const response = await server.call("POST", "/api/people", { body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" } });
  const alex = (await response.json()) as Person;
  expect((await server.call("POST", "/api/years", { body: { year: 2025, people: [alex.id] } })).status).toBe(201);
  return alex;
}

describe("identity", () => {
  it("answers 401 without the platform's identity", async () => {
    expect((await server.call("GET", "/api/me", { as: null })).status).toBe(401);
  });

  it("treats a request marked as the tick as nobody on every other route", async () => {
    expect((await server.call("GET", "/api/me", { as: { ...OWNER, via: "schedule" } })).status).toBe(401);
  });

  it("says who is calling and what they may do", async () => {
    const me = (await (await server.call("GET", "/api/me", { as: VIEWER })).json()) as Me;
    expect(me).toMatchObject({ role: "VIEWER", permissions: ["taxi.view"], accessVia: "browser", preview: false });
  });
});

describe("permissions", () => {
  it("lets a viewer read but not change", async () => {
    const alex = await seed();
    expect((await server.call("GET", "/api/years/2025", { as: VIEWER })).status).toBe(200);
    expect((await server.call("POST", "/api/people", { as: VIEWER, body: { name: "X", relationship: "child", birthDate: "2020-01-01" } })).status).toBe(403);
    expect((await server.call("DELETE", `/api/people/${alex.id}`, { as: VIEWER })).status).toBe(403);
    expect((await server.call("POST", "/api/years", { as: VIEWER, body: { year: 2025, people: [alex.id] } })).status).toBe(403);
  });

  it("narrows a role with x-suger-app-permissions, and never widens one", async () => {
    const alex = await seed();
    const viewOnlyEditor = { ...OWNER, role: "EDITOR" as const, permissions: "taxi.view" };
    expect((await server.call("GET", "/api/years", { as: viewOnlyEditor })).status).toBe(200);
    expect((await server.call("POST", "/api/years", { as: viewOnlyEditor, body: { year: 2025, people: [alex.id] } })).status).toBe(403);
    const forged = { ...VIEWER, permissions: "taxi.prepare taxi.view" };
    expect((await server.call("POST", "/api/years", { as: forged, body: { year: 2025, people: [alex.id] } })).status).toBe(403);
    const nothing = { ...OWNER, permissions: "" };
    expect((await server.call("GET", "/api/years", { as: nothing })).status).toBe(403);
  });

  it("publishes only the routes the caller may use", async () => {
    const catalog = async (as: typeof OWNER) => ((await (await server.call("GET", "/api/catalog", { as })).json()) as ApiCatalog).endpoints;
    const ownerPaths = (await catalog(OWNER)).map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(ownerPaths).toContain("PUT /api/years/{year}/personal-info");
    expect(ownerPaths).not.toContain("POST /api/scheduled");
    const viewerMethods = new Set((await catalog(VIEWER)).map((endpoint) => endpoint.method));
    expect([...viewerMethods]).toEqual(["GET"]);
  });

  it("blocks a cross-site write", async () => {
    const response = await server.call("POST", "/api/people", {
      body: { name: "Alex Martin", relationship: "self", birthDate: "1985-04-02" },
      headers: { Origin: "https://elsewhere.example" },
    });
    expect(response.status).toBe(403);
  });
});

describe("tenancy", () => {
  it("never shows or changes another organization's people", async () => {
    const alex = await seed();
    expect((await server.call("GET", "/api/years/2025", { as: OTHER_ORG })).status).toBe(404);
    expect((await server.call("PATCH", `/api/people/${alex.id}`, { as: OTHER_ORG, body: { name: "Taken" } })).status).toBe(404);
    expect((await server.call("DELETE", `/api/people/${alex.id}`, { as: OTHER_ORG })).status).toBe(404);
    const theirs = (await (await server.call("GET", "/api/years", { as: OTHER_ORG })).json()) as { years: unknown[]; people: unknown[] };
    expect(theirs).toMatchObject({ years: [], people: [] });
    // Each organization has a profile of its own.
    expect((await server.call("POST", "/api/people", { as: OTHER_ORG, body: { name: "Olive", relationship: "self", birthDate: "1980-01-01" } })).status).toBe(201);
  });
});

describe("the platform's tick", () => {
  it("accepts only the tick, and reports nothing without a metrics address", async () => {
    expect((await server.call("POST", "/api/scheduled", { as: OWNER })).status).toBe(403);
    const tick = await server.call("POST", "/api/scheduled", { as: null, headers: { "x-suger-access-via": "schedule" } });
    expect(tick.status).toBe(200);
    expect(await tick.json()).toEqual({ metrics: "not_configured" });
  });
});
