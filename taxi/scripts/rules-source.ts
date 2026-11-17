import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { compileRules, type SourceYear } from "../src/app/shared/engine/compile.ts";
import type { CompiledRules } from "../src/app/shared/engine/rules.ts";

// Reads rule folders from disk for the compiler: rules/<country>/<year>/*.yaml, following `extends` back to the first
// year. Used by scripts/compile-rules.ts and by the tests.

export const APP_ROOT = resolve(import.meta.dirname, "..");
export const RULES_ROOT = join(APP_ROOT, "rules");
export const COMPILED_ROOT = join(APP_ROOT, "src/app/shared/rules");

/** Every compiled rule set, as `ca-2025`. */
export function ruleSetNames(): string[] {
  return readdirSync(RULES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((country) =>
      readdirSync(join(RULES_ROOT, country.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
        .map((year) => `${country.name}-${year.name}`),
    )
    .sort();
}

export function readYear(dir: string): SourceYear {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { path: relative(APP_ROOT, path), data: parse(readFileSync(path, "utf8")) as unknown };
    });
  return { dir: relative(APP_ROOT, dir), files };
}

/** Compiles `ca-2025`: that year's folder and every year it extends. */
export function compileNamed(name: string): CompiledRules {
  const [country, year] = name.split("-");
  const chain: SourceYear[] = [];
  let next: number | null = Number(year);
  while (next !== null) {
    const source = readYear(join(RULES_ROOT, country!, String(next)));
    chain.unshift(source);
    const manifest = source.files.find((file) => file.path.endsWith("/year.yaml"))?.data as { extends?: number | null } | undefined;
    next = manifest?.extends ?? null;
  }
  return compileRules(chain, (text) => createHash("sha256").update(text).digest("hex").slice(0, 16));
}

/** The compiled JSON as written to disk. */
export function serialize(compiled: CompiledRules): string {
  return `${JSON.stringify(compiled, null, 2)}\n`;
}
