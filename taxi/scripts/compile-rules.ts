import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuleError } from "../src/app/shared/engine/errors.ts";
import { COMPILED_ROOT, compileNamed, ruleSetNames, serialize } from "./rules-source.ts";

// npm run rules: checks the YAML rule files and writes src/app/shared/rules/<country>-<year>.json, the form the app
// imports. With --check, writes nothing and fails when a JSON file is out of date (CI runs this through the tests).

const check = process.argv.includes("--check");
let stale = 0;
for (const name of ruleSetNames()) {
  const target = join(COMPILED_ROOT, `${name}.json`);
  let text: string;
  try {
    text = serialize(compileNamed(name));
  } catch (error) {
    if (error instanceof RuleError) {
      console.error(`rules: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === text) continue;
  if (check) {
    console.error(`rules: ${name}.json is out of date; run npm run rules`);
    stale += 1;
  } else {
    writeFileSync(target, text);
    console.log(`rules: wrote ${name}.json`);
  }
}
if (stale > 0) process.exit(1);
