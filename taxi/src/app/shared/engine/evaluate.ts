import { z } from "zod";
import { Dec } from "./decimal.ts";
import { EngineError } from "./errors.ts";
import type { BinaryOperator, Formula } from "./formula.ts";
import { isNumberQuestion, type BracketRow, type RuleSet, type Status } from "./rules.ts";

// Evaluates the returns of one year. The input is one JSON document per year (the people,
// their answers and their slips); the screens, AI reading and API clients all produce it. Evaluation is lazy and
// memoized: a value is computed the first time something asks for it, so a question only matters when a line that is
// reached reads it. Each value records what it read, which is what `explain` walks.

export const engineInputSchema = z.strictObject({
  year: z.number().int(),
  /** The adults whose returns are prepared: one per return, as the rule set's filing unit is `person`. */
  people: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        name: z.string(),
        role: z.enum(["self", "spouse"]),
        birthDate: z.iso.date(),
        province: z.string().nullable(),
        /** Lived in Canada all year; null when not said yet. Left out, it is taken as yes. */
        residentAllYear: z.boolean().nullable().optional(),
      }),
    )
    .min(1)
    .max(2)
    .refine((people) => people.filter((person) => person.role === "self").length === 1, { message: "One person is self" }),
  /** The family facts of the year: the marital status on December 31 and the dependants in the year. */
  family: z.strictObject({
    maritalStatus: z.string().nullable(),
    dependants: z.array(z.strictObject({ id: z.string().min(1), name: z.string(), birthDate: z.iso.date() })),
  }),
  /** Per person, the answers given: money as decimal text, yes/no, a choice's option. */
  answers: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.boolean()]))),
  slips: z.array(
    z.strictObject({
      id: z.string().min(1),
      person: z.string().min(1),
      type: z.string(),
      issuer: z.string(),
      /** Box number (as printed) → amount as decimal text. */
      boxes: z.record(z.string(), z.string()),
    }),
  ),
});
export type EngineInput = z.infer<typeof engineInputSchema>;

/** Why a number is what it is: its formula, and the values that went in, down to the answers and slip boxes. */
export interface Explanation {
  /** The name as a formula writes it, from the person's side: `line.T1.10100`, `spouse.line.T1.23600`, `T4.box14`. */
  ref: string;
  label: string;
  /** Exact decimal text, a choice, "yes" or "no"; null when missing. A slip box gives the total of its slips. */
  value: string | null;
  status: Status;
  formula?: string;
  source?: string;
  /** Why the value is missing when the rules can't compute it. */
  notes?: string[];
  inputs: Explanation[];
}

export interface ResultLine {
  id: string;
  label: string;
  value: string | null;
  status: Status;
}
export interface PersonResult {
  personId: string;
  /** The rule set's result lines, in order. */
  lines: ResultLine[];
  /** What a result line needs that isn't given: questions with no answer and no default, family facts, the province. */
  missing: { question: string; ask: string }[];
  /** Questions a result line needs that are unanswered, so their default was used. */
  estimates: { question: string; ask: string; assumed: string | boolean }[];
  /** What the person entered that the rules don't use: a slip box, or an answer to a question the year doesn't ask. */
  unhandled: string[];
  /**
   * Every question a result line reads for this person, answered or not, in the order the rules reach them; then each
   * question about a kind of slip (`slip`) whose boxes a result line reads, so a Quebec return asks for RL slips and
   * another return doesn't.
   */
  questions: string[];
}
export interface EvaluationResult {
  year: number;
  rulesVersion: string;
  people: PersonResult[];
}

type Value = Dec | string | boolean | Dec[] | BracketRow[] | null;
interface Computed {
  value: Value;
  status: Status;
}
interface Node extends Computed {
  label: string;
  formula?: string;
  source?: string;
  /** The keys of the nodes it read, in order. */
  reads: string[];
  /** For a slip box: one entry per slip that has it. */
  items?: { label: string; value: Dec; issuer?: string }[];
  /** Why the value is missing when the rules can't compute it (`unsupported`). */
  notes?: string[];
}

const RANK: Record<Status, number> = { complete: 0, estimate: 1, missing: 2 };
const worst = (...statuses: Status[]): Status => statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "complete");
const MISSING: Computed = { value: null, status: "missing" };
/** Division keeps this many digits; a line rounds explicitly with round(). */
const DIVISION_SCALE = 12;

export class Evaluation {
  readonly rules: RuleSet;
  readonly input: EngineInput;
  private readonly nodes = new Map<string, Node>();
  private readonly inProgress = new Set<string>();

  constructor(rules: RuleSet, input: unknown) {
    this.rules = rules;
    this.input = engineInputSchema.parse(input);
    if (this.input.year !== rules.year) throw new EngineError("ENGINE_YEAR", `The input is for ${this.input.year}; the rules are for ${rules.year}`);
    const ids = new Set(this.input.people.map((person) => person.id));
    for (const slip of this.input.slips) {
      if (!ids.has(slip.person)) throw new EngineError("ENGINE_INPUT", `Slip ${slip.id} belongs to no one in the input`);
      if (!rules.slips.has(slip.type)) throw new EngineError("ENGINE_INPUT", `Slip ${slip.id} has an unknown type ${slip.type}`);
      for (const amount of Object.values(slip.boxes)) Dec.from(amount);
    }
    for (const [personId, answers] of Object.entries(this.input.answers)) {
      if (!ids.has(personId)) throw new EngineError("ENGINE_INPUT", `Answers for ${personId}, who is not in the input`);
      for (const [id, answer] of Object.entries(answers)) {
        const question = rules.questions.get(id);
        if (!question) continue; // reported as unhandled
        const ok =
          isNumberQuestion(question.type)
            ? typeof answer === "string" && /^-?\d+(\.\d+)?$/.test(answer)
            : question.type === "boolean"
              ? typeof answer === "boolean"
              : typeof answer === "string" && question.options!.includes(answer);
        if (!ok) throw new EngineError("ENGINE_INPUT", `The answer to ${id} doesn't fit a ${question.type} question`);
      }
    }
  }

  /** A line of a person's return. */
  line(personId: string, lineId: string): { value: Dec | null; status: Status } {
    const node = this.node(this.key(personId, ["line", ...splitLine(lineId)]));
    return { value: node.value as Dec | null, status: node.status };
  }

  /** A formula (a hint's) worked out from a person's side; it reads the same values the return's lines do. */
  evaluate(personId: string, formula: Formula): { value: Dec | string | boolean | null; status: Status } {
    const computed = this.formula(formula, personId, [], []);
    const value = computed.value;
    return { value: Array.isArray(value) ? null : (value as Dec | string | boolean | null), status: computed.status };
  }

  /** The lines a person's result reads, in the rules' order: what their return is made of (not another province's). */
  linesOf(personId: string): string[] {
    const reached = new Set<string>();
    const walk = (key: string) => {
      if (reached.has(key)) return;
      reached.add(key);
      for (const next of this.node(key).reads) walk(next);
    };
    for (const id of this.resultOf(personId)) walk(this.key(personId, ["line", ...splitLine(id)]));
    return [...this.rules.lines.keys()].filter((id) => reached.has(this.key(personId, ["line", ...splitLine(id)])));
  }

  /** The result lines a person's return shows: all of them but those whose `resultWhen` is no for this person. */
  resultOf(personId: string): string[] {
    return this.rules.result.filter((id) => {
      const when = this.rules.resultWhen.get(id);
      return when === undefined || this.evaluate(personId, when).value === true;
    });
  }

  /** The other adult of the year, if both returns are prepared together. */
  spouse(personId: string): string | undefined {
    return this.spouseOf(personId);
  }

  /** Why a name (as a formula writes it, from this person's side) has its value. */
  explain(personId: string, ref: string): Explanation {
    return this.explainKey(this.key(personId, ref.split(".")), ref, personId);
  }

  /** Every return's result lines, and what is missing, estimated or not handled. */
  result(): EvaluationResult {
    const reached = new Set<string>();
    const walk = (key: string) => {
      if (reached.has(key)) return;
      reached.add(key);
      for (const next of this.node(key).reads) walk(next);
    };
    const people = this.input.people.map((person) => {
      const lines = this.resultOf(person.id).map((id) => {
        const key = this.key(person.id, ["line", ...splitLine(id)]);
        walk(key);
        const node = this.node(key);
        return { id, label: this.rules.lines.get(id)!.label, value: display(node.value), status: node.status };
      });
      return { person, lines };
    });
    return {
      year: this.input.year,
      rulesVersion: this.rules.version,
      people: people.map(({ person, lines }) => {
        const answered = this.input.answers[person.id] ?? {};
        const asked = [...reached].filter((key) => key.startsWith(`${person.id}:answer.`)).map((key) => key.slice(`${person.id}:answer.`.length));
        const missing: PersonResult["missing"] = [];
        const estimates: PersonResult["estimates"] = [];
        // A family fact or the province that a result line needs and that hasn't been given yet.
        for (const key of reached) {
          const fact = key.startsWith("family.") ? key : key.startsWith(`${person.id}:person.`) ? key.slice(person.id.length + 1) : null;
          if (fact !== null && this.node(key).status === "missing") missing.push({ question: fact, ask: this.node(key).label });
        }
        for (const id of asked) {
          const question = this.rules.questions.get(id)!;
          if (id in answered || question.decision) continue;
          if (question.default === undefined) missing.push({ question: id, ask: question.ask });
          else estimates.push({ question: id, ask: question.ask, assumed: question.default });
        }
        const unhandled: string[] = [];
        for (const slip of this.input.slips.filter((each) => each.person === person.id)) {
          const used = this.rules.usedBoxes.get(slip.type) ?? new Set();
          for (const [box, amount] of Object.entries(slip.boxes)) {
            // A box blank on the paper slip is entered as 0: it adds nothing, so it needs no handling.
            if (!used.has(box) && !Dec.from(amount).isZero()) unhandled.push(`${slip.type} from ${slip.issuer}: box ${box} isn't handled by this app`);
          }
        }
        for (const id of Object.keys(answered)) {
          if (!this.rules.questions.has(id)) unhandled.push(`The answer to ${id} isn't used for ${this.input.year}`);
        }
        for (const key of reached) {
          if (key.startsWith(`${person.id}:`)) for (const note of this.node(key).notes ?? []) if (!unhandled.includes(note)) unhandled.push(note);
        }
        const slipsRead = new Set(
          [...reached].filter((key) => key.startsWith(`${person.id}:`)).map((key) => key.slice(person.id.length + 1).split(".")[0]!),
        );
        const slipQuestions = [...this.rules.questions.values()]
          .filter((question) => question.slip !== undefined && slipsRead.has(question.slip) && !asked.includes(question.id))
          .map((question) => question.id);
        return { personId: person.id, lines, missing, estimates, unhandled, questions: [...asked, ...slipQuestions] };
      }),
    };
  }

  // -------------------------------------------------------------------------

  /** The node key of a name read from a person's side; `spouse.` moves to the spouse. */
  private key(personId: string, path: string[]): string {
    if (path[0] === "spouse") {
      const other = this.spouseOf(personId);
      if (!other) return `${personId}:${path.join(".")}`;
      return this.key(other, path.slice(1));
    }
    if (path[0] === "param" || path[0] === "family") return path.join(".");
    return `${personId}:${path.join(".")}`;
  }

  private spouseOf(personId: string): string | undefined {
    return this.input.people.find((person) => person.id !== personId)?.id;
  }

  private node(key: string): Node {
    const known = this.nodes.get(key);
    if (known) return known;
    if (this.inProgress.has(key)) throw new EngineError("ENGINE_CYCLE", `${key} depends on itself`);
    this.inProgress.add(key);
    try {
      const node = this.compute(key);
      this.nodes.set(key, node);
      return node;
    } finally {
      this.inProgress.delete(key);
    }
  }

  private compute(key: string): Node {
    if (key.startsWith("family.")) return this.familyValue(key.slice("family.".length));
    if (key.startsWith("param.")) {
      const param = this.rules.params.get(key.slice("param.".length))!;
      return { value: param.value, status: "complete", label: param.label, source: param.source, reads: [] };
    }
    const colon = key.indexOf(":");
    const personId = key.slice(0, colon);
    const path = key.slice(colon + 1).split(".");
    const person = this.input.people.find((each) => each.id === personId)!;
    const [head, ...rest] = path;
    switch (head) {
      case "spouse":
        return { ...MISSING, label: "No spouse is in this year", reads: [] };
      case "line": {
        const line = this.rules.lines.get(rest.join("."))!;
        const reads: string[] = [];
        const notes: string[] = [];
        const computed = this.formula(line.formula, personId, reads, notes);
        return {
          ...computed,
          label: line.label,
          formula: line.text,
          source: line.source,
          reads: [...new Set(reads)],
          ...(notes.length > 0 ? { notes } : {}),
        };
      }
      case "answer": {
        const question = this.rules.questions.get(rest[0]!)!;
        const answer = this.input.answers[personId]?.[question.id];
        const given = answer ?? question.default;
        // A decision's default is the app's choice, not a guess at what the person would say.
        const status: Status = answer !== undefined || question.decision ? "complete" : question.default !== undefined ? "estimate" : "missing";
        const value = given === undefined ? null : isNumberQuestion(question.type) ? Dec.from(given as string) : given;
        return { value, status, label: question.ask, reads: [] };
      }
      case "person":
        if (rest[0] === "age") {
          // Age on December 31 of the year: the birthday has always passed by then.
          return { value: Dec.of(this.input.year - Number(person.birthDate.slice(0, 4))), status: "complete", label: "Age on December 31", reads: [] };
        }
        if (rest[0] === "birthMonth") {
          return { value: Dec.of(Number(person.birthDate.slice(5, 7))), status: "complete", label: "Month of birth", reads: [] };
        }
        if (rest[0] === "role") return { value: person.role, status: "complete", label: "The person preparing, or their spouse", reads: [] };
        if (rest[0] === "residentAllYear") {
          const resident = person.residentAllYear === undefined ? true : person.residentAllYear;
          return { value: resident, status: resident === null ? "missing" : "complete", label: "Lived in Canada all year", reads: [] };
        }
        return { value: person.province, status: person.province === null ? "missing" : "complete", label: "Province on December 31", reads: [] };
      default: {
        const slip = this.rules.slips.get(head!)!;
        const mine = this.input.slips.filter((each) => each.person === personId && each.type === slip.id);
        if (rest[0] === "slips") return { value: Dec.of(mine.length), status: "complete", label: `${slip.id} slips`, reads: [] };
        const box = rest[0]!.slice("box".length);
        const items = mine
          .filter((each) => box in each.boxes)
          .map((each) => ({ label: `${slip.id} from ${each.issuer}`, value: Dec.from(each.boxes[box]!), issuer: each.issuer }));
        return {
          value: items.map((item) => item.value),
          status: "complete",
          label: `${slip.id} box ${box}: ${slip.boxes[box]}`,
          reads: [],
          items,
        };
      }
    }
  }

  /** The family facts: the same for both returns. */
  private familyValue(name: string): Node {
    const { family, year } = this.input;
    // A dependant born after December 31 (added while last year's return is prepared) isn't one for this year.
    const born = family.dependants.filter((dependant) => Number(dependant.birthDate.slice(0, 4)) <= year);
    const childrenUnder = (age: number) => Dec.of(born.filter((dependant) => year - Number(dependant.birthDate.slice(0, 4)) < age).length);
    switch (name) {
      case "maritalStatus":
        return {
          value: family.maritalStatus,
          status: family.maritalStatus === null ? "missing" : "complete",
          label: "Marital status on December 31",
          reads: [],
        };
      case "partnerInYear":
        return { value: this.input.people.length > 1, status: "complete", label: "Both returns are prepared together", reads: [] };
      case "childrenUnder6":
        return { value: childrenUnder(6), status: "complete", label: "Dependants under 6 at the end of the year", reads: [] };
      case "childrenUnder7":
        return { value: childrenUnder(7), status: "complete", label: "Dependants under 7 at the end of the year", reads: [] };
      case "childrenUnder17":
        return { value: childrenUnder(17), status: "complete", label: "Dependants under 17 at the end of the year", reads: [] };
      case "childrenUnder18":
        return { value: childrenUnder(18), status: "complete", label: "Dependants under 18 at the end of the year", reads: [] };
      case "childrenUnder19":
        return { value: childrenUnder(19), status: "complete", label: "Dependants under 19 at the end of the year", reads: [] };
      case "childMonthsUnder6": {
        // Some credits (Nova Scotia's and Prince Edward Island's amount for young children) count the months on whose
        // first day a child was born and not yet 6. One entry per dependant under 18, so a formula can also leave out
        // the child claimed as an eligible dependant.
        const items = born
          .filter((dependant) => year - Number(dependant.birthDate.slice(0, 4)) < 18)
          .map((dependant) => {
            const sixth = `${Number(dependant.birthDate.slice(0, 4)) + 6}${dependant.birthDate.slice(4)}`;
            const months = Array.from({ length: 12 }, (_, month) => `${year}-${String(month + 1).padStart(2, "0")}-01`).filter(
              (first) => first >= dependant.birthDate && first < sixth,
            ).length;
            return { label: `Months ${dependant.name} was under 6`, value: Dec.of(months) };
          });
        return { value: items.map((item) => item.value), status: "complete", label: "Months each dependant under 18 was under 6", reads: [], items };
      }
      default:
        throw new EngineError("ENGINE_NAME", `No family.${name}`);
    }
  }

  private formula(formula: Formula, personId: string, reads: string[], notes: string[]): Computed {
    const evaluate = (inner: Formula) => this.formula(inner, personId, reads, notes);
    switch (formula.kind) {
      case "number":
        return { value: Dec.from(formula.value), status: "complete" };
      case "string":
      case "boolean":
        return { value: formula.value, status: "complete" };
      case "ref": {
        const key = this.key(personId, formula.path);
        reads.push(key);
        const node = this.node(key);
        return { value: node.value, status: node.status };
      }
      case "unary": {
        const operand = evaluate(formula.operand);
        if (operand.value === null) return MISSING;
        return { value: formula.op === "-" ? (operand.value as Dec).neg() : !(operand.value as boolean), status: operand.status };
      }
      case "binary": {
        const left = evaluate(formula.left);
        // `and` and `or` stop early, so a question behind a false condition is never asked.
        if (formula.op === "and" && left.value === false) return left;
        if (formula.op === "or" && left.value === true) return left;
        const right = evaluate(formula.right);
        if (left.value === null || right.value === null) return MISSING;
        return { value: binary(formula.op, left.value, right.value), status: worst(left.status, right.status) };
      }
      case "call": {
        if (formula.name === "unsupported") {
          notes.push((formula.args[0] as Extract<Formula, { kind: "string" }>).value);
          return MISSING;
        }
        if (formula.name === "countIssuers") {
          // The list's values carry no issuer, so the slip box is read here, where its slips are.
          const key = this.key(personId, (formula.args[0] as Extract<Formula, { kind: "ref" }>).path);
          reads.push(key);
          const node = this.node(key);
          const issuers = new Set((node.items ?? []).filter((item) => !item.value.isZero()).map((item) => item.issuer!.trim().toLowerCase()));
          return { value: Dec.of(issuers.size), status: node.status };
        }
        if (formula.name === "if") {
          const condition = evaluate(formula.args[0]!);
          if (condition.value === null) return MISSING;
          const branch = evaluate(formula.args[condition.value ? 1 : 2]!);
          return branch.value === null ? MISSING : { value: branch.value, status: worst(condition.status, branch.status) };
        }
        const args = formula.args.map(evaluate);
        if (args.some((arg) => arg.value === null)) return MISSING;
        return { value: call(formula.name, args.map((arg) => arg.value!)), status: worst(...args.map((arg) => arg.status)) };
      }
    }
  }

  /** `viewer` is the person whose return is explained: the other person's values are named `spouse.`. */
  private explainKey(key: string, ref: string, viewer: string): Explanation {
    const node = this.node(key);
    const nameOf = (read: string) => {
      const colon = read.indexOf(":");
      if (colon < 0) return read; // a param: the same for everyone
      return `${read.slice(0, colon) === viewer ? "" : "spouse."}${read.slice(colon + 1)}`;
    };
    const inputs = node.items
      ? node.items.map((item) => ({ ref, label: item.label, value: item.value.toString(), status: "complete" as const, inputs: [] }))
      : node.reads.map((read) => this.explainKey(read, nameOf(read), viewer));
    return {
      ref,
      label: node.label,
      value: display(node.value),
      status: node.status,
      ...(node.formula === undefined ? {} : { formula: node.formula }),
      ...(node.source === undefined ? {} : { source: node.source }),
      ...(node.notes === undefined ? {} : { notes: node.notes }),
      inputs,
    };
  }
}

/** `T1.10100` → ["T1", "10100"]. */
function splitLine(id: string): string[] {
  return id.split(".");
}

function display(value: Value): string | null {
  if (value === null) return null;
  if (value instanceof Dec) return value.toString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  if (value.length === 0 || value[0] instanceof Dec) return Dec.sum(value as Dec[]).toString();
  return "table";
}

function binary(op: BinaryOperator, left: Value, right: Value): Value {
  switch (op) {
    case "+":
      return (left as Dec).add(right as Dec);
    case "-":
      return (left as Dec).sub(right as Dec);
    case "*":
      return (left as Dec).mul(right as Dec);
    case "/":
      if ((right as Dec).isZero()) throw new EngineError("ENGINE_DIVISION", "A formula divided by zero");
      return (left as Dec).divideTo(right as Dec, DIVISION_SCALE, "HALF_UP");
    case "<":
      return (left as Dec).lt(right as Dec);
    case "<=":
      return (left as Dec).lte(right as Dec);
    case ">":
      return (left as Dec).gt(right as Dec);
    case ">=":
      return (left as Dec).gte(right as Dec);
    case "==":
    case "!=": {
      const same = left instanceof Dec ? left.eq(right as Dec) : left === right;
      return op === "==" ? same : !same;
    }
    case "and":
      return (left as boolean) && (right as boolean);
    case "or":
      return (left as boolean) || (right as boolean);
  }
}

function numbers(values: Value[]): Dec[] {
  return values.flatMap((value) => (Array.isArray(value) ? (value as Dec[]) : [value as Dec]));
}

function call(name: string, args: Value[]): Value {
  switch (name) {
    case "sum":
      return Dec.sum(numbers(args));
    case "min":
    case "max": {
      const all = numbers(args);
      if (all.length === 0) return Dec.ZERO;
      return name === "min" ? Dec.min(all[0]!, ...all.slice(1)) : Dec.max(all[0]!, ...all.slice(1));
    }
    case "count":
      return Dec.of((args[0] as Dec[]).length);
    case "countNonZero":
      return Dec.of((args[0] as Dec[]).filter((amount) => !amount.isZero()).length);
    case "round":
      // The CRA rounds half a cent up.
      return (args[0] as Dec).roundTo(args[1] === undefined ? 2 : Number((args[1] as Dec).toString()), "HALF_UP");
    case "clamp": {
      const [value, low, high] = args as Dec[];
      return Dec.min(Dec.max(value!, low!), high!);
    }
    case "bracket":
      return bracket(args[0] as BracketRow[], args[1] as Dec);
    case "step": {
      // Each row is "more than the row above, but not more than upTo", as the CRA's charts print it.
      const amount = args[1] as Dec;
      return (args[0] as BracketRow[]).find((row) => row.upTo === null || amount.lte(row.upTo))!.rate;
    }
    default:
      throw new EngineError("ENGINE_FUNCTION", `No function ${name}`);
  }
}

/** Progressive tax: each bracket's rate on the part of the amount inside it, or the form's base and one rate. */
function bracket(rows: BracketRow[], amount: Dec): Dec {
  if (rows.every((row) => row.base !== undefined)) {
    let floor = Dec.ZERO;
    for (const row of rows) {
      if (row.upTo === null || amount.lte(row.upTo)) return row.base!.add(Dec.max(amount.sub(floor), Dec.ZERO).mul(row.rate));
      floor = row.upTo;
    }
  }
  let total = Dec.ZERO;
  let floor = Dec.ZERO;
  for (const row of rows) {
    if (!amount.gt(floor)) break;
    const top = row.upTo === null ? amount : Dec.min(amount, row.upTo);
    total = total.add(top.sub(floor).mul(row.rate));
    if (row.upTo === null) break;
    floor = row.upTo;
  }
  return total;
}
