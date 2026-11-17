import type { Estimate } from "#shared";
import { Evaluation, type EngineInput } from "../../shared/engine/evaluate.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { getYear } from "./household.ts";
import { notFound } from "./http.ts";

// A year's estimate: the engine run on what is stored for the year. Nothing computed is stored; every read computes
// again, so a change to the rules shows on the next read.

/** The engine input for a year: its adults, with their answers and slips (none are stored yet). */
export async function getEstimate(db: D1Database, orgId: string, year: number): Promise<Estimate> {
  const view = await getYear(db, orgId, year);
  const rules = rulesFor(year);
  if (!rules) throw notFound(`No tax rules for ${year}`);
  const input: EngineInput = {
    year,
    people: view.adults.map((adult) => {
      const person = view.people.find((each) => each.id === adult.personId)!;
      return {
        id: person.id,
        name: person.name,
        role: person.relationship === "self" ? "self" : "spouse",
        birthDate: person.birthDate,
        province: adult.province,
      };
    }),
    household: {
      maritalStatus: view.maritalStatus,
      dependants: view.people
        .filter((person) => view.members.includes(person.id) && (person.relationship === "child" || person.relationship === "other_dependant"))
        .map((person) => ({ id: person.id, name: person.name, birthDate: person.birthDate })),
    },
    answers: {},
    slips: [],
  };
  return { input, result: new Evaluation(rules, input).result() };
}
