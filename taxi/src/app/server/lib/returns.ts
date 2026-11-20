import type { ConfirmSlips, CreateSlip, SaveAnswers, SlipList, TaxYear, UpdateSlip } from "#shared";
import { Dec } from "../../shared/engine/decimal.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { audit, bumpRevision, getYear, runGuarded, yearRow, type YearRow } from "./people.ts";
import { ApiError, notFound } from "./http.ts";
import type { Caller } from "./identity.ts";
import { loadWorkspace } from "./workspace.ts";

// Each adult's answers and slips for a year. Every change is one batch under the year's revision (the same guard as
// the family facts), with its audit event, and answers with the year: its new revision and steps.

type Db = D1Database;

export async function openYear(db: Db, orgId: string, year: number): Promise<{ row: YearRow; view: TaxYear }> {
  const row = await yearRow(db, orgId, year);
  if (!row) throw notFound(`The ${year} tax year hasn't been started`);
  return { row, view: await getYear(db, orgId, year) };
}

/** The adult must be one whose return is prepared this year. */
export function checkAdult(view: TaxYear, personId: string, path: string): void {
  if (!view.adults.some((adult) => adult.personId === personId)) {
    throw new ApiError("validation_failed", "Only the year's adults have returns here", [{ path, message: "Not an adult of this year" }]);
  }
}

export async function listSlips(db: Db, orgId: string, year: number): Promise<SlipList> {
  const { row } = await openYear(db, orgId, year);
  return { revision: row.revision, slips: (await loadWorkspace(db, orgId, row.id)).slips };
}

/** Saves answers to the year's questions, each checked against its question; null clears one. */
export async function saveAnswers(db: Db, caller: Caller, year: number, input: SaveAnswers, now: number): Promise<TaxYear> {
  const { row, view } = await openYear(db, caller.orgId, year);
  checkAdult(view, input.personId, "personId");
  const rules = rulesFor(year)!;
  const issues: { path: string; message: string }[] = [];
  for (const [id, value] of Object.entries(input.answers)) {
    const question = rules.questions.get(id);
    const path = `answers.${id}`;
    if (!question) issues.push({ path, message: "Not a question of this year" });
    else if (value === null) continue;
    else if (question.type === "money" && !(typeof value === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(value))) {
      issues.push({ path, message: "Enter an amount like 1234.56" });
    } else if (question.type === "percent" && !(typeof value === "string" && /^\d{1,3}(\.\d{1,2})?$/.test(value) && Number(value) <= 100)) {
      issues.push({ path, message: "Enter a percent from 0 to 100, like 12.5" });
    } else if (question.type === "count" && !(typeof value === "string" && /^\d{1,3}$/.test(value))) {
      issues.push({ path, message: "Enter a whole number from 0 to 999" });
    } else if (question.type === "boolean" && typeof value !== "boolean") issues.push({ path, message: "Answer yes or no" });
    else if (question.type === "choice" && !(typeof value === "string" && question.options!.includes(value))) {
      issues.push({ path, message: `Choose one of ${question.options!.join(", ")}` });
    }
  }
  if (issues.length > 0) throw new ApiError("validation_failed", "Some answers don't fit their questions", issues);
  await runGuarded(db, [
    bumpRevision(db, caller.orgId, row.id, input.revision, now),
    ...Object.entries(input.answers).map(([question, value]) => answerStatement(db, caller.orgId, row.id, input.personId, question, value, now)),
    audit(db, caller, "answers.saved", row.id, now),
  ]);
  return getYear(db, caller.orgId, year);
}

/** Saves one answer, or clears it (null). */
export function answerStatement(db: Db, orgId: string, taxYearId: string, personId: string, question: string, value: string | boolean | null, now: number): D1PreparedStatement {
  if (value === null) {
    return db.prepare("DELETE FROM answers WHERE org_id = ? AND tax_year_id = ? AND person_id = ? AND question = ?").bind(orgId, taxYearId, personId, question);
  }
  return db
    .prepare(
      `INSERT INTO answers (id, org_id, tax_year_id, person_id, question, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tax_year_id, person_id, question) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(crypto.randomUUID(), orgId, taxYearId, personId, question, JSON.stringify(canonical(value)), now, now);
}

/** Money as canonical decimal text ("1200.5" not "1200.50"), so equal amounts are stored alike. */
function canonical(value: string | boolean): string | boolean {
  return typeof value === "string" && /^\d/.test(value) ? Dec.from(value).toString() : value;
}

/** The slip's type must be one of the year's, and every box one that type has. */
function checkSlip(year: number, type: string, boxes: Record<string, string> | undefined): Record<string, string> | undefined {
  const slip = rulesFor(year)!.slips.get(type);
  if (!slip) throw new ApiError("validation_failed", "Not a slip type of this year", [{ path: "type", message: "Unknown slip type" }]);
  if (!boxes) return undefined;
  const unknown = Object.keys(boxes).filter((box) => !(box in slip.boxes));
  if (unknown.length > 0) {
    throw new ApiError(
      "validation_failed",
      `${type} has boxes ${Object.keys(slip.boxes).join(", ")}`,
      unknown.map((box) => ({ path: `boxes.${box}`, message: `${type} has no box ${box}` })),
    );
  }
  return Object.fromEntries(Object.entries(boxes).map(([box, amount]) => [box, Dec.from(amount).toString()]));
}

export async function addSlip(db: Db, caller: Caller, year: number, input: CreateSlip, now: number): Promise<TaxYear> {
  const { row, view } = await openYear(db, caller.orgId, year);
  checkAdult(view, input.personId, "personId");
  const boxes = checkSlip(year, input.type, input.boxes)!;
  const id = crypto.randomUUID();
  await runGuarded(db, [
    bumpRevision(db, caller.orgId, row.id, input.revision, now),
    db
      .prepare(
        `INSERT INTO slips (id, org_id, tax_year_id, person_id, type, issuer, boxes, status, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unconfirmed', 'manual', ?, ?)`,
      )
      .bind(id, caller.orgId, row.id, input.personId, input.type, input.issuer, JSON.stringify(boxes), now, now),
    audit(db, caller, "slip.added", id, now),
  ]);
  return getYear(db, caller.orgId, year);
}

async function slipType(db: Db, orgId: string, taxYearId: string, id: string): Promise<string> {
  const slip = await db.prepare("SELECT type FROM slips WHERE id = ? AND org_id = ? AND tax_year_id = ?").bind(id, orgId, taxYearId).first<{ type: string }>();
  if (!slip) throw notFound("No such slip in this year");
  return slip.type;
}

/**
 * Changes whose slip it is, its issuer or its boxes; it goes back to unconfirmed, since nobody checked the change yet.
 * New boxes clear the boxes AI was unsure of: the person just entered them.
 */
export async function updateSlip(db: Db, caller: Caller, year: number, id: string, input: UpdateSlip, now: number): Promise<TaxYear> {
  const { row, view } = await openYear(db, caller.orgId, year);
  if (input.personId !== undefined) checkAdult(view, input.personId, "personId");
  const boxes = checkSlip(year, await slipType(db, caller.orgId, row.id, id), input.boxes);
  await runGuarded(db, [
    bumpRevision(db, caller.orgId, row.id, input.revision, now),
    db
      .prepare(
        `UPDATE slips SET person_id = coalesce(?, person_id), issuer = coalesce(?, issuer), boxes = coalesce(?, boxes),
           unsure = CASE WHEN ? IS NULL THEN unsure ELSE '[]' END,
           status = 'unconfirmed', confirmed_at = NULL, confirmed_by = NULL, updated_at = ?
         WHERE id = ? AND org_id = ? AND tax_year_id = ?`,
      )
      .bind(input.personId ?? null, input.issuer ?? null, boxes ? JSON.stringify(boxes) : null, boxes ? 1 : null, now, id, caller.orgId, row.id),
    audit(db, caller, "slip.changed", id, now),
  ]);
  return getYear(db, caller.orgId, year);
}

export async function removeSlip(db: Db, caller: Caller, year: number, id: string, revision: number, now: number): Promise<TaxYear> {
  const { row } = await openYear(db, caller.orgId, year);
  await slipType(db, caller.orgId, row.id, id);
  await runGuarded(db, [
    bumpRevision(db, caller.orgId, row.id, revision, now),
    db.prepare("DELETE FROM slips WHERE id = ? AND org_id = ? AND tax_year_id = ?").bind(id, caller.orgId, row.id),
    audit(db, caller, "slip.removed", id, now),
  ]);
  return getYear(db, caller.orgId, year);
}

/** Confirms the unconfirmed slips of one adult (or, with no person, of every adult), recording who did and when. */
export async function confirmSlips(db: Db, caller: Caller, year: number, input: ConfirmSlips, now: number): Promise<TaxYear> {
  const { row, view } = await openYear(db, caller.orgId, year);
  if (input.personId !== undefined) checkAdult(view, input.personId, "personId");
  await runGuarded(db, [
    bumpRevision(db, caller.orgId, row.id, input.revision, now),
    db
      .prepare(
        `UPDATE slips SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?, updated_at = ?
         WHERE org_id = ? AND tax_year_id = ? AND status = 'unconfirmed' AND (? IS NULL OR person_id = ?)`,
      )
      .bind(now, caller.userId, now, caller.orgId, row.id, input.personId ?? null, input.personId ?? null),
    audit(db, caller, "slips.confirmed", row.id, now),
  ]);
  return getYear(db, caller.orgId, year);
}
