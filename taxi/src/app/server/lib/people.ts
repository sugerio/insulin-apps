import {
  COUNTRY_NAMES,
  SUPPORTED_PROVINCES,
  isRegionOf,
  maritalStatusesFor,
  isAdult,
  type AdultYear,
  type Country,
  type CreatePerson,
  type FilingStatus,
  type Issue,
  type MaritalStatus,
  type Person,
  type Province,
  type Region,
  type Relationship,
  type SavePersonalInfo,
  type SetYearPeople,
  type TaxYear,
  type UpdatePerson,
  type YearList,
} from "#shared";
import { ApiError, conflict, isConstraintError, notFound } from "./http.ts";
import { loadWorkspace, stepStatuses } from "./workspace.ts";
import type { Caller } from "./identity.ts";

// The people (the profile) and their tax years in D1. People are the profile's, the same every year; a year names who is in it
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
  country: Country;
  marital_status: MaritalStatus | null;
  filing_status: FilingStatus | null;
  revision: number;
  updated_at: number;
}
interface ReturnRow {
  person_id: string;
  province: Province | null;
  state: Region | null;
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

/** The organization's profile id, made on first use (one per organization: a unique index decides a race). */
async function ensureProfile(db: Db, orgId: string, now: number): Promise<string> {
  await db
    .prepare("INSERT INTO households (id, org_id, created_at) VALUES (?, ?, ?) ON CONFLICT(org_id) DO NOTHING")
    .bind(crypto.randomUUID(), orgId, now)
    .run();
  const row = await db.prepare("SELECT id FROM households WHERE org_id = ?").bind(orgId).first<{ id: string }>();
  if (!row) throw new Error("The profile was not created");
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

const spouseStatuses = (country: Country) => (country === "ca" ? "choose married or living common-law" : "choose married");
const UNPARTNERED = "choose single, widowed, divorced or separated";

/**
 * The issues of a year: `blocking` ones stop the Personal info step, `unsupported` ones say a return can't be prepared
 * here. `adults` are the year's adults, each prepared.
 */
export function assess(
  country: Country,
  people: Person[],
  members: ReadonlySet<string>,
  maritalStatus: MaritalStatus | null,
  adults: AdultYear[],
  filingStatus: FilingStatus | null = null,
): Issue[] {
  const issues: Issue[] = [];
  const add = (code: Issue["code"], kind: Issue["kind"], personId: string | null, message: string) =>
    issues.push({ code, kind, personId, message });
  const self = people.find((person) => person.relationship === "self");
  // Who the profile says your partner is, in this year or not: the status follows it.
  const partner = people.find((person) => person.relationship === "spouse");
  if (!self || !members.has(self.id)) add("no_self", "blocking", null, "Add yourself to the profile and to this year.");
  if (maritalStatus === null) add("no_marital_status", "blocking", null, "Choose your marital status on December 31.");
  else if (!maritalStatusesFor(country, partner !== undefined).includes(maritalStatus)) {
    // Saved before the people in the Profile changed (a spouse added or removed): ask again.
    add(
      "marital_status_mismatch",
      "blocking",
      partner?.id ?? null,
      partner ? `${partner.name} is your spouse or partner in the Profile: ${spouseStatuses(country)}.` : `The Profile has no spouse or partner: ${UNPARTNERED}.`,
    );
  }
  // A married couple on a US return files jointly or separately; jointly, the spouse must be in the year.
  if (country === "us" && maritalStatus === "married") {
    if (filingStatus === null) add("no_filing_status", "blocking", null, "Choose whether you file jointly or separately.");
    else if (filingStatus === "joint" && adults.length < 2) {
      add("no_filing_status", "blocking", partner?.id ?? null, `${partner?.name ?? "Your spouse"} isn't in this year: add them to file jointly, or file separately.`);
    }
  }
  for (const adult of adults) {
    const name = people.find((person) => person.id === adult.personId)?.name ?? "This person";
    if (country === "ca") {
      if (adult.province === null) add("no_province", "blocking", adult.personId, `Choose ${name}'s province on December 31.`);
      else if (!SUPPORTED_PROVINCES.includes(adult.province as Province)) {
        add("unsupported_province", "unsupported", adult.personId, `${name}'s return for ${PROVINCE_NAMES[adult.province as Province]} needs other software.`);
      }
    } else if (adult.province === null) {
      // A US year asks the state: it decides the state return, and the federal rules for a community property state.
      // A state whose return the app doesn't prepare isn't an issue: the federal return is complete without it.
      add("no_province", "blocking", adult.personId, `Choose ${name}'s state on December 31.`);
    }
    if (adult.residentAllYear === null) {
      const question = country === "ca" ? `lived in Canada all year` : `was a U.S. citizen or resident alien all year`;
      add("no_residency", "blocking", adult.personId, `Say whether ${name} ${question}.`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Reads

export async function yearRow(db: Db, orgId: string, year: number): Promise<YearRow | null> {
  return db
    .prepare(
      `SELECT id, year, country, marital_status, filing_status, revision, updated_at
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
      .prepare("SELECT person_id, province, state, resident_all_year FROM returns WHERE org_id = ? AND tax_year_id = ?")
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
        province: (row.country === "us" ? saved?.state : saved?.province) ?? null,
        residentAllYear: saved?.resident_all_year === null || saved?.resident_all_year === undefined ? null : saved.resident_all_year === 1,
        prepared: true,
      };
    });
  const issues = assess(row.country, people, memberIds, row.marital_status, adults, row.filing_status);
  const members = people.filter((person) => memberIds.has(person.id)).map((person) => person.id);
  const workspace = await loadWorkspace(db, orgId, row.id);
  return {
    year: row.year,
    country: row.country,
    revision: row.revision,
    maritalStatus: row.marital_status,
    filingStatus: row.filing_status,
    prepareTogether: people.some((person) => person.relationship === "spouse" && memberIds.has(person.id)),
    people,
    members,
    adults,
    issues,
    returns: stepStatuses(
      { year: row.year, country: row.country, maritalStatus: row.marital_status, filingStatus: row.filing_status, people, members, adults },
      issues,
      workspace,
    ),
    updatedAt: row.updated_at,
  };
}

export async function getYear(db: Db, orgId: string, year: number): Promise<TaxYear> {
  const row = await yearRow(db, orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
  return viewOf(db, orgId, row);
}

export async function listYears(db: Db, orgId: string, supported: YearList["supported"]): Promise<YearList> {
  const { results } = await db
    .prepare(
      `SELECT id, year, country, marital_status, filing_status, revision, updated_at
       FROM tax_years WHERE org_id = ? ORDER BY year DESC`,
    )
    .bind(orgId)
    .all<YearRow>();
  const years = await Promise.all(results.map((row) => viewOf(db, orgId, row)));
  return {
    supported,
    people: await listPeople(db, orgId),
    years: years.map((view) => ({
      year: view.year,
      country: view.country,
      revision: view.revision,
      members: view.members,
      returns: view.returns.map((progress) => ({ ...progress, name: view.people.find((person) => person.id === progress.personId)?.name ?? "" })),
      updatedAt: view.updatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes

/** The year's people, checked: everyone is in the profile, and the person preparing is one of them. */
function checkMembers(people: Person[], ids: string[]): void {
  const known = new Set(people.map((person) => person.id));
  const unknown = ids.findIndex((id) => !known.has(id));
  if (unknown >= 0) {
    throw new ApiError("validation_failed", "Everyone in the year must be in the profile", [
      { path: `people.${unknown}`, message: "Not in this profile" },
    ]);
  }
  const self = people.find((person) => person.relationship === "self");
  if (!self) throw conflict("Add yourself to the profile first.");
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
  country: Country,
  memberIds: string[],
  now: number,
): Promise<{ view: TaxYear; created: boolean }> {
  const existing = await yearRow(db, caller.orgId, year);
  if (existing) {
    // A year is of one country: the profile can't hold Canada's and the United States' return for the same year.
    if (existing.country !== country) throw conflict(`The ${year} tax year was started for ${COUNTRY_NAMES[existing.country]}.`);
    return { view: await viewOf(db, caller.orgId, existing), created: false };
  }
  checkMembers(await listPeople(db, caller.orgId), memberIds);
  const profileId = await ensureProfile(db, caller.orgId, now);
  const id = crypto.randomUUID();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO tax_years (id, org_id, household_id, year, country, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(household_id, year) DO NOTHING`,
      )
      .bind(id, caller.orgId, profileId, year, country, now, now),
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
  // Another start won the race, for another country.
  if (row.country !== country) throw conflict(`The ${year} tax year was started for ${COUNTRY_NAMES[row.country]}.`);
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
export async function savePersonalInfo(db: Db, caller: Caller, year: number, input: SavePersonalInfo, now: number): Promise<TaxYear> {
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
  if (input.maritalStatus !== null && !maritalStatusesFor(view.country, hasSpouse).includes(input.maritalStatus)) {
    throw new ApiError("validation_failed", "The marital status doesn't match the Profile", [
      {
        path: "maritalStatus",
        message: hasSpouse ? `With a spouse or partner in the Profile, ${spouseStatuses(view.country)}` : `Without a spouse or partner in the Profile, ${UNPARTNERED}`,
      },
    ]);
  }
  // Only a married couple on a US return has a filing status: it is dropped when the status isn't married.
  if (input.filingStatus != null && (view.country !== "us" || input.maritalStatus !== "married")) {
    throw new ApiError("validation_failed", "Only a married couple on a US return has a filing status", [
      { path: "filingStatus", message: "Leave it empty unless married on a US return" },
    ]);
  }
  const filingStatus = input.maritalStatus === "married" ? (input.filingStatus === undefined ? row.filing_status : input.filingStatus) : null;
  // A Canadian year records a province, a US year a state (in its own column), in the same field.
  const index = input.adults.findIndex((adult) => adult.province !== null && !isRegionOf(view.country, adult.province));
  if (index >= 0) {
    throw new ApiError("validation_failed", view.country === "us" ? "A US year records a state" : "A Canadian year records a province", [
      { path: `adults.${index}.province`, message: view.country === "us" ? "Choose a US state" : "Choose a province or territory" },
    ]);
  }
  await runGuarded(db, [
    bumpRevision(db, caller.orgId, row.id, input.revision, now, "marital_status = ?, filing_status = ?, ", [input.maritalStatus, filingStatus]),
    ...input.adults.map((adult) =>
      db
        .prepare(
          `INSERT INTO returns (id, org_id, tax_year_id, person_id, province, state, resident_all_year, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tax_year_id, person_id) DO UPDATE SET
             province = excluded.province, state = excluded.state, resident_all_year = excluded.resident_all_year,
             updated_at = excluded.updated_at`,
        )
        .bind(
          crypto.randomUUID(),
          caller.orgId,
          row.id,
          adult.personId,
          view.country === "ca" ? adult.province : null,
          view.country === "us" ? adult.province : null,
          adult.residentAllYear === null ? null : adult.residentAllYear ? 1 : 0,
          now,
          now,
        ),
    ),
    audit(db, caller, "personal_info.saved", row.id, now),
  ]);
  return getYear(db, caller.orgId, year);
}

function personConflict(error: unknown): never {
  if (isConstraintError(error, "people.household_id")) {
    throw conflict("The profile already has that person: there can be one of you and one spouse or partner.");
  }
  throw error;
}

export async function addPerson(db: Db, caller: Caller, input: CreatePerson, now: number): Promise<Person> {
  const profileId = await ensureProfile(db, caller.orgId, now);
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO people (id, org_id, household_id, name, relationship, birth_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, caller.orgId, profileId, input.name, input.relationship, input.birthDate, now, now),
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

/**
 * Moves on the revision of every year the person is in, before a change to who files in those years or that takes
 * their facts out, so a save started from the year as read before is refused (409) rather than lost or failing.
 * Unguarded: the change is the profile's, not one year's someone opened.
 */
function bumpYearsOf(db: Db, orgId: string, personId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE tax_years SET revision = revision + 1, updated_at = ?
       WHERE org_id = ? AND id IN (SELECT tax_year_id FROM tax_year_people WHERE person_id = ? AND org_id = ?)`,
    )
    .bind(now, orgId, personId, orgId);
}

export async function updatePerson(db: Db, caller: Caller, id: string, input: UpdatePerson, now: number): Promise<Person> {
  const current = await personRow(db, caller.orgId, id);
  // The person preparing stays themselves: who "you" are is the one fact the profile is built around.
  if (input.relationship !== undefined && (current.relationship === "self") !== (input.relationship === "self")) {
    throw conflict("You can't change who \"you\" are. Add or remove people instead.");
  }
  // Only the fields sent are written, so two changes saved at the same time to different fields both stay.
  const fields = Object.entries({ name: input.name, relationship: input.relationship, birth_date: input.birthDate }).filter(([, value]) => value !== undefined);
  // A person who is no longer an adult files no return.
  const noReturn = input.relationship !== undefined && !isAdult(input.relationship);
  try {
    await db.batch([
      ...(input.relationship !== undefined ? [bumpYearsOf(db, caller.orgId, id, now)] : []),
      db
        .prepare(`UPDATE people SET ${fields.map(([column]) => `${column} = ?, `).join("")}updated_at = ? WHERE id = ? AND org_id = ?`)
        .bind(...fields.map(([, value]) => value), now, id, caller.orgId),
      ...(noReturn ? [db.prepare("DELETE FROM returns WHERE person_id = ? AND org_id = ?").bind(id, caller.orgId)] : []),
      audit(db, caller, "person.changed", id, now),
    ]);
  } catch (error) {
    personConflict(error);
  }
  return toPerson(await personRow(db, caller.orgId, id));
}

export async function removePerson(db: Db, caller: Caller, id: string, now: number): Promise<void> {
  const current = await personRow(db, caller.orgId, id);
  if (current.relationship === "self") throw conflict("You can't remove yourself from the profile.");
  await db.batch([
    bumpYearsOf(db, caller.orgId, id, now),
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
