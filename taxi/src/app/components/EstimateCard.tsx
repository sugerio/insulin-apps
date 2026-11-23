import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { balancesOf, type Estimate } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet.tsx";
import { cn } from "@/lib/utils.ts";
import { Evaluation, type Explanation } from "../shared/engine/evaluate.ts";
import type { RuleSet, Status } from "../shared/engine/rules.ts";
import { rulesFor } from "../shared/rules/index.ts";
import { formatMoney, formatRate } from "../lib/format.ts";
import { useEstimate } from "../lib/useYearData.ts";
import { ResourceView } from "./Feedback.tsx";
import { useReturn, useYear } from "./YearFrame.tsx";

// The open return's estimate above each step: its refund or balance owing in one line, and on "Details" its result
// lines in a panel from the side, with "why" for each line, which the browser works out with the same engine and the
// input the server sent (both adults' returns are worked out together, so what one adult's return takes from the
// other's shows in the "why").

export function EstimateSummary() {
  const resource = useEstimate();
  const { person } = useReturn();
  const { year } = useYear();
  const result = resource.status === "ready" ? headline(rulesFor(year.country, year.year)!, resource.data, person.id) : null;
  return (
    <Sheet>
      <div className="flex items-center gap-3" role="group" aria-label="Estimate">
        <span className="flex flex-col items-end leading-tight">
          <span className="text-xs text-muted-foreground">Estimate</span>
          <span className="font-semibold tabular-nums">
            {resource.status === "loading" ? "…" : result ? result.text : "Not worked out yet"}
            {result?.estimate ? <span className="ml-1 text-xs font-normal text-muted-foreground">est.</span> : null}
          </span>
        </span>
        <SheetTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Estimate details">
            Details
          </Button>
        </SheetTrigger>
      </div>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Estimate</SheetTitle>
          <SheetDescription className="wrap-anywhere">{person.name}'s return. Select a line to see why.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <ResourceView resource={resource}>{(estimate) => <EstimateBody estimate={estimate} />}</ResourceView>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The refund or balance owing, and whether an answer assumed for now went into it. */
function headline(rules: RuleSet, estimate: Estimate, personId: string): { text: string; estimate: boolean } | null {
  const lines = estimate.result.people.find((person) => person.personId === personId)?.lines ?? [];
  // The federal refund or balance, and a resident of Quebec's after it (TP-1 lines 478 and 479).
  const balances = balancesOf(rules, lines);
  if (balances.length === 0 || balances.some((balance) => balance.refund.value === null || balance.owing.value === null)) return null;
  const parts = balances.map((balance) => {
    const owes = Number(balance.owing.value) > 0;
    const line = owes ? balance.owing : balance.refund;
    const name = balances.length > 1 ? `${balance.name} ` : "";
    return { text: `${name}${owes ? "balance owing" : "refund"} ${formatMoney(line.value!)}`, estimate: line.status === "estimate" };
  });
  return { text: parts.map((part) => part.text).join(" · ").replace(/^./, (first) => first.toUpperCase()), estimate: parts.some((part) => part.estimate) };
}

function EstimateBody({ estimate }: { estimate: Estimate }) {
  const { person: owner } = useReturn();
  const { year } = useYear();
  const rules = rulesFor(year.country, estimate.input.year)!;
  const evaluation = useMemo(() => new Evaluation(rules, estimate.input), [rules, estimate.input]);
  const person = estimate.result.people.find((each) => each.personId === owner.id);
  if (!person) return <p className="text-sm text-muted-foreground">Nothing to work out yet.</p>;
  return (
    <div className="flex flex-col gap-1.5">
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
    </div>
  );
}

export function ResultLine({ line, explain, rules }: { line: Estimate["result"]["people"][number]["lines"][number]; explain: () => Explanation; rules: RuleSet }) {
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
export function ExplanationBody({ explanation, rules }: { explanation: Explanation; rules: RuleSet }) {
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
    if (question?.type === "money") return formatMoney(value);
    if (question?.type === "percent") return `${value}%`;
    return question?.optionLabels?.[value] ?? value;
  }
  if (path.startsWith("person.")) return value;
  return formatMoney(value);
}
