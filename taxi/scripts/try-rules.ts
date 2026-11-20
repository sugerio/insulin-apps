import { readFileSync } from "node:fs";
import { Evaluation, type Explanation } from "../src/app/shared/engine/evaluate.ts";
import { rulesFor } from "../src/app/shared/rules/index.ts";

// npm run rules:try -- <file.json>: evaluates a year's returns and prints each return's result lines, why each one is what
// it is, and what is estimated, missing or not handled. The file is an engine input, or a golden case (whose
// `input` is used). Example: npm run rules:try -- test/golden/ca-2025/single-employee-on.json

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run rules:try -- <case.json>");
  process.exit(1);
}
const json = JSON.parse(readFileSync(file, "utf8")) as { input?: unknown; year?: number };
const input = (json.input ?? json) as { year: number; people: { id: string; name: string }[] };
const rules = rulesFor(input.year);
if (!rules) {
  console.error(`No rules for ${input.year}`);
  process.exit(1);
}
const evaluation = new Evaluation(rules, input);
const result = evaluation.result();

const mark = { complete: "", estimate: " (estimate)", missing: " (missing)" } as const;
function print(explanation: Explanation, depth: number) {
  const pad = "  ".repeat(depth);
  const formula = explanation.formula ? `  = ${explanation.formula.replace(/\s+/g, " ")}` : "";
  console.log(`${pad}${explanation.ref}  ${explanation.label}: ${explanation.value ?? "?"}${mark[explanation.status]}${formula}`);
  if (explanation.source) console.log(`${pad}  source: ${explanation.source}`);
  for (const child of explanation.inputs) print(child, depth + 1);
}

console.log(`Rules ${rules.country}-${rules.year}, version ${result.rulesVersion}\n`);
for (const person of result.people) {
  const name = input.people.find((each) => each.id === person.personId)?.name ?? person.personId;
  console.log(`== ${name}`);
  for (const line of person.lines) console.log(`  ${line.id.padEnd(10)} ${line.label.padEnd(45)} ${(line.value ?? "?").padStart(12)}${mark[line.status]}`);
  for (const estimate of person.estimates) console.log(`  estimate: "${estimate.ask}" is unanswered; assumed ${String(estimate.assumed)}`);
  for (const missing of person.missing) console.log(`  missing: ${missing.ask}`);
  for (const note of person.unhandled) console.log(`  not handled: ${note}`);
  console.log("\nWhy:");
  for (const line of person.lines) print(evaluation.explain(person.personId, `line.${line.id}`), 1);
  console.log("");
}
