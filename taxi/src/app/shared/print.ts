import type { PersonResult } from "./engine/evaluate.ts";
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

export function printBlockers(year: PrintYear, person: PersonResult, spouse?: { name: string; result: PersonResult }): PrintBlocker[] {
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
    const on = `${spouse.name}'s return:`;
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

/** The spouse's result, for printBlockers: the other adult of the year, when both returns are prepared here. */
export function spouseOf<T extends { personId: string }>(people: T[], personId: string): T | undefined {
  return people.find((each) => each.personId !== personId);
}
