import { Dec } from "./engine/decimal.ts";
import type { Module, Question, RuleSet } from "./engine/rules.ts";
import type { Slip } from "./returns.ts";

// What is left in a part of a return (income, deductions, credits, about the person) before its step is done. The
// server's step states and the step's own page both use this, so the page says exactly why its step isn't done.

export interface LeftItem {
  question: string;
  ask: string;
  /** `unanswered`: not said whether it applies, or no amount entered. `slip`: said yes, but the slip isn't there. */
  reason: "unanswered" | "slip";
  slip?: string;
}

/**
 * Whether a return asks a question. A yes/no question with a note is always asked. Any other question is asked only when
 * the return reads it (`reached`): tuition to transfer needs a T2202 and a spouse, a province's own credits are read
 * only by its own form, and a kind of income shown by a slip is asked when the return reads that slip (every return
 * reads the T4; only a Quebec return reads the RL-1). One answered already stays on the screen.
 */
export function isAsked(question: Question, reached: readonly string[] | ReadonlySet<string>, answered: boolean): boolean {
  if (question.note !== undefined || answered) return true;
  return reached instanceof Set ? reached.has(question.id) : (reached as readonly string[]).includes(question.id);
}

/** A question asked is done when answered, or answered by a slip found (a yes without its slip is not). */
export function leftInModule(
  rules: RuleSet,
  module: Module,
  answers: Record<string, string | boolean>,
  slips: Slip[],
  reached: readonly string[],
): LeftItem[] {
  const left: LeftItem[] = [];
  for (const question of rules.questions.values()) {
    if (question.module !== module || !isAsked(question, reached, false)) continue;
    if (question.type === "boolean") {
      if (question.slip && slips.some((slip) => slip.type === question.slip)) continue;
      const answer = answers[question.id];
      if (answer === undefined) left.push({ question: question.id, ask: question.ask, reason: "unanswered" });
      else if (question.slip && answer === true) left.push({ question: question.id, ask: question.ask, reason: "slip", slip: question.slip });
      continue;
    }
    if (answers[question.id] === undefined) left.push({ question: question.id, ask: question.ask, reason: "unanswered" });
  }
  return left;
}

/** Boxes AI couldn't read that have no amount: the slip can't be confirmed until they are entered (0 when blank on the slip). */
export function unreadBoxes(slip: Pick<Slip, "boxes" | "unsure">): string[] {
  return slip.unsure.filter((box) => !(box in slip.boxes));
}

type SlipLike = Pick<Slip, "id" | "personId" | "type" | "issuer" | "boxes">;

/**
 * Two slips that may be one: the same person's, of one type and issuer (case and spaces aside), with no box holding
 * different amounts, even when they have no box in common (a blurred copy with none read). Never merged: two partly read
 * slips of one issuer can be different ones, so a person decides.
 */
export function maybeSameSlip(a: Omit<SlipLike, "id">, b: Omit<SlipLike, "id">): boolean {
  if (a.personId !== b.personId || a.type !== b.type || a.issuer.trim().toLowerCase() !== b.issuer.trim().toLowerCase()) return false;
  return Object.keys(a.boxes)
    .filter((box) => b.boxes[box] !== undefined)
    .every((box) => Dec.from(a.boxes[box]!).eq(b.boxes[box]!));
}

/**
 * The slips that may be the same as one before them in the list, each with the first such slip, for Confirm to point
 * out. Receipts aren't compared: two can hold the same amount from the same place (a monthly prescription).
 */
export function possibleDuplicates<T extends SlipLike>(rules: RuleSet, slips: T[]): Map<string, T> {
  const flagged = new Map<string, T>();
  slips.forEach((slip, index) => {
    if (rules.slips.get(slip.type)?.receipt) return;
    const earlier = slips.slice(0, index).find((other) => maybeSameSlip(other, slip));
    if (earlier) flagged.set(slip.id, earlier);
  });
  return flagged;
}
