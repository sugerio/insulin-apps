import type { PersonResult } from "./engine/evaluate.ts";
import type { Slip } from "./returns.ts";

// What stands between a return and its filled-in CRA forms. The forms are printed only from a finished return: every
// slip confirmed, every result line worked out from answers (no usual answer assumed), and nothing the app doesn't
// handle. Finish lists these as "Before you file"; the download refuses while any is left.

export interface PrintBlocker {
  text: string;
  /** The question to answer, when it is one. */
  question?: string;
  /** Confirm the slips; otherwise the step of the question, or none. */
  confirm?: true;
}

export function printBlockers(person: PersonResult, slips: Slip[]): PrintBlocker[] {
  const toConfirm = slips.filter((slip) => slip.personId === person.personId && slip.status === "unconfirmed").length;
  const blockers: PrintBlocker[] = [
    ...(toConfirm > 0 ? [{ text: `${toConfirm} ${toConfirm === 1 ? "slip is" : "slips are"} not confirmed yet.`, confirm: true as const }] : []),
    ...person.missing.map((item) => ({ text: `Needed: ${item.ask}.`, question: item.question })),
    ...person.estimates.map((item) => ({ text: `Not answered yet: ${item.ask}.`, question: item.question })),
    ...person.unhandled.map((note) => ({ text: note })),
  ];
  // A line can still be incomplete without a reason above (a value the rules can't work out): never print it.
  if (blockers.length === 0 && person.lines.some((line) => line.status !== "complete")) {
    blockers.push({ text: "Some lines of the return can't be worked out yet." });
  }
  return blockers;
}
