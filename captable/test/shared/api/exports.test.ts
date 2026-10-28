import { describe, expect, it } from "vitest";
import { api } from "../../../src/app/shared/index.ts";

describe("the package index", () => {
  it("exports the API contract as the `api` namespace", () => {
    expect(api.routes.getMe.path).toBe("/api/me");
    expect(api.ROUTE_TABLE.length).toBe(Object.keys(api.routes).length);
    expect(api.capTableResponseSchema.safeParse({}).success).toBe(false);
  });

  it("names every zod schema …Schema, so the barrel stays readable and collision-free", () => {
    const misnamed = Object.entries(api)
      .filter(([, value]) => typeof value === "object" && value !== null && "_zod" in value)
      .map(([name]) => name)
      .filter((name) => !name.endsWith("Schema"));
    expect(misnamed).toEqual([]);
  });
});
