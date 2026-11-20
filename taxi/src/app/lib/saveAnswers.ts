import { routes, type TaxYear } from "#shared";
import { apiRequest } from "../api/client.ts";

/**
 * Saves each adult's answers in turn, each under the revision the previous save returned, and answers with the year
 * as it is after the last one. An adult with nothing to save is skipped.
 */
export async function saveAnswersFor(year: TaxYear, byPerson: Record<string, Record<string, string | boolean | null>>): Promise<TaxYear> {
  let current = year;
  for (const [personId, answers] of Object.entries(byPerson)) {
    if (Object.keys(answers).length === 0) continue;
    current = await apiRequest(routes.saveAnswers, { params: { year: year.year }, body: { revision: current.revision, personId, answers } });
  }
  return current;
}
