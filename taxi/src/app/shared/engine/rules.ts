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
//   <SLIP>.box<key>               that box of every one of the person's slips of that type (a list: sum, count,
//                                 countNonZero, countIssuers, max)
//   <SLIP>.slips                  how many slips of that type the person has, whatever boxes they show
//   person.age, person.province, person.role   the person's age and province (or state) on December 31, and "self"
//                                 for the person preparing or "spouse"; person.residentAllYear whether they were a
//                                 resident all year (the rule set's `residency` says of which country)
//   person.birthMonth             the month the person was born, 1 to 12 (with person.age, the month they turned an
//                                 age this year, which prorates CPP in the year they turn 18 or 70)
//   family.filingStatus           a married couple's filing status where the country has one (US: joint or separate)
//   family.maritalStatus, family.partnerInYear, family.childrenUnder18, family.childrenUnder19
//                                 the year's marital status, whether the spouse's return is prepared too, and the
//                                 number of dependants under 18 (or 19) at the end of the year; also childrenUnder6,
//                                 childrenUnder7 and childrenUnder17, and family.dependants, the dependants of any age
//   family.childMonthsUnder6      for each dependant under 18, the months on whose first day they were born and under 6
//                                 (a list: sum, min)
//   spouse.<any of the above but param>   the same, for the spouse
//   dependants.<line>             a line with `each: dependant`, worked out for each dependant claimed on this return
//                                 (a list: sum, count, max, min)
// A line with `each: dependant` is worked out once for each dependant in the year and reads:
//   dependant.age                 the dependant's age on December 31
//   dependant.answer.<question>   an answer about the dependant (a question with `dependant: true`)
//   line.<form>.<line>            another line worked out for the same dependant
//   param.<name>, family.<fact>   as above

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
  /** `dependant`: worked out once for each dependant in the year, reading dependant.<…> (rules.ts header). */
  each?: "dependant";
}
export type QuestionType = "money" | "percent" | "count" | "boolean" | "choice";
/** A question whose answer is a number: an amount, a percent or a count. */
export const isNumberQuestion = (type: QuestionType) => type === "money" || type === "percent" || type === "count";
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
  /**
   * A part asked only when another part of its group, a choice, has one of these options: the years of a home that was
   * your residence only some of the years, the balances of a class of capital cost allowance. It keeps a group's card
   * to what applies; the rules read such a part only in the same case.
   */
  askedWhen?: { question: string; options: string[] };
  /** For a yes/no question: shown when it is answered yes (what else to do, such as a form to file separately). */
  note?: string;
  /** For a choice: each option's words on screen. */
  optionLabels?: Record<string, string>;
  /** Used, and the result marked an estimate, while the question has no answer. */
  default?: string | boolean;
  /** The default is the app's choice, not a guess: the result is complete without an answer (a hint may change it). */
  decision?: boolean;
  /** Asked about each dependant in the year (dependant.answer.<id>), not about an adult. */
  dependant?: boolean;
  options?: string[];
  /** For a count: the most it can be, where the year sets one (12 months, 365 days). */
  max?: number;
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
  /**
   * Boxes that hold a code from a list, not an amount: a 1099-R's distribution code (box 7), which part of Form 8949 a
   * 1099-B summary is for. A formula reads them only through sumWhere and countWhere.
   */
  codes: Record<string, string[]>;
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
 * answers; the engine works out the result of the year's returns with and without it, so a saving is never guessed.
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
  /**
   * The what-if files the year this way instead (a married couple's US return). Only an info hint can: the person
   * changes the filing status on Personal info, as it changes who is on each return.
   */
  filingStatus?: "joint" | "separate";
  /** An info hint shown only when its what-if raises the year's outcome by $1 or more, as a saving is. */
  onlyIfSaving?: boolean;
}

/**
 * What a form's text box can hold: facts about the person that no tax line computes, kept out of the formulas. A name
 * is split at its last space (first name, last name). The TP-1 asks for the spouse's last name and date of birth too.
 * The IRS's forms ask for the spouse's whole name (filing separately), each schedule for the names on the return
 * (`returnNames`: both spouses' on a joint return), and a person's own schedule for their whole name (`name`).
 */
export const PERSONAL_FACTS = [
  "firstName",
  "lastName",
  "birthDate",
  "province",
  "spouseFirstName",
  "spouseLastName",
  "spouseBirthDate",
  "spouseName",
  "returnNames",
  "name",
] as const;
export type PersonalFact = (typeof PERSONAL_FACTS)[number];
/**
 * What a dependant's text box can hold: their name split at its last space, their whole name, and their year of birth.
 * A field can also write a dependant's answer to a choice question in the form's own words (`labels`).
 */
export const DEPENDANT_FACTS = ["firstName", "lastName", "name", "birthYear"] as const;
export type DependantFact = (typeof DEPENDANT_FACTS)[number];
export const FIELD_KINDS = ["amount", "count", "tick", "text"] as const;

/** Where a form's field is (form-layout.yaml): the page, and x and y in PDF points from the bottom left. */
interface FieldPlace {
  /** The form's row number, the line code of a box without one, or a named place (Step 1's `firstName`). */
  key: string;
  page: number;
  x: number;
  y: number;
  /** Written only when this is yes. */
  when?: { formula: Formula; text: string };
}
/**
 * What a form gets, by kind: an amount in dollars and cents (x is the line between them, or the right end of a `plain`
 * box with no such line; `zero` writes 0.00 where the CRA asks for an amount even when it is zero), a whole number (x is
 * where its box ends; with `digits`, written with that many digits, zeros included, even when it is zero), a tick (x
 * and y are the box's centre) and a personal fact as text (x is where it starts; a date's boxes have a cell width).
 */
export type FormField =
  | (FieldPlace & { kind: "amount"; formula: Formula; text: string; zero: boolean; plain: boolean })
  | (FieldPlace & { kind: "count"; formula: Formula; text: string; digits?: number })
  | (FieldPlace & { kind: "tick"; formula: Formula; text: string })
  | (FieldPlace & { kind: "text"; fact: PersonalFact; width?: number; cell?: number });

/**
 * A field of a form's table of dependants, in the column (or row) of the table it is in: worked out for the dependant
 * written there, from their side (`dependant.`), like a line with `each: dependant`. Its `when` is about the return
 * instead (the filer's social security number): a dependant's side can't read the return's lines. Text is one of the
 * dependant's facts, or their answer to a choice question in the form's words (an answer with no words leaves the box
 * blank).
 */
export type DependantField =
  | (FieldPlace & { column: number; kind: "amount"; formula: Formula; text: string; plain: boolean })
  | (FieldPlace & { column: number; kind: "count" | "tick"; formula: Formula; text: string })
  | (FieldPlace & { column: number; kind: "text"; fact: DependantFact; width?: number; cell?: number })
  | (FieldPlace & { column: number; kind: "choice"; question: string; labels: Record<string, string>; width?: number });

/**
 * A form's table of dependants (Form 1040's, Schedule EIC's): when `when` is yes for the return, the dependants of the
 * return for whom `which` is yes, in the year's order, one per column, as many as the form has columns. When there are
 * more and the form has a "more" box (Form 1040's "more than four dependents"), it is ticked and the others are named
 * on the worksheet; a form without one (Schedule EIC, which counts three at most) takes the first.
 */
export interface DependantTable {
  when?: Formula;
  which: Formula;
  whichText: string;
  columns: number;
  more?: { page: number; x: number; y: number };
  fields: DependantField[];
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

/** A version of a print form: its file, and what goes where on it. */
export interface FormVersion {
  title: string;
  /** Where the CRA or Revenu Québec publishes it, and the SHA-256 of the file the layout was measured on. */
  url: string;
  sha256: string;
  pages: number;
  fields: FormField[];
  tables: FormTable[];
}

/** A CRA or Revenu Québec print form the app fills in (forms.yaml), measured in form-layout.yaml. */
export interface FormSpec extends FormVersion {
  id: string;
  /** Which returns get it. */
  applies: Formula;
  appliesText: string;
  /** The publisher's French version, with the same fields at that version's places. */
  french?: FormVersion;
  /** The form's table of dependants. */
  dependants?: DependantTable;
  /**
   * Whose form it is on a joint return: the spouse's copy of a form each spouse files (Schedule C, Schedule SE) works
   * its rows out from the spouse's side, and writes the spouse's name where the form asks for the person's.
   */
  side?: "spouse";
}

/**
 * A form a return needs that isn't printed (forms.yaml `toAdd`): the worksheet and Finish name it, with what it is for,
 * for the person to fill in and file with the printed forms.
 */
export interface FormToAdd {
  id: string;
  form: string;
  why: string;
  applies: Formula;
}

/** The languages a return's forms print in: English, or French where the form has a French version. */
export const FORM_LANGUAGES = ["en", "fr"] as const;
export type FormLanguage = (typeof FORM_LANGUAGES)[number];

/** The version of a form to print in a language: its French version when asked for and it has one. */
export function formIn(form: FormSpec, language: FormLanguage): FormSpec {
  return language === "fr" && form.french ? { ...form, ...form.french } : form;
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
  /** A result line shown only on the returns where its formula is yes. */
  resultWhen: Map<string, Formula>;
  params: Map<string, Param>;
  lines: Map<string, Line>;
  questions: Map<string, Question>;
  slips: Map<string, SlipType>;
  /** Per slip type, the boxes some formula reads, and the informational ones. Any other box with an amount is shown as not handled. */
  usedBoxes: Map<string, Set<string>>;
  hints: Map<string, Hint>;
  /** The official forms a return is printed on, in order. */
  forms: Map<string, FormSpec>;
  /** The forms a return can need that aren't printed, in the order they're attached. */
  formsToAdd: FormToAdd[];
  /** The line a hint's what-if compares, added up over the year's returns: the refund less the balance owing. */
  outcome?: string;
  /**
   * Each refund-or-balance a return shows, in order, as a pair of result lines: the federal one, then (for a resident
   * of Quebec) Revenu Québec's. A return shows the ones whose lines are in its result.
   */
  balances: Balance[];
  /** What person.residentAllYear means, as an explanation names it. */
  residency: string;
  /**
   * What AI reading is told about this country's documents: what they are ("Canadian personal tax slips, receipts and
   * notices"), and notes on reading the ones that need it. `{year}`, `{nextYear}` and `{lastYear}` in a note are years.
   */
  reading: { documents: string; notes: string[] };
}

export interface Balance {
  /** "Federal", "Quebec": the title when a return shows more than one. */
  name: string;
  refund: string;
  owing: string;
}

// ---------------------------------------------------------------------------
// The compiled form (JSON)

const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/);
const bracketRowSchema = z.strictObject({ upTo: decimalText.nullable(), rate: decimalText, base: decimalText.optional() });
/** A printed bracket table's part: its page, each column's cents line, its rows' baselines and their numbers. */
const tablePartSchema = z.strictObject({
  page: z.number().int().min(1),
  columns: z.array(z.number()).min(1),
  amount: z.number(),
  over: z.number(),
  times: z.number(),
  tax: z.number(),
  rows: z.tuple([z.string(), z.string(), z.string(), z.string()]),
});

/** A form's field as compiled: its place, and a formula (for text, the fact; for a choice, the question). */
const compiledFieldSchema = z.strictObject({
  key: z.string(),
  kind: z.enum([...FIELD_KINDS, "choice"]),
  page: z.number().int().min(1),
  x: z.number(),
  y: z.number(),
  value: z.string(),
  when: z.string().optional(),
  zero: z.boolean().optional(),
  plain: z.boolean().optional(),
  width: z.number().optional(),
  cell: z.number().optional(),
  /** A count written with this many digits, zeros included. */
  digits: z.number().int().min(1).optional(),
  /** In a table of dependants: the column. */
  column: z.number().int().min(1).optional(),
  /** A choice's answers in the form's words. */
  labels: z.record(z.string(), z.string()).optional(),
});

export const compiledRulesSchema = z.strictObject({
  country: z.string().regex(/^[a-z]{2}$/),
  year: z.number().int(),
  filingUnit: z.literal("person"),
  version: z.string(),
  result: z.array(z.string()),
  resultWhen: z.record(z.string(), z.string()),
  params: z.record(z.string(), z.strictObject({ label: z.string(), value: z.union([decimalText, z.array(bracketRowSchema).min(1)]), source: z.string() })),
  lines: z.record(
    z.string(),
    z.strictObject({
      label: z.string(),
      formula: z.string(),
      source: z.string().optional(),
      module: z.enum(MODULES).optional(),
      each: z.literal("dependant").optional(),
    }),
  ),
  questions: z.record(
    z.string(),
    z.strictObject({
      type: z.enum(["money", "percent", "count", "boolean", "choice"]),
      ask: z.string(),
      module: z.enum(MODULES).optional(),
      help: z.string().optional(),
      slip: z.string().optional(),
      receipts: z.string().optional(),
      suggest: z.string().optional(),
      default: z.union([z.string(), z.boolean()]).optional(),
      decision: z.boolean().optional(),
      dependant: z.boolean().optional(),
      options: z.array(z.string()).optional(),
      parent: z.string().optional(),
      askedWhen: z.strictObject({ question: z.string(), options: z.array(z.string()) }).optional(),
      note: z.string().optional(),
      optionLabels: z.record(z.string(), z.string()).optional(),
      max: z.number().int().min(1).optional(),
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
      filingStatus: z.enum(["joint", "separate"]).optional(),
      onlyIfSaving: z.boolean().optional(),
    }),
  ),
  outcome: z.string().optional(),
  balances: z.array(z.strictObject({ name: z.string(), refund: z.string(), owing: z.string() })),
  residency: z.string().optional(),
  reading: z.strictObject({ documents: z.string(), notes: z.array(z.string()) }).optional(),
  forms: z.record(
    z.string(),
    z.strictObject({
      title: z.string(),
      url: z.url(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      pages: z.number().int().min(1),
      applies: z.string(),
      side: z.literal("spouse").optional(),
      fields: z.array(compiledFieldSchema),
      dependants: z
        .strictObject({
          when: z.string().optional(),
          which: z.string(),
          columns: z.number().int().min(1),
          more: z.tuple([z.number().int().min(1), z.number(), z.number()]).optional(),
          fields: z.array(compiledFieldSchema),
        })
        .optional(),
      /** The French version: its file, and each field's place on it (in the fields' order), and each table's parts. */
      french: z
        .strictObject({
          title: z.string(),
          url: z.url(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          pages: z.number().int().min(1),
          places: z.array(
            z.strictObject({
              page: z.number().int().min(1),
              x: z.number(),
              y: z.number(),
              plain: z.boolean().optional(),
              width: z.number().optional(),
              cell: z.number().optional(),
            }),
          ),
          tables: z.array(z.array(tablePartSchema)),
        })
        .optional(),
      tables: z.array(
        z.strictObject({
          brackets: z.string(),
          amount: z.string(),
          parts: z.array(tablePartSchema),
        }),
      ),
    }),
  ),
  formsToAdd: z.array(z.strictObject({ id: z.string(), form: z.string(), why: z.string(), applies: z.string() })),
  slips: z.record(
    z.string(),
    z.strictObject({
      title: z.string(),
      about: z.string(),
      boxes: z.record(z.string(), z.string()),
      informational: z.array(z.string()),
      counts: z.array(z.string()),
      codes: z.record(z.string(), z.array(z.string())).default({}),
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
  /** A compiled field's place, and its condition. */
  const placeOf = (where: string, field: z.infer<typeof compiledFieldSchema>) => ({
    key: field.key,
    page: field.page,
    x: field.x,
    y: field.y,
    ...(field.when === undefined ? {} : { when: { formula: parse(where, field.when), text: field.when } }),
  });
  const sizeOf = (field: z.infer<typeof compiledFieldSchema>) => ({ ...(field.width === undefined ? {} : { width: field.width }), ...(field.cell === undefined ? {} : { cell: field.cell }) });
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
      ...(line.each === undefined ? {} : { each: line.each }),
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
      ...(hint.filingStatus === undefined ? {} : { filingStatus: hint.filingStatus }),
      ...(hint.onlyIfSaving === undefined ? {} : { onlyIfSaving: hint.onlyIfSaving }),
    });
  }

  const usedBoxes = new Map<string, Set<string>>();
  for (const slip of slips.values()) {
    for (const box of slip.informational) if (!(box in slip.boxes)) fail(`slips.${slip.id}`, `informational box ${box} isn't one of its boxes`);
    for (const box of slip.counts) if (!(box in slip.boxes)) fail(`slips.${slip.id}`, `count box ${box} isn't one of its boxes`);
    for (const [box, codes] of Object.entries(slip.codes)) {
      if (!(box in slip.boxes)) fail(`slips.${slip.id}`, `code box ${box} isn't one of its boxes`);
      if (codes.length === 0 || codes.some((code) => !/^[0-9A-Z]{1,2}$/.test(code))) fail(`slips.${slip.id}`, `code box ${box} needs codes of one or two capital letters or digits`);
      if (slip.counts.includes(box) || slip.informational.includes(box)) fail(`slips.${slip.id}`, `code box ${box} can't also be a count or informational`);
    }
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
    resultWhen: new Map(Object.entries(compiled.resultWhen).map(([id, text]) => [id, parse(`resultWhen.${id}`, text)])),
    params,
    lines,
    questions,
    slips,
    usedBoxes,
    hints,
    formsToAdd: compiled.formsToAdd.map((each) => ({ id: each.id, form: each.form, why: each.why, applies: parse(`formsToAdd.${each.id}`, each.applies) })),
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
          ...(form.side === undefined ? {} : { side: form.side }),
          fields: form.fields.map((field): FormField => {
            const where = `${entry}.fields.${field.key}`;
            const place = placeOf(where, field);
            if (field.kind === "choice") return fail(where, "A choice is written only in a table of dependants");
            if (field.kind === "text") {
              const fact = PERSONAL_FACTS.find((each) => each === field.value) ?? fail(where, `No personal fact ${field.value}`);
              return { ...place, kind: "text", fact, ...sizeOf(field) };
            }
            const formula = { formula: parse(where, field.value), text: field.value };
            if (field.kind === "amount") return { ...place, kind: "amount", ...formula, zero: field.zero ?? false, plain: field.plain ?? false };
            if (field.kind === "count") return { ...place, kind: "count", ...formula, ...(field.digits === undefined ? {} : { digits: field.digits }) };
            return { ...place, kind: field.kind, ...formula };
          }),
          ...(form.dependants === undefined
            ? {}
            : {
                dependants: {
                  ...(form.dependants.when === undefined ? {} : { when: parse(`${entry}.dependants`, form.dependants.when) }),
                  which: parse(`${entry}.dependants`, form.dependants.which),
                  whichText: form.dependants.which,
                  columns: form.dependants.columns,
                  ...(form.dependants.more === undefined ? {} : { more: { page: form.dependants.more[0], x: form.dependants.more[1], y: form.dependants.more[2] } }),
                  fields: form.dependants.fields.map((field): DependantField => {
                    const where = `${entry}.dependants.${field.key}`;
                    const column = field.column ?? fail(where, "A field of a table of dependants has a column");
                    const place = { ...placeOf(where, field), column };
                    if (field.kind === "text") {
                      const fact = DEPENDANT_FACTS.find((each) => each === field.value) ?? fail(where, `No dependant's fact ${field.value}`);
                      return { ...place, kind: "text", fact, ...sizeOf(field) };
                    }
                    if (field.kind === "choice") {
                      return { ...place, kind: "choice", question: field.value, labels: field.labels ?? {}, ...(field.width === undefined ? {} : { width: field.width }) };
                    }
                    const formula = { formula: parse(where, field.value), text: field.value };
                    return field.kind === "amount" ? { ...place, kind: "amount", ...formula, plain: field.plain ?? false } : { ...place, kind: field.kind, ...formula };
                  }),
                },
              }),
          tables: form.tables.map((table) => ({ brackets: table.brackets, amount: parse(entry, table.amount), amountText: table.amount, parts: table.parts })),
        };
        if (form.french) {
          const { french } = form;
          if (french.places.length !== spec.fields.length || french.tables.length !== spec.tables.length) fail(entry, "The French version places each field and table");
          spec.french = {
            title: french.title,
            url: french.url,
            sha256: french.sha256,
            pages: french.pages,
            fields: spec.fields.map((field, index): FormField => {
              const { page, x, y, plain, width, cell } = french.places[index]!;
              const placed = { ...field, page, x, y };
              if (placed.kind === "amount") return { ...placed, plain: plain ?? false };
              if (placed.kind !== "text") return placed;
              const { width: _width, cell: _cell, ...text } = placed;
              return { ...text, ...(width === undefined ? {} : { width }), ...(cell === undefined ? {} : { cell }) };
            }),
            tables: spec.tables.map((table, index) => ({ ...table, parts: french.tables[index]! })),
          };
        }
        return [id, spec];
      }),
    ),
    ...(compiled.outcome === undefined ? {} : { outcome: compiled.outcome }),
    balances: compiled.balances,
    residency: compiled.residency ?? "Lived in the country all year",
    reading: compiled.reading ?? { documents: "personal tax documents", notes: [] },
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

// "codes": a slip box holding a code, which only sumWhere and countWhere read.
type Type = "number" | "string" | "boolean" | "list" | "table" | "codes";

const FUNCTIONS: Record<string, { args: [number, number]; check: (types: Type[], args: Formula[]) => Type | string }> = {
  min: { args: [1, 20], check: (types) => (types.every((t) => t === "number" || t === "list") ? "number" : "takes numbers or slip boxes") },
  max: { args: [1, 20], check: (types) => (types.every((t) => t === "number" || t === "list") ? "number" : "takes numbers or slip boxes") },
  sum: { args: [1, 20], check: (types) => (types.every((t) => t === "number" || t === "list") ? "number" : "takes numbers or slip boxes") },
  count: { args: [1, 1], check: (types) => (types[0] === "list" ? "number" : "takes slip boxes") },
  // The slips whose box holds an amount other than 0: a box left blank on the paper slip is entered as 0, and count()
  // counts it.
  countNonZero: { args: [1, 1], check: (types) => (types[0] === "list" ? "number" : "takes slip boxes") },
  // The issuers of the slips whose box holds an amount other than 0, each counted once: an employer's two T4s are one
  // employer. Names are compared without case or surrounding spaces, as Confirm compares slips.
  countIssuers: {
    args: [1, 1],
    check: (types, args) => (types[0] === "list" && args[0]?.kind === "ref" && args[0].path[0] !== "family" ? "number" : "takes slip boxes"),
  },
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
  // The amount rounded down to a multiple of a positive number: the start of a printed tax table's row (the IRS Tax
  // Table's rows are $50 wide, so floor(line.F1040.15, 50)).
  floor: {
    args: [2, 2],
    check: (types, args) => {
      if (types[0] !== "number") return "rounds a number down";
      const unit = args[1];
      return unit?.kind === "number" && Number(unit.value) > 0 ? "number" : "takes a positive number to round down to a multiple of";
    },
  },
  if: {
    args: [3, 3],
    check: (types) => {
      if (types[0] !== "boolean") return "needs a yes/no condition first";
      return types[1] === types[2] ? types[1]! : "needs both outcomes of the same kind";
    },
  },
  bracket: { args: [2, 2], check: (types) => (types[0] === "table" && types[1] === "number" ? "number" : "takes a bracket table and an amount") },
  // A chart of rates by amount (a rate that steps down as income goes up), read as a bracket table: the rate of the
  // row the amount falls in, not a progressive tax.
  step: { args: [2, 2], check: (types) => (types[0] === "table" && types[1] === "number" ? "number" : "takes a bracket table and an amount") },
  // sumWhere(B.box1D, B.boxCAT, "A", "D"): the amounts of the slips whose code box holds one of the codes;
  // countWhere(...) the number of those slips. The amount and the code are boxes of one slip type, on one side.
  sumWhere: { args: [3, 40], check: whereCheck },
  countWhere: { args: [3, 40], check: whereCheck },
  // A case the rules know about but the app can't compute yet: the value is missing, and the text says why.
  unsupported: {
    args: [1, 1],
    check: (_types, args) => (args[0]?.kind === "string" ? "number" : "takes the reason, as text in quotes"),
  },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

function whereCheck(types: Type[], args: Formula[]): Type | string {
  const [amount, code] = args;
  const usage = "takes a slip box of amounts, a code box of the same slip type, then the codes in quotes";
  if (types[0] !== "list" || types[1] !== "codes" || amount?.kind !== "ref" || code?.kind !== "ref") return usage;
  if (args.slice(2).some((arg) => arg.kind !== "string")) return usage;
  const slipOf = (path: string[]) => (path[0] === "spouse" ? path.slice(1, 2).concat("spouse") : path.slice(0, 1)).join(".");
  return slipOf(amount.path) === slipOf(code.path) ? "number" : usage;
}

function checkRuleSet(ruleSet: RuleSet, fail: (entry: string, message: string, column?: number) => never) {
  for (const id of ruleSet.result) if (!ruleSet.lines.has(id)) fail("result", `No line ${id}`);
  for (const [id, when] of ruleSet.resultWhen) {
    if (!ruleSet.result.includes(id)) fail(`resultWhen.${id}`, "Names a line of the result");
    if (formulaType(ruleSet, when, (message, column) => fail(`resultWhen.${id}`, message, column), new Set()) !== "boolean") {
      fail(`resultWhen.${id}`, "Must be a yes/no value");
    }
  }
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
        isNumberQuestion(question.type)
          ? typeof question.default === "string" && /^-?\d+(\.\d+)?$/.test(question.default)
          : question.type === "boolean"
            ? typeof question.default === "boolean"
            : typeof question.default === "string" && question.options!.includes(question.default);
      if (!ok) fail(entry, `The default doesn't fit a ${question.type} question`);
    }
    if (question.decision && question.default === undefined) fail(entry, "A decision needs a default");
    if (question.max !== undefined) {
      if (question.type !== "count") fail(entry, "Only a count has a max");
      if (question.default !== undefined && Number(question.default) > question.max) fail(entry, `The default is more than the max, ${question.max}`);
    }
    if (question.parent !== undefined) {
      const parent = ruleSet.questions.get(question.parent);
      if (!parent || parent.type !== "boolean" || parent.slip || parent.parent) fail(entry, "A question's parent must be a yes/no question without a slip, not itself a part");
      if (parent!.module !== question.module) fail(entry, "A question and its parent are asked in the same module");
      if (question.type === "boolean") fail(entry, "A part of a group is an amount, a percent, a count or a choice");
    }
    if (question.askedWhen !== undefined) {
      const choice = ruleSet.questions.get(question.askedWhen.question);
      if (question.parent === undefined || !choice || choice.type !== "choice" || choice.parent !== question.parent) {
        fail(entry, "askedWhen names a choice of the same group, on a part");
      }
      const unknown = question.askedWhen.options.find((option) => !choice!.options!.includes(option));
      if (unknown !== undefined) fail(entry, `askedWhen: ${unknown} isn't an option of ${choice!.id}`);
    }
    if (question.type === "count" && question.parent === undefined && question.module !== "about") {
      fail(entry, "A count is asked as a part of a group, or about the person");
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
    if (formulaType(ruleSet, line.formula, (message, column) => fail(entry, message, column), reads, line.each ?? "person") !== "number") fail(entry, "A line must be a number");
    edges.set(line.id, reads);
  }

  // A hint's formulas: `when` a yes/no value, its amount a number, each change of its answer's type.
  if (ruleSet.outcome !== undefined && !ruleSet.lines.has(ruleSet.outcome)) fail("outcome", `No line ${ruleSet.outcome}`);
  for (const balance of ruleSet.balances) {
    for (const id of [balance.refund, balance.owing]) if (!ruleSet.result.includes(id)) fail(`balances.${balance.name}`, `${id} must be a line of the result`);
  }
  for (const hint of ruleSet.hints.values()) {
    const entry = `hints.${hint.id}`;
    const at = (message: string, column?: number) => fail(entry, message, column);
    const reads = new Set<string>();
    if (formulaType(ruleSet, hint.when, at, reads) !== "boolean") fail(entry, "when must be a yes/no value");
    if (hint.amount && formulaType(ruleSet, hint.amount.formula, at, reads) !== "number") fail(entry, "amount must be a number");
    for (const change of hint.change) {
      const question = ruleSet.questions.get(change.question);
      if (!question) return fail(entry, `No question ${change.question}`);
      const want = isNumberQuestion(question.type) ? "number" : question.type === "boolean" ? "boolean" : "string";
      if (formulaType(ruleSet, change.formula, at, reads) !== want) fail(entry, `The change to ${change.question} must be a ${want === "boolean" ? "yes/no value" : want}`);
    }
    if (hint.kind === "saving" && hint.change.length === 0) fail(entry, "A saving hint changes at least one answer");
    if (hint.kind === "saving" && hint.effectLabel !== undefined) fail(entry, "A saving hint shows what it saves; effectLabel is for info hints");
    const whatIf = hint.change.length > 0 || hint.filingStatus !== undefined;
    if (hint.kind !== "saving" && whatIf !== (hint.effectLabel !== undefined)) {
      fail(entry, "An info hint with a change names its effect (effectLabel), and only then");
    }
    if (whatIf && ruleSet.outcome === undefined) fail(entry, "A hint with a change needs the year's outcome line (outcome in year.yaml)");
    if (hint.filingStatus !== undefined && hint.kind !== "info") fail(entry, "Only an info hint changes the filing status: the person changes it on Personal info");
    if (hint.onlyIfSaving && (hint.kind !== "info" || !whatIf)) fail(entry, "onlyIfSaving is for an info hint with a change");
  }

  // A form's formulas: which returns get it (yes/no), each amount and count a number, each tick and condition yes/no. A bracket table
  // names a bracket param with printed bases, and its parts have a column for each bracket.
  for (const form of ruleSet.forms.values()) {
    const entry = `forms.${form.id}`;
    const at = (where: string) => (message: string, column?: number) => fail(where, message, column);
    if (formulaType(ruleSet, form.applies, at(entry), new Set()) !== "boolean") fail(entry, "applies must be a yes/no value");
    for (const field of form.french?.fields ?? []) {
      if (field.page > form.french!.pages) fail(`${entry}.fields.${field.key}`, `The French version has ${form.french!.pages} pages`);
    }
    for (const field of form.fields) {
      const where = `${entry}.fields.${field.key}`;
      if (field.page > form.pages) fail(where, `The form has ${form.pages} pages`);
      if (field.kind === "amount" || field.kind === "count") {
        if (formulaType(ruleSet, field.formula, at(where), new Set()) !== "number") fail(where, `${field.kind === "amount" ? "An amount" : "A count"} on a form must be a number`);
      } else if (field.kind === "tick" && formulaType(ruleSet, field.formula, at(where), new Set()) !== "boolean") {
        fail(where, "A tick must be a yes/no value");
      }
      if (field.when && formulaType(ruleSet, field.when.formula, at(where), new Set()) !== "boolean") fail(where, "when must be a yes/no value");
    }
    if (form.dependants) {
      const table = form.dependants;
      const at2 = (where: string) => (message: string, column?: number) => fail(where, message, column);
      if (form.french) fail(entry, "A form with a table of dependants has no French version");
      if (formulaType(ruleSet, table.which, at2(`${entry}.dependants`), new Set(), "dependant") !== "boolean") fail(`${entry}.dependants`, "which must be a yes/no value");
      if (table.when && formulaType(ruleSet, table.when, at2(`${entry}.dependants`), new Set()) !== "boolean") fail(`${entry}.dependants`, "when must be a yes/no value");
      for (const field of table.fields) {
        const where = `${entry}.dependants.${field.key}`;
        if (field.page > form.pages) fail(where, `The form has ${form.pages} pages`);
        if (field.column > table.columns) fail(where, `The table has ${table.columns} columns`);
        if (field.kind === "amount" || field.kind === "count") {
          if (formulaType(ruleSet, field.formula, at2(where), new Set(), "dependant") !== "number") fail(where, `${field.kind === "amount" ? "An amount" : "A count"} on a form must be a number`);
        } else if (field.kind === "tick") {
          if (formulaType(ruleSet, field.formula, at2(where), new Set(), "dependant") !== "boolean") fail(where, "A tick must be a yes/no value");
        } else if (field.kind === "choice") {
          const question = ruleSet.questions.get(field.question);
          if (!question || question.type !== "choice" || !question.dependant) fail(where, `${field.question} isn't a choice question about a dependant`);
          for (const option of Object.keys(field.labels)) if (!question!.options?.includes(option)) fail(where, `${field.question} has no answer ${option}`);
        }
        if (field.when && formulaType(ruleSet, field.when.formula, at2(where), new Set()) !== "boolean") fail(where, "when must be a yes/no value");
      }
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

  for (const each of ruleSet.formsToAdd) {
    const at = (message: string, column?: number) => fail(`formsToAdd.${each.id}`, message, column);
    if (formulaType(ruleSet, each.applies, at, new Set()) !== "boolean") at("applies must be a yes/no value");
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
/** Where a formula is worked out: for an adult's return, or for each dependant (a line with `each: dependant`). */
type Scope = "person" | "dependant";

function formulaType(ruleSet: RuleSet, formula: Formula, fail: (message: string, column?: number) => never, reads: Set<string>, scope: Scope = "person"): Type {
  const typeOf = (inner: Formula) => formulaType(ruleSet, inner, fail, reads, scope);
  switch (formula.kind) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "ref":
      return refType(ruleSet, formula.path, (message) => fail(message, formula.column), reads, false, scope);
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
      if (formula.name === "sumWhere" || formula.name === "countWhere") {
        // Each code must be one the code box can hold.
        const path = (formula.args[1] as Extract<Formula, { kind: "ref" }>).path;
        const [slipId, boxRef] = path[0] === "spouse" ? path.slice(1) : path;
        const codes = ruleSet.slips.get(slipId!)!.codes[boxRef!.slice(3)]!;
        for (const arg of formula.args.slice(2) as Extract<Formula, { kind: "string" }>[]) {
          if (!codes.includes(arg.value)) fail(`${formula.name}: ${slipId} box ${boxRef!.slice(3)} holds ${codes.join(", ")}, not ${arg.value}`, formula.column);
        }
      }
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
function refType(ruleSet: RuleSet, path: string[], fail: (message: string) => never, reads: Set<string>, spouse = false, scope: Scope = "person"): Type {
  const name = path.join(".");
  const [head, ...rest] = path;
  // A dependant's line reads the dependant, its other lines, the params and the family facts; nothing of an adult's.
  if (scope === "dependant" && !["dependant", "line", "param", "family"].includes(head ?? "")) {
    return fail(`${name}: a line for each dependant reads dependant.<…>, its own lines, params and family facts`);
  }
  switch (head) {
    case "dependant": {
      if (scope !== "dependant") return fail(`${name}: only a line with each: dependant reads dependant.<…>; a return reads dependants.<line>`);
      if (rest.length === 1 && rest[0] === "age") return "number";
      if (rest.length === 2 && rest[0] === "answer") {
        const question = ruleSet.questions.get(rest[1]!);
        if (!question) return fail(`No question ${rest[1]}`);
        if (!question.dependant) return fail(`${name}: ${question.id} is asked about an adult (add dependant: true to ask it about each dependant)`);
        return isNumberQuestion(question.type) ? "number" : question.type === "boolean" ? "boolean" : "string";
      }
      return fail(`${name}: a dependant has age and answer.<question>`);
    }
    case "dependants": {
      // One value per dependant claimed on this return: a list, like a slip box.
      if (spouse) return fail(`${name}: a return reads its own dependants`);
      const id = rest.join(".");
      const line = ruleSet.lines.get(id);
      if (rest.length !== 2 || !line) return fail(`No line ${id}`);
      if (line.each !== "dependant") return fail(`${name}: ${id} isn't worked out for each dependant`);
      reads.add(id);
      return "list";
    }
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
      const line = ruleSet.lines.get(id);
      if (rest.length !== 2 || !line) return fail(`No line ${id}`);
      if ((line.each === "dependant") !== (scope === "dependant")) {
        return fail(scope === "dependant" ? `${name}: a dependant's line reads only lines worked out for each dependant` : `${name}: read a dependant's line through dependants.${id}`);
      }
      reads.add(id);
      return "number";
    }
    case "answer": {
      const question = rest.length === 1 ? ruleSet.questions.get(rest[0]!) : undefined;
      if (!question) return fail(`No question ${rest.join(".")}`);
      if (question.dependant) return fail(`${name}: ${question.id} is asked about each dependant; read it in a line with each: dependant`);
      return isNumberQuestion(question.type) ? "number" : question.type === "boolean" ? "boolean" : "string";
    }
    case "family":
      if (spouse) return fail(`${name}: the family facts are the same for both spouses; write family.${rest.join(".")}`);
      if (rest.length === 1 && (rest[0] === "maritalStatus" || rest[0] === "filingStatus")) return "string";
      if (rest.length === 1 && rest[0] === "partnerInYear") return "boolean";
      if (rest.length === 1 && ["dependants", "childrenUnder6", "childrenUnder7", "childrenUnder17", "childrenUnder18", "childrenUnder19"].includes(rest[0]!)) return "number";
      if (rest.length === 1 && rest[0] === "childMonthsUnder6") return "list";
      return fail(`${name}: family has maritalStatus, filingStatus, partnerInYear, dependants, childrenUnder6, childrenUnder7, childrenUnder17, childrenUnder18, childrenUnder19 and childMonthsUnder6`);
    case "person":
      if (rest.length === 1 && (rest[0] === "age" || rest[0] === "birthMonth")) return "number";
      if (rest.length === 1 && (rest[0] === "province" || rest[0] === "role")) return "string";
      if (rest.length === 1 && rest[0] === "residentAllYear") return "boolean";
      return fail(`${name}: a person has age, birthMonth, province, role and residentAllYear`);
    default: {
      const slip = ruleSet.slips.get(head ?? "");
      if (!slip) return fail(`Unknown name ${name}`);
      if (rest.length === 1 && rest[0] === "slips") return "number";
      const box = rest.length === 1 && rest[0]!.startsWith("box") ? rest[0]!.slice(3) : undefined;
      if (box === undefined || !(box in slip.boxes)) return fail(`${name}: ${slip.id} has boxes ${Object.keys(slip.boxes).join(", ")} (and ${slip.id}.slips counts them)`);
      return box in slip.codes ? "codes" : "list";
    }
  }
}

/** `answer.x == "text"`: the text must be one of the question's options. */
function checkChoice(ruleSet: RuleSet, ref: Formula, other: Formula, fail: (message: string) => never) {
  if (ref.kind !== "ref" || other.kind !== "string") return;
  const path = ref.path[0] === "spouse" || ref.path[0] === "dependant" ? ref.path.slice(1) : ref.path;
  const question = path[0] === "answer" ? ruleSet.questions.get(path[1] ?? "") : undefined;
  if (question?.options && !question.options.includes(other.value)) {
    fail(`"${other.value}" isn't an option of ${question.id}: ${question.options.join(", ")}`);
  }
}
