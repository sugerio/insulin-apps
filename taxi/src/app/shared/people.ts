import { z } from "zod";

// The people and their tax years, as the browser, the server and API clients see them. The people (the profile)
// belong to one organization and are the same every year. Each tax year names who is in it (the person preparing always; their spouse
// when the two returns are prepared together; the dependants who lived with them) and records the facts that can
// change from year to year: marital status on December 31, each adult's province, whether they lived in Canada all
// year.

/**
 * The countries the app prepares returns for: Canada (the CRA's T1, and Revenu Québec's TP-1) and the United States
 * (federal Form 1040). A tax year is of one country.
 */
export const COUNTRIES = ["ca", "us"] as const;
export const countrySchema = z.enum(COUNTRIES);
export type Country = z.infer<typeof countrySchema>;
export const COUNTRY_NAMES: Record<Country, string> = { ca: "Canada", us: "United States" };

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

/**
 * Marital status on December 31, as the T1 asks it (page 1, "Your marital status on December 31"). A US year records
 * it too, and its filing status follows it: `separated` there is legally separated under a decree, which files as
 * unmarried; a couple only living apart is `married`.
 */
export const MARITAL_STATUSES = ["married", "common_law", "widowed", "divorced", "separated", "single"] as const;
export const maritalStatusSchema = z.enum(MARITAL_STATUSES);
export type MaritalStatus = z.infer<typeof maritalStatusSchema>;
/**
 * The statuses a year may record, from the Profile: with a spouse or partner in it, married or (in Canada) living
 * common-law (the tax treats both the same; the T1 has a box for each); without one, the other four. A separation
 * during the year isn't handled yet, so a profile with a spouse never records one.
 */
export function maritalStatusesFor(country: Country, hasSpouse: boolean): readonly MaritalStatus[] {
  if (hasSpouse) return country === "ca" ? ["married", "common_law"] : ["married"];
  return ["single", "widowed", "divorced", "separated"];
}

/** Province or territory of residence on December 31, by its two-letter code. */
export const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"] as const;
export const provinceSchema = z.enum(PROVINCES);
export type Province = z.infer<typeof provinceSchema>;
/** Each province's and territory's name, as the T1 asks for it in Step 1. */
export const PROVINCE_NAMES: Record<Province, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};
/** The provinces whose tax this app works out: all of them. A Quebec resident also files Revenu Québec's TP-1. */
export const SUPPORTED_PROVINCES: readonly Province[] = ["ON", "BC", "AB", "MB", "SK", "NB", "NL", "NS", "PE", "YT", "NT", "NU", "QC"];

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
  /** Prepared in this app: the person preparing, and their spouse when the spouse is in the year. */
  prepared: z.boolean(),
});
export type AdultYear = z.infer<typeof adultYearSchema>;

/** Something that stops a step from being finished, or that the app can't handle. */
export const issueSchema = z.strictObject({
  code: z.enum([
    "no_self",
    "no_marital_status",
    "marital_status_mismatch",
    "no_province",
    "no_residency",
    "unsupported_province",
  ]),
  /** The person it is about, if any. */
  personId: idSchema.nullable(),
  /** `blocking` stops the step; `unsupported` means the return can't be prepared in this app. */
  kind: z.enum(["blocking", "unsupported"]),
  message: z.string(),
});
export type Issue = z.infer<typeof issueSchema>;

/** Issues about the facts every return of the year shares (the marital status, who prepares): they are each return's. */
const SHARED_ISSUES: ReadonlySet<Issue["code"]> = new Set(["no_self", "no_marital_status", "marital_status_mismatch"]);
/** Whether an issue is one of an adult's return: about that adult, or about a fact the year's returns share. */
export const isIssueOf = (issue: Issue, personId: string) => SHARED_ISSUES.has(issue.code) || issue.personId === personId;

export const STEPS = ["personal", "upload", "income", "deductions", "credits", "confirm", "finish"] as const;
export const stepSchema = z.enum(STEPS);
export type Step = z.infer<typeof stepSchema>;
export const stepStatusSchema = z.enum(["done", "todo", "not_built"]);
export const stepStatusesSchema = z.record(stepSchema, stepStatusSchema);
export type StepStatuses = z.infer<typeof stepStatusesSchema>;

/** One adult's return in a year: whose it is and how far each of its steps is. */
export const returnProgressSchema = z.strictObject({
  personId: idSchema,
  steps: stepStatusesSchema,
});
export type ReturnProgress = z.infer<typeof returnProgressSchema>;

export const taxYearSchema = z.strictObject({
  year: z.number().int(),
  /** Whose return it is: Canada's or the United States'. A year is of one country. */
  country: countrySchema,
  /** Bumped on every change to the year's personal info; a save names the revision it started from. */
  revision: z.number().int().min(1),
  maritalStatus: maritalStatusSchema.nullable(),
  /** Whether both adults' returns are prepared: the spouse is one of the year's people. */
  prepareTogether: z.boolean(),
  /** Everyone in the profile, in or out of this year. */
  people: z.array(personSchema),
  /** The ids of the year's people, in the profile's order. */
  members: z.array(idSchema),
  /** The year's adults (you, and your spouse when in the year). */
  adults: z.array(adultYearSchema),
  issues: z.array(issueSchema),
  /** Each adult's return, in the order of `adults`: its steps' states. */
  returns: z.array(returnProgressSchema),
  updatedAt: z.number().int(),
});
export type TaxYear = z.infer<typeof taxYearSchema>;

const memberIdsSchema = z
  .array(idSchema)
  .min(1, "Choose at least yourself")
  .max(30)
  .refine((ids) => new Set(ids).size === ids.length, { message: "A person is listed twice" });

/** Start a year with the people in it: you, and whoever else is in this year. The country is Canada when not given. */
export const startYearSchema = z.strictObject({ year: yearSchema, country: countrySchema.default("ca"), people: memberIdsSchema });

/** Change who is in a year, from the revision you read. */
export const setYearPeopleSchema = z.strictObject({ revision: z.number().int().min(1), people: memberIdsSchema });
export type SetYearPeople = z.infer<typeof setYearPeopleSchema>;

export const savePersonalInfoSchema = z.strictObject({
  revision: z.number().int().min(1),
  maritalStatus: maritalStatusSchema.nullable(),
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
export type SavePersonalInfo = z.infer<typeof savePersonalInfoSchema>;

export const yearSummarySchema = z.strictObject({
  year: z.number().int(),
  country: countrySchema,
  /** The year's revision, to change who is in it from the list of years. */
  revision: z.number().int().min(1),
  /** The ids of the year's people, in the profile's order. */
  members: z.array(idSchema),
  /** Each adult's return: whose it is, by name, and its steps' states. */
  returns: z.array(returnProgressSchema.extend({ name: z.string() })),
  updatedAt: z.number().int(),
});
export const peopleListSchema = z.strictObject({ people: z.array(personSchema) });

export const yearListSchema = z.strictObject({
  /** The years a return can be prepared for, by country. */
  supported: z.array(z.strictObject({ country: countrySchema, years: z.array(z.number().int()) })),
  years: z.array(yearSummarySchema),
  people: z.array(personSchema),
});
export type YearList = z.infer<typeof yearListSchema>;

/**
 * The filing deadline for most people, for a tax year: April 30 of the next year in Canada; April 15 in the United
 * States (the next business day when it falls on a weekend or holiday; for 2025 returns, Wednesday April 15, 2026).
 */
export function filingDeadline(country: Country, year: number): string {
  return country === "ca" ? `${year + 1}-04-30` : `${year + 1}-04-15`;
}
