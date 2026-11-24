import type { Estimate } from "#shared";
import { getYear, yearRow } from "./people.ts";
import { ApiError, notFound } from "./http.ts";
import { rulesFor } from "../../shared/rules/index.ts";
import { evaluateYear, loadWorkspace } from "./workspace.ts";

// A year's estimate: the engine run on what is stored for the year (its adults, family facts, answers and slips).
// Nothing computed is stored; every read computes again, so a change to the rules shows on the next read.

export async function getEstimate(db: D1Database, orgId: string, year: number): Promise<Estimate> {
  const view = await getYear(db, orgId, year);
  const row = (await yearRow(db, orgId, year))!;
  const evaluation = evaluateYear(view, await loadWorkspace(db, orgId, row.id));
  if (!rulesFor(view.country, year)) throw notFound(`No tax rules for ${year}`);
  // The rules are there but refuse what is stored (logged by evaluateYear), for example an answer to an option a later
  // release renamed: that is the app's fault, not a year without rules.
  if (!evaluation) throw new ApiError("internal", `The returns of ${year} can't be worked out from what is stored. The error is logged.`);
  return evaluation;
}
