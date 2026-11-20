import { Dec } from "./decimal.ts";
import type { EngineInput, Evaluation } from "./evaluate.ts";
import { formIn, type FormLanguage, type FormSpec, type PersonalFact, type RuleSet } from "./rules.ts";

// What a return puts on each CRA or Revenu Québec form (forms.yaml), and where: the amounts and counts worked out by the
// same engine as the return's lines, ticks from yes/no formulas, and Step 1's name, birth date and province from the
// person's facts, placed by the measured layout. Zero and missing amounts are left out (the form's box stays blank),
// unless the form asks for the zero.

export interface PlacedAmount {
  /** The row or line code it fills, `<row>@<n>` for a row's n-th box, or `<row>@<column>` in a bracket table. */
  key: string;
  page: number;
  /** The line between dollars and cents, or a plain box's right end. */
  x: number;
  /** The baseline. */
  y: number;
  /** Rounded to the cent. */
  value: Dec;
  /** A box with no cents line: the amount is written with its decimal point, ending at x. */
  plain?: true;
}

/**
 * Something else written on a form: text starting at x (in a box `width` wide, or one character per date cell of
 * `cell` points), a whole number ending at x, or a tick centred at x and y.
 */
export type PlacedMark =
  | { kind: "text"; key: string; page: number; x: number; y: number; text: string; width?: number; cell?: number }
  | { kind: "count"; key: string; page: number; x: number; y: number; text: string }
  | { kind: "tick"; key: string; page: number; x: number; y: number };

export interface FilledForm {
  /** The version of the form printed: in French when asked for and the form has a French version. */
  form: FormSpec;
  /** The language of that version: amounts on a French form are written the French way (1 234,56). */
  language: FormLanguage;
  amounts: PlacedAmount[];
  marks: PlacedMark[];
}

/** The facts a form's text boxes can hold; null when the app doesn't know one (the box stays blank). */
export type PersonalFacts = Record<PersonalFact, string | null>;

/**
 * A name as the T1 asks for it: the last word is the last name, the words before it the first name ("Mary Ann Lee" is
 * Mary Ann, Lee). A one-word name is a first name only. A last name of several words ("van der Berg") is split wrongly
 * and has to be corrected by hand.
 */
export function splitName(name: string): { first: string; last: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { first: words[0] ?? "", last: "" };
  return { first: words.slice(0, -1).join(" "), last: words.at(-1)! };
}

/**
 * The personal facts for a person's forms, from the engine's input. The spouse's name and birth date come from the
 * input when their return is prepared here too; otherwise the caller gives them (the spouse in the profile), or they stay
 * blank. The engine knows no country, so the caller names the province (a code otherwise).
 */
export function personalFacts(
  input: EngineInput,
  personId: string,
  options: { spouseName?: string | null; spouseBirthDate?: string | null; provinceName?: (code: string) => string } = {},
): PersonalFacts {
  const person = input.people.find((each) => each.id === personId)!;
  const other = input.people.find((each) => each.id !== personId);
  const spouse = options.spouseName ?? other?.name ?? null;
  const { first, last } = splitName(person.name);
  const spouseName = spouse === null ? null : splitName(spouse);
  return {
    firstName: first || null,
    lastName: last || null,
    birthDate: person.birthDate,
    province: person.province === null ? null : (options.provinceName?.(person.province) ?? person.province),
    spouseFirstName: spouseName?.first || null,
    spouseLastName: spouseName?.last || null,
    spouseBirthDate: options.spouseBirthDate ?? other?.birthDate ?? null,
  };
}

/**
 * The forms a person's return is printed on, in the rules' order, with what goes on each. In French, a form with a
 * French version (Revenu Québec's) is printed on it; the CRA's forms stay in English.
 */
export function fillForms(rules: RuleSet, evaluation: Evaluation, personId: string, facts: PersonalFacts, language: FormLanguage = "en"): FilledForm[] {
  const filled: FilledForm[] = [];
  const evaluate = (formula: Parameters<Evaluation["evaluate"]>[1]) => evaluation.evaluate(personId, formula).value;
  for (const spec of rules.forms.values()) {
    if (evaluate(spec.applies) !== true) continue;
    const form = formIn(spec, language);
    const amounts: PlacedAmount[] = [];
    const marks: PlacedMark[] = [];
    const place = (key: string, page: number, x: number, y: number, value: Dec | null, zero = false, plain = false) => {
      if (value === null || (value.isZero() && !zero)) return;
      amounts.push({ key, page, x, y, value: value.roundTo(2, "HALF_UP"), ...(plain ? { plain } : {}) });
    };
    for (const field of form.fields) {
      if (field.when && evaluate(field.when.formula) !== true) continue;
      const { key, page, x, y } = field;
      if (field.kind === "text") {
        const fact = facts[field.fact];
        if (!fact) continue;
        // A date in boxes is its digits, one per cell (year, month, day); elsewhere it is written as stored.
        const text = field.cell !== undefined && (field.fact === "birthDate" || field.fact === "spouseBirthDate") ? fact.replaceAll("-", "") : fact;
        marks.push({ kind: "text", key, page, x, y, text, ...(field.width === undefined ? {} : { width: field.width }), ...(field.cell === undefined ? {} : { cell: field.cell }) });
        continue;
      }
      const { value, status } = evaluation.evaluate(personId, field.formula);
      if (field.kind === "tick") {
        // A tick says something about the person, so it is written only from what they said, never from a question's
        // usual answer standing in for theirs.
        if (value === true && status === "complete") marks.push({ kind: "tick", key, page, x, y });
      } else if (field.kind === "count") {
        if (value instanceof Dec && !value.isZero()) marks.push({ kind: "count", key, page, x, y, text: value.roundTo(0, "HALF_UP").toString() });
      } else if (field.kind === "amount") {
        place(key, page, x, y, value instanceof Dec ? value : null, field.zero, field.plain);
      }
    }
    for (const table of form.tables) {
      const amount = evaluate(table.amount);
      if (!(amount instanceof Dec) || !amount.gt(Dec.ZERO)) continue;
      const brackets = rules.params.get(table.brackets)!.value as { upTo: Dec | null; rate: Dec; base?: Dec }[];
      // "More than the floor, but not more than upTo": an amount on a bracket's top stays in that bracket.
      const index = brackets.findIndex((row) => row.upTo === null || amount.lte(row.upTo));
      const floor = index === 0 ? Dec.ZERO : brackets[index - 1]!.upTo!;
      const over = amount.sub(floor);
      const times = over.mul(brackets[index]!.rate).roundTo(2, "HALF_UP");
      let first = 0;
      for (const part of table.parts) {
        if (index < first + part.columns.length) {
          const x = part.columns[index - first]!;
          const [amountRow, overRow, timesRow, taxRow] = part.rows;
          place(`${amountRow}@${index}`, part.page, x, part.amount, amount);
          place(`${overRow}@${index}`, part.page, x, part.over, over);
          place(`${timesRow}@${index}`, part.page, x, part.times, times);
          place(`${taxRow}@${index}`, part.page, x, part.tax, times.add(brackets[index]!.base!));
          break;
        }
        first += part.columns.length;
      }
    }
    filled.push({ form, language: form.french && language === "fr" ? "fr" : "en", amounts, marks });
  }
  return filled;
}

/**
 * An amount as written in a form's box: dollars with thousands separators, and cents. A negative one is in brackets on
 * the CRA's forms ("if negative, show in brackets") and has a minus sign on Revenu Québec's. A French form separates
 * the thousands with a space.
 */
export function formAmount(value: Dec, negativeStyle: "brackets" | "minus" = "brackets", language: FormLanguage = "en"): { dollars: string; cents: string } {
  const negative = value.isNegative();
  const [whole, fraction = ""] = value.abs().roundTo(2, "HALF_UP").toString().split(".");
  const dollars = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, language === "fr" ? " " : ",");
  const cents = fraction.padEnd(2, "0");
  if (!negative) return { dollars, cents };
  return negativeStyle === "minus" ? { dollars: `-${dollars}`, cents } : { dollars: `(${dollars}`, cents: `${cents})` };
}
