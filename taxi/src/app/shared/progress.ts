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
 * Whether a return asks a question. A kind of income shown by a slip, and a yes/no question with a note, are always
 * asked. Any other question is asked only when the return reads it (`reached`): tuition to transfer needs a T2202 and
 * a spouse, and a province's own credits are read only by its own form. One answered already stays on the screen.
 */
export function isAsked(question: Question, reached: readonly string[] | ReadonlySet<string>, answered: boolean): boolean {
  if (question.slip !== undefined || question.note !== undefined || answered) return true;
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
