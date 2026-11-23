import type { Evaluation, PersonResult } from "./engine/evaluate.ts";
import { parseFormula } from "./engine/formula.ts";
import { documentName, type RuleSet } from "./engine/rules.ts";
import { isIssueOf, type Issue } from "./people.ts";
import { leftInModule } from "./progress.ts";
import type { Slip } from "./returns.ts";

/** The languages a return's forms print in (`?language=` on the forms' URL): Revenu Québec's forms have a French version. */
export { FORM_LANGUAGES, type FormLanguage } from "./engine/rules.ts";

// What stands between a return and its filled-in CRA forms. The forms are printed only from a finished return: no
// issue of the year left on it (a fact on Personal info not given, or one the app doesn't handle), every slip there and
// confirmed (a kind of income added without its slip is missing), every result line worked out from answers (no usual
// answer assumed), and nothing the app doesn't handle. A couple's returns read each other (the spouse amount reads the
// other's net income), so the spouse's issues, slips and unhandled items hold this one too, and their questions left do
// when a line of this return waits on them: those are listed under the spouse's name. The Finish step's state, its
// "Before you file" and the download all use this, so they agree.

export interface PrintBlocker {
  text: string;
  /** The question to answer, when it is one. */
  question?: string;
  /** Confirm the slips, on the Confirm step. */
  confirm?: true;
  /** An answer not given yet (the usual answer is assumed): Finish groups three or more of one step. */
  unanswered?: true;
  /** An issue of the year's facts, settled on Personal info. */
  issue?: Issue["code"];
  /** The return it is on, when it is the spouse's. */
  personId?: string;
}

/** What printBlockers reads of the year besides the engine's result: its rules and issues, each adult's answers, its slips. */
export interface PrintYear {
  rules: RuleSet;
  issues: Issue[];
  answers: Record<string, Record<string, string | boolean>>;
  slips: Slip[];
}

const SLIP_MODULES = ["income", "deductions", "credits"] as const;

export function printBlockers(year: PrintYear, person: PersonResult, spouse?: { name: string; result: PersonResult; joint?: boolean }): PrintBlocker[] {
  const own = slipsLeft(year, person);
  const blockers: PrintBlocker[] = [
    ...year.issues.filter((issue) => isIssueOf(issue, person.personId)).map((issue) => ({ text: issue.message, issue: issue.code })),
    ...(own.toConfirm > 0 ? [{ text: toConfirmText(own.toConfirm), confirm: true as const }] : []),
    ...own.waiting.map((item) => ({ text: `Waiting for a slip: ${item.text}.`, question: item.question })),
    ...person.missing.map((item) => ({ text: `Needed: ${item.ask}.`, question: item.question })),
    ...person.estimates.map((item) => ({ text: `Not answered yet: ${item.ask}.`, question: item.question, unanswered: true as const })),
    ...person.unhandled.map((note) => ({ text: note })),
  ];
  const incomplete = person.lines.some((line) => line.status !== "complete");
  if (spouse) {
    const theirs = spouse.result.personId;
    // On a joint return the spouse's items are this return's: named by person, not by return.
    const on = spouse.joint ? `${spouse.name}:` : `${spouse.name}'s return:`;
    const other = slipsLeft(year, spouse.result);
    // Their facts, slips and what the app doesn't handle never show in a line's status, so they hold this return
    // whatever it reads. The issues the returns share are listed above already.
    blockers.push(
      ...year.issues
        .filter((issue) => !isIssueOf(issue, person.personId) && isIssueOf(issue, theirs))
        .map((issue) => ({ text: `${on} ${issue.message}`, issue: issue.code, personId: theirs })),
      ...(other.toConfirm > 0 ? [{ text: `${on} ${toConfirmText(other.toConfirm)}`, confirm: true as const, personId: theirs }] : []),
      ...other.waiting.map((item) => ({ text: `${on} waiting for a slip: ${item.text}.`, question: item.question, personId: theirs })),
      ...spouse.result.unhandled.map((note) => ({ text: `${on} ${note}`, personId: theirs })),
    );
    if (incomplete) {
      blockers.push(
        ...spouse.result.missing.map((item) => ({ text: `${on} needed: ${item.ask}.`, question: item.question, personId: theirs })),
        ...spouse.result.estimates.map((item) => ({ text: `${on} not answered yet: ${item.ask}.`, question: item.question, unanswered: true as const, personId: theirs })),
      );
    }
  }
  // A line can still be incomplete without a reason above (a value the rules can't work out): never print it.
  if (blockers.length === 0 && incomplete) blockers.push({ text: "Some lines of the return can't be worked out yet." });
  return blockers;
}

/** A return's slips not confirmed yet, and the slips it says it has that aren't there (shared/progress.ts). */
function slipsLeft(year: PrintYear, result: PersonResult): { toConfirm: number; waiting: { question: string; text: string }[] } {
  const slips = year.slips.filter((slip) => slip.personId === result.personId);
  const answers = year.answers[result.personId] ?? {};
  const waiting = SLIP_MODULES.flatMap((module) => leftInModule(year.rules, module, answers, slips, result.questions))
    .filter((item) => item.reason === "slip")
    .map((item) => ({ question: item.question, text: `the ${documentName(year.rules.slips.get(item.slip!), item.slip!)} (${item.ask})` }));
  return { toConfirm: slips.filter((slip) => slip.status === "unconfirmed").length, waiting };
}

const toConfirmText = (count: number) => `${count} ${count === 1 ? "slip is" : "slips are"} not confirmed yet.`;

// Forms a return needs that aren't printed (forms.yaml has no layout for them), in the order they're attached: the
// worksheet and Finish name them, for the person to fill in and file with the forms. Each applies when its formula,
// read like a printed form's `applies`, is yes.
const FORMS_TO_ADD = [
  // CWB.schedule: a benefit on line 45300, or advance payments on an RC210 slip (Step 4), even with no benefit.
  {
    form: "Schedule 6 (5005-S6), Canada Workers Benefit for residents of Quebec",
    why: "for the Canada workers benefit on line 45300 of your return, or its advance payments on an RC210 slip",
    applies: 'person.province == "QC" and line.CWB.schedule == 1',
  },
  {
    form: "Schedule 6 (5009-S6), Canada Workers Benefit for residents of Alberta",
    why: "for the Canada workers benefit on line 45300 of your return, or its advance payments on an RC210 slip",
    applies: 'person.province == "AB" and line.CWB.schedule == 1',
  },
  {
    form: "Schedule 6 (5014-S6), Canada Workers Benefit for residents of Nunavut",
    why: "for the Canada workers benefit on line 45300 of your return, or its advance payments on an RC210 slip",
    applies: 'person.province == "NU" and line.CWB.schedule == 1',
  },
  {
    form: "Schedule MB428-A (5007-A), Manitoba Family Tax Benefit",
    why: "for the family tax benefit on line 41 of your MB428",
    applies: 'person.province == "MB" and line.MB428.41 > 0',
  },
  {
    form: "Schedule ON(S11) (5006-S11), Ontario Tuition and Education Amounts",
    why: "for your unused Ontario tuition and education amounts",
    applies: 'person.province == "ON" and answer.unusedProvincialTuition > 0',
  },
  {
    form: "Schedule BC(S11) (5010-S11), British Columbia Tuition Amounts",
    why: "for your British Columbia tuition amounts",
    applies: 'person.province == "BC" and answer.unusedProvincialTuition + line.BCS11.2 > 0',
  },
  {
    form: "Schedule SK(S11) (5008-S11), Saskatchewan Tuition and Education Amounts",
    why: "for your unused Saskatchewan tuition and education amounts",
    applies: 'person.province == "SK" and answer.unusedProvincialTuition > 0',
  },
  {
    form: "Schedule D, Solidarity Tax Credit (Revenu Québec)",
    why: "with your TP-1, to get the solidarity tax credit: Revenu Québec works it out from this schedule",
    applies: 'person.province == "QC"',
  },
].map((each) => ({ ...each, applies: parseFormula(each.applies) }));

/** The forms a person's return needs that aren't printed, each with what it is for. */
export function formsToAdd(evaluation: Evaluation, personId: string): { form: string; why: string }[] {
  return FORMS_TO_ADD.filter((each) => evaluation.evaluate(personId, each.applies).value === true).map(({ form, why }) => ({ form, why }));
}

/** The spouse's result, for printBlockers: the other adult of the year, when both returns are prepared here. */
export function spouseOf<T extends { personId: string }>(people: T[], personId: string): T | undefined {
  return people.find((each) => each.personId !== personId);
}
