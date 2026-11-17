import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { routes, type Estimate } from "#shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";
import { apiRequest } from "../api/client.ts";
import { Evaluation, type Explanation } from "../shared/engine/evaluate.ts";
import type { RuleSet, Status } from "../shared/engine/rules.ts";
import { rulesFor } from "../shared/rules/index.ts";
import { formatMoney, formatRate } from "../lib/format.ts";
import { useResource } from "../lib/useResource.ts";
import { ResourceView } from "./Feedback.tsx";
import { useYear } from "./YearFrame.tsx";

// The year's estimate beside a step: each return's result lines from the server, and "why" for each line, which the
// browser works out with the same engine and the input the server sent.

export function EstimateCard() {
  const { year } = useYear();
  // The revision is in the key, so a saved change to the year loads the estimate again.
  const resource = useResource(`estimate-${year.year}-${year.revision}`, (signal) => apiRequest(routes.getEstimate, { params: { year: year.year }, signal }));
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-sm font-semibold">Estimate</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResourceView resource={resource}>{(estimate) => <EstimateBody estimate={estimate} />}</ResourceView>
      </CardContent>
    </Card>
  );
}

function EstimateBody({ estimate }: { estimate: Estimate }) {
  const rules = rulesFor(estimate.input.year)!;
  const evaluation = useMemo(() => new Evaluation(rules, estimate.input), [rules, estimate.input]);
  const couple = estimate.result.people.length > 1;
  return (
    <div className="flex flex-col gap-4">
      {estimate.result.people.map((person) => {
        const name = estimate.input.people.find((each) => each.id === person.personId)?.name ?? "";
        return (
          <section key={person.personId} aria-label={name} className="flex flex-col gap-1.5">
            {couple ? <h3 className="text-sm font-medium">{name}</h3> : null}
            <ul className="flex flex-col">
              {person.lines.map((line) => (
                <ResultLine key={line.id} line={line} explain={() => evaluation.explain(person.personId, `line.${line.id}`)} rules={rules} />
              ))}
            </ul>
            {person.missing.length + person.unhandled.length > 0 ? (
              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                {person.missing.map((item) => (
                  <li key={item.question}>Needed: {item.ask}</li>
                ))}
                {person.unhandled.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
            {person.estimates.length > 0 ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  {person.estimates.length} {person.estimates.length === 1 ? "answer" : "answers"} assumed
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5 pl-3">
                  {person.estimates.map((item) => (
                    <li key={item.question}>
                      {item.ask}: {typeof item.assumed === "boolean" ? (item.assumed ? "yes" : "no") : rules.questions.get(item.question)?.type === "money" ? formatMoney(item.assumed) : item.assumed}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function ResultLine({ line, explain, rules }: { line: Estimate["result"]["people"][number]["lines"][number]; explain: () => Explanation; rules: RuleSet }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        className="flex w-full items-baseline gap-2 py-1.5 text-left text-sm hover:text-primary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 self-center transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span className="min-w-0 flex-1">{line.label}</span>
        <Amount value={line.value} status={line.status} />
      </button>
      {open ? (
        <div className="pb-2 pl-5">
          <ExplanationBody explanation={explain()} rules={rules} />
        </div>
      ) : null}
    </li>
  );
}

function Amount({ value, status }: { value: string | null; status: Status }) {
  if (value === null) return <span className="text-muted-foreground">Missing</span>;
  return (
    <span className="tabular-nums">
      {formatMoney(value)}
      {status === "estimate" ? <span className="ml-1 text-xs text-muted-foreground">est.</span> : null}
    </span>
  );
}

/** One value of an explanation and, opened, the values that went into it. */
function ExplanationTree({ explanation, rules }: { explanation: Explanation; rules: RuleSet }) {
  const [open, setOpen] = useState(false);
  const expandable = explanation.inputs.length > 0 || explanation.formula !== undefined || explanation.source !== undefined;
  return (
    <div className="flex flex-col gap-1 text-xs">
      <button
        type="button"
        className="flex items-baseline gap-1.5 text-left disabled:cursor-default"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen(!open)}
      >
        {expandable ? (
          <ChevronRight className={cn("size-3 shrink-0 self-center transition-transform", open && "rotate-90")} aria-hidden="true" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="min-w-0 flex-1">{explanation.label}</span>
        <span className="tabular-nums">{showValue(explanation, rules)}</span>
      </button>
      {open && expandable ? (
        <div className="ml-1.5 border-l pl-3">
          <ExplanationBody explanation={explanation} rules={rules} />
        </div>
      ) : null}
    </div>
  );
}

/** What a value is made of: its formula, its source, and the values that went into it. */
function ExplanationBody({ explanation, rules }: { explanation: Explanation; rules: RuleSet }) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      {explanation.formula ? <code className="break-words text-[11px] text-muted-foreground">= {explanation.formula.replace(/\s+/g, " ")}</code> : null}
      {explanation.source ? <p className="text-muted-foreground">{explanation.source}</p> : null}
      {explanation.notes?.map((note) => (
        <p key={note} className="text-amber-700 dark:text-amber-400">
          {note}
        </p>
      ))}
      {explanation.inputs.map((input, index) => (
        <ExplanationTree key={`${input.ref}-${index}`} explanation={input} rules={rules} />
      ))}
    </div>
  );
}

/** A value as the kind of thing it is: money, a rate, a bracket table, an age, an answer. */
function showValue(explanation: Explanation, rules: RuleSet): string {
  const { ref, value } = explanation;
  if (value === null) return "Missing";
  const path = ref.startsWith("spouse.") ? ref.slice("spouse.".length) : ref;
  if (path.startsWith("param.")) {
    const param = rules.params.get(path.slice("param.".length));
    if (param && Array.isArray(param.value)) return `${param.value.length} brackets`;
    return value.includes(".") && !value.startsWith("-") && Number(value) < 1 ? formatRate(value) : formatMoney(value);
  }
  if (path.startsWith("answer.")) {
    const question = rules.questions.get(path.slice("answer.".length));
    return question?.type === "money" ? formatMoney(value) : value;
  }
  if (path.startsWith("person.")) return value;
  return formatMoney(value);
}
