import { z } from "zod";
import { Dec } from "./decimal.ts";
import { RuleError } from "./errors.ts";
import { percentToDecimal } from "./formula.ts";
import { loadRuleSet, type CompiledRules } from "./rules.ts";

// Compiles a year's rule files into the JSON the app imports. A year is a folder of YAML files: `year.yaml` names the
// country, the year, the filing unit and the year it extends; the other files hold entries (params, lines, questions,
// slips, result) in any split. A year that extends another lists only what changed: an entry replaces the one with
// the same id, and `null` removes it. The compiler checks everything the engine relies on, so a broken rule file
// fails the build instead of a return.
//
// This module reads parsed YAML, not files: scripts/compile-rules.ts does the reading, and the tests call it directly.

export interface SourceFile {
  /** The path shown in errors, such as `rules/ca/2025/federal.yaml`. */
  path: string;
  /** The parsed YAML. */
  data: unknown;
}
/** One year's folder, read. */
export interface SourceYear {
  dir: string;
  files: SourceFile[];
}

const MANIFEST = "year.yaml";
const SECTIONS = ["params", "lines", "questions", "slips"] as const;
type Section = (typeof SECTIONS)[number];

const sourceNumber = z.union([z.number(), z.string()]);
const sourceParam = z.strictObject({
  label: z.string().min(1),
  value: z.union([sourceNumber, z.array(z.strictObject({ upTo: sourceNumber.optional(), rate: sourceNumber, base: sourceNumber.optional() }))]),
  source: z.string().min(1, "Every param names its source"),
});
const sourceLine = z.strictObject({ label: z.string().min(1), formula: z.string().min(1), source: z.string().min(1).optional() });
const sourceQuestion = z.strictObject({
  type: z.enum(["money", "boolean", "choice"]),
  ask: z.string().min(1),
  step: z.enum(["applies", "deductions"]).optional(),
  help: z.string().min(1).optional(),
  default: z.union([sourceNumber, z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
});
const sourceSlip = z.strictObject({
  title: z.string().min(1),
  about: z.string().min(1),
  boxes: z.record(z.string(), z.string()),
  informational: z.array(sourceNumber).optional(),
});

const manifestSchema = z.strictObject({
  country: z.string().regex(/^[a-z]{2}$/),
  year: z.number().int(),
  filingUnit: z.literal("person"),
  extends: z.number().int().nullable(),
  result: z.array(z.string()).optional(),
});
const entriesSchema = z.strictObject({
  params: z.record(z.string(), sourceParam.nullable()).optional(),
  lines: z.record(z.string(), sourceLine.nullable()).optional(),
  questions: z.record(z.string(), sourceQuestion.nullable()).optional(),
  slips: z.record(z.string(), sourceSlip.nullable()).optional(),
});

/** Compiles a chain of years, oldest first; the last is the year compiled. `hash` makes the version from the content. */
export function compileRules(chain: SourceYear[], hash: (text: string) => string): CompiledRules {
  if (chain.length === 0) throw new Error("No rule folder to compile");
  const merged: Record<Section, Record<string, unknown>> = { params: {}, lines: {}, questions: {}, slips: {} };
  const origin = new Map<string, string>();
  let manifest: z.infer<typeof manifestSchema> | undefined;
  let result: string[] | undefined;

  chain.forEach((year, index) => {
    const manifestFile = year.files.find((file) => file.path.endsWith(`/${MANIFEST}`));
    if (!manifestFile) throw new RuleError({ file: `${year.dir}/${MANIFEST}` }, "Every year folder has a year.yaml");
    const parsedManifest = parse(manifestSchema, manifestFile);
    const previous = chain[index - 1];
    if (parsedManifest.extends !== (previous ? manifest!.year : null)) {
      throw new RuleError({ file: manifestFile.path }, previous ? `extends must be ${manifest!.year}` : "The first year extends nothing (extends: null)");
    }
    if (manifest && parsedManifest.country !== manifest.country) throw new RuleError({ file: manifestFile.path }, "A year can only extend the same country");
    manifest = parsedManifest;
    result = parsedManifest.result ?? result;

    const seen = new Map<string, string>();
    for (const file of year.files) {
      if (file === manifestFile) continue;
      const entries = parse(entriesSchema, file);
      for (const section of SECTIONS) {
        for (const [id, entry] of Object.entries(entries[section] ?? {})) {
          const key = `${section}.${id}`;
          const other = seen.get(key);
          if (other) throw new RuleError({ file: file.path, entry: key }, `Also in ${other}; a year defines each entry once`);
          seen.set(key, file.path);
          if (entry === null) {
            if (!(id in merged[section])) throw new RuleError({ file: file.path, entry: key }, "Removes an entry that no earlier year has");
            delete merged[section][id];
            origin.delete(key);
          } else {
            merged[section][id] = entry;
            origin.set(key, file.path);
          }
        }
      }
    }
  });

  const where = (entry: string) => origin.get(entry) ?? `${chain.at(-1)!.dir}/${MANIFEST}`;
  const decimal = (entry: string, value: string | number) => toDecimalText(value, (message) => {
    throw new RuleError({ file: where(entry), entry }, message);
  });

  const content: Omit<CompiledRules, "version"> = {
    country: manifest!.country,
    year: manifest!.year,
    filingUnit: manifest!.filingUnit,
    result: result ?? [],
    params: mapValues(merged.params as Record<string, z.infer<typeof sourceParam>>, (param, id) => ({
      label: param.label,
      value: Array.isArray(param.value)
        ? param.value.map((row) => ({
            upTo: row.upTo === undefined ? null : decimal(`params.${id}`, row.upTo),
            rate: decimal(`params.${id}`, row.rate),
            ...(row.base === undefined ? {} : { base: decimal(`params.${id}`, row.base) }),
          }))
        : decimal(`params.${id}`, param.value),
      source: param.source,
    })),
    lines: merged.lines as CompiledRules["lines"],
    questions: mapValues(merged.questions as Record<string, z.infer<typeof sourceQuestion>>, (question, id) => {
      const { default: fallback, ...rest } = question;
      if (fallback === undefined) return rest;
      return { ...rest, default: typeof fallback === "boolean" || question.type === "choice" ? fallback : decimal(`questions.${id}`, fallback) };
    }) as CompiledRules["questions"],
    slips: mapValues(merged.slips as Record<string, z.infer<typeof sourceSlip>>, (slip) => ({
      ...slip,
      informational: (slip.informational ?? []).map(String),
    })),
  };
  const compiled: CompiledRules = { ...content, version: hash(JSON.stringify(content)) };
  // Loading runs every check the engine relies on: formulas parse, names exist, types agree, no cycles.
  loadRuleSet(compiled, where);
  return compiled;
}

function parse<T>(schema: z.ZodType<T>, file: SourceFile): T {
  const parsed = schema.safeParse(file.data ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new RuleError({ file: file.path, entry: issue.path.join(".") || undefined }, issue.message);
}

/** A number as written in YAML (`1471`, `"82400.50"`, `14.5%`) → exact decimal text. */
function toDecimalText(value: string | number, fail: (message: string) => never): string {
  const text = typeof value === "number" ? String(value) : value.trim();
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
  if (percent) return percentToDecimal(percent[1]!);
  if (!/^-?\d+(\.\d+)?$/.test(text)) fail(`Not a number: ${JSON.stringify(value)}`);
  return Dec.from(text).toString();
}

function mapValues<T, U>(record: Record<string, T>, fn: (value: T, key: string) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value, key)]));
}
