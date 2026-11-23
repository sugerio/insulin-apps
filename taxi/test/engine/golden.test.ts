import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Evaluation } from "../../src/app/shared/engine/evaluate.ts";
import type { Country } from "../../src/app/shared/people.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// Golden cases: an input and the expected lines, one JSON file each under test/golden/<country>-<year>/. A new
// year or a new case adds files here, not test code. Every expected line must match to the cent, and be complete, and
// every line of the rules must be non-zero in at least one golden case, so no line goes untested.

const ROOT = resolve(import.meta.dirname, "../golden");

interface Golden {
  about: string;
  input: { year: number; family?: { dependants?: { id: string }[] } };
  expected: Record<string, Record<string, string>>;
}

/** Lines no golden case makes non-zero, and why that is fine. Every other line must be non-zero in at least one. */
const ALWAYS_ZERO: Record<string, string> = {
  "SCOPE.departure": "property deemed sold on leaving Canada is not handled: the line is zero or says so",
  "QC.scope": "the Quebec return's cases this app doesn't handle: the line is zero or says so",
  "QCD.check": "Schedule D answers that don't fit together: the line is zero or says so",
  // United States: each SCOPE line is zero, or says what isn't handled (test/engine/us-scope.test.ts checks each says so).
  "SCOPE.return": "situations the US return doesn't handle yet: zero, or says so",
  "SCOPE.residency": "a nonresident or dual-status alien: zero, or says so",
  "SCOPE.widowed": "a spouse who died in 2025: zero, or says so",
  "SCOPE.tips": "tips and overtime: zero, or says so",
  "SCOPE.kiddie": "the kiddie tax: zero, or says so",
  "SCOPE.care": "a household employee (Schedule H), or 2024 care paid in 2025: zero, or says so",
};

for (const folder of readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
  const [country, year] = folder.split("-") as [Country, string];
  const rules = rulesFor(country, Number(year))!;
  const goldens = readdirSync(join(ROOT, folder))
    .filter((name) => name.endsWith(".json"))
    .map((file) => ({ file, golden: JSON.parse(readFileSync(join(ROOT, folder, file), "utf8")) as Golden }));

  describe(`golden cases ${folder}`, () => {
    for (const { file, golden } of goldens) {
      it(`${file}: ${golden.about}`, () => {
        const evaluation = new Evaluation(rules, golden.input);
        for (const [personId, lines] of Object.entries(golden.expected)) {
          const actual = Object.fromEntries(Object.keys(lines).map((id) => [id, evaluation.line(personId, id).value?.toString() ?? null]));
          expect(actual).toEqual(lines);
          for (const id of Object.keys(lines)) expect(evaluation.line(personId, id).status, id).toBe("complete");
        }
      });
    }

    it("make every line non-zero in at least one golden case", () => {
      const covered = new Set<string>();
      for (const { golden } of goldens) {
        const evaluation = new Evaluation(rules, golden.input);
        // An adult's lines on each return; a line worked out for each dependant, on each dependant.
        const dependants = (golden.input.family?.dependants ?? []).map((dependant) => dependant.id);
        for (const [id, line] of rules.lines) {
          const owners = line.each === "dependant" ? dependants : Object.keys(golden.expected);
          if (owners.some((owner) => !(evaluation.line(owner, id).value?.isZero() ?? true))) covered.add(id);
        }
      }
      const uncovered = [...rules.lines.keys()].filter((id) => !covered.has(id) && !(id in ALWAYS_ZERO));
      expect(uncovered).toEqual([]);
    });
  });
}
