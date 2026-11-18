import { z } from "zod";
import { HINT_KINDS } from "./engine/rules.ts";
import { idSchema, yearSchema } from "./household.ts";
import { revisionSchema } from "./returns.ts";

// Hints: checks on each return of a year (rules/<country>/<year>/hints.yaml), worked out from what is stored. A saving
// can be accepted (its answers are saved) or dismissed; the decision is kept and can be undone.

export const HINT_STATES = ["open", "applied", "dismissed"] as const;

const decimalText = z.string().regex(/^-?\d+(\.\d+)?$/);

export const hintSchema = z.strictObject({
  id: z.string(),
  /** The return it is about. */
  personId: idSchema,
  kind: z.enum(HINT_KINDS),
  title: z.string(),
  text: z.string(),
  amount: z.strictObject({ label: z.string(), value: decimalText }).nullable(),
  /**
   * The household's refund less balance owing with the change, less without it: for a saving, what it saves (when
   * applied, what it saved when accepted); for an info hint, what the change makes, named by `effectLabel`.
   */
  effect: decimalText.nullable(),
  effectLabel: z.string().nullable(),
  /** open; applied (an accepted saving); dismissed. */
  state: z.enum(HINT_STATES),
});
export type HintView = z.infer<typeof hintSchema>;

export const hintListSchema = z.strictObject({ revision: z.number().int(), hints: z.array(hintSchema) });
export type HintList = z.infer<typeof hintListSchema>;

export const decideHintSchema = z.strictObject({
  revision: revisionSchema,
  /** The return the hint is about. */
  personId: idSchema,
  /** accept: save a saving's answers. dismiss: hide a hint. undo: put back what accepting changed, or show it again. */
  decision: z.enum(["accept", "dismiss", "undo"]),
});
export type DecideHint = z.infer<typeof decideHintSchema>;

export const hintParamsSchema = z.strictObject({ year: yearSchema, hint: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,59}$/) });
