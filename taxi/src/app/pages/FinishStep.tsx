import { useMemo } from "react";
import { Link } from "react-router";
import type { Estimate, SlipList } from "#shared";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { ResultLine } from "../components/EstimateCard.tsx";
import { ResourceView } from "../components/Feedback.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, useReturn, useYear } from "../components/YearFrame.tsx";
import { formatMoney } from "../lib/format.ts";
import { useEstimate, useSlips } from "../lib/useYearData.ts";
import { Evaluation } from "../shared/engine/evaluate.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Step 6, `/returns/:year/:personId/finish`: the open return's refund or balance owing, its key lines with why each is
// what it is (worked out in the browser with the same engine), and what still needs a look before filing.

export function FinishStep() {
  const estimate = useEstimate();
  const slips = useSlips();
  return (
    <StepLayout step="finish" title="Your results" estimate={false}>
      <ResourceView resource={estimate}>
        {(data) => <ResourceView resource={slips}>{(slipList) => <Results estimate={data} slips={slipList} />}</ResourceView>}
      </ResourceView>
    </StepLayout>
  );
}

function Results({ estimate, slips }: { estimate: Estimate; slips: SlipList }) {
  const { year } = useYear();
  const { person: owner } = useReturn();
  const rules = rulesFor(year.year)!;
  const evaluation = useMemo(() => new Evaluation(rules, estimate.input), [rules, estimate.input]);
  const person = estimate.result.people.find((each) => each.personId === owner.id);
  if (!person) return <p className="text-sm text-muted-foreground">Nothing to work out yet.</p>;
  const line = (id: string) => person.lines.find((each) => each.id === id);
  const refund = line("T1.48400");
  const owing = line("T1.48500");
  const toConfirm = slips.slips.filter((slip) => slip.personId === owner.id && slip.status === "unconfirmed").length;
  const checks = [
    ...(toConfirm > 0 ? [{ text: `${toConfirm} ${toConfirm === 1 ? "slip is" : "slips are"} not confirmed yet.`, step: "confirm" as const }] : []),
    ...person.missing.map((item) => ({ text: `Needed: ${item.ask}.`, step: item.question.startsWith("household.") || item.question.startsWith("person.") ? ("household" as const) : ("deductions" as const) })),
    ...person.estimates.map((item) => ({ text: `Not answered yet: ${item.ask}.`, step: rules.questions.get(item.question)?.step === "applies" ? ("applies" as const) : ("deductions" as const) })),
    ...person.unhandled.map((note) => ({ text: note, step: null })),
  ];
  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <Headline refund={refund?.value ?? null} owing={owing?.value ?? null} />
        <ul className="flex flex-col" aria-label="Key lines">
          {person.lines
            .filter((each) => each.id !== "T1.48400" && each.id !== "T1.48500")
            .map((each) => (
              <ResultLine key={each.id} line={each} explain={() => evaluation.explain(person.personId, `line.${each.id}`)} rules={rules} />
            ))}
        </ul>
        {checks.length > 0 ? (
          <section aria-label="Before you file" className="flex flex-col gap-1.5">
            <h2 className="text-sm font-medium">Before you file</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {checks.map((check) => (
                <li key={check.text} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted-foreground">{check.text}</span>
                  {check.step ? (
                    <Link className="text-xs underline underline-offset-2" to={stepPath(year.year, owner.id, check.step)}>
                      Go to the step
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Headline({ refund, owing }: { refund: string | null; owing: string | null }) {
  if (refund === null || owing === null) {
    return <p className="text-sm text-muted-foreground">The refund or balance owing can't be worked out yet: see below.</p>;
  }
  const isRefund = !Number(owing);
  return (
    <div className="rounded-lg bg-muted/50 px-4 py-3">
      <p className="text-sm text-muted-foreground">{isRefund ? "Refund" : "Balance owing"}</p>
      <p className="text-2xl font-semibold tabular-nums">{formatMoney(isRefund ? refund : owing)}</p>
    </div>
  );
}
