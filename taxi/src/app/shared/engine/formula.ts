import { FormulaSyntaxError } from "./errors.ts";

// The formula language of the rule files: a small, closed expression language that the engine parses itself. Nothing
// is passed to `eval`, so a rule file can't run code. A formula reads like the CRA worksheet line it implements:
//
//   min(param.canadaEmploymentAmount, line.T1.10100)
//   bracket(param.taxBrackets, line.T1.26000)
//   if(answer.maritalStatus == "married", spouse.line.T1.23600, 0)
//
// Numbers are exact decimals; `14.5%` is 0.145. Names are dotted paths (`param.x`, `line.T1.10100`, `answer.x`,
// `T4.box14`, `person.age`, `spouse.line.T1.23600`); what each one means is the rule set's business, not the parser's.

export type BinaryOperator = "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "and" | "or";

export type Formula =
  | { kind: "number"; value: string; column: number }
  | { kind: "string"; value: string; column: number }
  | { kind: "boolean"; value: boolean; column: number }
  | { kind: "ref"; path: string[]; column: number }
  | { kind: "call"; name: string; args: Formula[]; column: number }
  | { kind: "unary"; op: "-" | "not"; operand: Formula; column: number }
  | { kind: "binary"; op: BinaryOperator; left: Formula; right: Formula; column: number };

type Token =
  | { type: "number"; text: string; column: number }
  | { type: "string"; text: string; column: number }
  | { type: "name"; text: string; column: number }
  | { type: "op"; text: string; column: number }
  | { type: "end"; text: ""; column: number };

const OPERATORS = ["<=", ">=", "==", "!=", "+", "-", "*", "/", "<", ">", "(", ")", ","];
const KEYWORDS = new Set(["and", "or", "not", "true", "false"]);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const column = index + 1;
    const rest = text.slice(index);
    const space = /^\s+/.exec(rest);
    if (space) {
      index += space[0].length;
      continue;
    }
    const number = /^\d+(?:\.\d+)?%?/.exec(rest);
    if (number) {
      tokens.push({ type: "number", text: number[0], column });
      index += number[0].length;
      continue;
    }
    // A dotted path: the first segment starts with a letter; later ones may be digits (`line.T1.10100`).
    const name = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/.exec(rest);
    if (name) {
      tokens.push({ type: "name", text: name[0], column });
      index += name[0].length;
      continue;
    }
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end < 0) throw new FormulaSyntaxError(column, "A text value isn't closed with \"");
      tokens.push({ type: "string", text: rest.slice(1, end), column });
      index += end + 1;
      continue;
    }
    const op = OPERATORS.find((candidate) => rest.startsWith(candidate));
    if (!op) throw new FormulaSyntaxError(column, `Unexpected character ${JSON.stringify(rest[0])}`);
    tokens.push({ type: "op", text: op, column });
    index += op.length;
  }
  tokens.push({ type: "end", text: "", column: text.length + 1 });
  return tokens;
}

// Binding power of each binary operator: `or` binds loosest, `*` and `/` tightest.
const PRECEDENCE: Record<BinaryOperator, number> = {
  or: 1,
  and: 2,
  "==": 3,
  "!=": 3,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
};

/** Parses a formula. Throws a FormulaSyntaxError with the column of the problem. */
export function parseFormula(text: string): Formula {
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position]!;
  const next = () => tokens[position++]!;
  const expect = (op: string) => {
    const token = next();
    if (token.type !== "op" || token.text !== op) throw new FormulaSyntaxError(token.column, `Expected "${op}"${describe(token)}`);
  };

  function binaryOperator(token: Token): BinaryOperator | null {
    if (token.type === "op" && token.text in PRECEDENCE) return token.text as BinaryOperator;
    if (token.type === "name" && (token.text === "and" || token.text === "or")) return token.text;
    return null;
  }

  function expression(minimum: number): Formula {
    let left = unary();
    for (;;) {
      const token = peek();
      const op = binaryOperator(token);
      if (!op || PRECEDENCE[op] < minimum) return left;
      next();
      // Comparisons don't chain: `a < b < c` is refused rather than read as `(a < b) < c`.
      const right = expression(PRECEDENCE[op] + 1);
      if (PRECEDENCE[op] === 3 && left.kind === "binary" && PRECEDENCE[left.op] === 3) {
        throw new FormulaSyntaxError(token.column, "Comparisons can't be chained; combine them with and");
      }
      left = { kind: "binary", op, left, right, column: token.column };
    }
  }

  function unary(): Formula {
    const token = peek();
    if (token.type === "op" && token.text === "-") {
      next();
      return { kind: "unary", op: "-", operand: unary(), column: token.column };
    }
    if (token.type === "name" && token.text === "not") {
      next();
      // `not` applies to a whole comparison: `not a == b` is `not (a == b)`.
      return { kind: "unary", op: "not", operand: expression(PRECEDENCE["=="]), column: token.column };
    }
    return primary();
  }

  function primary(): Formula {
    const token = next();
    switch (token.type) {
      case "number": {
        const percent = token.text.endsWith("%");
        const digits = percent ? token.text.slice(0, -1) : token.text;
        return { kind: "number", value: percent ? percentToDecimal(digits) : digits, column: token.column };
      }
      case "string":
        return { kind: "string", value: token.text, column: token.column };
      case "name": {
        if (token.text === "true" || token.text === "false") return { kind: "boolean", value: token.text === "true", column: token.column };
        if (KEYWORDS.has(token.text)) throw new FormulaSyntaxError(token.column, `"${token.text}" can't start a value`);
        const after = peek();
        if (after.type === "op" && after.text === "(") {
          if (token.text.includes(".")) throw new FormulaSyntaxError(token.column, `"${token.text}" isn't a function`);
          next();
          const args: Formula[] = [];
          if (!(peek().type === "op" && peek().text === ")")) {
            for (;;) {
              args.push(expression(1));
              if (peek().type === "op" && peek().text === ",") {
                next();
                continue;
              }
              break;
            }
          }
          expect(")");
          return { kind: "call", name: token.text, args, column: token.column };
        }
        return { kind: "ref", path: token.text.split("."), column: token.column };
      }
      case "op":
        if (token.text === "(") {
          const inner = expression(1);
          expect(")");
          return inner;
        }
        throw new FormulaSyntaxError(token.column, `Unexpected "${token.text}"`);
      case "end":
        throw new FormulaSyntaxError(token.column, "The formula ends too early");
    }
  }

  const formula = expression(1);
  const rest = peek();
  if (rest.type !== "end") throw new FormulaSyntaxError(rest.column, `Unexpected "${rest.text}"`);
  return formula;
}

function describe(token: Token): string {
  return token.type === "end" ? ", found the end" : `, found "${token.text}"`;
}

/** "14.5" (from `14.5%`) → "0.145", exactly. */
export function percentToDecimal(digits: string): string {
  const [whole = "0", fraction = ""] = digits.split(".");
  const padded = whole.padStart(3, "0");
  const text = `${padded.slice(0, -2)}.${padded.slice(-2)}${fraction}`.replace(/^0+(?=\d)/, "");
  return text.replace(/\.?0+$/, "") || "0";
}

/** Every name a formula reads, in the order written. */
export function references(formula: Formula): Extract<Formula, { kind: "ref" }>[] {
  switch (formula.kind) {
    case "ref":
      return [formula];
    case "call":
      return formula.args.flatMap(references);
    case "unary":
      return references(formula.operand);
    case "binary":
      return [...references(formula.left), ...references(formula.right)];
    default:
      return [];
  }
}
