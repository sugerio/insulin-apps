import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { UUID_PATTERN } from "../../../src/app/shared/api/primitives.ts";
import { type AnyRoute, type RouteId, routes } from "../../../src/app/shared/api/routes.ts";
import { ENDPOINT_EXAMPLES } from "./endpoint-examples.ts";

// Every endpoint, with synthetic examples: the valid call and answer parse (and survive a JSON round trip
// unchanged), every request body refuses unknown keys and missing required keys, malformed ids are refused (404 on the
// wire), and each endpoint's targeted invalid cases fail.

const ENTRIES = Object.entries(routes) as [RouteId, AnyRoute][];

/** Parses, sends through JSON and parses again: the wire form must be stable. */
function roundTrip(schema: z.ZodType, value: unknown): unknown {
  const parsed = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys whose removal makes `value` invalid: a schema with required fields must have some. */
function requiredKeys(schema: z.ZodType, value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => {
    const { [key]: _dropped, ...rest } = value;
    return !schema.safeParse(rest).success;
  });
}

function responseSchemaOf(route: AnyRoute): z.ZodType | null {
  if (route.response.kind === "json") return route.response.schema;
  if (route.response.kind === "file") return route.response.jsonSchema;
  return null;
}

describe("endpoint examples", () => {
  it("cover every route", () => {
    expect(Object.keys(ENDPOINT_EXAMPLES).sort()).toEqual(Object.keys(routes).sort());
  });
});

describe.each(ENTRIES)("%s", (id, route) => {
  const example = ENDPOINT_EXAMPLES[id];

  it("has examples for exactly the parts the route has", () => {
    expect(example.params !== undefined, "params").toBe(route.params !== null);
    expect(example.body !== undefined, "body").toBe(route.body.kind === "json");
    expect(example.dryRunBody !== undefined, "dryRunBody").toBe(route.body.kind === "json" && route.body.dryRunSchema !== undefined);
    expect(example.headers !== undefined, "headers").toBe(route.body.kind === "raw");
    expect(example.response !== undefined, "response").toBe(responseSchemaOf(route) !== null);
    expect(example.responseHeaders !== undefined, "responseHeaders").toBe(route.response.kind === "file");
    if (route.query === null) expect(example.query, "query").toBeUndefined();
  });

  if (route.params !== null) it("accepts its path parameters and refuses a malformed id", () => {
    const params = route.params!;
    expect(params.safeParse(example.params).success).toBe(true);
    for (const [name, value] of Object.entries(example.params ?? {})) {
      if (UUID_PATTERN.test(value)) {
        expect(params.safeParse({ ...example.params, [name]: "NOT-A-UUID" }).success, name).toBe(false);
      }
    }
  });

  if (route.query !== null) it("accepts its query string", () => {
    const result = route.query!.safeParse(example.query ?? {});
    expect(result.error?.issues ?? []).toEqual([]);
  });

  if (route.body.kind === "json") it("accepts its JSON body, refuses unknown and missing fields", () => {
    if (route.body.kind !== "json") return;
    const { schema, dryRunSchema } = route.body;
    expect(isPlainObject(example.body)).toBe(true);
    const body = example.body as Record<string, unknown>;
    const result = schema.safeParse(body);
    expect(result.error?.issues ?? []).toEqual([]);
    roundTrip(schema, body);
    expect(schema.safeParse({ ...body, unexpectedField: true }).success).toBe(false);
    if (Object.keys(body).length > 0 && !schema.safeParse({}).success) {
      expect(requiredKeys(schema, body).length).toBeGreaterThan(0);
    }
    if (dryRunSchema !== undefined) {
      const dryRun = dryRunSchema.safeParse(example.dryRunBody);
      expect(dryRun.error?.issues ?? []).toEqual([]);
      roundTrip(dryRunSchema, example.dryRunBody);
      expect(dryRunSchema.safeParse({ ...(example.dryRunBody as object), unexpectedField: true }).success).toBe(false);
    }
  });

  if (route.body.kind === "raw") it("accepts its upload headers and refuses a bad digest", () => {
    if (route.body.kind !== "raw") return;
    const result = route.body.headers.safeParse(example.headers);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(route.body.headers.safeParse({ ...example.headers, "x-content-sha256": "not-a-digest" }).success).toBe(false);
    expect(route.body.maxBytes).toBeGreaterThan(0);
  });

  if (responseSchemaOf(route) !== null) it("answers with a response its schema accepts unchanged", () => {
    const schema = responseSchemaOf(route)!;
    expect(example.response).toBeDefined();
    const result = schema.safeParse(example.response);
    expect(result.error?.issues ?? []).toEqual([]);
    // Nothing in the example is stripped or defaulted: it is exactly what the Worker sends.
    expect(roundTrip(schema, example.response)).toEqual(schema.parse(example.response));
    if (isPlainObject(example.response)) {
      expect(requiredKeys(schema, example.response).length).toBeGreaterThan(0);
    }
  });

  if (route.response.kind === "file") it("streams an attachment with every security header", () => {
    if (route.response.kind !== "file") return;
    const { headers, contentTypes } = route.response;
    const valid = example.responseHeaders!;
    expect(headers.safeParse(valid).error?.issues ?? []).toEqual([]);
    expect(contentTypes).toContain(valid["content-type"]);
    for (const name of Object.keys(valid).filter((key) => key !== "content-type")) {
      const { [name]: _dropped, ...missing } = valid;
      expect(headers.safeParse(missing).success, `without ${name}`).toBe(false);
    }
    const wrong = {
      "content-disposition": "inline; filename=report.pdf",
      "x-content-type-options": "sniff",
      "cache-control": "max-age=3600",
      "content-security-policy": "default-src 'self'",
      digest: "md5=abc",
    };
    for (const [name, value] of Object.entries(wrong)) {
      if (name in valid) expect(headers.safeParse({ ...valid, [name]: value }).success, `${name}: ${value}`).toBe(false);
    }
  });

  if ((example.invalid ?? []).length > 0) it("refuses its invalid examples", () => {
    for (const [index, invalid] of (example.invalid ?? []).entries()) {
      const label = `${id} invalid #${index}`;
      if (invalid.params !== undefined) expect(route.params!.safeParse(invalid.params).success, label).toBe(false);
      if (invalid.query !== undefined) expect(route.query!.safeParse(invalid.query).success, label).toBe(false);
      if (invalid.body !== undefined) {
        const schema = route.body.kind === "json" ? route.body.schema : null;
        expect(schema, label).not.toBeNull();
        expect(schema!.safeParse(invalid.body).success, label).toBe(false);
      }
      if (invalid.headers !== undefined) {
        expect(route.body.kind, label).toBe("raw");
        if (route.body.kind === "raw") expect(route.body.headers.safeParse(invalid.headers).success, label).toBe(false);
      }
      if (invalid.response !== undefined) expect(responseSchemaOf(route)!.safeParse(invalid.response).success, label).toBe(false);
    }
  });
});
