import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { COMMANDS } from "../../../src/app/shared/api/commands.ts";
import { COMMAND_NAMES } from "../../../src/app/shared/api/enums.ts";
import { AUTH_CLASSES, HTTP_METHODS, ROUTE_TABLE, pathParamNames, routeById, routes, type AnyRoute } from "../../../src/app/shared/api/routes.ts";

const entries = Object.entries(routes) as [string, AnyRoute][];

function shapeOf(schema: z.ZodType | null): Record<string, z.ZodType> {
  if (!schema) return {};
  return ((schema as unknown as { _zod: { def: { shape?: Record<string, z.ZodType> } } })._zod.def.shape ?? {});
}

describe("the pruned route table", () => {
  it("contains every retained route exactly once", () => {
    expect(ROUTE_TABLE).toHaveLength(entries.length);
    expect(new Set(ROUTE_TABLE.map((route) => route.id)).size).toBe(ROUTE_TABLE.length);
    expect(new Set(ROUTE_TABLE.map((route) => `${route.method} ${route.path}`)).size).toBe(ROUTE_TABLE.length);
  });

  it.each(entries)("%s is keyed by its id", (key, route) => {
    expect(route.id).toBe(key);
    expect(routeById(key)).toBe(route);
  });

  it.each(entries)("%s uses console identity and valid path parameters", (_key, route) => {
    expect(HTTP_METHODS).toContain(route.method);
    expect(AUTH_CLASSES).toContain(route.auth);
    expect(route.auth).not.toBe("public");
    expect(route.path).toMatch(/^\/api\//);
    expect(Object.keys(shapeOf(route.params)).sort()).toEqual(pathParamNames(route.path).sort());
    if (route.path.startsWith("/api/portal/")) expect(route.auth).toBe("holder");
    else if (route.path === "/api/me") expect(route.auth).toBe("identity");
    else expect(route.auth).toBe("admin");
  });

  it.each(entries)("%s grants read or write administrator access consistently", (_key, route) => {
    if (route.auth !== "admin") return expect(route.access).toEqual([]);
    if ((route.method === "GET" || route.id === "previewVesting") && !route.path.startsWith("/api/import/")) expect(route.access).toEqual(["admin_rw", "admin_ro"]);
    else expect(route.access).toEqual(["admin_rw"]);
  });

  it.each(entries)("%s requires idempotency for mutations", (_key, route) => {
    if (route.method === "GET" || route.id === "previewVesting" || route.id === "processDue" || route.id === "previewImport") expect(route.idempotency).toBe("none");
    else if (route.body.kind === "json" && route.body.dryRunSchema !== undefined) {
      expect(route.idempotency).toBe("required_unless_dry_run");
    } else expect(route.idempotency).toBe("required");
  });

});

describe("commands", () => {
  it("keeps one route for every ledger command", () => {
    for (const name of COMMAND_NAMES) {
      const route = ROUTE_TABLE.find((candidate) => candidate.path === `/api/orgs/:orgId/commands/${name}`);
      expect(route, name).toBeDefined();
      expect(route!.body.kind).toBe("json");
      if (route!.body.kind === "json") {
        expect(route!.body.schema).toBe(COMMANDS[name].schema);
        expect(route!.body.dryRunSchema ?? null).toBe(COMMANDS[name].dryRunSchema);
      }
      expect(route!.access).toEqual(["admin_rw"]);
      expect(route!.errors).toContain("self_dealing");
    }
  });
});
