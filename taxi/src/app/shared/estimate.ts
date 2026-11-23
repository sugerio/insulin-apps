import { z } from "zod";
import { engineInputSchema } from "./engine/evaluate.ts";
import { STATUSES, type RuleSet } from "./engine/rules.ts";

// A year's estimate: what the engine computes from what is stored so far. The answer carries the engine input too, so
// the browser can run the same engine to explain any number without another request.

export const statusSchema = z.enum(STATUSES);

export const estimateSchema = z.strictObject({
  input: engineInputSchema,
  result: z.strictObject({
    year: z.number().int(),
    rulesVersion: z.string(),
    people: z.array(
      z.strictObject({
        personId: z.string(),
        lines: z.array(z.strictObject({ id: z.string(), label: z.string(), value: z.string().nullable(), status: statusSchema })),
        missing: z.array(z.strictObject({ question: z.string(), ask: z.string() })),
        estimates: z.array(z.strictObject({ question: z.string(), ask: z.string(), assumed: z.union([z.string(), z.boolean()]) })),
        unhandled: z.array(z.string()),
        questions: z.array(z.string()),
      }),
    ),
  }),
});
export type Estimate = z.infer<typeof estimateSchema>;

type ResultLine = Estimate["result"]["people"][number]["lines"][number];

/** One refund-or-balance of a return, from its result lines. */
export interface ReturnBalance {
  /** "Federal", "Quebec": the rule set's name for it. */
  name: string;
  refund: ResultLine;
  owing: ResultLine;
}

/**
 * The refunds or balances owing a return shows, in the rules' order: the pairs of the rule set's `balances` whose two
 * lines are both in the return's result (Quebec's only for a resident of Quebec).
 */
export function balancesOf(rules: Pick<RuleSet, "balances">, lines: readonly ResultLine[]): ReturnBalance[] {
  return rules.balances.flatMap(({ name, refund, owing }) => {
    const refundLine = lines.find((line) => line.id === refund);
    const owingLine = lines.find((line) => line.id === owing);
    return refundLine && owingLine ? [{ name, refund: refundLine, owing: owingLine }] : [];
  });
}
