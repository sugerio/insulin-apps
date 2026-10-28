import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  apiErrorBodySchema,
  CONFLICT_REASONS,
  FORBIDDEN_REASONS,
  VIOLATION_CODES,
  WARNING_CODES,
} from "../../../src/app/shared/api/errors.ts";
import { COMMANDS } from "../../../src/app/shared/api/commands.ts";
import { routes } from "../../../src/app/shared/api/routes.ts";
import { uid } from "./fixtures.ts";

const body = (error: Record<string, unknown>) => ({ error: { message: "Refused", ...error } });

describe("the error envelope", () => {
  it("maps every code to its HTTP status", () => {
    expect(Object.keys(API_ERROR_STATUS).sort()).toEqual([...API_ERROR_CODES].sort());
    expect(API_ERROR_STATUS.validation_failed).toBe(400);
    expect(API_ERROR_STATUS.unavailable).toBe(503);
  });

  it("accepts each code with what it promises", () => {
    const valid = [
      body({ code: "validation_failed", issues: [{ path: "quantity", message: "Use a canonical decimal" }] }),
      body({ code: "unauthenticated" }),
      body({ code: "forbidden", reason: "org_inactive" }),
      body({ code: "forbidden", reason: "org_read_only" }),
      body({ code: "self_dealing" }),
      body({ code: "not_found" }),
      body({ code: "conflict", reason: "stale_ledger" }),
      body({ code: "conflict", reason: "dependents_exist", dependents: [{ commandId: uid(9), type: "exercise-option", createdAt: 1 }] }),
      body({ code: "invariant_violation", violations: [{ code: "NO_PRESUMPTIVELY_VALID_409A", message: "No valid 409A", override: { role: "admin_rw", requires: ["counselMemoDocumentId"] } }] }),
      body({ code: "warnings_unacknowledged", warnings: [{ code: "DUPLICATE_EMAIL", message: "Also used by another stakeholder" }] }),
      body({ code: "unavailable" }),
      body({ code: "internal" }),
    ];
    for (const value of valid) expect(apiErrorBodySchema.safeParse(value).error?.issues ?? [], JSON.stringify(value)).toEqual([]);
  });

  it("refuses an envelope that breaks its code's promise", () => {
    const invalid = [
      body({ code: "teapot" }),
      body({ code: "conflict" }),
      body({ code: "conflict", reason: "busy" }),
      body({ code: "conflict", reason: "dependents_exist" }),
      body({ code: "invariant_violation", violations: [] }),
      body({ code: "warnings_unacknowledged" }),
      body({ code: "validation_failed" }),
      body({ code: "not_found", dependents: [{ commandId: uid(9), type: "x", createdAt: 1 }] }),
      body({ code: "invariant_violation", violations: [{ code: "X", message: "m", override: { role: "admin_rw", requires: [] } }] }),
      { message: "Refused" },
    ];
    for (const value of invalid) expect(apiErrorBodySchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("lists every structured reason the contract uses", () => {
    expect(CONFLICT_REASONS).toEqual(["stale_version", "stale_ledger", "idempotency_key_reused", "state_changed", "dependents_exist", "migrated_history"]);
    expect(FORBIDDEN_REASONS).toEqual(["org_inactive", "org_read_only"]);
  });

  it("names every product code a route or command declares", () => {
    const declared = new Set([...Object.values(routes).flatMap((route) => [...route.violations, ...route.warnings])]);
    for (const spec of Object.values(COMMANDS)) for (const code of [...spec.violations, ...spec.warnings]) declared.add(code);
    for (const code of declared) expect([...VIOLATION_CODES, ...WARNING_CODES], code).toContain(code);
  });
});
