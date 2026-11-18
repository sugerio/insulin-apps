import { STEPS, isIssueOf, type AdultYear, type Issue, type Person, type ReturnProgress, type Slip, type StepStatuses } from "#shared";
import { Evaluation, type EngineInput, type EvaluationResult } from "../../shared/engine/evaluate.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { logError } from "./http.ts";

// A year's slips and answers, as stored, and what they make: the engine input, the engine's result, and each step's
// state. Nothing computed is stored; every read computes again.

interface SlipRow {
  id: string;
  person_id: string;
  type: string;
  issuer: string;
  boxes: string;
  status: Slip["status"];
  source: Slip["source"];
  document_id: string | null;
  unsure: string;
  confirmed_at: number | null;
  updated_at: number;
}

export interface Workspace {
  slips: Slip[];
  /** Per person, their answers by question. */
  answers: Record<string, Record<string, string | boolean>>;
  /** The adults in whose returns a file was uploaded and read into slips. */
  uploadedIn: Set<string>;
}

export async function loadWorkspace(db: D1Database, orgId: string, taxYearId: string): Promise<Workspace> {
  const [slips, answers, documents] = await Promise.all([
    db
      .prepare(
        `SELECT id, person_id, type, issuer, boxes, status, source, document_id, unsure, confirmed_at, updated_at
         FROM slips WHERE org_id = ? AND tax_year_id = ? ORDER BY created_at, id`,
      )
      .bind(orgId, taxYearId)
      .all<SlipRow>(),
    db
      .prepare("SELECT person_id, question, value FROM answers WHERE org_id = ? AND tax_year_id = ?")
      .bind(orgId, taxYearId)
      .all<{ person_id: string; question: string; value: string }>(),
    db
      .prepare("SELECT DISTINCT person_id FROM documents WHERE org_id = ? AND tax_year_id = ? AND status = 'read' AND person_id IS NOT NULL")
      .bind(orgId, taxYearId)
      .all<{ person_id: string }>(),
  ]);
  const byPerson: Workspace["answers"] = {};
  for (const row of answers.results) {
    (byPerson[row.person_id] ??= {})[row.question] = JSON.parse(row.value) as string | boolean;
  }
  return {
    slips: slips.results.map((row) => ({
      id: row.id,
      personId: row.person_id,
      type: row.type,
      issuer: row.issuer,
      boxes: JSON.parse(row.boxes) as Record<string, string>,
      status: row.status,
      source: row.source,
      documentId: row.document_id,
      unsure: JSON.parse(row.unsure) as string[],
      confirmedAt: row.confirmed_at,
      updatedAt: row.updated_at,
    })),
    answers: byPerson,
    uploadedIn: new Set(documents.results.map((row) => row.person_id)),
  };
}

/** What the engine needs from a year: who files it, the household, and each adult's answers and slips. */
export interface YearFacts {
  year: number;
  maritalStatus: string | null;
  people: Person[];
  members: string[];
  adults: AdultYear[];
}

export function engineInputOf(facts: YearFacts, workspace: Workspace): EngineInput {
  const adults = new Set(facts.adults.map((adult) => adult.personId));
  return {
    year: facts.year,
    people: facts.adults.map((adult) => {
      const person = facts.people.find((each) => each.id === adult.personId)!;
      return { id: person.id, name: person.name, role: person.relationship === "self" ? "self" : "spouse", birthDate: person.birthDate, province: adult.province };
    }),
    household: {
      maritalStatus: facts.maritalStatus,
      dependants: facts.people
        .filter((person) => facts.members.includes(person.id) && (person.relationship === "child" || person.relationship === "other_dependant"))
        .map((person) => ({ id: person.id, name: person.name, birthDate: person.birthDate })),
    },
    answers: Object.fromEntries(Object.entries(workspace.answers).filter(([personId]) => adults.has(personId))),
    slips: workspace.slips
      .filter((slip) => adults.has(slip.personId))
      .map((slip) => ({ id: slip.id, person: slip.personId, type: slip.type, issuer: slip.issuer, boxes: slip.boxes })),
  };
}

/** The engine's result for a year, or null when the rules can't read what is stored (logged). */
export function evaluateYear(facts: YearFacts, workspace: Workspace): { input: EngineInput; result: EvaluationResult } | null {
  const rules = rulesFor(facts.year);
  if (!rules || facts.adults.length === 0) return null;
  const input = engineInputOf(facts, workspace);
  try {
    return { input, result: new Evaluation(rules, input).result() };
  } catch (error) {
    logError("evaluation_failed", error, { year: facts.year });
    return null;
  }
}

/**
 * Each adult's return and the state of its steps. Household: no blocking issue of the year's shared facts or of this
 * adult. Upload: a file was uploaded in this return and read into slips, or a slip of this adult was read from a file
 * (slips can also be typed in step 4). What applies: each of its questions is answered, or answered by a slip found,
 * and no slip said to exist is missing. Confirm: the adult has slips and all are confirmed. Deductions: no question of
 * the step that the adult's result lines read is left unanswered. Finish comes with the filled-in forms.
 */
export function stepStatuses(facts: YearFacts, issues: Issue[], workspace: Workspace): ReturnProgress[] {
  const rules = rulesFor(facts.year);
  const questions = [...(rules?.questions.values() ?? [])];
  // What applies: a question about a slip is answered by the slip itself; a yes without the slip is still missing.
  const applies = questions.filter((question) => question.step === "applies");
  const deductions = new Set(questions.filter((question) => question.step === "deductions").map((question) => question.id));
  const evaluation = evaluateYear(facts, workspace);
  return facts.adults.map(({ personId }) => {
    const slips = workspace.slips.filter((slip) => slip.personId === personId);
    const answers = workspace.answers[personId] ?? {};
    const reached = evaluation?.result.people.find((person) => person.personId === personId)?.questions;
    const status: StepStatuses = {
      household: issues.some((issue) => issue.kind === "blocking" && isIssueOf(issue, personId)) ? "todo" : "done",
      upload: workspace.uploadedIn.has(personId) || slips.some((slip) => slip.documentId !== null) ? "done" : "todo",
      applies: applies.every((question) => {
        if (question.slip && slips.some((slip) => slip.type === question.slip)) return true;
        const answer = answers[question.id];
        return answer !== undefined && !(question.slip && answer === true);
      })
        ? "done"
        : "todo",
      confirm: slips.length > 0 && slips.every((slip) => slip.status === "confirmed") ? "done" : "todo",
      deductions: reached !== undefined && reached.filter((id) => deductions.has(id)).every((id) => answers[id] !== undefined) ? "done" : "todo",
      finish: "todo",
    };
    return { personId, steps: Object.fromEntries(STEPS.map((step) => [step, status[step]])) as StepStatuses };
  });
}
