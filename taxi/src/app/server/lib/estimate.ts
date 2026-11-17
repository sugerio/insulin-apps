import type { Estimate } from "#shared";
import { getYear, yearRow } from "./household.ts";
import { notFound } from "./http.ts";
import { evaluateYear, loadWorkspace } from "./workspace.ts";

// A year's estimate: the engine run on what is stored for the year (its adults, household, answers and slips).
// Nothing computed is stored; every read computes again, so a change to the rules shows on the next read.

export async function getEstimate(db: D1Database, orgId: string, year: number): Promise<Estimate> {
  const view = await getYear(db, orgId, year);
  const row = (await yearRow(db, orgId, year))!;
  const evaluation = evaluateYear(view, await loadWorkspace(db, orgId, row.id));
  if (!evaluation) throw notFound(`No tax rules for ${year}`);
  return evaluation;
}
