import type { DecideHint, HintList, HintView, TaxYear } from "#shared";
import { findHints, type FoundHint } from "../../shared/engine/hints.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { audit, bumpRevision, getYear, runGuarded } from "./household.ts";
import { ApiError, conflict, logError, notFound } from "./http.ts";
import type { Caller } from "./identity.ts";
import { answerStatement, checkAdult, openYear } from "./returns.ts";
import { engineInputOf, loadWorkspace, type Workspace } from "./workspace.ts";

// A year's hints (rules/<country>/<year>/hints.yaml), worked out on every read from what is stored, with each return's
// decisions: an accepted saving is applied (its answers saved, the ones it changed kept to undo it), a dismissed hint
// is hidden. Like every change to a year, a decision saves under the year's revision.

type Db = D1Database;
type Answer = string | boolean;

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
  const rules = rulesFor(year)!;
  const adults = new Set(view.adults.map((adult) => adult.personId));
  const decisionOf = (personId: string, hint: string) => decisions.find((each) => each.person_id === personId && each.hint === hint);
  const hints: HintView[] = [];
  for (const decision of decisions) {
    const hint = rules.hints.get(decision.hint);
    if (decision.decision !== "accepted" || !hint || !adults.has(decision.person_id)) continue;
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
  for (const hint of hintsOf(view, workspace)) {
    const decision = decisionOf(hint.personId, hint.id);
    if (decision?.decision === "accepted") continue;
    hints.push({
      id: hint.id,
      personId: hint.personId,
      kind: hint.kind,
      title: hint.title,
      text: hint.text,
      amount: hint.amount,
      effect: hint.effect,
      effectLabel: hint.effectLabel,
      state: decision ? "dismissed" : "open",
    });
  }
  return { revision: row.revision, hints };
}

export async function decideHint(db: Db, caller: Caller, year: number, hintId: string, input: DecideHint, now: number): Promise<TaxYear> {
  const { row, view } = await openYear(db, caller.orgId, year);
  checkAdult(view, input.personId, "personId");
  const hint = rulesFor(year)!.hints.get(hintId);
  if (!hint) throw notFound(`There is no hint ${hintId} for ${year}`);
  const decisions = await loadDecisions(db, caller.orgId, row.id);
  const current = decisions.find((each) => each.person_id === input.personId && each.hint === hintId);
  const forget = db
    .prepare("DELETE FROM hint_decisions WHERE org_id = ? AND tax_year_id = ? AND person_id = ? AND hint = ?")
    .bind(caller.orgId, row.id, input.personId, hintId);
  const record = (decision: DecisionRow["decision"], effect: string | null, previous: Record<string, Record<string, Answer | null>>) =>
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
      const previous: Record<string, Record<string, Answer | null>> = {};
      for (const change of offer.change) (previous[change.personId] ??= {})[change.question] = workspace.answers[change.personId]?.[change.question] ?? null;
      statements.push(
        ...offer.change.map((change) => answerStatement(db, caller.orgId, row.id, change.personId, change.question, change.value, now)),
        // A saving accepted replaces any earlier one of the same hint in the year (from either return: an allocation
        // moved back the other way), whose answers it has just changed.
        db.prepare("DELETE FROM hint_decisions WHERE org_id = ? AND tax_year_id = ? AND hint = ? AND decision = 'accepted'").bind(caller.orgId, row.id, hintId),
        forget,
        record("accepted", offer.effect, previous),
        audit(db, caller, "hint.accepted", row.id, now),
      );
      break;
    }
    case "dismiss":
      if (current?.decision === "accepted") throw conflict("This saving is applied. Undo it to dismiss it.");
      statements.push(forget, record("dismissed", null, {}), audit(db, caller, "hint.dismissed", row.id, now));
      break;
    case "undo": {
      if (!current) throw notFound("There is no decision on this hint to undo");
      const adults = new Set(view.adults.map((adult) => adult.personId));
      const previous = JSON.parse(current.previous) as Record<string, Record<string, Answer | null>>;
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

/** The hints the year's returns get from what is stored; none when the rules can't read it (logged). */
function hintsOf(view: TaxYear, workspace: Workspace): FoundHint[] {
  const rules = rulesFor(view.year);
  if (!rules || view.adults.length === 0) return [];
  try {
    return findHints(rules, engineInputOf(view, workspace));
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
