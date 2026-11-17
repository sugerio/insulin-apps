import { z } from "zod";
import { Dec } from "./decimal.ts";
import { FormulaSyntaxError, RuleError } from "./errors.ts";
import { parseFormula, references, type Formula } from "./formula.ts";

// A rule set: everything the engine knows about one country and year, compiled from the YAML rule files
// (rules/<country>/<year>/) into one JSON document that the browser and the Worker import. The engine itself knows
// nothing about any country or year.
//
// What a formula may read, by the first segment of its name:
//   param.<name>                  a number or a bracket table of the year
//   line.<form>.<line>            another line of the same person's return
//   answer.<question>             the person's answer; the question's default when there is none (an estimate)
//   <SLIP>.box<key>               that box of every one of the person's slips of that type (a list: sum, count, max)
//   person.age, person.province   the person's age on December 31 and province on December 31
//   spouse.<any of the above but param>   the same, for the spouse

export const STATUSES = ["complete", "estimate", "missing"] as const;
/** How sure a value is: `estimate` when a question's default stood in for an answer, `missing` when nothing could. */
export type Status = (typeof STATUSES)[number];

export interface BracketRow {
  /** The top of the bracket; null for the last one. */
  upTo: Dec | null;
  rate: Dec;
}
export type ParamValue = Dec | BracketRow[];

export interface Param {
  id: string;
  label: string;
  value: ParamValue;
  source: string;
}
export interface Line {
  id: string;
  label: string;
  /** The formula as written in the rule file. */
  text: string;
  formula: Formula;
  source?: string;
}
export type QuestionType = "money" | "boolean" | "choice";
export interface Question {
  id: string;
  type: QuestionType;
  ask: string;
  /** Used, and the result marked an estimate, while the question has no answer. */
  default?: string | boolean;
  options?: string[];
}
export interface SlipType {
  id: string;
  title: string;
  about: string;
  boxes: Record<string, string>;
  /** Boxes that never change a return (the CRA's checks, next year's limits): not reported as unhandled. */
  informational: string[];
}

export interface RuleSet {
  country: string;
  year: number;
  /** Who a return belongs to. `person`: one return per adult, a couple's returns reading each other through `spouse.`. */
  filingUnit: "person";
  /** A hash of the compiled rules: a saved result names the rules it was computed with. */
  version: string;
  /** The lines a summary shows, in order. */
  result: string[];
  params: Map<string, Param>;
  lines: Map<string, Line>;
  questions: Map<string, Question>;
  slips: Map<string, SlipType>;
  /** Per slip type, the boxes some formula reads, and the informational ones. Any other box is shown as not handled. */
  usedBoxes: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// The compiled form (JSON)

const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/);
const bracketRowSchema = z.strictObject({ upTo: decimalText.nullable(), rate: decimalText });
export const compiledRulesSchema = z.strictObject({
  country: z.string().regex(/^[a-z]{2}$/),
  year: z.number().int(),
  filingUnit: z.literal("person"),
  version: z.string(),
  result: z.array(z.string()),
  params: z.record(z.string(), z.strictObject({ label: z.string(), value: z.union([decimalText, z.array(bracketRowSchema).min(1)]), source: z.string() })),
  lines: z.record(z.string(), z.strictObject({ label: z.string(), formula: z.string(), source: z.string().optional() })),
  questions: z.record(
    z.string(),
    z.strictObject({
      type: z.enum(["money", "boolean", "choice"]),
      ask: z.string(),
      default: z.union([z.string(), z.boolean()]).optional(),
      options: z.array(z.string()).optional(),
    }),
  ),
  slips: z.record(
    z.string(),
    z.strictObject({ title: z.string(), about: z.string(), boxes: z.record(z.string(), z.string()), informational: z.array(z.string()) }),
  ),
});
export type CompiledRules = z.infer<typeof compiledRulesSchema>;

/** Reads compiled rules. `where` names the source of each entry for error messages (the compiler passes the YAML file). */
export function loadRuleSet(json: unknown, where: (entry: string) => string = () => "compiled rules"): RuleSet {
  const compiled = compiledRulesSchema.parse(json);
  const fail = (entry: string, message: string, column?: number): never => {
    throw new RuleError({ file: where(entry), entry, column }, message);
  };

  const params = new Map<string, Param>();
  for (const [id, param] of Object.entries(compiled.params)) {
    const value: ParamValue =
      typeof param.value === "string"
        ? Dec.from(param.value)
        : param.value.map((row) => ({ upTo: row.upTo === null ? null : Dec.from(row.upTo), rate: Dec.from(row.rate) }));
    if (Array.isArray(value)) checkBrackets(value, (message) => fail(`params.${id}`, message));
    params.set(id, { id, label: param.label, value, source: param.source });
  }
  const lines = new Map<string, Line>();
  for (const [id, line] of Object.entries(compiled.lines)) {
    let formula: Formula;
    try {
      formula = parseFormula(line.formula);
    } catch (error) {
      if (error instanceof FormulaSyntaxError) fail(`lines.${id}`, error.message, error.column);
      throw error;
    }
    lines.set(id, { id, label: line.label, text: line.formula, formula, ...(line.source === undefined ? {} : { source: line.source }) });
  }
  const questions = new Map(Object.entries(compiled.questions).map(([id, question]) => [id, { id, ...question } satisfies Question]));
  const slips = new Map(Object.entries(compiled.slips).map(([id, slip]) => [id, { id, ...slip } satisfies SlipType]));

  const usedBoxes = new Map<string, Set<string>>();
  for (const slip of slips.values()) {
    for (const box of slip.informational) if (!(box in slip.boxes)) fail(`slips.${slip.id}`, `informational box ${box} isn't one of its boxes`);
    usedBoxes.set(slip.id, new Set(slip.informational));
  }
  for (const line of lines.values()) {
    for (const ref of references(line.formula)) {
      const path = ref.path[0] === "spouse" ? ref.path.slice(1) : ref.path;
      const slip = slips.get(path[0] ?? "");
      const box = path[1]?.startsWith("box") ? path[1].slice(3) : undefined;
      if (slip && box !== undefined) usedBoxes.set(slip.id, (usedBoxes.get(slip.id) ?? new Set()).add(box));
    }
  }

  const ruleSet: RuleSet = {
    country: compiled.country,
    year: compiled.year,
    filingUnit: compiled.filingUnit,
    version: compiled.version,
    result: compiled.result,
    params,
    lines,
    questions,
    slips,
    usedBoxes,
  };
  checkRuleSet(ruleSet, fail);
  return ruleSet;
}

function checkBrackets(rows: BracketRow[], fail: (message: string) => never) {
  rows.forEach((row, index) => {
    const last = index === rows.length - 1;
    if (last !== (row.upTo === null)) fail("Every bracket but the last needs upTo; the last has none");
    const previous = rows[index - 1]?.upTo;
    if (row.upTo && previous && !row.upTo.gt(previous)) fail("Brackets must go up");
    if (row.rate.isNegative()) fail("A rate can't be negative");
  });
}

// ---------------------------------------------------------------------------
// Checks: every name exists, types agree, and no line depends on itself

type Type = "number" | "string" | "boolean" | "list" | "table";

const FUNCTIONS: Record<string, { args: [number, number]; check: (types: Type[], args: Formula[]) => Type | string }> = {
  min: { args: [1, 20], check: (types) => (types.every((t) => t === "number" || t === "list") ? "number" : "takes numbers or slip boxes") },
  max: { args: [1, 20], check: (types) => (types.every((t) => t === "number" || t === "list") ? "number" : "takes numbers or slip boxes") },
  sum: { args: [1, 20], check: (types) => (types.every((t) => t === "number" || t === "list") ? "number" : "takes numbers or slip boxes") },
  count: { args: [1, 1], check: (types) => (types[0] === "list" ? "number" : "takes slip boxes") },
  round: {
    args: [1, 2],
    check: (types, args) => {
      if (types[0] !== "number") return "rounds a number";
      const digits = args[1];
      if (digits && !(digits.kind === "number" && /^\d+$/.test(digits.value) && Number(digits.value) <= 12)) return "takes a whole number of digits from 0 to 12";
      return "number";
    },
  },
  clamp: { args: [3, 3], check: (types) => (types.every((t) => t === "number") ? "number" : "takes three numbers: value, low, high") },
  if: {
    args: [3, 3],
    check: (types) => {
      if (types[0] !== "boolean") return "needs a yes/no condition first";
      return types[1] === types[2] ? types[1]! : "needs both outcomes of the same kind";
    },
  },
  bracket: { args: [2, 2], check: (types) => (types[0] === "table" && types[1] === "number" ? "number" : "takes a bracket table and an amount") },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

function checkRuleSet(ruleSet: RuleSet, fail: (entry: string, message: string, column?: number) => never) {
  for (const id of ruleSet.result) if (!ruleSet.lines.has(id)) fail("result", `No line ${id}`);
  for (const [id, question] of ruleSet.questions) {
    const entry = `questions.${id}`;
    if (question.type === "choice" && !question.options?.length) fail(entry, "A choice needs options");
    if (question.type !== "choice" && question.options) fail(entry, "Only a choice has options");
    if (question.default !== undefined) {
      const ok =
        question.type === "money"
          ? typeof question.default === "string" && /^-?\d+(\.\d+)?$/.test(question.default)
          : question.type === "boolean"
            ? typeof question.default === "boolean"
            : typeof question.default === "string" && question.options!.includes(question.default);
      if (!ok) fail(entry, `The default doesn't fit a ${question.type} question`);
    }
  }

  // Each line's type, and the lines it reads (in its own return or the spouse's: both count toward a cycle).
  const edges = new Map<string, Set<string>>();
  for (const line of ruleSet.lines.values()) {
    const entry = `lines.${line.id}`;
    const reads = new Set<string>();
    const typeOf = (formula: Formula): Type => {
      switch (formula.kind) {
        case "number":
          return "number";
        case "string":
          return "string";
        case "boolean":
          return "boolean";
        case "ref":
          return refType(ruleSet, formula.path, (message) => fail(entry, message, formula.column), reads);
        case "unary": {
          const operand = typeOf(formula.operand);
          const want = formula.op === "-" ? "number" : "boolean";
          if (operand !== want) fail(entry, `"${formula.op}" needs a ${want === "number" ? "number" : "yes/no value"}`, formula.column);
          return want;
        }
        case "binary": {
          const at = (message: string) => fail(entry, message, formula.column);
          if (formula.op === "==" || formula.op === "!=") {
            checkChoice(ruleSet, formula.left, formula.right, at);
            checkChoice(ruleSet, formula.right, formula.left, at);
          }
          return binaryType(formula, typeOf(formula.left), typeOf(formula.right), at);
        }
        case "call": {
          const fn = FUNCTIONS[formula.name];
          if (!fn) return fail(entry, `No function ${formula.name}; the functions are ${FUNCTION_NAMES.join(", ")}`, formula.column);
          const [low, high] = fn.args;
          if (formula.args.length < low || formula.args.length > high) {
            fail(entry, `${formula.name} takes ${low === high ? low : `${low} to ${high}`} values`, formula.column);
          }
          const type = fn.check(formula.args.map(typeOf), formula.args);
          if (!["number", "string", "boolean", "list", "table"].includes(type)) fail(entry, `${formula.name} ${type}`, formula.column);
          return type as Type;
        }
      }
    };
    if (typeOf(line.formula) !== "number") fail(entry, "A line must be a number");
    edges.set(line.id, reads);
  }

  // Depth-first search for a cycle; the message lists it.
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") fail(`lines.${id}`, `The line depends on itself: ${[...trail.slice(trail.indexOf(id)), id].join(" → ")}`);
    state.set(id, "visiting");
    for (const next of edges.get(id) ?? []) visit(next, [...trail, id]);
    state.set(id, "done");
  };
  for (const id of ruleSet.lines.keys()) visit(id, []);
}

function binaryType(formula: Extract<Formula, { kind: "binary" }>, left: Type, right: Type, fail: (message: string) => never): Type {
  switch (formula.op) {
    case "+":
    case "-":
    case "*":
    case "/":
      if (left !== "number" || right !== "number") fail(`"${formula.op}" works on numbers; use sum() for slip boxes`);
      return "number";
    case "<":
    case "<=":
    case ">":
    case ">=":
      if (left !== "number" || right !== "number") fail(`"${formula.op}" compares numbers`);
      return "boolean";
    case "==":
    case "!=":
      if (left !== right || left === "list" || left === "table") fail(`"${formula.op}" compares two numbers, texts or yes/no values`);
      return "boolean";
    case "and":
    case "or":
      if (left !== "boolean" || right !== "boolean") fail(`"${formula.op}" joins yes/no values`);
      return "boolean";
  }
}

/** The type of a name, checking that it exists. Lines it reads are added to `reads`. */
function refType(ruleSet: RuleSet, path: string[], fail: (message: string) => never, reads: Set<string>, spouse = false): Type {
  const name = path.join(".");
  const [head, ...rest] = path;
  switch (head) {
    case "spouse":
      if (spouse) return fail(`${name}: spouse. can't be repeated`);
      if (rest[0] === "param") return fail(`${name}: params are the same for both spouses; write param.${rest.slice(1).join(".")}`);
      return refType(ruleSet, rest, fail, reads, true);
    case "param": {
      const param = rest.length === 1 ? ruleSet.params.get(rest[0]!) : undefined;
      if (!param) return fail(`No param ${name}`);
      return Array.isArray(param.value) ? "table" : "number";
    }
    case "line": {
      const id = rest.join(".");
      if (rest.length !== 2 || !ruleSet.lines.has(id)) return fail(`No line ${id}`);
      reads.add(id);
      return "number";
    }
    case "answer": {
      const question = rest.length === 1 ? ruleSet.questions.get(rest[0]!) : undefined;
      if (!question) return fail(`No question ${rest.join(".")}`);
      return question.type === "money" ? "number" : question.type === "boolean" ? "boolean" : "string";
    }
    case "person":
      if (rest.length === 1 && rest[0] === "age") return "number";
      if (rest.length === 1 && rest[0] === "province") return "string";
      return fail(`${name}: a person has age and province`);
    default: {
      const slip = ruleSet.slips.get(head ?? "");
      if (!slip) return fail(`Unknown name ${name}`);
      const box = rest.length === 1 && rest[0]!.startsWith("box") ? rest[0]!.slice(3) : undefined;
      if (box === undefined || !(box in slip.boxes)) return fail(`${name}: ${slip.id} has boxes ${Object.keys(slip.boxes).join(", ")}`);
      return "list";
    }
  }
}

/** `answer.x == "text"`: the text must be one of the question's options. */
function checkChoice(ruleSet: RuleSet, ref: Formula, other: Formula, fail: (message: string) => never) {
  if (ref.kind !== "ref" || other.kind !== "string") return;
  const path = ref.path[0] === "spouse" ? ref.path.slice(1) : ref.path;
  const question = path[0] === "answer" ? ruleSet.questions.get(path[1] ?? "") : undefined;
  if (question?.options && !question.options.includes(other.value)) {
    fail(`"${other.value}" isn't an option of ${question.id}: ${question.options.join(", ")}`);
  }
}
