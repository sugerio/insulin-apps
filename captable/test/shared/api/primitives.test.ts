import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  currencySchema,
  DECIMAL_VECTORS,
  decimalSchema,
  decimalUnits,
  einSchema,
  emailSchema,
  holdingsQuerySchema,
  isCanonicalDecimal,
  isCanonicalRatio,
  isIsoDate,
  isoDateSchema,
  monthDaySchema,
  noteSchema,
  orgKeySchema,
  pageQuerySchema,
  positiveDecimalSchema,
  queryBooleanSchema,
  ratioSchema,
  sha256HexSchema,
  slugSchema,
  timezoneSchema,
  uniqueIdsSchema,
  uuidSchema,
} from "../../../src/app/shared/api/primitives.ts";
import { uid } from "./fixtures.ts";

/** The decimal CHECK of migrations/0001, clause by clause (SQLite GLOB semantics): the contract's rule exactly. */
function sqlDecimalCheck(value: string): boolean {
  const dot = value.indexOf(".");
  return (
    /^[0-9.]*$/.test(value) && // NOT GLOB '*[^0-9.]*'
    /^[0-9]/.test(value) && // GLOB '[0-9]*'
    value.split(".").length <= 2 && // NOT GLOB '*.*.*'
    !value.endsWith(".") && // NOT GLOB '*.'
    !/^0[0-9]/.test(value) && // NOT GLOB '0[0-9]*'
    !(dot >= 0 && value.endsWith("0")) && // NOT GLOB '*.*0'
    value.length <= 40 &&
    (dot < 0 || value.length - (dot + 1) <= 12)
  );
}

describe("decimals", () => {
  it("accept and refuse exactly the shared conformance vectors (the Worker runs them against D1)", () => {
    for (const value of DECIMAL_VECTORS.accept) expect(decimalSchema.safeParse(value).success, value).toBe(true);
    for (const value of DECIMAL_VECTORS.reject) expect(decimalSchema.safeParse(value).success, value).toBe(false);
    for (const value of [...DECIMAL_VECTORS.accept, ...DECIMAL_VECTORS.reject]) {
      expect(isCanonicalDecimal(value), value).toBe(sqlDecimalCheck(value));
    }
    expect(decimalSchema.safeParse(48000).success).toBe(false);
  });

  it("positive decimals refuse zero only", () => {
    expect(positiveDecimalSchema.safeParse("0").success).toBe(false);
    expect(positiveDecimalSchema.safeParse("0.000000000001").success).toBe(true);
  });

  it("are exactly the migration's CHECK (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("0", "1", "5", "9", "."), maxLength: 44 }), (value) => {
        expect(isCanonicalDecimal(value)).toBe(sqlDecimalCheck(value));
      }),
      { numRuns: 3000 },
    );
  });

  it("accept every value a BigInt mantissa and a scale of at most 12 produce in canonical form (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 39n - 1n }), fc.integer({ min: 0, max: 12 }), (mantissa, scale) => {
        const digits = mantissa.toString().padStart(scale + 1, "0");
        const whole = digits.slice(0, digits.length - scale);
        const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
        const text = fraction ? `${whole}.${fraction}` : whole;
        expect(decimalSchema.safeParse(text).success).toBe(true);
        expect(decimalUnits(text)).toBe(mantissa * 10n ** BigInt(12 - scale));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("ratios", () => {
  it("are exact fractions in lowest terms", () => {
    for (const value of ["0", "1", "1/4", "3/1250", "17/24312120"]) expect(isCanonicalRatio(value), value).toBe(true);
    for (const value of ["2/4", "0/1", "1/1", "5/0", "-1/2", "1/-2", "0.25", "25%", "1/04", "01/4", ""]) {
      expect(ratioSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe("dates", () => {
  it("are real calendar dates with a four-digit year from 0001", () => {
    for (const value of ["2026-12-04", "2024-02-29", "2000-02-29", "0001-01-01", "9999-12-31"]) expect(isIsoDate(value), value).toBe(true);
    for (const value of ["2026-02-29", "1900-02-29", "2026-13-01", "2026-04-31", "0000-01-01", "2026-1-4", "20261204", "2026-12-04T00:00:00Z"]) {
      expect(isoDateSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("fiscal year ends are MM-DD", () => {
    expect(monthDaySchema.safeParse("12-31").success).toBe(true);
    expect(monthDaySchema.safeParse("13-01").success).toBe(false);
  });

  it("time zones are IANA names the runtime knows", () => {
    expect(timezoneSchema.safeParse("America/Los_Angeles").success).toBe(true);
    expect(timezoneSchema.safeParse("UTC").success).toBe(true);
    expect(timezoneSchema.safeParse("Mars/Olympus_Mons").success).toBe(false);
    expect(timezoneSchema.safeParse("PST8PDT; DROP").success).toBe(false);
  });
});

describe("identifiers and text", () => {
  it("UUIDs are lowercase 8-4-4-4-12 hex", () => {
    expect(uuidSchema.safeParse(uid(1)).success).toBe(true);
    expect(uuidSchema.safeParse(uid(1).toUpperCase()).success).toBe(false);
    expect(uuidSchema.safeParse("acme-demo").success).toBe(false);
  });

  it("org keys and slugs follow the CHECKs", () => {
    expect(orgKeySchema.safeParse("acme-demo").success).toBe(true);
    for (const value of ["a", "-acme", "Acme", "acme_demo", "a".repeat(41)]) expect(orgKeySchema.safeParse(value).success, value).toBe(false);
    expect(slugSchema.safeParse("acme-demo--r07").success).toBe(true);
  });

  it("e-mail addresses are trimmed and lowercased before validation", () => {
    expect(emailSchema.parse("  Dana@Mailbox.Example ")).toBe("dana@mailbox.example");
    expect(emailSchema.safeParse("dana@localhost").success).toBe(false);
    expect(emailSchema.safeParse(`${"a".repeat(250)}@b.example`).success).toBe(false);
  });

  it("notes are trimmed and required", () => {
    expect(noteSchema.parse("  Separation agreement  ")).toBe("Separation agreement");
    expect(noteSchema.safeParse("   ").success).toBe(false);
    expect(noteSchema.safeParse("x".repeat(2001)).success).toBe(false);
  });

  it("hashes, currencies and EINs", () => {
    expect(sha256HexSchema.safeParse("ab".repeat(32)).success).toBe(true);
    expect(sha256HexSchema.safeParse("AB".repeat(32)).success).toBe(false);
    expect(currencySchema.safeParse("USD").success).toBe(true);
    expect(currencySchema.safeParse("usd").success).toBe(false);
    expect(einSchema.safeParse("12-3456789").success).toBe(true);
    expect(einSchema.safeParse("123456789").success).toBe(false);
  });

  it("id lists refuse duplicates and respect their bounds", () => {
    const ids = uniqueIdsSchema(1, 2);
    expect(ids.safeParse([uid(1), uid(2)]).success).toBe(true);
    expect(ids.safeParse([uid(1), uid(1)]).success).toBe(false);
    expect(ids.safeParse([]).success).toBe(false);
    expect(ids.safeParse([uid(1), uid(2), uid(3)]).success).toBe(false);
  });
});

describe("query strings", () => {
  it("booleans are exactly true or false", () => {
    expect(queryBooleanSchema.parse("true")).toBe(true);
    expect(queryBooleanSchema.parse("false")).toBe(false);
    for (const value of ["1", "yes", "on", ""]) expect(queryBooleanSchema.safeParse(value).success, value).toBe(false);
  });

  it("pages default to 50 and cap at 200", () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(pageQuerySchema.parse({ cursor: "c-1", limit: "200" })).toEqual({ cursor: "c-1", limit: 200 });
    expect(pageQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("as of a date and as known at a seq", () => {
    expect(holdingsQuerySchema.parse({ asOf: "2026-12-31", asKnownAt: "412" })).toEqual({ asOf: "2026-12-31", asKnownAt: 412 });
    expect(holdingsQuerySchema.safeParse({ asKnownAt: "4.5" }).success).toBe(false);
  });
});
