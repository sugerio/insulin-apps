import "./zod-config.ts";
import { z } from "zod";

// Shared primitives of the API contract (the API contract). Values on the wire are strings or integers only: decimals
// are canonical strings that are validated here and never parsed into floats; the arithmetic is the engine's
// (`Dec` and `Rational` in src/engine), which accepts these strings as they are.

// ---------------------------------------------------------------------------
// Identifiers

/** Lowercase UUID text, as the Worker generates it (UUIDv7). A path segment that isn't one answers 404 (the API contract). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const uuidSchema = z.string().regex(UUID_PATTERN, "Use a lowercase UUID");

/** A legal entity's key (`orgs.org_key`): the access policy's org admin lists are keyed by it. */
export const orgKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "2–40 lowercase letters, digits or hyphens, starting with a letter or digit");
/** The active company's slug, equal to its `org_key`. */
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/, "2–60 lowercase letters, digits or hyphens");
/** A security's certificate number or ID (`OPT-33`, `CS-12`): unique per org and never reused. */
export const displayIdSchema = z.string().min(1).max(40);
/** Autoincremented records such as audit events and expiry runs use integer ids. */
export const integerIdSchema = z.number().int().positive();

// ---------------------------------------------------------------------------
// Dates and instants

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * True for a real calendar date as `YYYY-MM-DD` with a four-digit year from 0001: the rule of the engine's
 * `isIsoDate` and of the schema's `date(x) IS x` CHECKs. Legal dates carry no time zone (the ledger rules).
 */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_SHAPE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export const isoDateSchema = z.string().regex(ISO_DATE_SHAPE, "Use a date as YYYY-MM-DD").refine(isIsoDate, "Invalid date");
/** Instants are epoch milliseconds (the API contract). */
export const epochMsSchema = z.number().int().nonnegative();
/** A fiscal year end or other day of the year, `MM-DD`. */
export const monthDaySchema = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Use MM-DD");

/** An IANA time zone such as `America/Los_Angeles`: it defines the org's "today" (the ledger rules). */
export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/, "Use an IANA time zone")
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone");

// ---------------------------------------------------------------------------
// Decimals, ratios and money

/**
 * Canonical decimal text (the ledger rules): digits with at most one point, no sign, no exponent, no leading zeros, no
 * trailing fractional zeros, at most 12 fractional digits and 40 characters in all. It is exactly the decimal CHECK of
 * migrations/0001, which DECIMAL_VECTORS pin on both sides (the Worker's D1 test runs the same vectors). An earlier contract had
 * capped the integer part at 27 digits; the ledger rules and the schema don't, so neither does the contract.
 */
export const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d{0,11}[1-9])?$/;
export const MAX_DECIMAL_FRACTION_DIGITS = 12;
export const MAX_DECIMAL_LENGTH = 40;

export function isCanonicalDecimal(value: string): boolean {
  return value.length <= MAX_DECIMAL_LENGTH && DECIMAL_PATTERN.test(value);
}

/**
 * Conformance vectors for the decimal rule: the contract and D1's CHECK must accept and refuse exactly these. A
 * change to either side has to change them, and both tests with them.
 */
export const DECIMAL_VECTORS = {
  accept: [
    "0",
    "1",
    "48000",
    "0.95",
    "0.000000000001",
    "16147718.6",
    "1.123456789012",
    "9".repeat(27),
    "9".repeat(40),
    `${"9".repeat(27)}.${"9".repeat(12)}`,
  ],
  reject: [
    "",
    "-1",
    "+1",
    "1e3",
    "01",
    "00",
    "0.0",
    "1.0",
    "1.50",
    ".5",
    "5.",
    "1.2.3",
    " 1",
    "1 ",
    "1,000",
    "0.0000000000001",
    "1.1234567890123",
    "9".repeat(41),
    `${"9".repeat(28)}.${"9".repeat(12)}`,
  ],
} as const;

/** A non-negative quantity, price or amount. Direction comes from the transaction type, never from a sign. */
export const decimalSchema = z
  .string()
  .max(MAX_DECIMAL_LENGTH)
  .regex(DECIMAL_PATTERN, "Use a canonical decimal: digits, at most 12 after the point, no sign or trailing zeros");
/** A quantity or price greater than zero (`PositiveDec`; invariant I18). */
export const positiveDecimalSchema = decimalSchema.refine((value) => value !== "0", "Must be greater than 0");

/** A canonical non-negative integer as text, such as one side of a conversion ratio. */
export const integerStringSchema = z.string().max(MAX_DECIMAL_LENGTH).regex(/^(0|[1-9]\d*)$/, "Use a whole number");
export const positiveIntegerStringSchema = z
  .string()
  .max(MAX_DECIMAL_LENGTH)
  .regex(/^[1-9]\d*$/, "Use a whole number greater than 0");

const DECIMAL_SCALE = 10n ** BigInt(MAX_DECIMAL_FRACTION_DIGITS);

/**
 * A canonical decimal as an exact integer count of 10^-12 units, for comparisons and sums inside schemas (an explicit
 * vesting table must add up to its quantity). Never a float; the engine's `Dec` does the real arithmetic.
 */
export function decimalUnits(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * DECIMAL_SCALE + BigInt(fraction.padEnd(MAX_DECIMAL_FRACTION_DIGITS, "0") || "0");
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * An exact non-negative fraction, `n` or `n/d` in lowest terms with `d > 1`: the engine's `Rational#toJSON()`.
 * Percentages (`…Pct`, `pct`) travel as the exact fraction of the whole (0.25 is `1/4`, never `25`) and are rounded
 * only where they are shown: 2 decimal places in the UI and 6 in exports (the ledger and API contract).
 */
export const RATIO_PATTERN = /^(0|[1-9]\d*)(?:\/([1-9]\d*))?$/;
export function isCanonicalRatio(value: string): boolean {
  const match = RATIO_PATTERN.exec(value);
  if (!match) return false;
  if (match[2] === undefined) return true;
  const numerator = BigInt(match[1]!);
  const denominator = BigInt(match[2]);
  return denominator > 1n && gcd(numerator, denominator) === 1n;
}
export const ratioSchema = z
  .string()
  .max(200)
  .refine(isCanonicalRatio, "Use an exact fraction in lowest terms, e.g. 1/4");

/** ISO 4217 code, e.g. `USD`. Amounts are decimals in this currency; there is no money float anywhere. */
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code");
/** An amount of money in the org's currency (payments, withholding, capital): a canonical decimal. */
export const moneyAmountSchema = decimalSchema;
export const positiveMoneyAmountSchema = positiveDecimalSchema;

// ---------------------------------------------------------------------------
// Hashes, text and contact data

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "Use 64 lowercase hex characters");
/** Lowercased and trimmed before validation, as every stored address is (`email = lower(email)` CHECKs). */
export const emailSchema = z
  .string()
  .max(254)
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email("Enter an e-mail address"));
/** A reason or note a person typed: required where it is used (`Note` in the API contract). */
export const noteSchema = z.string().trim().min(1, "Enter a note").max(2000, "At most 2,000 characters");
/** Two uppercase letters (ISO 3166-1 alpha-2), as `stakeholders.country_of_residence` requires. */
export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/, "Use a two-letter country code");
/** A US employer identification number, `12-3456789`. */
export const einSchema = z.string().regex(/^\d{2}-\d{7}$/, "Use an EIN as 12-3456789");

// ---------------------------------------------------------------------------
// Concurrency

/** The `version` a PATCH or transition sends back: the one it read (the API contract). Rows start at 1. */
export const versionSchema = z.number().int().positive();
/** A ledger seq: 0 for an empty ledger, then 1, 2, 3, … per org with no gaps. */
export const ledgerSeqSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Lists and query strings

/** `true`/`false` in a query string, such as `?dryRun=true`. */
export const queryBooleanSchema = z.stringbool({ truthy: ["true"], falsy: ["false"] });

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** Cursor pagination for the audit log, transactions and documents. Cursors are opaque. */
export const pageQueryShape = {
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};
export const pageQuerySchema = z.object(pageQueryShape);

/** A page of a cursor list: `nextCursor` is null at the end. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().min(1).nullable() });
}

/** A bounded list returned whole. */
export function listSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}

/** `asOf` (a legal date; default: the org's today) and `asKnownAt` (a ledger seq; default: the head), the API contract*/
export const asOfQuerySchema = z.object({ asOf: isoDateSchema.optional() });
export const holdingsQueryShape = {
  asOf: isoDateSchema.optional(),
  asKnownAt: z.coerce.number().int().nonnegative().optional(),
};
export const holdingsQuerySchema = z.object(holdingsQueryShape);

/** What every holdings response echoes (the API contract), so a view can say which ledger state it shows. */
export const holdingsEchoShape = {
  asOf: isoDateSchema,
  asKnownAt: ledgerSeqSchema,
  ledgerSeq: ledgerSeqSchema,
  ledgerHeadHash: sha256HexSchema.nullable(),
  engineVersion: z.string().min(1).max(64),
};

/** A whole list computed by replaying the ledger, with the echo of the state it was computed from. */
export function holdingsListSchema<T extends z.ZodType>(item: T) {
  return z.object({ ...holdingsEchoShape, items: z.array(item) });
}

/** Ids in a request body that must not repeat, such as `{ids}` or `{stakeholderIds}`. */
export function uniqueIdsSchema(min: number, max: number) {
  return z
    .array(uuidSchema)
    .min(min)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, "Each id can appear only once");
}

/** A typed confirmation (the API contract): what the person typed, compared by the server with the expected text. */
export const confirmationSchema = z.string().trim().min(1, "Type the confirmation").max(200);
