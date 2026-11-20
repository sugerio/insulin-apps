import { z } from "zod";
import { engineInputSchema } from "./engine/evaluate.ts";
import { STATUSES } from "./engine/rules.ts";

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
