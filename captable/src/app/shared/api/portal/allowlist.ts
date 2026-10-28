import "../zod-config.ts";
import type { z } from "zod";
import { UUID_PATTERN } from "../primitives.ts";

// The checks of the portal allowlist release gate (the API contract; the ledger rules), shared by this package's contract test and
// the Worker's recursive response test. They are pure functions over schemas and JSON values.

/** No portal response may carry a key that names a percentage, ownership, fully diluted figures or org totals. */
export const PORTAL_FORBIDDEN_KEY_PATTERN = /pct|percent|ownership|fullyDiluted|orgTotal|capTable/i;

interface SchemaDef {
  type: string;
  [key: string]: unknown;
}

function defOf(schema: unknown): SchemaDef {
  return (schema as { _zod: { def: SchemaDef } })._zod.def;
}

/**
 * Visits every schema reachable from `schema`, with a JSON-path-like location. Wrappers (optional, nullable, default,
 * pipe, lazy, …) are looked through, so an object nested anywhere is reached.
 */
export function walkSchema(schema: z.ZodType, visit: (schema: z.ZodType, def: SchemaDef, path: string) => void, path = "$"): void {
  const seen = new Set<unknown>();
  const go = (current: unknown, at: string): void => {
    if (seen.has(current)) return;
    seen.add(current);
    const def = defOf(current);
    visit(current as z.ZodType, def, at);
    switch (def.type) {
      case "object":
        for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) go(child, `${at}.${key}`);
        if (def.catchall) go(def.catchall, `${at}.*`);
        break;
      case "array":
      case "set":
        go(def.element ?? def.valueType, `${at}[]`);
        break;
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "nonoptional":
      case "readonly":
      case "catch":
        go(def.innerType, at);
        break;
      case "union":
        (def.options as unknown[]).forEach((option, index) => go(option, `${at}|${index}`));
        break;
      case "intersection":
        go(def.left, at);
        go(def.right, at);
        break;
      case "pipe":
        go(def.in, at);
        go(def.out, at);
        break;
      case "lazy":
        go((def.getter as () => unknown)(), at);
        break;
      case "record":
      case "map":
        go(def.valueType, `${at}{}`);
        break;
      case "tuple":
        (def.items as unknown[]).forEach((item, index) => go(item, `${at}[${index}]`));
        if (def.rest) go(def.rest, `${at}[…]`);
        break;
    }
  };
  go(schema, path);
}

/** The locations of every object schema that isn't a z.strictObject (its unknown keys aren't refused). */
export function findNonStrictObjects(schema: z.ZodType): string[] {
  const found: string[] = [];
  walkSchema(schema, (_schema, def, path) => {
    // A strict object's catchall is z.never(); z.object has none (unknown keys are stripped) and z.looseObject unknown.
    if (def.type === "object" && (def.catchall === undefined || defOf(def.catchall).type !== "never")) found.push(path);
    if (def.type === "record" || def.type === "map") found.push(`${path} (${def.type}: open keys)`);
  });
  return found;
}

/** The locations of every key a schema allows that matches the forbidden pattern. */
export function findForbiddenSchemaKeys(schema: z.ZodType): string[] {
  const found: string[] = [];
  walkSchema(schema, (_schema, def, path) => {
    if (def.type !== "object") return;
    for (const key of Object.keys(def.shape as Record<string, unknown>)) {
      if (PORTAL_FORBIDDEN_KEY_PATTERN.test(key)) found.push(`${path}.${key}`);
    }
  });
  return found;
}

/** The paths of every key in a JSON value that matches the forbidden pattern. */
export function findForbiddenKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(PORTAL_FORBIDDEN_KEY_PATTERN.test(key) ? [`${path}.${key}`] : []),
    ...findForbiddenKeys(child, `${path}.${key}`),
  ]);
}

/**
 * The paths of every UUID value in a JSON response that isn't one the caller may see (their stakeholder ids, orgs,
 * securities and documents). The release gate fails on any.
 */
export function findForeignIds(value: unknown, allowed: ReadonlySet<string>, path = "$"): string[] {
  if (typeof value === "string") return UUID_PATTERN.test(value) && !allowed.has(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findForeignIds(item, allowed, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => findForeignIds(child, allowed, `${path}.${key}`));
}
