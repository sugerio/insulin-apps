import { STEPS, filesJointly, isIssueOf, leftInModule, printBlockers, returnsOf, spouseOf, type AdultYear, type Country, type FilingStatus, type Issue, type MaritalStatus, type Person, type PrintYear, type ReturnProgress, type Slip, type StepStatuses } from "#shared";
import { Evaluation, type EngineInput, type EvaluationResult } from "../../shared/engine/evaluate.ts";
import type { Module, RuleSet } from "../../shared/engine/rules.ts";
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

/** What the engine needs from a year: who files it, the family facts, and each adult's answers and slips. */
export interface YearFacts {
  year: number;
  country: Country;
  maritalStatus: MaritalStatus | null;
  filingStatus: FilingStatus | null;
  people: Person[];
  members: string[];
  adults: AdultYear[];
}

export function engineInputOf(facts: YearFacts, workspace: Workspace): EngineInput {
  const adults = new Set(facts.adults.map((adult) => adult.personId));
  return {
    country: facts.country,
    year: facts.year,
    people: facts.adults.map((adult) => {
      const person = facts.people.find((each) => each.id === adult.personId)!;
      return {
        id: person.id,
        name: person.name,
        role: person.relationship === "self" ? "self" : "spouse",
        birthDate: person.birthDate,
        province: adult.province,
        residentAllYear: adult.residentAllYear,
      };
    }),
    family: {
      maritalStatus: facts.maritalStatus,
      // Only a US return has a filing status: Canada's input stays as it was.
      ...(facts.country === "us" ? { filingStatus: facts.filingStatus } : {}),
      dependants: facts.people
        .filter((person) => facts.members.includes(person.id) && (person.relationship === "child" || person.relationship === "other_dependant"))
        .map((person) => {
          const answers = workspace.answers[person.id] ?? {};
          const claimedBy = claimerOf(facts, answers);
          return {
            id: person.id,
            name: person.name,
            birthDate: person.birthDate,
            ...(Object.keys(answers).length > 0 ? { answers } : {}),
            ...(claimedBy ? { claimedBy } : {}),
          };
        }),
    },
    answers: Object.fromEntries(Object.entries(workspace.answers).filter(([personId]) => adults.has(personId))),
    slips: workspace.slips
      .filter((slip) => adults.has(slip.personId))
      .map((slip) => ({ id: slip.id, person: slip.personId, type: slip.type, issuer: slip.issuer, boxes: slip.boxes })),
  };
}

/**
 * Whose return claims a dependant: the person preparing's (left out), except when a married couple on a US return
 * files separately and the dependant's `claimedBy` answer is the spouse.
 */
function claimerOf(facts: YearFacts, answers: Record<string, string | boolean>): string | undefined {
  const separate = facts.country === "us" && facts.maritalStatus === "married" && facts.filingStatus === "separate" && facts.adults.length === 2;
  if (!separate || answers.claimedBy !== "spouse") return undefined;
  return facts.adults.find((adult) => facts.people.find((person) => person.id === adult.personId)?.relationship === "spouse")?.personId;
}

/** The engine's result for a year, or null when the rules can't read what is stored (logged). */
export function evaluateYear(facts: YearFacts, workspace: Workspace): { input: EngineInput; result: EvaluationResult } | null {
  const rules = rulesFor(facts.country, facts.year);
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
 * Each adult's return and the state of its steps. Personal info: no blocking issue of the year's shared facts or of
 * this adult, and the questions about the person that the result reads are answered. Upload: a file was uploaded in
 * this return and read into slips, or a slip of this adult was read from a file (slips can also be typed in step 6).
 * Income, deductions and credits: each yes/no question of the module is answered, or answered by a slip found, no slip
 * said to exist is missing, and every amount the result reads is entered. Confirm: the adult has slips and all are
 * confirmed. Finish: the return is finished, so its CRA forms can be printed (shared/print.ts).
 */
export function stepStatuses(facts: YearFacts, issues: Issue[], workspace: Workspace): ReturnProgress[] {
  const rules = rulesFor(facts.country, facts.year);
  const evaluation = evaluateYear(facts, workspace);
  // Each return's steps cover everyone on it: on a joint return, both spouses' facts, answers and slips.
  return returnsOf(facts).map(({ personId, members }) => {
    const slips = workspace.slips.filter((slip) => members.includes(slip.personId));
    const result = evaluation?.result.people.find((person) => person.personId === personId);
    // Without an evaluation (the engine refused what is stored) nothing says which questions the return reads, so no
    // step that depends on them is done.
    const answered = (module: Module) =>
      evaluation !== null &&
      rules !== undefined &&
      members.every((member) => {
        const reached = evaluation.result.people.find((person) => person.personId === member)?.questions ?? [];
        const theirs = workspace.slips.filter((slip) => slip.personId === member);
        return leftInModule(rules, module, workspace.answers[member] ?? {}, theirs, reached).length === 0;
      }) &&
      // Personal info also asks about the dependants this return claims.
      (module !== "about" ||
        dependantsOf(evaluation, members).every((dependant) => leftInModule(rules, "about", workspace.answers[dependant.dependantId] ?? {}, [], dependant.questions).length === 0));
    const state = (done: boolean) => (done ? "done" : "todo");
    const status: StepStatuses = {
      personal: state(!issues.some((issue) => issue.kind === "blocking" && members.some((member) => isIssueOf(issue, member))) && answered("about")),
      upload: state(members.some((member) => workspace.uploadedIn.has(member)) || slips.some((slip) => slip.documentId !== null)),
      income: state(answered("income")),
      deductions: state(answered("deductions")),
      credits: state(answered("credits")),
      confirm: state(slips.length > 0 && slips.every((slip) => slip.status === "confirmed")),
      finish: state(
        rules !== undefined &&
          result !== undefined &&
          printBlockers(
            printYear(rules, issues, workspace),
            result,
            spouseResult(facts, evaluation?.result.people ?? [], personId),
            evaluation ? dependantsOf(evaluation, members).map((dependant) => ({ name: nameOf(facts, dependant.dependantId), result: dependant })) : [],
          ).length === 0,
      ),
    };
    return { personId, members, steps: Object.fromEntries(STEPS.map((step) => [step, status[step]])) as StepStatuses };
  });
}

/** The dependants a return claims (its members'), with what the rules asked about each. */
function dependantsOf(evaluation: { input: EngineInput; result: EvaluationResult }, members: string[]) {
  const claimer = new Map(evaluation.input.family.dependants.map((each) => [each.id, each.claimedBy ?? evaluation.input.people.find((person) => person.role === "self")!.id]));
  return evaluation.result.dependants.filter((dependant) => members.includes(claimer.get(dependant.dependantId) ?? ""));
}

const nameOf = (facts: YearFacts, personId: string) => facts.people.find((person) => person.id === personId)?.name ?? "A dependant";

/** What printBlockers reads of a year, as stored. */
export function printYear(rules: RuleSet, issues: Issue[], workspace: Workspace): PrintYear {
  return { rules, issues, answers: workspace.answers, slips: workspace.slips };
}

/** The other adult's name and result, when both returns of a couple are prepared here. */
export function spouseResult(
  facts: YearFacts,
  people: EvaluationResult["people"],
  personId: string,
): { name: string; result: EvaluationResult["people"][number]; joint: boolean } | undefined {
  const result = spouseOf(people, personId);
  if (!result) return undefined;
  return { name: facts.people.find((person) => person.id === result.personId)?.name ?? "Your spouse", result, joint: filesJointly(facts) };
}
