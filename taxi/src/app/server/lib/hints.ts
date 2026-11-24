import type { DecideHint, HintList, HintView, TaxYear } from "#shared";
import { findHints, type FoundHint } from "../../shared/engine/hints.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { audit, bumpRevision, getYear, runGuarded } from "./people.ts";
import { ApiError, conflict, logError, notFound } from "./http.ts";
import type { Caller } from "./identity.ts";
import { answerStatement, checkAdult, openYear } from "./returns.ts";
import { engineInputOf, loadWorkspace, type Workspace } from "./workspace.ts";

// A year's hints (rules/<country>/<year>/hints.yaml), worked out on every read from what is stored, with each return's
// decisions: an accepted saving is applied (its answers saved, the ones it changed kept to undo it), a dismissed hint
// is hidden. Like every change to a year, a decision saves under the year's revision.

type Db = D1Database;
type Answer = string | boolean;
type AnswersByPerson = Record<string, Record<string, Answer | null>>;

interface DecisionRow {
  person_id: string;
  hint: string;
  decision: "accepted" | "dismissed";
  effect: string | null;
  previous: string;
}

export async function listHints(db: Db, orgId: string, year: number): Promise<HintList> {
  const { row, view } = await openYear(db, orgId, year);
  const [workspace, decisions] = await Promise.all([loadWorkspace(db, orgId, row.id), loadDecisions(db, orgId, row.id)]);
  const rules = rulesFor(view.country, year)!;
  const adults = new Set(view.adults.map((adult) => adult.personId));
  const decisionOf = (personId: string, hint: string) => decisions.find((each) => each.person_id === personId && each.hint === hint);
  const offers = hintsOf(view, workspace);
  const applied = stillApplied(decisions, offers, workspace.answers);
  const hints: HintView[] = [];
  for (const decision of applied) {
    const hint = rules.hints.get(decision.hint);
    if (!hint || !adults.has(decision.person_id)) continue;
    hints.push({
      id: hint.id,
      personId: decision.person_id,
      kind: hint.kind,
      title: hint.title,
      text: hint.text,
      amount: null,
      effect: decision.effect,
      effectLabel: null,
      state: "applied",
    });
  }
  for (const hint of offers) {
    const decision = decisionOf(hint.personId, hint.id);
    if (decision && applied.includes(decision)) continue;
    hints.push({
      id: hint.id,
      personId: hint.personId,
      kind: hint.kind,
      title: hint.title,
      text: hint.text,
      amount: hint.amount,
      effect: hint.effect,
      effectLabel: hint.effectLabel,
      state: decision?.decision === "dismissed" ? "dismissed" : "open",
    });
  }
  return { revision: row.revision, hints };
}

export async function decideHint(db: Db, caller: Caller, year: number, hintId: string, input: DecideHint, now: number): Promise<TaxYear> {
  const { row, view } = await openYear(db, caller.orgId, year);
  checkAdult(view, input.personId, "personId");
  const hint = rulesFor(view.country, year)!.hints.get(hintId);
  if (!hint) throw notFound(`There is no hint ${hintId} for ${year}`);
  const decisions = await loadDecisions(db, caller.orgId, row.id);
  const current = decisions.find((each) => each.person_id === input.personId && each.hint === hintId);
  const forget = db
    .prepare("DELETE FROM hint_decisions WHERE org_id = ? AND tax_year_id = ? AND person_id = ? AND hint = ?")
    .bind(caller.orgId, row.id, input.personId, hintId);
  const record = (decision: DecisionRow["decision"], effect: string | null, previous: { before: AnswersByPerson; after: AnswersByPerson } | Record<string, never>) =>
    db
      .prepare(
        `INSERT INTO hint_decisions (id, org_id, tax_year_id, person_id, hint, decision, effect, previous, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), caller.orgId, row.id, input.personId, hintId, decision, effect, JSON.stringify(previous), caller.userId, now);

  const statements: D1PreparedStatement[] = [bumpRevision(db, caller.orgId, row.id, input.revision, now)];
  switch (input.decision) {
    case "accept": {
      if (hint.kind !== "saving") {
        throw new ApiError("validation_failed", "Only a saving can be accepted", [{ path: "decision", message: "This hint is only something to know: dismiss it" }]);
      }
      const workspace = await loadWorkspace(db, caller.orgId, row.id);
      const offer = hintsOf(view, workspace).find((each) => each.id === hintId && each.personId === input.personId);
      if (!offer) throw conflict("This hint doesn't apply to the return any more. Reload to see its hints now.");
      // The answers it changes as they were, to undo it, and as it sets them, to tell later whether it still holds.
      const before: AnswersByPerson = {};
      const after: AnswersByPerson = {};
      for (const change of offer.change) {
        (before[change.personId] ??= {})[change.question] = workspace.answers[change.personId]?.[change.question] ?? null;
        (after[change.personId] ??= {})[change.question] = change.value;
      }
      statements.push(
        ...offer.change.map((change) => answerStatement(db, caller.orgId, row.id, change.personId, change.question, change.value, now)),
        // A saving accepted replaces any earlier one of the same hint in the year (from either return: an allocation
        // moved back the other way), whose answers it has just changed.
        db.prepare("DELETE FROM hint_decisions WHERE org_id = ? AND tax_year_id = ? AND hint = ? AND decision = 'accepted'").bind(caller.orgId, row.id, hintId),
        forget,
        record("accepted", offer.effect, { before, after }),
        audit(db, caller, "hint.accepted", row.id, now),
      );
      break;
    }
    case "dismiss": {
      // A saving that still holds is undone, not dismissed; one whose answers were changed since is offered again,
      // with Dismiss, so its old decision is replaced.
      if (current?.decision === "accepted") {
        const workspace = await loadWorkspace(db, caller.orgId, row.id);
        if (stillApplied([current], hintsOf(view, workspace), workspace.answers).length > 0) throw conflict("This saving is applied. Undo it to dismiss it.");
      }
      statements.push(forget, record("dismissed", null, {}), audit(db, caller, "hint.dismissed", row.id, now));
      break;
    }
    case "undo": {
      if (!current) throw notFound("There is no decision on this hint to undo");
      // A saving that no longer holds is only forgotten: its earlier answers would overwrite the ones entered since.
      const workspace = await loadWorkspace(db, caller.orgId, row.id);
      const holds = current.decision !== "accepted" || stillApplied([current], hintsOf(view, workspace), workspace.answers).length > 0;
      const adults = new Set(view.adults.map((adult) => adult.personId));
      const previous = holds ? changeOf(current.previous).before : {};
      for (const [personId, answers] of Object.entries(previous)) {
        if (!adults.has(personId)) continue;
        for (const [question, value] of Object.entries(answers)) statements.push(answerStatement(db, caller.orgId, row.id, personId, question, value, now));
      }
      statements.push(forget, audit(db, caller, "hint.undone", row.id, now));
      break;
    }
  }
  await runGuarded(db, statements);
  return getYear(db, caller.orgId, year);
}

/**
 * An accepted saving's answers: `before` it, to undo it, and as it set them (`after`). A decision saved before `after`
 * was kept is the bare `before` map (its keys are person ids, never "before").
 */
function changeOf(previous: string): { before: AnswersByPerson; after: AnswersByPerson | null } {
  const value = JSON.parse(previous) as AnswersByPerson | { before: AnswersByPerson; after: AnswersByPerson };
  return "before" in value && "after" in value ? (value as { before: AnswersByPerson; after: AnswersByPerson }) : { before: value as AnswersByPerson, after: null };
}

/**
 * The accepted savings that still hold: every answer they set is still what they set. One whose answers were changed
 * since (by hand, or by taking someone out of the year) shows as open again, isn't printed as applied, can be
 * dismissed, and undoing it only forgets it, so its earlier answers never overwrite newer ones. The engine offering
 * the same hint again doesn't by itself undo it (a second T2202 can raise the tuition to transfer). A decision without
 * `after` holds while the engine doesn't offer it again.
 */
export function stillApplied<T extends Pick<DecisionRow, "person_id" | "hint" | "decision" | "previous">>(
  decisions: T[],
  offers: FoundHint[],
  answers: Record<string, Record<string, Answer>>,
): T[] {
  return decisions.filter((decision) => {
    if (decision.decision !== "accepted") return false;
    const { after } = changeOf(decision.previous);
    if (after === null) return !offers.some((offer) => offer.id === decision.hint && offer.personId === decision.person_id);
    return Object.entries(after).every(([personId, set]) => Object.entries(set).every(([question, value]) => (answers[personId]?.[question] ?? null) === value));
  });
}

/** The hints the year's returns get from what is stored; none when the rules can't read it (logged). */
export function hintsOf(view: TaxYear, workspace: Workspace): FoundHint[] {
  const rules = rulesFor(view.country, view.year);
  if (!rules || view.adults.length === 0) return [];
  try {
    // A hint that files the year the other way works out from what is stored, as the year would be filed.
    return findHints(rules, engineInputOf(view, workspace), (_, filingStatus) => engineInputOf({ ...view, filingStatus }, workspace));
  } catch (error) {
    logError("hints_failed", error, { year: view.year });
    return [];
  }
}

async function loadDecisions(db: Db, orgId: string, taxYearId: string): Promise<DecisionRow[]> {
  const rows = await db
    .prepare("SELECT person_id, hint, decision, effect, previous FROM hint_decisions WHERE org_id = ? AND tax_year_id = ? ORDER BY decided_at, id")
    .bind(orgId, taxYearId)
    .all<DecisionRow>();
  return rows.results;
}
