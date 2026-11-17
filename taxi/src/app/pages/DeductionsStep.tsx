import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { canPrepare, type Estimate } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { ApiError, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { StepLayout, useAdults } from "../components/StepLayout.tsx";
import { stepPath, useYear } from "../components/YearFrame.tsx";
import { saveAnswersFor } from "../lib/saveAnswers.ts";
import { useEstimate } from "../lib/useYearData.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Step 5, `/returns/:year/deductions`: for each adult, the amounts of the year's deductions and credits
// (`step: deductions` in questions.yaml) that their return reads: the engine says which, so a question appears only
// when it can change the result (tuition to transfer only with a T2202 and a spouse in the year, a spouse's net income
// only when their return isn't prepared here).

export function DeductionsStep() {
  const { year } = useYear();
  const estimate = useEstimate();
  return (
    <StepLayout step="deductions" title="Deductions and credits">
      <ResourceView resource={estimate}>{(data) => <DeductionsForm key={year.revision} estimate={data} />}</ResourceView>
    </StepLayout>
  );
}

function DeductionsForm({ estimate }: { estimate: Estimate }) {
  const me = useMe();
  const navigate = useNavigate();
  const { year, replace, reload } = useYear();
  const adults = useAdults();
  const editable = canPrepare(me);
  const rules = rulesFor(year.year)!;
  const step = [...rules.questions.values()].filter((question) => question.step === "deductions");
  const questionsFor = (personId: string) => {
    const reached = new Set(estimate.result.people.find((person) => person.personId === personId)?.questions ?? []);
    const given = estimate.input.answers[personId] ?? {};
    return step.filter((question) => reached.has(question.id) || question.id in given);
  };
  const [values, setValues] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(
      adults.map((adult) => {
        const given = estimate.input.answers[adult.personId] ?? {};
        return [adult.personId, Object.fromEntries(step.map((question) => [question.id, typeof given[question.id] === "string" ? (given[question.id] as string) : ""]))];
      }),
    ),
  );
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });

  async function save(thenContinue: boolean) {
    setState({ status: "saving" });
    try {
      // A blank amount is saved as 0: the person looked at it and has nothing to claim.
      const byPerson = Object.fromEntries(
        adults.map((adult) => [
          adult.personId,
          Object.fromEntries(questionsFor(adult.personId).map((question) => [question.id, (values[adult.personId]?.[question.id] ?? "").replace(/[$,\s]/g, "") || "0"])),
        ]),
      );
      const saved = await saveAnswersFor(year, byPerson);
      replace(saved);
      if (thenContinue) navigate(stepPath(year.year, "finish"));
      else setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }
  const issues = state.status === "error" && state.error instanceof ApiError ? (state.error.body?.error.issues ?? []) : [];
  const stale = state.status === "error" && state.error instanceof ApiError && state.error.status === 409;

  return (
    <>
      <div className={adults.length > 1 ? "grid gap-4 2xl:grid-cols-2" : "flex flex-col gap-4"}>
        {adults.map((adult) => (
          <Card key={adult.personId}>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">{adult.person.name}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {questionsFor(adult.personId).map((question) => (
                <MoneyField
                  key={question.id}
                  label={question.ask}
                  help={question.help}
                  value={values[adult.personId]?.[question.id] ?? ""}
                  disabled={!editable}
                  issue={issues.find((issue) => issue.path === `answers.${question.id}`)?.message}
                  onChange={(value) => setValues((current) => ({ ...current, [adult.personId]: { ...current[adult.personId], [question.id]: value } }))}
                />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
      {stale ? (
        <Banner kind="error" title="Someone else changed this year" action={<Button variant="outline" size="sm" onClick={reload}>Reload</Button>}>
          {describeError(state.error)}
        </Banner>
      ) : state.status === "error" && issues.length === 0 ? (
        <Banner kind="error" title="The amounts weren't saved">{describeError(state.error)}</Banner>
      ) : null}
      {editable ? (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void save(false)} disabled={state.status === "saving"}>
            Save
          </Button>
          <Button onClick={() => void save(true)} disabled={state.status === "saving"}>
            {state.status === "saving" ? "Saving…" : "Save and continue"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function MoneyField({ label, help, value, onChange, disabled, issue }: { label: string; help?: string; value: string; onChange: (value: string) => void; disabled: boolean; issue?: string }) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
      <div className="min-w-0 flex-1 basis-64">
        <Label htmlFor={id}>{label}</Label>
        {help ? <p className="mt-0.5 text-xs text-muted-foreground">{help}</p> : null}
      </div>
      <div className="flex w-40 flex-col gap-1">
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">$</span>
          <Input id={id} inputMode="decimal" className="pl-6 text-right tabular-nums" placeholder="0" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-invalid={issue ? true : undefined} />
        </div>
        {issue ? <p className="text-xs text-destructive">{issue}</p> : null}
      </div>
    </div>
  );
}
