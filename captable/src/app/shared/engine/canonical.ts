import { EngineError } from "./errors.ts";

/**
 * Canonical JSON for payload hashes, the ledger chain and replay hashes (the ledger rules): object keys sorted by
 * UTF-16 code units, no whitespace, strings escaped as JSON.stringify does (RFC 8785's rules for the values we allow).
 *
 * Numbers must be safe integers. Quantities, prices and money travel as decimal strings, so a float reaching a hash is
 * a bug, and refusing it keeps two runtimes from serializing the same value differently. `undefined` object members
 * are dropped (as JSON.stringify drops them); `undefined` elsewhere, functions, symbols and bigints are refused.
 * Values with a `toJSON` method (Dec, Rational) serialize through it.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, []);
}

/**
 * The path to a value ("$.a[2].b"), built only for an error message: hashing serializes every ledger row, so the
 * happy path keeps a stack of keys instead of concatenating a path per member.
 */
function fail(path: readonly (string | number)[], message: string): never {
  let text = "$";
  for (const part of path) text += typeof part === "number" ? `[${part}]` : `.${part}`;
  throw new EngineError("CANONICAL_JSON", `${text}: ${message}`);
}

function serialize(value: unknown, path: (string | number)[]): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) fail(path, `only safe integers may be JSON numbers (got ${value})`);
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      const withJson = value as { toJSON?: () => unknown };
      if (typeof withJson.toJSON === "function") return serialize(withJson.toJSON(), path);
      if (Array.isArray(value)) {
        let text = "[";
        for (let index = 0; index < value.length; index++) {
          const item: unknown = value[index];
          path.push(index);
          if (item === undefined) fail(path, "undefined in an array");
          text += (index > 0 ? "," : "") + serialize(item, path);
          path.pop();
        }
        return `${text}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail(path, "only plain objects can be serialized");
      const record = value as Record<string, unknown>;
      let text = "{";
      let first = true;
      for (const key of Object.keys(record).sort()) {
        const member = record[key];
        if (member === undefined) continue;
        path.push(key);
        text += `${first ? "" : ","}${JSON.stringify(key)}:${serialize(member, path)}`;
        path.pop();
        first = false;
      }
      return `${text}}`;
    }
    default:
      return fail(path, `a ${typeof value} can't be serialized`);
  }
}

/** True when `text` is exactly the canonical serialization of the JSON it holds. */
export function isCanonicalJsonText(text: string): boolean {
  try {
    return canonicalJson(JSON.parse(text)) === text;
  } catch {
    return false;
  }
}
