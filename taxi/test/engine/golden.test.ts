import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Evaluation } from "../../src/app/shared/engine/evaluate.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

// Golden households: an input and the expected lines, one JSON file each under test/golden/<country>-<year>/. A new
// year or a new case adds files here, not test code. Every expected line must match to the cent, and be complete.

const ROOT = resolve(import.meta.dirname, "../golden");

interface Golden {
  about: string;
  input: { year: number };
  expected: Record<string, Record<string, string>>;
}

for (const folder of readdirSync(ROOT)) {
  const year = Number(folder.split("-")[1]);
  describe(`golden households ${folder}`, () => {
    for (const file of readdirSync(join(ROOT, folder)).filter((name) => name.endsWith(".json"))) {
      const golden = JSON.parse(readFileSync(join(ROOT, folder, file), "utf8")) as Golden;
      it(`${file}: ${golden.about}`, () => {
        const evaluation = new Evaluation(rulesFor(year)!, golden.input);
        for (const [personId, lines] of Object.entries(golden.expected)) {
          const actual = Object.fromEntries(Object.keys(lines).map((id) => [id, evaluation.line(personId, id).value?.toString() ?? null]));
          expect(actual).toEqual(lines);
          for (const id of Object.keys(lines)) expect(evaluation.line(personId, id).status, id).toBe("complete");
        }
      });
    }
  });
}
