import type { Module, RuleSet } from "./engine/rules.ts";
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
 * A yes/no question is done when answered, or answered by a slip found (a yes without its slip is not). An amount is
 * asked only when the result reads it (`reached`), and then it must be entered.
 */
export function leftInModule(
  rules: RuleSet,
  module: Module,
  answers: Record<string, string | boolean>,
  slips: Slip[],
  reached: readonly string[],
): LeftItem[] {
  const left: LeftItem[] = [];
  for (const question of rules.questions.values()) {
    if (question.module !== module) continue;
    if (question.type === "boolean") {
      if (question.slip && slips.some((slip) => slip.type === question.slip)) continue;
      const answer = answers[question.id];
      if (answer === undefined) left.push({ question: question.id, ask: question.ask, reason: "unanswered" });
      else if (question.slip && answer === true) left.push({ question: question.id, ask: question.ask, reason: "slip", slip: question.slip });
      continue;
    }
    if (reached.includes(question.id) && answers[question.id] === undefined) left.push({ question: question.id, ask: question.ask, reason: "unanswered" });
  }
  return left;
}
