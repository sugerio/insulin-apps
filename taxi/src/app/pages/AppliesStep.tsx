import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { canPrepare, type Estimate } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { ApiError, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { StepLayout, useAdults } from "../components/StepLayout.tsx";
import { stepPath, useYear } from "../components/YearFrame.tsx";
import { saveAnswersFor } from "../lib/saveAnswers.ts";
import { useEstimate } from "../lib/useYearData.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Step 3, `/returns/:year/applies`: for each adult, yes or no to each kind of income or expense the year's rules ask
// about here (`step: applies` in questions.yaml). A yes to something the app doesn't handle makes the return say so.

export function AppliesStep() {
  const { year } = useYear();
  const estimate = useEstimate();
  return (
    <StepLayout step="applies" title={`What applies in ${year.year}`}>
      <ResourceView resource={estimate}>{(data) => <AppliesForm key={year.revision} estimate={data} />}</ResourceView>
    </StepLayout>
  );
}

type Values = Record<string, Record<string, boolean | null>>;

function AppliesForm({ estimate }: { estimate: Estimate }) {
  const me = useMe();
  const navigate = useNavigate();
  const { year, replace, reload } = useYear();
  const adults = useAdults();
  const editable = canPrepare(me);
  const questions = [...rulesFor(year.year)!.questions.values()].filter((question) => question.step === "applies");
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(
      adults.map((adult) => {
        const given = estimate.input.answers[adult.personId] ?? {};
        return [adult.personId, Object.fromEntries(questions.map((question) => [question.id, typeof given[question.id] === "boolean" ? (given[question.id] as boolean) : null]))];
      }),
    ),
  );
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });

  async function save(thenContinue: boolean) {
    setState({ status: "saving" });
    try {
      const byPerson = Object.fromEntries(
        Object.entries(values).map(([personId, answers]) => [personId, Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== null))]),
      );
      const saved = await saveAnswersFor(year, byPerson);
      replace(saved);
      if (thenContinue && saved.steps.applies === "done") navigate(stepPath(year.year, "confirm"));
      else setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  const unanswered = adults.some((adult) => questions.some((question) => values[adult.personId]?.[question.id] === null));
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
            <CardContent>
              <ul className="flex flex-col divide-y">
                {questions.map((question) => (
                  <li key={question.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="text-sm font-medium" id={`${adult.personId}-${question.id}`}>
                        {question.ask}
                      </p>
                      {question.help ? <p className="text-xs text-muted-foreground">{question.help}</p> : null}
                      {values[adult.personId]?.[question.id] === true ? (
                        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Not handled by this app yet.</p>
                      ) : null}
                    </div>
                    <YesNo
                      labelledBy={`${adult.personId}-${question.id}`}
                      value={values[adult.personId]?.[question.id] ?? null}
                      disabled={!editable}
                      onChange={(value) => setValues((current) => ({ ...current, [adult.personId]: { ...current[adult.personId], [question.id]: value } }))}
                    />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
      {stale ? (
        <Banner kind="error" title="Someone else changed this year" action={<Button variant="outline" size="sm" onClick={reload}>Reload</Button>}>
          {describeError(state.error)}
        </Banner>
      ) : state.status === "error" ? (
        <Banner kind="error" title="The answers weren't saved">{describeError(state.error)}</Banner>
      ) : null}
      {editable ? (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void save(false)} disabled={state.status === "saving"}>
            Save
          </Button>
          <Button onClick={() => void save(true)} disabled={state.status === "saving" || unanswered}>
            {state.status === "saving" ? "Saving…" : "Save and continue"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function YesNo({ value, onChange, disabled, labelledBy }: { value: boolean | null; onChange: (value: boolean) => void; disabled: boolean; labelledBy: string }) {
  const id = useId();
  return (
    <RadioGroup
      aria-labelledby={labelledBy}
      value={value === null ? "" : value ? "yes" : "no"}
      onValueChange={(next) => onChange(next === "yes")}
      disabled={disabled}
      className="flex gap-2"
    >
      {(["yes", "no"] as const).map((option) => (
        <Label
          key={option}
          htmlFor={`${id}-${option}`}
          className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 has-disabled:cursor-default"
        >
          <RadioGroupItem id={`${id}-${option}`} value={option} />
          {option === "yes" ? "Yes" : "No"}
        </Label>
      ))}
    </RadioGroup>
  );
}
