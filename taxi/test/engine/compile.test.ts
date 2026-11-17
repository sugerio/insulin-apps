import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileRules, type SourceYear } from "../../src/app/shared/engine/compile.ts";
import { RuleError } from "../../src/app/shared/engine/errors.ts";
import { loadRuleSet } from "../../src/app/shared/engine/rules.ts";
import { COMPILED_ROOT, compileNamed, ruleSetNames, serialize } from "../../scripts/rules-source.ts";

const hash = (text: string) => `h${text.length}`;

/** A year folder in memory: its year.yaml, then the other files by name. */
function year(value: number, extendsYear: number | null, files: Record<string, unknown>, result?: string[]): SourceYear {
  const dir = `rules/xx/${value}`;
  return {
    dir,
    files: [
      { path: `${dir}/year.yaml`, data: { country: "xx", year: value, filingUnit: "person", extends: extendsYear, ...(result ? { result } : {}) } },
      ...Object.entries(files).map(([name, data]) => ({ path: `${dir}/${name}`, data })),
    ],
  };
}

const base = {
  params: { rate: { label: "Rate", value: "10%", source: "s" } },
  lines: {
    "A.1": { label: "Income", formula: "sum(S.box1)" },
    "A.2": { label: "Tax", formula: "round(line.A.1 * param.rate, 2)" },
  },
  questions: { status: { type: "choice", ask: "Status", options: ["single", "married"] } },
  slips: { S: { title: "Slip", about: "A slip", boxes: { 1: "Income", 2: "Other" } } },
};

function compileError(chain: SourceYear[]): string {
  try {
    compileRules(chain, hash);
  } catch (error) {
    if (error instanceof RuleError) return error.message;
    throw error;
  }
  throw new Error("compiled");
}

describe("compiling rule files", () => {
  it("keeps the committed JSON in step with the YAML (run npm run rules)", () => {
    for (const name of ruleSetNames()) {
      expect(serialize(compileNamed(name)), name).toBe(readFileSync(join(COMPILED_ROOT, `${name}.json`), "utf8"));
    }
  });

  it("merges a year onto the one it extends: replaced, removed and new entries", () => {
    const compiled = compileRules(
      [
        year(2025, null, { "a.yaml": base }, ["A.2"]),
        year(2026, 2025, {
          "a.yaml": {
            params: { rate: { label: "Rate", value: 12, source: "2026" } },
            lines: { "A.3": { label: "Other", formula: "sum(S.box2)" } },
          },
          "b.yaml": { questions: { status: null } },
        }),
      ],
      hash,
    );
    expect(compiled.year).toBe(2026);
    expect(compiled.result).toEqual(["A.2"]);
    expect(compiled.params.rate).toEqual({ label: "Rate", value: "12", source: "2026" });
    expect(Object.keys(compiled.lines)).toEqual(["A.1", "A.2", "A.3"]);
    expect(compiled.questions).toEqual({});
    expect(loadRuleSet(compiled).lines.get("A.2")!.text).toBe("round(line.A.1 * param.rate, 2)");
  });

  it("names the file, the entry and the column of an unknown name", () => {
    const lines = { ...base.lines, "A.2": { label: "Tax", formula: "line.A.1 * param.nope" } };
    expect(compileError([year(2025, null, { "a.yaml": { ...base, lines } })])).toBe("rules/xx/2025/a.yaml, lines.A.2, column 12: No param param.nope");
  });

  it("refuses a line that depends on itself, and says through what", () => {
    const lines = { "A.1": { label: "One", formula: "line.A.2" }, "A.2": { label: "Two", formula: "line.A.1 + 1" } };
    expect(compileError([year(2025, null, { "a.yaml": { ...base, lines } })])).toMatch(/lines\.A\.1: The line depends on itself: A\.1 → A\.2 → A\.1$/);
  });

  it("refuses values of the wrong kind", () => {
    const withLine = (formula: string) => [year(2025, null, { "a.yaml": { ...base, lines: { ...base.lines, "A.3": { label: "X", formula } } } })];
    expect(compileError(withLine("S.box1 + 1"))).toContain('"+" works on numbers; use sum() for slip boxes');
    expect(compileError(withLine('if(answer.status == "widowed", 1, 0)'))).toContain('"widowed" isn\'t an option of status: single, married');
    expect(compileError(withLine("answer.status"))).toContain("A line must be a number");
    expect(compileError(withLine("bracket(param.rate, 1)"))).toContain("bracket takes a bracket table and an amount");
    expect(compileError(withLine("S.box9"))).toContain("S.box9: S has boxes 1, 2");
    expect(compileError(withLine("median(1)"))).toContain("No function median");
    expect(compileError(withLine("spouse.param.rate"))).toContain("params are the same for both spouses");
    expect(compileError(withLine("unsupported(1)"))).toContain("unsupported takes the reason, as text in quotes");
  });

  it("checks a bracket base printed on a form against the brackets below it", () => {
    const brackets = (base2: number) => ({
      label: "Brackets",
      source: "s",
      value: [{ upTo: 100, rate: "10%", base: 0 }, { upTo: 200, rate: "20%", base: base2 }, { rate: "30%", base: 30 }],
    });
    const withBrackets = (base2: number) => [year(2025, null, { "a.yaml": { ...base, params: { ...base.params, brackets: brackets(base2) } } })];
    expect(compileRules(withBrackets(10), hash).params.brackets!.value).toHaveLength(3);
    expect(compileError(withBrackets(11))).toBe("rules/xx/2025/a.yaml, params.brackets: The base of bracket 2 is 11; the brackets below it give 10");
  });

  it("refuses an entry defined twice in a year, a removal of nothing, and a param without its source", () => {
    expect(compileError([year(2025, null, { "a.yaml": base, "b.yaml": { params: { rate: { label: "Rate", value: 1, source: "s" } } } })])).toBe(
      "rules/xx/2025/b.yaml, params.rate: Also in rules/xx/2025/a.yaml; a year defines each entry once",
    );
    expect(compileError([year(2025, null, { "a.yaml": { ...base, lines: { ...base.lines, "A.9": null } } })])).toContain("Removes an entry that no earlier year has");
    expect(compileError([year(2025, null, { "a.yaml": { params: { rate: { label: "Rate", value: 1 } } } })])).toContain("params.rate.source");
  });

  it("checks the year chain", () => {
    expect(compileError([year(2025, 2024, { "a.yaml": base })])).toContain("The first year extends nothing (extends: null)");
    expect(compileError([year(2025, null, { "a.yaml": base }), year(2026, 2024, {})])).toContain("extends must be 2025");
  });
});
