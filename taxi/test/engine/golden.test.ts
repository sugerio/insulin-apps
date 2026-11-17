import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Evaluation } from "../../src/app/shared/engine/evaluate.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// Golden households: an input and the expected lines, one JSON file each under test/golden/<country>-<year>/. A new
// year or a new case adds files here, not test code. Every expected line must match to the cent, and be complete, and
// every line of the rules must be non-zero in at least one household, so no line goes untested.

const ROOT = resolve(import.meta.dirname, "../golden");

interface Golden {
  about: string;
  input: { year: number };
  expected: Record<string, Record<string, string>>;
}

/** Lines no golden household makes non-zero, and why that is fine. Every other line must be non-zero in at least one. */
const ALWAYS_ZERO: Record<string, string> = {
  "T1.44800": "a CPP overpayment is not handled yet: the line is zero or says so",
  "T1.45000": "an EI overpayment is not handled yet: the line is zero or says so",
  "BC428.44": "a spouse's unused British Columbia age amount is not handled yet: the line is zero or says so",
  "AB428.42": "a spouse's unused Alberta age amount is not handled yet: the line is zero or says so",
  "SCOPE.income": "income this app doesn't handle: the line is zero or says so",
  "SCOPE.deductions": "deductions this app doesn't handle: the line is zero or says so",
};

for (const folder of readdirSync(ROOT)) {
  const year = Number(folder.split("-")[1]);
  const rules = rulesFor(year)!;
  const goldens = readdirSync(join(ROOT, folder))
    .filter((name) => name.endsWith(".json"))
    .map((file) => ({ file, golden: JSON.parse(readFileSync(join(ROOT, folder, file), "utf8")) as Golden }));

  describe(`golden households ${folder}`, () => {
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

    it("make every line non-zero in at least one household", () => {
      const covered = new Set<string>();
      for (const { golden } of goldens) {
        const evaluation = new Evaluation(rules, golden.input);
        for (const personId of Object.keys(golden.expected)) {
          for (const id of rules.lines.keys()) if (!(evaluation.line(personId, id).value?.isZero() ?? true)) covered.add(id);
        }
      }
      const uncovered = [...rules.lines.keys()].filter((id) => !covered.has(id) && !(id in ALWAYS_ZERO));
      expect(uncovered).toEqual([]);
    });
  });
}
