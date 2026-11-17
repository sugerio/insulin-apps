import { z } from "zod";

// The household and its tax years, as the browser, the server and API clients see them. A household is the people a
// return is prepared for in one organization; each tax year records the facts that can change from year to year
// (marital status on December 31, each adult's province, whether they lived in Canada all year) and whether the two
// adults' returns are prepared together.

/** The years the app prepares returns for. A year is data for the tax engine; adding one adds its rule files. */
export const SUPPORTED_YEARS = [2025] as const;
export const yearSchema = z.coerce.number().int().refine((year) => (SUPPORTED_YEARS as readonly number[]).includes(year), {
  message: `Only ${SUPPORTED_YEARS.join(", ")} is supported`,
});

export const RELATIONSHIPS = ["self", "spouse", "child", "other_dependant"] as const;
export const relationshipSchema = z.enum(RELATIONSHIPS);
export type Relationship = z.infer<typeof relationshipSchema>;
/** The two people who can file a return here: the person preparing it and their spouse or common-law partner. */
export const isAdult = (relationship: Relationship) => relationship === "self" || relationship === "spouse";

/** Marital status on December 31, as the T1 asks it (page 1, "Your marital status on December 31"). */
export const MARITAL_STATUSES = ["married", "common_law", "widowed", "divorced", "separated", "single"] as const;
export const maritalStatusSchema = z.enum(MARITAL_STATUSES);
export type MaritalStatus = z.infer<typeof maritalStatusSchema>;
/** The statuses in which a spouse or common-law partner's return can be prepared alongside. */
export const hasPartner = (status: MaritalStatus | null) => status === "married" || status === "common_law";

/** Province or territory of residence on December 31, by its two-letter code. */
export const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"] as const;
export const provinceSchema = z.enum(PROVINCES);
export type Province = z.infer<typeof provinceSchema>;
/** The provinces whose tax this app works out. Quebec, with its own return, comes later. */
export const SUPPORTED_PROVINCES: readonly Province[] = ["ON", "BC", "AB"];

export const idSchema = z.uuid();
const isoDateSchema = z.iso.date();
/** A birth date: a real date, not in the future, and after 1900. */
export const birthDateSchema = isoDateSchema.refine((date) => date >= "1900-01-01" && date <= new Date().toISOString().slice(0, 10), {
  message: "Enter a real birth date",
});
export const personNameSchema = z.string().trim().min(1, "Enter a name").max(100);

export const personSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  relationship: relationshipSchema,
  birthDate: z.string(),
});
export type Person = z.infer<typeof personSchema>;

export const createPersonSchema = z.strictObject({
  name: personNameSchema,
  relationship: relationshipSchema,
  birthDate: birthDateSchema,
});
export type CreatePerson = z.infer<typeof createPersonSchema>;
export const updatePersonSchema = createPersonSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: "Change at least one field",
});
export type UpdatePerson = z.infer<typeof updatePersonSchema>;

/** One adult's facts for the year, and whether their return is prepared here. */
export const adultYearSchema = z.strictObject({
  personId: idSchema,
  province: provinceSchema.nullable(),
  residentAllYear: z.boolean().nullable(),
  /** Prepared in this app: always the person preparing; their spouse only when the returns are prepared together. */
  prepared: z.boolean(),
});
export type AdultYear = z.infer<typeof adultYearSchema>;

/** Something that stops a step from being finished, or that the app can't handle. */
export const issueSchema = z.strictObject({
  code: z.enum([
    "no_self",
    "no_marital_status",
    "no_spouse",
    "spouse_without_partner_status",
    "no_province",
    "no_residency",
    "unsupported_province",
    "part_year_resident",
  ]),
  /** The person it is about, if any. */
  personId: idSchema.nullable(),
  /** `blocking` stops the step; `unsupported` means the return can't be prepared in this app. */
  kind: z.enum(["blocking", "unsupported"]),
  message: z.string(),
});
export type Issue = z.infer<typeof issueSchema>;

export const STEPS = ["household", "upload", "applies", "confirm", "deductions", "finish"] as const;
export const stepSchema = z.enum(STEPS);
export type Step = z.infer<typeof stepSchema>;
export const stepStatusSchema = z.enum(["done", "todo", "not_built"]);

export const taxYearSchema = z.strictObject({
  year: z.number().int(),
  /** Bumped on every change to the year's household facts; a save names the revision it started from. */
  revision: z.number().int().min(1),
  maritalStatus: maritalStatusSchema.nullable(),
  prepareTogether: z.boolean(),
  people: z.array(personSchema),
  adults: z.array(adultYearSchema),
  issues: z.array(issueSchema),
  steps: z.record(stepSchema, stepStatusSchema),
  updatedAt: z.number().int(),
});
export type TaxYear = z.infer<typeof taxYearSchema>;

export const startYearSchema = z.strictObject({ year: yearSchema });

export const saveHouseholdSchema = z.strictObject({
  revision: z.number().int().min(1),
  maritalStatus: maritalStatusSchema.nullable(),
  prepareTogether: z.boolean(),
  adults: z
    .array(
      z.strictObject({
        personId: idSchema,
        province: provinceSchema.nullable(),
        residentAllYear: z.boolean().nullable(),
      }),
    )
    .max(2),
});
export type SaveHousehold = z.infer<typeof saveHouseholdSchema>;

export const yearSummarySchema = z.strictObject({
  year: z.number().int(),
  /** The adults whose returns are prepared, by name. */
  filers: z.array(z.string()),
  steps: z.record(stepSchema, stepStatusSchema),
  updatedAt: z.number().int(),
});
export const yearListSchema = z.strictObject({
  supportedYears: z.array(z.number().int()),
  years: z.array(yearSummarySchema),
  people: z.array(personSchema),
});
export type YearList = z.infer<typeof yearListSchema>;

/** The tax filing deadline for most people, for a tax year (April 30 of the next year). */
export function filingDeadline(year: number): string {
  return `${year + 1}-04-30`;
}
