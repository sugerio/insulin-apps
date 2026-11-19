import { Dec } from "./decimal.ts";
import type { Evaluation } from "./evaluate.ts";
import type { FormSpec, RuleSet } from "./rules.ts";

// What a return puts on each CRA form (forms.yaml), and where: the amounts worked out by the same engine as the
// return's lines, placed by the measured layout. Zero and missing amounts are left out (the form's box stays blank).

export interface PlacedAmount {
  /** The row or line code it fills, or `<row>@<column>` in a bracket table. */
  key: string;
  page: number;
  /** The line between dollars and cents. */
  x: number;
  /** The baseline. */
  y: number;
  /** Rounded to the cent. */
  value: Dec;
}

export interface FilledForm {
  form: FormSpec;
  amounts: PlacedAmount[];
}

/** The forms a person's return is printed on, in the rules' order, with what goes on each. */
export function fillForms(rules: RuleSet, evaluation: Evaluation, personId: string): FilledForm[] {
  const filled: FilledForm[] = [];
  for (const form of rules.forms.values()) {
    if (evaluation.evaluate(personId, form.applies).value !== true) continue;
    const amounts: PlacedAmount[] = [];
    const place = (key: string, page: number, x: number, y: number, value: Dec | null) => {
      if (value === null || value.isZero()) return;
      amounts.push({ key, page, x, y, value: value.roundTo(2, "HALF_UP") });
    };
    for (const field of form.fields) {
      if (field.when && evaluation.evaluate(personId, field.when.formula).value !== true) continue;
      const { value } = evaluation.evaluate(personId, field.formula);
      place(field.key, field.page, field.x, field.y, value instanceof Dec ? value : null);
    }
    for (const table of form.tables) {
      const { value: amount } = evaluation.evaluate(personId, table.amount);
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
    filled.push({ form, amounts });
  }
  return filled;
}

/** An amount as written in a form's box: dollars with thousands separators, and cents; a negative one in brackets. */
export function formAmount(value: Dec): { dollars: string; cents: string } {
  const negative = value.isNegative();
  const [whole, fraction = ""] = value.abs().roundTo(2, "HALF_UP").toString().split(".");
  const dollars = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = fraction.padEnd(2, "0");
  return negative ? { dollars: `(${dollars}`, cents: `${cents})` } : { dollars, cents };
}
