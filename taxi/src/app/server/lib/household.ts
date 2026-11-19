import {
  SUPPORTED_PROVINCES,
  maritalStatusesFor,
  isAdult,
  type AdultYear,
  type CreatePerson,
  type Issue,
  type MaritalStatus,
  type Person,
  type Province,
  type Relationship,
  type SaveHousehold,
  type SetYearPeople,
  type TaxYear,
  type UpdatePerson,
  type YearList,
} from "#shared";
import { ApiError, conflict, isConstraintError, notFound } from "./http.ts";
import { loadWorkspace, stepStatuses } from "./workspace.ts";
import type { Caller } from "./identity.ts";

// The household and its tax years in D1. People are the household's, the same every year; a year names who is in it
// (`tax_year_people`). Every statement names the caller's organization (`org_id`), so another
// organization's ids are simply not found. Each change is one batch, which D1 runs as one transaction, with its audit
// event in the same batch.

type Db = D1Database;

interface PersonRow {
  id: string;
  name: string;
  relationship: Relationship;
  birth_date: string;
}
export interface YearRow {
  id: string;
  year: number;
  marital_status: MaritalStatus | null;
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

export function audit(db: Db, caller: Caller, action: string, subjectId: string | null, now: number): D1PreparedStatement {
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

/**
 * The issues of a year: `blocking` ones stop the household step, `unsupported` ones say a return can't be prepared
 * here. `adults` are the year's adults, each prepared.
 */
export function assess(people: Person[], members: ReadonlySet<string>, maritalStatus: MaritalStatus | null, adults: AdultYear[]): Issue[] {
  const issues: Issue[] = [];
  const add = (code: Issue["code"], kind: Issue["kind"], personId: string | null, message: string) =>
    issues.push({ code, kind, personId, message });
  const self = people.find((person) => person.relationship === "self");
  // Who the household says your partner is, in this year or not: the status follows it.
  const partner = people.find((person) => person.relationship === "spouse");
  if (!self || !members.has(self.id)) add("no_self", "blocking", null, "Add yourself to the household and to this year.");
  if (maritalStatus === null) add("no_marital_status", "blocking", null, "Choose your marital status on December 31.");
  else if (!maritalStatusesFor(partner !== undefined).includes(maritalStatus)) {
    // Saved before the Household changed (a spouse added or removed): ask again.
    add(
      "marital_status_mismatch",
      "blocking",
      partner?.id ?? null,
      partner
        ? `${partner.name} is your spouse or partner in the Household: choose married or living common-law.`
        : "The Household has no spouse or partner: choose single, widowed, divorced or separated.",
    );
  }
  for (const adult of adults) {
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
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Reads

export async function yearRow(db: Db, orgId: string, year: number): Promise<YearRow | null> {
  return db
    .prepare(
      `SELECT id, year, marital_status, revision, updated_at
       FROM tax_years WHERE org_id = ? AND year = ?`,
    )
    .bind(orgId, year)
    .first<YearRow>();
}

async function viewOf(db: Db, orgId: string, row: YearRow): Promise<TaxYear> {
  const [people, memberRows, returns] = await Promise.all([
    listPeople(db, orgId),
    db.prepare("SELECT person_id FROM tax_year_people WHERE org_id = ? AND tax_year_id = ?").bind(orgId, row.id).all<{ person_id: string }>(),
    db
      .prepare("SELECT person_id, province, resident_all_year FROM returns WHERE org_id = ? AND tax_year_id = ?")
      .bind(orgId, row.id)
      .all<ReturnRow>(),
  ]);
  const memberIds = new Set(memberRows.results.map((entry) => entry.person_id));
  const byPerson = new Map(returns.results.map((entry) => [entry.person_id, entry]));
  const adults: AdultYear[] = people
    .filter((person) => isAdult(person.relationship) && memberIds.has(person.id))
    .map((person) => {
      const saved = byPerson.get(person.id);
      return {
        personId: person.id,
        province: saved?.province ?? null,
        residentAllYear: saved?.resident_all_year === null || saved?.resident_all_year === undefined ? null : saved.resident_all_year === 1,
        prepared: true,
      };
    });
  const issues = assess(people, memberIds, row.marital_status, adults);
  const members = people.filter((person) => memberIds.has(person.id)).map((person) => person.id);
  const workspace = await loadWorkspace(db, orgId, row.id);
  return {
    year: row.year,
    revision: row.revision,
    maritalStatus: row.marital_status,
    prepareTogether: people.some((person) => person.relationship === "spouse" && memberIds.has(person.id)),
    people,
    members,
    adults,
    issues,
    returns: stepStatuses({ year: row.year, maritalStatus: row.marital_status, people, members, adults }, issues, workspace),
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
      `SELECT id, year, marital_status, revision, updated_at
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
      revision: view.revision,
      members: view.members,
      returns: view.returns.map((progress) => ({ ...progress, name: view.people.find((person) => person.id === progress.personId)?.name ?? "" })),
      updatedAt: view.updatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes

/** The year's people, checked: everyone is in the household, and the person preparing is one of them. */
function checkMembers(people: Person[], ids: string[]): void {
  const known = new Set(people.map((person) => person.id));
  const unknown = ids.findIndex((id) => !known.has(id));
  if (unknown >= 0) {
    throw new ApiError("validation_failed", "Everyone in the year must be in the household", [
      { path: `people.${unknown}`, message: "Not in this household" },
    ]);
  }
  const self = people.find((person) => person.relationship === "self");
  if (!self) throw conflict("Add yourself to the household first.");
  if (!ids.includes(self.id)) {
    throw new ApiError("validation_failed", "You are always in your own tax year", [{ path: "people", message: "Include yourself" }]);
  }
}

const insertMember = (db: Db, orgId: string, taxYearId: string, personId: string, now: number) =>
  db
    .prepare(
      `INSERT INTO tax_year_people (tax_year_id, person_id, org_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tax_year_id, person_id) DO NOTHING`,
    )
    .bind(taxYearId, personId, orgId, now);

/**
 * Starts a tax year with the people in it. One that exists is returned as it is, whoever was asked for (the unique
 * index settles a race: the people go in only with the year this call inserted).
 */
export async function startYear(
  db: Db,
  caller: Caller,
  year: number,
  memberIds: string[],
  now: number,
): Promise<{ view: TaxYear; created: boolean }> {
  const existing = await yearRow(db, caller.orgId, year);
  if (existing) return { view: await viewOf(db, caller.orgId, existing), created: false };
  checkMembers(await listPeople(db, caller.orgId), memberIds);
  const householdId = await ensureHousehold(db, caller.orgId, now);
  const id = crypto.randomUUID();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO tax_years (id, org_id, household_id, year, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(household_id, year) DO NOTHING`,
      )
      .bind(id, caller.orgId, householdId, year, now, now),
    // Only into the year this batch made: when another start won the race, `id` names no row and nothing is added.
    ...memberIds.map((personId) =>
      db
        .prepare(
          `INSERT INTO tax_year_people (tax_year_id, person_id, org_id, created_at)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tax_years WHERE id = ?)`,
        )
        .bind(id, personId, caller.orgId, now, id),
    ),
    audit(db, caller, "tax_year.started", id, now),
  ]);
  const row = await yearRow(db, caller.orgId, year);
  if (!row) throw new Error("The tax year was not created");
  return { view: await viewOf(db, caller.orgId, row), created: (inserted?.meta.changes ?? 0) > 0 };
}

/**
 * The statement that bumps a year's revision only when it is still the one the caller read, and otherwise writes -1,
 * which `CHECK (revision >= 1)` refuses: the whole batch then rolls back and the caller gets a 409 to reload. It goes
 * first in every batch that changes a year.
 */
export function bumpRevision(db: Db, orgId: string, taxYearId: string, revision: number, now: number, set = "", values: unknown[] = []) {
  return db
    .prepare(
      `UPDATE tax_years SET ${set}updated_at = ?, revision = CASE WHEN revision = ? THEN revision + 1 ELSE -1 END
       WHERE id = ? AND org_id = ?`,
    )
    .bind(...values, now, revision, taxYearId, orgId);
}

export async function runGuarded(db: Db, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error, "tax_years_revision") || isConstraintError(error, "revision >= 1")) {
      throw conflict("Someone else changed this year since you opened it. Reload to see their changes.");
    }
    throw error;
  }
}

/** Changes who is in a year. Someone taken out loses their facts, answers, slips and hint decisions for that year. */
export async function setYearPeople(db: Db, caller: Caller, year: number, input: SetYearPeople, now: number): Promise<TaxYear> {
  const row = await yearRow(db, caller.orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
  checkMembers(await listPeople(db, caller.orgId), input.people);
  const keep = JSON.stringify(input.people);
  await runGuarded(db, [
    bumpRevision(db, caller.orgId, row.id, input.revision, now),
    db
      .prepare("DELETE FROM tax_year_people WHERE org_id = ? AND tax_year_id = ? AND person_id NOT IN (SELECT value FROM json_each(?))")
      .bind(caller.orgId, row.id, keep),
    // Someone taken out of the year takes their facts, answers, slips and hint decisions for that year with them.
    ...["returns", "answers", "slips", "hint_decisions"].map((table) =>
      db
        .prepare(`DELETE FROM ${table} WHERE org_id = ? AND tax_year_id = ? AND person_id NOT IN (SELECT value FROM json_each(?))`)
        .bind(caller.orgId, row.id, keep),
    ),
    ...input.people.map((personId) => insertMember(db, caller.orgId, row.id, personId, now)),
    audit(db, caller, "tax_year.people_changed", row.id, now),
  ]);
  return getYear(db, caller.orgId, year);
}

/** Saves a year's facts (marital status, each adult's province and residency) under the year's revision. */
export async function saveHousehold(db: Db, caller: Caller, year: number, input: SaveHousehold, now: number): Promise<TaxYear> {
  const row = await yearRow(db, caller.orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
  const view = await viewOf(db, caller.orgId, row);
  const adults = new Set(view.adults.map((adult) => adult.personId));
  const seen = new Set<string>();
  for (const [index, adult] of input.adults.entries()) {
    if (!adults.has(adult.personId) || seen.has(adult.personId)) {
      throw new ApiError("validation_failed", "Each adult must be you or your spouse in this year, once", [
        { path: `adults.${index}.personId`, message: "Not an adult of this year" },
      ]);
    }
    seen.add(adult.personId);
  }
  const hasSpouse = view.people.some((person) => person.relationship === "spouse");
  if (input.maritalStatus !== null && !maritalStatusesFor(hasSpouse).includes(input.maritalStatus)) {
    throw new ApiError("validation_failed", "The marital status doesn't match the Household", [
      {
        path: "maritalStatus",
        message: hasSpouse ? "With a spouse or partner in the Household, choose married or living common-law" : "Without a spouse or partner in the Household, choose single, widowed, divorced or separated",
      },
    ]);
  }
  await runGuarded(db, [
    bumpRevision(db, caller.orgId, row.id, input.revision, now, "marital_status = ?, ", [input.maritalStatus]),
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
  ]);
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
    db.prepare("DELETE FROM answers WHERE person_id = ? AND org_id = ?").bind(id, caller.orgId),
    db.prepare("DELETE FROM slips WHERE person_id = ? AND org_id = ?").bind(id, caller.orgId),
    db.prepare("DELETE FROM hint_decisions WHERE person_id = ? AND org_id = ?").bind(id, caller.orgId),
    db.prepare("UPDATE documents SET person_id = NULL WHERE person_id = ? AND org_id = ?").bind(id, caller.orgId),
    db.prepare("DELETE FROM tax_year_people WHERE person_id = ? AND org_id = ?").bind(id, caller.orgId),
    db.prepare("DELETE FROM people WHERE id = ? AND org_id = ?").bind(id, caller.orgId),
    audit(db, caller, "person.removed", id, now),
  ]);
}
