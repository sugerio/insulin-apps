import type { PersonResult } from "./engine/evaluate.ts";
import type { Slip } from "./returns.ts";

// What stands between a return and its filled-in CRA forms. The forms are printed only from a finished return: every
// slip confirmed, every result line worked out from answers (no usual answer assumed), and nothing the app doesn't
// handle. A couple's returns read each other (the spouse amount reads the other's net income), so a question left on
// the spouse's return can hold this one too: it is listed under the spouse's name. Finish lists these as "Before you
// file"; the download refuses while any is left.

export interface PrintBlocker {
  text: string;
  /** The question to answer, when it is one. */
  question?: string;
  /** Confirm the slips; otherwise the step of the question, or none. */
  confirm?: true;
  /** The return it is on, when it is the spouse's. */
  personId?: string;
}

export function printBlockers(person: PersonResult, slips: Slip[], spouse?: { name: string; result: PersonResult }): PrintBlocker[] {
  const toConfirm = slips.filter((slip) => slip.personId === person.personId && slip.status === "unconfirmed").length;
  const blockers: PrintBlocker[] = [
    ...(toConfirm > 0 ? [{ text: `${toConfirm} ${toConfirm === 1 ? "slip is" : "slips are"} not confirmed yet.`, confirm: true as const }] : []),
    ...person.missing.map((item) => ({ text: `Needed: ${item.ask}.`, question: item.question })),
    ...person.estimates.map((item) => ({ text: `Not answered yet: ${item.ask}.`, question: item.question })),
    ...person.unhandled.map((note) => ({ text: note })),
  ];
  const incomplete = person.lines.some((line) => line.status !== "complete");
  if (incomplete && spouse) {
    const theirs = spouse.result.personId;
    blockers.push(
      ...spouse.result.missing.map((item) => ({ text: `${spouse.name}'s return: needed: ${item.ask}.`, question: item.question, personId: theirs })),
      ...spouse.result.estimates.map((item) => ({ text: `${spouse.name}'s return: not answered yet: ${item.ask}.`, question: item.question, personId: theirs })),
    );
  }
  // A line can still be incomplete without a reason above (a value the rules can't work out): never print it.
  if (blockers.length === 0 && incomplete) blockers.push({ text: "Some lines of the return can't be worked out yet." });
  return blockers;
}

/** The spouse's result, for printBlockers: the other adult of the year, when both returns are prepared here. */
export function spouseOf<T extends { personId: string }>(people: T[], personId: string): T | undefined {
  return people.find((each) => each.personId !== personId);
}
