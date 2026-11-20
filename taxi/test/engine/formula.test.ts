import { describe, expect, it } from "vitest";
import { FormulaSyntaxError } from "../../src/app/shared/engine/errors.ts";
import { parseFormula, percentToDecimal, references, type Formula } from "../../src/app/shared/engine/formula.ts";

/** A formula as text with explicit parentheses, to check how it was grouped. */
function show(formula: Formula): string {
  switch (formula.kind) {
    case "number":
    case "string":
      return formula.value;
    case "boolean":
      return String(formula.value);
    case "ref":
      return formula.path.join(".");
    case "call":
      return `${formula.name}(${formula.args.map(show).join(", ")})`;
    case "unary":
      return `(${formula.op} ${show(formula.operand)})`;
    case "binary":
      return `(${show(formula.left)} ${formula.op} ${show(formula.right)})`;
  }
}

const syntaxError = (text: string) => {
  try {
    parseFormula(text);
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { column: error.column, message: error.message };
    throw error;
  }
  throw new Error(`${text} parsed`);
};

describe("the formula language", () => {
  it("groups as arithmetic does, and logic looser than comparisons", () => {
    expect(show(parseFormula("a.x + b.y * 2 - 1"))).toBe("((a.x + (b.y * 2)) - 1)");
    expect(show(parseFormula("-x.a * (y.b + 1)"))).toBe("((- x.a) * (y.b + 1))");
    expect(show(parseFormula("a.x < 1 or b.y >= 2 and not c.z == \"on\""))).toBe("((a.x < 1) or ((b.y >= 2) and (not (c.z == on))))");
  });

  it("reads dotted names with number segments, calls, percentages and text", () => {
    expect(show(parseFormula("min(param.limit, line.T1.10100)"))).toBe("min(param.limit, line.T1.10100)");
    expect(show(parseFormula("sum(T4.box16A) * 14.5%"))).toBe("(sum(T4.box16A) * 0.145)");
    expect(show(parseFormula("if(true, 1, 0)"))).toBe("if(true, 1, 0)");
  });

  it("lists the names a formula reads", () => {
    expect(references(parseFormula("max(0, line.T1.15000 - spouse.line.T1.23300) + T4.box14")).map((ref) => ref.path.join("."))).toEqual([
      "line.T1.15000",
      "spouse.line.T1.23300",
      "T4.box14",
    ]);
  });

  it("names the column of a syntax error", () => {
    expect(syntaxError("min(1, 2")).toMatchObject({ column: 9, message: 'Expected ")", found the end' });
    expect(syntaxError("1 + * 2")).toMatchObject({ column: 5 });
    expect(syntaxError("a.b $ 2")).toMatchObject({ column: 5, message: 'Unexpected character "$"' });
    expect(syntaxError("1 < a.b < 3")).toMatchObject({ column: 9, message: "Comparisons can't be chained; combine them with and" });
    expect(syntaxError("line.T1.x(2)")).toMatchObject({ column: 1 });
    expect(syntaxError('"open')).toMatchObject({ column: 1 });
  });

  it("turns percentages into exact decimals", () => {
    expect(["14.5", "5.95", "100", "0.5", "0", "33"].map(percentToDecimal)).toEqual(["0.145", "0.0595", "1", "0.005", "0", "0.33"]);
  });
});
