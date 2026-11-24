import { Dec } from "./decimal.ts";
import { Evaluation, type EngineInput } from "./evaluate.ts";
import type { Hint, HintKind, RuleSet } from "./rules.ts";

// Finds the hints that apply to the returns of a year (hints.yaml). A hint with a change is a what-if: the engine works
// out every return again with the changed answers, and the difference in the combined outcome (the refund less the
// balance owing, added up over both returns) is what the change is worth. A saving shows only when that is positive,
// so a saving is never a guess.

/** Less than this is not worth a hint. */
const SMALLEST_SAVING = Dec.of(1);

export interface FoundHint {
  id: string;
  /** The return the hint is about. */
  personId: string;
  kind: HintKind;
  title: string;
  text: string;
  amount: { label: string; value: string } | null;
  /** The combined outcome of the year's returns with the change less without it; null without a change or when it can't be worked out. */
  effect: string | null;
  effectLabel: string | null;
  /** The answers the change sets, by person. */
  change: { personId: string; question: string; value: string | boolean }[];
}

/**
 * The year's input filed with another filing status, for a hint that changes it. The caller that builds the input
 * (the server, from what is stored) passes its own, so whose return claims each dependant follows the same rule as
 * the real year. Without one, the status is set and a joint return claims every dependant.
 */
export type Refile = (input: EngineInput, filingStatus: "joint" | "separate") => EngineInput;

const refileInput: Refile = (input, filingStatus) => ({
  ...input,
  family: {
    ...input.family,
    filingStatus,
    dependants: filingStatus === "joint" ? input.family.dependants.map(({ claimedBy: _, ...dependant }) => dependant) : input.family.dependants,
  },
});

export function findHints(rules: RuleSet, input: EngineInput, refile: Refile = refileInput): FoundHint[] {
  if (rules.hints.size === 0) return [];
  const base = new Evaluation(rules, input);
  const before = outcomeOf(rules, base);
  const found: FoundHint[] = [];
  for (const person of input.people) {
    for (const hint of rules.hints.values()) {
      const when = base.evaluate(person.id, hint.when);
      if (when.value !== true) continue;
      const change = changeOf(hint, person.id, base);
      if (change === null) continue; // a change it can't work out, or for a spouse who isn't in the year
      const changed = change.filter((each) => !sameAnswer(input.answers[each.personId]?.[each.question], each.value));
      let effect: Dec | null = null;
      if ((changed.length > 0 || hint.filingStatus !== undefined) && before !== null) {
        const changedInput = withAnswers(hint.filingStatus === undefined ? input : refile(input, hint.filingStatus), changed);
        const after = outcomeOf(rules, new Evaluation(rules, changedInput));
        effect = after === null ? null : after.sub(before);
      }
      if ((hint.kind === "saving" || hint.onlyIfSaving) && (effect === null || effect.lt(SMALLEST_SAVING))) continue;
      const amount = hint.amount ? base.evaluate(person.id, hint.amount.formula).value : null;
      found.push({
        id: hint.id,
        personId: person.id,
        kind: hint.kind,
        title: hint.title,
        text: hint.text,
        amount: hint.amount && amount instanceof Dec ? { label: hint.amount.label, value: amount.roundTo(2, "HALF_UP").toString() } : null,
        effect: effect === null ? null : effect.toString(),
        effectLabel: hint.effectLabel ?? null,
        change: changed,
      });
    }
  }
  return bestOfEachAllocation(rules, found);
}

/**
 * A hint that also changes the spouse's answers moves something between the returns (donations, medical expenses), so
 * it is worked out from each side; only the better of the two is offered (on a tie, the first return's).
 */
function bestOfEachAllocation(rules: RuleSet, found: FoundHint[]): FoundHint[] {
  const best = new Map<string, FoundHint>();
  for (const hint of found) {
    if (!rules.hints.get(hint.id)!.change.some((change) => change.spouse)) continue;
    const other = best.get(hint.id);
    if (!other || Dec.from(hint.effect ?? "0").gt(Dec.from(other.effect ?? "0"))) best.set(hint.id, hint);
  }
  return found.filter((hint) => !best.has(hint.id) || best.get(hint.id) === hint);
}

/** The combined outcome: the outcome line added up over every return; null when a return's can't be worked out. */
function outcomeOf(rules: RuleSet, evaluation: Evaluation): Dec | null {
  if (rules.outcome === undefined) return null;
  let total = Dec.ZERO;
  for (const person of evaluation.input.people) {
    const { value } = evaluation.line(person.id, rules.outcome);
    if (value === null) return null;
    total = total.add(value);
  }
  return total;
}

/** The answers a hint sets, worked out from the person's side: money to the cent and never below zero. */
function changeOf(hint: Hint, personId: string, evaluation: Evaluation): FoundHint["change"] | null {
  const change: FoundHint["change"] = [];
  for (const each of hint.change) {
    const target = each.spouse ? evaluation.spouse(personId) : personId;
    if (target === undefined) return null;
    const { value } = evaluation.evaluate(personId, each.formula);
    if (value === null) return null;
    change.push({ personId: target, question: each.question, value: value instanceof Dec ? Dec.max(value, Dec.ZERO).roundTo(2, "HALF_UP").toString() : value });
  }
  return change;
}

function sameAnswer(current: string | boolean | undefined, value: string | boolean): boolean {
  if (current === undefined) return false;
  if (typeof current === "string" && typeof value === "string" && /^-?\d/.test(current) && /^-?\d/.test(value)) return Dec.from(current).eq(Dec.from(value));
  return current === value;
}

function withAnswers(input: EngineInput, change: FoundHint["change"]): EngineInput {
  const answers = Object.fromEntries(Object.entries(input.answers).map(([personId, given]) => [personId, { ...given }]));
  for (const each of change) (answers[each.personId] ??= {})[each.question] = each.value;
  return { ...input, answers };
}
