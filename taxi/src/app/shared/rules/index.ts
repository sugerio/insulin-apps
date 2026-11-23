import { loadRuleSet, type RuleSet } from "../engine/rules.ts";
import ca2025 from "./ca-2025.json" with { type: "json" };
import us2025 from "./us-2025.json" with { type: "json" };
import type { Country } from "../people.ts";

// The compiled rule sets the app ships, by country and year. They are generated from rules/<country>/<year>/ by
// `npm run rules`; never edit the JSON by hand.

const COMPILED: Record<Country, Record<number, unknown>> = { ca: { 2025: ca2025 }, us: { 2025: us2025 } };
const loaded = new Map<string, RuleSet>();

/** The years the app has rules for in a country, oldest first. */
export function yearsFor(country: Country): number[] {
  return Object.keys(COMPILED[country]).map(Number).sort((a, b) => a - b);
}

/** The rules for a country's year, or undefined when the app has none. */
export function rulesFor(country: Country, year: number): RuleSet | undefined {
  const key = `${country}-${year}`;
  const known = loaded.get(key);
  if (known) return known;
  const compiled = COMPILED[country]?.[year];
  if (compiled === undefined) return undefined;
  const ruleSet = loadRuleSet(compiled);
  loaded.set(key, ruleSet);
  return ruleSet;
}
