// The app's tables, in Drizzle's SQLite dialect. After changing this file, run `npm run db:generate` to write the
// migration; never edit a published migration.
//
// Conventions: ids are server-made UUIDs. Every table carries `org_id`, the platform's organization id from
// `getCurrentUser().organizationId`, and every query names it, so one organization never reads another's rows.
// Instants are INTEGER Unix epoch milliseconds (`*_at`); dates are TEXT 'YYYY-MM-DD'; booleans are INTEGER 0/1.
//
// Never stored: a SIN, a home address or bank details. People write those on the paper return when they sign it.
import { sql } from "drizzle-orm";
import { blob, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { MARITAL_STATUSES, PROVINCES, RELATIONSHIPS } from "../shared/household.ts";

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((value) => `'${value}'`).join(", ")})`);

/** One household per organization, made by the first change. */
export const households = sqliteTable(
  "households",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("households_org_unique").on(table.orgId)],
);

/** The people in the household. At most one `self` and one `spouse` per household (partial unique indexes). */
export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    relationship: text("relationship", { enum: RELATIONSHIPS }).notNull(),
    birthDate: text("birth_date").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("people_org").on(table.orgId),
    uniqueIndex("people_one_self").on(table.householdId).where(sql`relationship = 'self'`),
    uniqueIndex("people_one_spouse").on(table.householdId).where(sql`relationship = 'spouse'`),
    check("people_relationship", inList("relationship", RELATIONSHIPS)),
    check("people_name_length", sql`length(name) BETWEEN 1 AND 100`),
    check("people_birth_date", sql`birth_date GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'`),
  ],
);

/**
 * A tax year of the household: the facts that change from year to year, under one revision. Whether the two adults'
 * returns are prepared together isn't stored: it is whether the spouse is one of the year's people.
 */
export const taxYears = sqliteTable(
  "tax_years",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    maritalStatus: text("marital_status", { enum: MARITAL_STATUSES }),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("tax_years_household_year").on(table.householdId, table.year),
    index("tax_years_org").on(table.orgId),
    check("tax_years_marital_status", sql`marital_status IS NULL OR ${inList("marital_status", MARITAL_STATUSES)}`),
    check("tax_years_revision", sql`revision >= 1`),
  ],
);

/** Who is in a tax year: the person preparing always, their spouse when prepared together, and the dependants. */
export const taxYearPeople = sqliteTable(
  "tax_year_people",
  {
    taxYearId: text("tax_year_id")
      .notNull()
      .references(() => taxYears.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.taxYearId, table.personId] }), index("tax_year_people_org").on(table.orgId)],
);

/** An adult's return for a tax year: their province on December 31 and whether they lived in Canada all year. */
export const returns = sqliteTable(
  "returns",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    taxYearId: text("tax_year_id")
      .notNull()
      .references(() => taxYears.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    province: text("province", { enum: PROVINCES }),
    residentAllYear: integer("resident_all_year", { mode: "boolean" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("returns_year_person").on(table.taxYearId, table.personId),
    index("returns_org").on(table.orgId),
    check("returns_province", sql`province IS NULL OR ${inList("province", PROVINCES)}`),
  ],
);

/**
 * An adult's answer to a question of the year's rules (`rules/<country>/<year>/questions.yaml`): money as decimal text,
 * yes/no, or a choice, as JSON. One row per person and question; clearing an answer deletes it.
 */
export const answers = sqliteTable(
  "answers",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    taxYearId: text("tax_year_id")
      .notNull()
      .references(() => taxYears.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    value: text("value").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("answers_year_person_question").on(table.taxYearId, table.personId, table.question),
    index("answers_org").on(table.orgId),
    check("answers_value_json", sql`json_valid(value)`),
  ],
);

export const SLIP_STATUSES = ["unconfirmed", "confirmed"] as const;
export const SLIP_SOURCES = ["manual", "ai"] as const;

/**
 * A tax slip of an adult for the year: its type (a slip type of the year's rules), who issued it, and its boxes as
 * printed, as a JSON object of box → decimal text. Any change sets it back to unconfirmed.
 */
export const slips = sqliteTable(
  "slips",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    taxYearId: text("tax_year_id")
      .notNull()
      .references(() => taxYears.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    issuer: text("issuer").notNull(),
    boxes: text("boxes").notNull(),
    status: text("status", { enum: SLIP_STATUSES }).notNull(),
    source: text("source", { enum: SLIP_SOURCES }).notNull(),
    /** The uploaded file AI read it from, for a slip with source `ai`. */
    documentId: text("document_id"),
    /** The boxes AI wasn't sure it read right, as a JSON array; checked first when confirming. */
    unsure: text("unsure").notNull().default("[]"),
    confirmedAt: integer("confirmed_at"),
    confirmedBy: text("confirmed_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("slips_year_person").on(table.taxYearId, table.personId),
    index("slips_org").on(table.orgId),
    check("slips_boxes_json", sql`json_valid(boxes) AND json_type(boxes) = 'object'`),
    check("slips_status", inList("status", SLIP_STATUSES)),
    check("slips_source", inList("source", SLIP_SOURCES)),
    check("slips_issuer_length", sql`length(issuer) BETWEEN 1 AND 100`),
    check("slips_unsure_json", sql`json_valid(unsure) AND json_type(unsure) = 'array'`),
  ],
);

export const DOCUMENT_STATUSES = ["read", "duplicate", "not_a_slip", "failed", "not_available"] as const;

/**
 * A file uploaded for a tax year (step 2): what it is, its SHA-256 (the same file uploaded twice is found by it), and
 * what reading it gave. The bytes are in `document_chunks`.
 */
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    taxYearId: text("tax_year_id")
      .notNull()
      .references(() => taxYears.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status", { enum: DOCUMENT_STATUSES }).notNull(),
    /** What reading found or why it didn't, for people. */
    message: text("message").notNull(),
    /** The model that read it, when one did. */
    modelId: text("model_id"),
    /** Whose return it was uploaded in; null for files uploaded before returns were per person. */
    personId: text("person_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("documents_year").on(table.taxYearId, table.createdAt),
    index("documents_year_sha").on(table.taxYearId, table.sha256),
    index("documents_org").on(table.orgId),
    check("documents_status", inList("status", DOCUMENT_STATUSES)),
    check("documents_name_length", sql`length(name) BETWEEN 1 AND 200`),
  ],
);

/** An uploaded file's bytes, in pieces of at most 256 KiB (a D1 row is limited in size). */
export const documentChunks = sqliteTable(
  "document_chunks",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    orgId: text("org_id").notNull(),
    bytes: blob("bytes").notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.chunkIndex] })],
);

/** Who changed what, and when: one row per change, never updated. */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    at: integer("at").notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name"),
    /** `browser`, `mcp` or `api`. */
    accessVia: text("access_via").notNull(),
    action: text("action").notNull(),
    subjectId: text("subject_id"),
  },
  (table) => [index("audit_events_org_at").on(table.orgId, table.at)],
);

/** The hourly usage report's claims (server/lib/usage-metrics.ts). */
export const metricsReports = sqliteTable("metrics_reports", {
  hour: integer("hour").primaryKey(),
  startedAt: integer("started_at").notNull(),
  sentAt: integer("sent_at"),
});
