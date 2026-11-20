import { loadRuleSet, type RuleSet } from "../engine/rules.ts";
import ca2025 from "./ca-2025.json" with { type: "json" };

// The compiled rule sets the app ships, by year. They are generated from rules/ by `npm run rules`; never edit the
// JSON by hand.

const COMPILED: Record<number, unknown> = { 2025: ca2025 };
const loaded = new Map<number, RuleSet>();

/** The rules for a year, or undefined when the app has none. */
export function rulesFor(year: number): RuleSet | undefined {
  const known = loaded.get(year);
  if (known) return known;
  const compiled = COMPILED[year];
  if (compiled === undefined) return undefined;
  const ruleSet = loadRuleSet(compiled);
  loaded.set(year, ruleSet);
  return ruleSet;
}
