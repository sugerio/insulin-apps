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
//   household.maritalStatus, household.partnerInYear, household.childrenUnder18, household.childrenUnder19
//                                 the year's marital status, whether the spouse's return is prepared too, and the
//                                 number of dependants under 18 (or 19) at the end of the year
//   spouse.<any of the above but param>   the same, for the spouse

export const STATUSES = ["complete", "estimate", "missing"] as const;
/** How sure a value is: `estimate` when a question's default stood in for an answer, `missing` when nothing could. */
export type Status = (typeof STATUSES)[number];

export interface BracketRow {
  /** The top of the bracket; null for the last one. */
  upTo: Dec | null;
  rate: Dec;
  /**
   * The tax on the income below this bracket, as the CRA's form prints it (rounded to the cent). When every row has
   * one, the tax is the base of the amount's bracket plus its rate on the part above the bracket's floor, which is
   * exactly how the form computes it.
   */
  base?: Dec;
}
export type ParamValue = Dec | BracketRow[];

export interface Param {
  id: string;
  label: string;
  value: ParamValue;
  source: string;
}
/**
 * The parts of a return the screens group its questions into: `about` the person (Personal info), and the income,
 * deductions and credits on it.
 */
export const MODULES = ["about", "income", "deductions", "credits"] as const;
export type Module = (typeof MODULES)[number];

export interface Line {
  id: string;
  label: string;
  /** The formula as written in the rule file. */
  text: string;
  formula: Formula;
  source?: string;
  /** A line worked out from slips, shown in this module so people see what their slips already claim. */
  module?: Module;
}
export type QuestionType = "money" | "percent" | "boolean" | "choice";
export interface Question {
  id: string;
  type: QuestionType;
  ask: string;
  /** The part of the return that asks it; the screens build their forms from this. */
  module?: Module;
  /** A sentence under the question. */
  help?: string;
  /** For a question about a kind of income or expense: the slip type that shows it. Found slips answer it. */
  slip?: string;
  /** For an amount: the receipts (a slip type) that go with it, shown beside it (and, where its line adds them, added). */
  receipts?: string;
  /** For an amount: a line that works out a starting amount from documents (receipts, a notice of assessment). */
  suggest?: string;
  /** A part of a yes/no question (a group): asked in its card once it applies (self-employment's income and expenses). */
  parent?: string;
  /** For a yes/no question: shown when it is answered yes (what else to do, such as a form to file separately). */
  note?: string;
  /** For a choice: each option's words on screen. */
  optionLabels?: Record<string, string>;
  /** Used, and the result marked an estimate, while the question has no answer. */
  default?: string | boolean;
  /** The default is the app's choice, not a guess: the result is complete without an answer (a hint may change it). */
  decision?: boolean;
  options?: string[];
}
export interface SlipType {
  id: string;
  title: string;
  about: string;
  boxes: Record<string, string>;
  /** Boxes that never change a return (the CRA's checks, next year's limits): not reported as unhandled. */
  informational: string[];
  /** Boxes that hold a count (months of study), not an amount of money. */
  counts: string[];
  /** A receipt or notice rather than a numbered slip: its "boxes" are amounts with no number printed beside them. */
  receipt: boolean;
  /** The years it may carry, relative to the tax year (0 the year itself; -1 last year's notice of assessment). */
  printedYears: number[];
  /** How it is named on screen when its id can't be (T4A(OAS) for T4AOAS). */
  name?: string;
}

export const HINT_KINDS = ["saving", "info", "warning"] as const;
export type HintKind = (typeof HINT_KINDS)[number];

/** One answer a hint changes: the question, on this return or the spouse's, and its new value as a formula. */
export interface HintChange {
  spouse: boolean;
  question: string;
  text: string;
  formula: Formula;
}

/**
 * A hint: a check on a return that either proposes a change with the money it saves (`saving`) or tells the person
 * something (`info`, `warning`). `when` decides whether it shows, from this person's side. A change is a set of
 * answers; the engine works out the household's result with and without it, so a saving is never guessed.
 */
export interface Hint {
  id: string;
  kind: HintKind;
  title: string;
  text: string;
  when: Formula;
  whenText: string;
  change: HintChange[];
  /** An amount shown with the hint, and what it is. */
  amount?: { formula: Formula; text: string; label: string };
  /** For an info hint with a change: what the difference the change makes is called. */
  effectLabel?: string;
}

/** An amount on a CRA form: where it goes (page, the x of the line between dollars and cents, the baseline) and what. */
export interface FormField {
  /** The form's row number, or the line code of a box without one (form-layout.yaml). */
  key: string;
  page: number;
  x: number;
  y: number;
  formula: Formula;
  text: string;
  /** Written only when this is yes. */
  when?: { formula: Formula; text: string };
}

/**
 * A bracket table printed on a form (one column per bracket, in one or more parts): the column of the bracket the amount
 * falls in gets the amount, the amount over the bracket's floor, that times the rate, and that plus the printed base.
 */
export interface FormTable {
  brackets: string;
  amount: Formula;
  amountText: string;
  /** Each printed table: its page, each column's cents line, and its rows' baselines, with the rows' numbers. */
  parts: { page: number; columns: number[]; amount: number; over: number; times: number; tax: number; rows: [string, string, string, string] }[];
}

/** A CRA print form the app fills in (forms.yaml), measured in form-layout.yaml. */
export interface FormSpec {
  id: string;
  title: string;
  /** Where the CRA publishes it, and the SHA-256 of the file the layout was measured on. */
  url: string;
  sha256: string;
  pages: number;
  /** Which returns get it. */
  applies: Formula;
  appliesText: string;
  fields: FormField[];
  tables: FormTable[];
}

/** What to call a document of this type on screen: a slip by its type (T4), a receipt or notice by its title. */
export function documentName(slipType: SlipType | undefined, id: string): string {
  return slipType?.receipt ? slipType.title : (slipType?.name ?? id);
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
  hints: Map<string, Hint>;
  /** The CRA forms a return is printed on, in order. */
  forms: Map<string, FormSpec>;
  /** The line a hint's what-if compares, added up over the household: the refund less the balance owing. */
  outcome?: string;
}

// ---------------------------------------------------------------------------
// The compiled form (JSON)

const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/);
const bracketRowSchema = z.strictObject({ upTo: decimalText.nullable(), rate: decimalText, base: decimalText.optional() });
export const compiledRulesSchema = z.strictObject({
  country: z.string().regex(/^[a-z]{2}$/),
  year: z.number().int(),
  filingUnit: z.literal("person"),
  version: z.string(),
  result: z.array(z.string()),
  params: z.record(z.string(), z.strictObject({ label: z.string(), value: z.union([decimalText, z.array(bracketRowSchema).min(1)]), source: z.string() })),
  lines: z.record(z.string(), z.strictObject({ label: z.string(), formula: z.string(), source: z.string().optional(), module: z.enum(MODULES).optional() })),
  questions: z.record(
    z.string(),
    z.strictObject({
      type: z.enum(["money", "percent", "boolean", "choice"]),
      ask: z.string(),
      module: z.enum(MODULES).optional(),
      help: z.string().optional(),
      slip: z.string().optional(),
      receipts: z.string().optional(),
      suggest: z.string().optional(),
      default: z.union([z.string(), z.boolean()]).optional(),
      decision: z.boolean().optional(),
      options: z.array(z.string()).optional(),
      parent: z.string().optional(),
      note: z.string().optional(),
      optionLabels: z.record(z.string(), z.string()).optional(),
    }),
  ),
  hints: z.record(
    z.string(),
    z.strictObject({
      kind: z.enum(HINT_KINDS),
      title: z.string(),
      text: z.string(),
      when: z.string(),
      change: z.record(z.string(), z.string()).optional(),
      amount: z.string().optional(),
      amountLabel: z.string().optional(),
      effectLabel: z.string().optional(),
    }),
  ),
  outcome: z.string().optional(),
  forms: z.record(
    z.string(),
    z.strictObject({
      title: z.string(),
      url: z.url(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      pages: z.number().int().min(1),
      applies: z.string(),
      fields: z.array(
        z.strictObject({ key: z.string(), page: z.number().int().min(1), x: z.number(), y: z.number(), value: z.string(), when: z.string().optional() }),
      ),
      tables: z.array(
        z.strictObject({
          brackets: z.string(),
          amount: z.string(),
          parts: z.array(
            z.strictObject({
              page: z.number().int().min(1),
              columns: z.array(z.number()).min(1),
              amount: z.number(),
              over: z.number(),
              times: z.number(),
              tax: z.number(),
              rows: z.tuple([z.string(), z.string(), z.string(), z.string()]),
            }),
          ),
        }),
      ),
    }),
  ),
  slips: z.record(
    z.string(),
    z.strictObject({
      title: z.string(),
      about: z.string(),
      boxes: z.record(z.string(), z.string()),
      informational: z.array(z.string()),
      counts: z.array(z.string()),
      receipt: z.boolean(),
      printedYears: z.array(z.number().int()).min(1),
      name: z.string().optional(),
    }),
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
        : param.value.map((row) => ({
            upTo: row.upTo === null ? null : Dec.from(row.upTo),
            rate: Dec.from(row.rate),
            ...(row.base === undefined ? {} : { base: Dec.from(row.base) }),
          }));
    if (Array.isArray(value)) checkBrackets(value, (message) => fail(`params.${id}`, message));
    params.set(id, { id, label: param.label, value, source: param.source });
  }
  const parse = (entry: string, text: string): Formula => {
    try {
      return parseFormula(text);
    } catch (error) {
      if (error instanceof FormulaSyntaxError) fail(entry, error.message, error.column);
      throw error;
    }
  };
  const lines = new Map<string, Line>();
  for (const [id, line] of Object.entries(compiled.lines)) {
    const formula = parse(`lines.${id}`, line.formula);
    lines.set(id, {
      id,
      label: line.label,
      text: line.formula,
      formula,
      ...(line.source === undefined ? {} : { source: line.source }),
      ...(line.module === undefined ? {} : { module: line.module }),
    });
  }
  const questions = new Map(Object.entries(compiled.questions).map(([id, question]) => [id, { id, ...question } satisfies Question]));
  const slips = new Map(Object.entries(compiled.slips).map(([id, slip]) => [id, { id, ...slip } satisfies SlipType]));
  const hints = new Map<string, Hint>();
  for (const [id, hint] of Object.entries(compiled.hints)) {
    const entry = `hints.${id}`;
    const change = Object.entries(hint.change ?? {}).map(([target, text]) => {
      const match = /^(spouse\.)?answer\.([A-Za-z][A-Za-z0-9]*)$/.exec(target);
      if (!match) return fail(entry, `change ${target}: write answer.<question> or spouse.answer.<question>`);
      return { spouse: match[1] !== undefined, question: match[2]!, text, formula: parse(entry, text) };
    });
    if ((hint.amount === undefined) !== (hint.amountLabel === undefined)) fail(entry, "Give amount and amountLabel together");
    hints.set(id, {
      id,
      kind: hint.kind,
      title: hint.title,
      text: hint.text,
      when: parse(entry, hint.when),
      whenText: hint.when,
      change,
      ...(hint.amount === undefined ? {} : { amount: { formula: parse(entry, hint.amount), text: hint.amount, label: hint.amountLabel! } }),
      ...(hint.effectLabel === undefined ? {} : { effectLabel: hint.effectLabel }),
    });
  }

  const usedBoxes = new Map<string, Set<string>>();
  for (const slip of slips.values()) {
    for (const box of slip.informational) if (!(box in slip.boxes)) fail(`slips.${slip.id}`, `informational box ${box} isn't one of its boxes`);
    for (const box of slip.counts) if (!(box in slip.boxes)) fail(`slips.${slip.id}`, `count box ${box} isn't one of its boxes`);
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
    hints,
    forms: new Map(
      Object.entries(compiled.forms).map(([id, form]) => {
        const entry = `forms.${id}`;
        const spec: FormSpec = {
          id,
          title: form.title,
          url: form.url,
          sha256: form.sha256,
          pages: form.pages,
          applies: parse(entry, form.applies),
          appliesText: form.applies,
          fields: form.fields.map((field) => ({
            key: field.key,
            page: field.page,
            x: field.x,
            y: field.y,
            formula: parse(`${entry}.fields.${field.key}`, field.value),
            text: field.value,
            ...(field.when === undefined ? {} : { when: { formula: parse(`${entry}.fields.${field.key}`, field.when), text: field.when } }),
          })),
          tables: form.tables.map((table) => ({ brackets: table.brackets, amount: parse(entry, table.amount), amountText: table.amount, parts: table.parts })),
        };
        return [id, spec];
      }),
    ),
    ...(compiled.outcome === undefined ? {} : { outcome: compiled.outcome }),
  };
  checkRuleSet(ruleSet, fail);
  return ruleSet;
}

function checkBrackets(rows: BracketRow[], fail: (message: string) => never) {
  const withBase = rows.filter((row) => row.base !== undefined).length;
  if (withBase !== 0 && withBase !== rows.length) fail("Give a base for every bracket or for none");
  let exact = Dec.ZERO;
  rows.forEach((row, index) => {
    const last = index === rows.length - 1;
    if (last !== (row.upTo === null)) fail("Every bracket but the last needs upTo; the last has none");
    const previous = rows[index - 1]?.upTo ?? null;
    if (row.upTo && previous && !row.upTo.gt(previous)) fail("Brackets must go up");
    if (row.rate.isNegative()) fail("A rate can't be negative");
    // A printed base is the exact tax below the bracket, rounded to the cent: anything else is a typo.
    if (row.base !== undefined && !row.base.eq(exact.roundTo(2, "HALF_UP"))) {
      fail(`The base of bracket ${index + 1} is ${row.base.toString()}; the brackets below it give ${exact.roundTo(2, "HALF_UP").toString()}`);
    }
    if (row.upTo) exact = exact.add(row.upTo.sub(previous ?? Dec.ZERO).mul(row.rate));
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
  // A case the rules know about but the app can't compute yet: the value is missing, and the text says why.
  unsupported: {
    args: [1, 1],
    check: (_types, args) => (args[0]?.kind === "string" ? "number" : "takes the reason, as text in quotes"),
  },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

function checkRuleSet(ruleSet: RuleSet, fail: (entry: string, message: string, column?: number) => never) {
  for (const id of ruleSet.result) if (!ruleSet.lines.has(id)) fail("result", `No line ${id}`);
  for (const [id, question] of ruleSet.questions) {
    const entry = `questions.${id}`;
    if (question.type === "choice" && !question.options?.length) fail(entry, "A choice needs options");
    if (question.type !== "choice" && question.options) fail(entry, "Only a choice has options");
    if (question.slip !== undefined && (question.type !== "boolean" || !ruleSet.slips.has(question.slip))) {
      fail(entry, "A question's slip must be a slip type, on a yes/no question");
    }
    if (question.receipts !== undefined && (question.type !== "money" || !ruleSet.slips.has(question.receipts))) {
      fail(entry, "A question's receipts must be a slip type, on an amount");
    }
    if (question.suggest !== undefined && (question.type !== "money" || !ruleSet.lines.has(question.suggest))) {
      fail(entry, "A question's suggest must be a line, on an amount");
    }
    if (question.default !== undefined) {
      const ok =
        question.type === "money" || question.type === "percent"
          ? typeof question.default === "string" && /^-?\d+(\.\d+)?$/.test(question.default)
          : question.type === "boolean"
            ? typeof question.default === "boolean"
            : typeof question.default === "string" && question.options!.includes(question.default);
      if (!ok) fail(entry, `The default doesn't fit a ${question.type} question`);
    }
    if (question.decision && question.default === undefined) fail(entry, "A decision needs a default");
    if (question.parent !== undefined) {
      const parent = ruleSet.questions.get(question.parent);
      if (!parent || parent.type !== "boolean" || parent.slip || parent.parent) fail(entry, "A question's parent must be a yes/no question without a slip, not itself a part");
      if (parent!.module !== question.module) fail(entry, "A question and its parent are asked in the same module");
      if (question.type === "boolean") fail(entry, "A part of a group is an amount, a percent or a choice");
    }
    if (question.optionLabels && (question.type !== "choice" || Object.keys(question.optionLabels).some((option) => !question.options!.includes(option)))) {
      fail(entry, "optionLabels name the options of a choice");
    }
    if (question.note !== undefined && question.type !== "boolean") fail(entry, "Only a yes/no question has a note");
  }

  // Each line's type, and the lines it reads (in its own return or the spouse's: both count toward a cycle).
  const edges = new Map<string, Set<string>>();
  for (const line of ruleSet.lines.values()) {
    const entry = `lines.${line.id}`;
    const reads = new Set<string>();
    if (formulaType(ruleSet, line.formula, (message, column) => fail(entry, message, column), reads) !== "number") fail(entry, "A line must be a number");
    edges.set(line.id, reads);
  }

  // A hint's formulas: `when` a yes/no value, its amount a number, each change of its answer's type.
  if (ruleSet.outcome !== undefined && !ruleSet.lines.has(ruleSet.outcome)) fail("outcome", `No line ${ruleSet.outcome}`);
  for (const hint of ruleSet.hints.values()) {
    const entry = `hints.${hint.id}`;
    const at = (message: string, column?: number) => fail(entry, message, column);
    const reads = new Set<string>();
    if (formulaType(ruleSet, hint.when, at, reads) !== "boolean") fail(entry, "when must be a yes/no value");
    if (hint.amount && formulaType(ruleSet, hint.amount.formula, at, reads) !== "number") fail(entry, "amount must be a number");
    for (const change of hint.change) {
      const question = ruleSet.questions.get(change.question);
      if (!question) return fail(entry, `No question ${change.question}`);
      const want = question.type === "money" || question.type === "percent" ? "number" : question.type === "boolean" ? "boolean" : "string";
      if (formulaType(ruleSet, change.formula, at, reads) !== want) fail(entry, `The change to ${change.question} must be a ${want === "boolean" ? "yes/no value" : want}`);
    }
    if (hint.kind === "saving" && hint.change.length === 0) fail(entry, "A saving hint changes at least one answer");
    if (hint.kind === "saving" && hint.effectLabel !== undefined) fail(entry, "A saving hint shows what it saves; effectLabel is for info hints");
    if (hint.kind !== "saving" && (hint.change.length > 0) !== (hint.effectLabel !== undefined)) {
      fail(entry, "An info hint with a change names its effect (effectLabel), and only then");
    }
    if (hint.change.length > 0 && ruleSet.outcome === undefined) fail(entry, "A hint with a change needs the year's outcome line (outcome in year.yaml)");
  }

  // A form's formulas: which returns get it (yes/no), each amount a number, and its condition yes/no. A bracket table
  // names a bracket param with printed bases, and its parts have a column for each bracket.
  for (const form of ruleSet.forms.values()) {
    const entry = `forms.${form.id}`;
    const at = (where: string) => (message: string, column?: number) => fail(where, message, column);
    if (formulaType(ruleSet, form.applies, at(entry), new Set()) !== "boolean") fail(entry, "applies must be a yes/no value");
    for (const field of form.fields) {
      const where = `${entry}.fields.${field.key}`;
      if (field.page > form.pages) fail(where, `The form has ${form.pages} pages`);
      if (formulaType(ruleSet, field.formula, at(where), new Set()) !== "number") fail(where, "An amount on a form must be a number");
      if (field.when && formulaType(ruleSet, field.when.formula, at(where), new Set()) !== "boolean") fail(where, "when must be a yes/no value");
    }
    for (const table of form.tables) {
      const param = ruleSet.params.get(table.brackets);
      if (!param || !Array.isArray(param.value)) return fail(entry, `No bracket table param ${table.brackets}`);
      if (param.value.some((row) => row.base === undefined)) fail(entry, `${table.brackets} needs the base of each bracket, as printed on the form`);
      const columns = table.parts.reduce((sum, part) => sum + part.columns.length, 0);
      if (columns !== param.value.length) fail(entry, `The table has ${columns} columns; ${table.brackets} has ${param.value.length} brackets`);
      if (formulaType(ruleSet, table.amount, at(entry), new Set()) !== "number") fail(entry, "A table's amount must be a number");
    }
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

/** The type of a formula, checking every name and function in it. Lines it reads are added to `reads`. */
function formulaType(ruleSet: RuleSet, formula: Formula, fail: (message: string, column?: number) => never, reads: Set<string>): Type {
  const typeOf = (inner: Formula) => formulaType(ruleSet, inner, fail, reads);
  switch (formula.kind) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "ref":
      return refType(ruleSet, formula.path, (message) => fail(message, formula.column), reads);
    case "unary": {
      const operand = typeOf(formula.operand);
      const want = formula.op === "-" ? "number" : "boolean";
      if (operand !== want) fail(`"${formula.op}" needs a ${want === "number" ? "number" : "yes/no value"}`, formula.column);
      return want;
    }
    case "binary": {
      const at = (message: string) => fail(message, formula.column);
      if (formula.op === "==" || formula.op === "!=") {
        checkChoice(ruleSet, formula.left, formula.right, at);
        checkChoice(ruleSet, formula.right, formula.left, at);
      }
      return binaryType(formula, typeOf(formula.left), typeOf(formula.right), at);
    }
    case "call": {
      const fn = FUNCTIONS[formula.name];
      if (!fn) return fail(`No function ${formula.name}; the functions are ${FUNCTION_NAMES.join(", ")}`, formula.column);
      const [low, high] = fn.args;
      if (formula.args.length < low || formula.args.length > high) {
        fail(`${formula.name} takes ${low === high ? low : `${low} to ${high}`} values`, formula.column);
      }
      const type = fn.check(formula.args.map(typeOf), formula.args);
      if (!["number", "string", "boolean", "list", "table"].includes(type)) fail(`${formula.name} ${type}`, formula.column);
      return type as Type;
    }
  }
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
      return question.type === "money" || question.type === "percent" ? "number" : question.type === "boolean" ? "boolean" : "string";
    }
    case "household":
      if (spouse) return fail(`${name}: the household is the same for both spouses; write household.${rest.join(".")}`);
      if (rest.length === 1 && rest[0] === "maritalStatus") return "string";
      if (rest.length === 1 && rest[0] === "partnerInYear") return "boolean";
      if (rest.length === 1 && ["childrenUnder7", "childrenUnder17", "childrenUnder18", "childrenUnder19"].includes(rest[0]!)) return "number";
      return fail(`${name}: the household has maritalStatus, partnerInYear, childrenUnder7, childrenUnder17, childrenUnder18 and childrenUnder19`);
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
