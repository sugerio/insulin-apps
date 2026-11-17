import {
  SUPPORTED_PROVINCES,
  STEPS,
  hasPartner,
  isAdult,
  type AdultYear,
  type CreatePerson,
  type Issue,
  type MaritalStatus,
  type Person,
  type Province,
  type Relationship,
  type SaveHousehold,
  type Step,
  type TaxYear,
  type UpdatePerson,
  type YearList,
} from "#shared";
import { ApiError, conflict, isConstraintError, notFound } from "./http.ts";
import type { Caller } from "./identity.ts";

// The household and its tax years in D1. Every statement names the caller's organization (`org_id`), so another
// organization's ids are simply not found. Each change is one batch, which D1 runs as one transaction, with its audit
// event in the same batch.

type Db = D1Database;

interface PersonRow {
  id: string;
  name: string;
  relationship: Relationship;
  birth_date: string;
}
interface YearRow {
  id: string;
  year: number;
  marital_status: MaritalStatus | null;
  prepare_together: number;
  revision: number;
  updated_at: number;
}
interface ReturnRow {
  person_id: string;
  province: Province | null;
  resident_all_year: number | null;
}

const RELATIONSHIP_ORDER: Record<Relationship, number> = { self: 0, spouse: 1, child: 2, other_dependant: 3 };

const toPerson = (row: PersonRow): Person => ({ id: row.id, name: row.name, relationship: row.relationship, birthDate: row.birth_date });

function audit(db: Db, caller: Caller, action: string, subjectId: string | null, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (id, org_id, at, actor_id, actor_name, access_via, action, subject_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), caller.orgId, now, caller.userId, caller.name, caller.accessVia, action, subjectId);
}

/** The organization's household id, made on first use (one per organization: a unique index decides a race). */
async function ensureHousehold(db: Db, orgId: string, now: number): Promise<string> {
  await db
    .prepare("INSERT INTO households (id, org_id, created_at) VALUES (?, ?, ?) ON CONFLICT(org_id) DO NOTHING")
    .bind(crypto.randomUUID(), orgId, now)
    .run();
  const row = await db.prepare("SELECT id FROM households WHERE org_id = ?").bind(orgId).first<{ id: string }>();
  if (!row) throw new Error("The household was not created");
  return row.id;
}

export async function listPeople(db: Db, orgId: string): Promise<Person[]> {
  const { results } = await db
    .prepare("SELECT id, name, relationship, birth_date FROM people WHERE org_id = ? ORDER BY created_at, id")
    .bind(orgId)
    .all<PersonRow>();
  return results
    .map(toPerson)
    .sort((a, b) => RELATIONSHIP_ORDER[a.relationship] - RELATIONSHIP_ORDER[b.relationship] || a.birthDate.localeCompare(b.birthDate));
}

// ---------------------------------------------------------------------------
// What a year's facts mean: who files, what is missing, what the app can't do

/** Whether an adult's return is prepared here: the person preparing always, their partner only together. */
export function isPrepared(person: Person, maritalStatus: MaritalStatus | null, prepareTogether: boolean): boolean {
  if (person.relationship === "self") return true;
  return person.relationship === "spouse" && prepareTogether && hasPartner(maritalStatus);
}

const PROVINCE_NAMES: Record<Province, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "the Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

/** The issues of a year's household facts: `blocking` ones stop the step, `unsupported` ones the return. */
export function assess(people: Person[], maritalStatus: MaritalStatus | null, prepareTogether: boolean, adults: AdultYear[]): Issue[] {
  const issues: Issue[] = [];
  const add = (code: Issue["code"], kind: Issue["kind"], personId: string | null, message: string) =>
    issues.push({ code, kind, personId, message });
  const self = people.find((person) => person.relationship === "self");
  const spouse = people.find((person) => person.relationship === "spouse");
  if (!self) add("no_self", "blocking", null, "Add yourself to the household.");
  if (maritalStatus === null) add("no_marital_status", "blocking", null, "Choose your marital status on December 31.");
  if (prepareTogether && hasPartner(maritalStatus) && !spouse) {
    add("no_spouse", "blocking", null, "Add your spouse or common-law partner, or prepare only your own return.");
  }
  if (spouse && maritalStatus !== null && !hasPartner(maritalStatus)) {
    add(
      "spouse_without_partner_status",
      "blocking",
      spouse.id,
      `${spouse.name} is listed as your spouse or partner, but your status on December 31 isn't married or common-law. Change one of them.`,
    );
  }
  for (const adult of adults.filter((entry) => entry.prepared)) {
    const name = people.find((person) => person.id === adult.personId)?.name ?? "This person";
    if (adult.province === null) add("no_province", "blocking", adult.personId, `Choose ${name}'s province on December 31.`);
    else if (!SUPPORTED_PROVINCES.includes(adult.province)) {
      add(
        "unsupported_province",
        "unsupported",
        adult.personId,
        `This app prepares returns for Ontario, British Columbia and Alberta. ${name}'s return for ${PROVINCE_NAMES[adult.province]} needs other software.`,
      );
    }
    if (adult.residentAllYear === null) add("no_residency", "blocking", adult.personId, `Say whether ${name} lived in Canada all year.`);
    else if (!adult.residentAllYear) {
      add("part_year_resident", "unsupported", adult.personId, `${name} moved to or from Canada during the year, which this app doesn't handle yet.`);
    }
  }
  return issues;
}

/** Each step's state: the household's from its issues; the later steps are built in later parts. */
export function stepStatuses(issues: Issue[]): Record<Step, "done" | "todo" | "not_built"> {
  const household = issues.some((issue) => issue.kind === "blocking") ? "todo" : "done";
  return Object.fromEntries(STEPS.map((step) => [step, step === "household" ? household : "not_built"])) as Record<
    Step,
    "done" | "todo" | "not_built"
  >;
}

// ---------------------------------------------------------------------------
// Reads

async function yearRow(db: Db, orgId: string, year: number): Promise<YearRow | null> {
  return db
    .prepare(
      `SELECT id, year, marital_status, prepare_together, revision, updated_at
       FROM tax_years WHERE org_id = ? AND year = ?`,
    )
    .bind(orgId, year)
    .first<YearRow>();
}

async function viewOf(db: Db, orgId: string, row: YearRow): Promise<TaxYear> {
  const [people, returns] = await Promise.all([
    listPeople(db, orgId),
    db
      .prepare("SELECT person_id, province, resident_all_year FROM returns WHERE org_id = ? AND tax_year_id = ?")
      .bind(orgId, row.id)
      .all<ReturnRow>(),
  ]);
  const byPerson = new Map(returns.results.map((entry) => [entry.person_id, entry]));
  const prepareTogether = row.prepare_together === 1;
  const adults: AdultYear[] = people
    .filter((person) => isAdult(person.relationship))
    .map((person) => {
      const saved = byPerson.get(person.id);
      return {
        personId: person.id,
        province: saved?.province ?? null,
        residentAllYear: saved?.resident_all_year === null || saved?.resident_all_year === undefined ? null : saved.resident_all_year === 1,
        prepared: isPrepared(person, row.marital_status, prepareTogether),
      };
    });
  const issues = assess(people, row.marital_status, prepareTogether, adults);
  return {
    year: row.year,
    revision: row.revision,
    maritalStatus: row.marital_status,
    prepareTogether,
    people,
    adults,
    issues,
    steps: stepStatuses(issues),
    updatedAt: row.updated_at,
  };
}

export async function getYear(db: Db, orgId: string, year: number): Promise<TaxYear> {
  const row = await yearRow(db, orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
  return viewOf(db, orgId, row);
}

export async function listYears(db: Db, orgId: string, supportedYears: readonly number[]): Promise<YearList> {
  const { results } = await db
    .prepare(
      `SELECT id, year, marital_status, prepare_together, revision, updated_at
       FROM tax_years WHERE org_id = ? ORDER BY year DESC`,
    )
    .bind(orgId)
    .all<YearRow>();
  const years = await Promise.all(results.map((row) => viewOf(db, orgId, row)));
  return {
    supportedYears: [...supportedYears],
    people: await listPeople(db, orgId),
    years: years.map((view) => ({
      year: view.year,
      filers: view.adults
        .filter((adult) => adult.prepared)
        .map((adult) => view.people.find((person) => person.id === adult.personId)?.name ?? ""),
      steps: view.steps,
      updatedAt: view.updatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes

/** Starts a tax year; one that exists is returned as it is (the unique index settles a race). */
export async function startYear(db: Db, caller: Caller, year: number, now: number): Promise<{ view: TaxYear; created: boolean }> {
  const existing = await yearRow(db, caller.orgId, year);
  if (existing) return { view: await viewOf(db, caller.orgId, existing), created: false };
  const householdId = await ensureHousehold(db, caller.orgId, now);
  const id = crypto.randomUUID();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO tax_years (id, org_id, household_id, year, prepare_together, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?) ON CONFLICT(household_id, year) DO NOTHING`,
      )
      .bind(id, caller.orgId, householdId, year, now, now),
    audit(db, caller, "tax_year.started", id, now),
  ]);
  const row = await yearRow(db, caller.orgId, year);
  if (!row) throw new Error("The tax year was not created");
  return { view: await viewOf(db, caller.orgId, row), created: (inserted?.meta.changes ?? 0) > 0 };
}

/**
 * Saves a year's household facts under optimistic concurrency. The first statement bumps the revision only when it is
 * still the one the caller read, and otherwise writes -1, which `CHECK (revision >= 1)` refuses: the whole batch then
 * rolls back, the adults' facts included, and the caller gets a 409 to reload.
 */
export async function saveHousehold(db: Db, caller: Caller, year: number, input: SaveHousehold, now: number): Promise<TaxYear> {
  const row = await yearRow(db, caller.orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
  const people = await listPeople(db, caller.orgId);
  const adults = new Map(people.filter((person) => isAdult(person.relationship)).map((person) => [person.id, person]));
  const seen = new Set<string>();
  for (const [index, adult] of input.adults.entries()) {
    if (!adults.has(adult.personId) || seen.has(adult.personId)) {
      throw new ApiError("validation_failed", "Each adult must be you or your spouse, once", [
        { path: `adults.${index}.personId`, message: "Not an adult of this household" },
      ]);
    }
    seen.add(adult.personId);
  }
  const statements = [
    db
      .prepare(
        `UPDATE tax_years
         SET marital_status = ?, prepare_together = ?, updated_at = ?,
             revision = CASE WHEN revision = ? THEN revision + 1 ELSE -1 END
         WHERE id = ? AND org_id = ?`,
      )
      .bind(input.maritalStatus, input.prepareTogether ? 1 : 0, now, input.revision, row.id, caller.orgId),
    ...input.adults.map((adult) =>
      db
        .prepare(
          `INSERT INTO returns (id, org_id, tax_year_id, person_id, province, resident_all_year, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tax_year_id, person_id) DO UPDATE SET
             province = excluded.province, resident_all_year = excluded.resident_all_year, updated_at = excluded.updated_at`,
        )
        .bind(
          crypto.randomUUID(),
          caller.orgId,
          row.id,
          adult.personId,
          adult.province,
          adult.residentAllYear === null ? null : adult.residentAllYear ? 1 : 0,
          now,
          now,
        ),
    ),
    audit(db, caller, "household.saved", row.id, now),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error, "tax_years_revision") || isConstraintError(error, "revision >= 1")) {
      throw conflict("Someone else changed this year's household since you opened it. Reload to see their changes.");
    }
    throw error;
  }
  return getYear(db, caller.orgId, year);
}

function personConflict(error: unknown): never {
  if (isConstraintError(error, "people.household_id")) {
    throw conflict("The household already has that person: there can be one of you and one spouse or partner.");
  }
  throw error;
}

export async function addPerson(db: Db, caller: Caller, input: CreatePerson, now: number): Promise<Person> {
  const householdId = await ensureHousehold(db, caller.orgId, now);
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO people (id, org_id, household_id, name, relationship, birth_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, caller.orgId, householdId, input.name, input.relationship, input.birthDate, now, now),
      audit(db, caller, "person.added", id, now),
    ]);
  } catch (error) {
    personConflict(error);
  }
  return { id, ...input };
}

async function personRow(db: Db, orgId: string, id: string): Promise<PersonRow> {
  const row = await db
    .prepare("SELECT id, name, relationship, birth_date FROM people WHERE org_id = ? AND id = ?")
    .bind(orgId, id)
    .first<PersonRow>();
  if (!row) throw notFound("Person not found");
  return row;
}

export async function updatePerson(db: Db, caller: Caller, id: string, input: UpdatePerson, now: number): Promise<Person> {
  const current = await personRow(db, caller.orgId, id);
  // The person preparing stays themselves: who "you" are is the one fact the household is built around.
  if (input.relationship !== undefined && (current.relationship === "self") !== (input.relationship === "self")) {
    throw conflict("You can't change who \"you\" are. Add or remove people instead.");
  }
  const next = { ...toPerson(current), ...input };
  try {
    await db.batch([
      db
        .prepare("UPDATE people SET name = ?, relationship = ?, birth_date = ?, updated_at = ? WHERE id = ? AND org_id = ?")
        .bind(next.name, next.relationship, next.birthDate, now, id, caller.orgId),
      // A person who is no longer an adult files no return.
      ...(isAdult(next.relationship)
        ? []
        : [db.prepare("DELETE FROM returns WHERE person_id = ? AND org_id = ?").bind(id, caller.orgId)]),
      audit(db, caller, "person.changed", id, now),
    ]);
  } catch (error) {
    personConflict(error);
  }
  return next;
}

export async function removePerson(db: Db, caller: Caller, id: string, now: number): Promise<void> {
  const current = await personRow(db, caller.orgId, id);
  if (current.relationship === "self") throw conflict("You can't remove yourself from the household.");
  await db.batch([
    db.prepare("DELETE FROM returns WHERE person_id = ? AND org_id = ?").bind(id, caller.orgId),
    db.prepare("DELETE FROM people WHERE id = ? AND org_id = ?").bind(id, caller.orgId),
    audit(db, caller, "person.removed", id, now),
  ]);
}
