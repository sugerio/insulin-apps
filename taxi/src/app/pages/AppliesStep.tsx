import { useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRight, FileUp } from "lucide-react";
import { canPrepare, routes, type Estimate, type Slip, type SlipList } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { cn } from "@/lib/utils.ts";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { SlipBoxTable, SlipForm, type SlipChange } from "../components/SlipForm.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, stepsOf, useReturn, useYear } from "../components/YearFrame.tsx";
import { saveAnswersFor } from "../lib/saveAnswers.ts";
import { uploadFile, uploadType } from "../lib/upload.ts";
import { useEstimate, useSlips } from "../lib/useYearData.ts";
import type { Question } from "../shared/engine/rules.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Step 3, `/returns/:year/:personId/applies`: what the open return's documents show and what they don't. The year's
// rules list the kinds of income and expenses to ask about (`step: applies` in questions.yaml). A question with a
// `slip` is answered by finding that slip: found ones open into their boxes as read, to check and change right here;
// for the others the person says
// whether they have one, and a yes without the slip is missing, to upload right here or type in at step 4. Questions
// without a slip name what the app doesn't handle.

export function AppliesStep() {
  const { year } = useYear();
  const estimate = useEstimate();
  const slips = useSlips();
  // The slips opened: kept here, as the form below starts again whenever the year changes (a slip saved, say).
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <StepLayout step="applies" title={`What applies in ${year.year}`}>
      <ResourceView resource={estimate}>
        {(answers) => (
          <ResourceView resource={slips}>{(slipList) => <AppliesForm key={year.revision} estimate={answers} slips={slipList} open={open} onToggle={toggle} />}</ResourceView>
        )}
      </ResourceView>
    </StepLayout>
  );
}

function AppliesForm({ estimate, slips, open, onToggle }: { estimate: Estimate; slips: SlipList; open: ReadonlySet<string>; onToggle: (slipId: string) => void }) {
  const me = useMe();
  const navigate = useNavigate();
  const { year, replace, reload } = useYear();
  const { person } = useReturn();
  const editable = canPrepare(me);
  const rules = rulesFor(year.year)!;
  const questions = [...rules.questions.values()].filter((question) => question.step === "applies");
  const topics = questions.filter((question) => question.slip !== undefined);
  const notHandled = questions.filter((question) => question.slip === undefined);
  const slipsOf = (type: string) => slips.slips.filter((slip) => slip.personId === person.id && slip.type === type);
  const [values, setValues] = useState<Record<string, boolean | null>>(() => {
    const given = estimate.input.answers[person.id] ?? {};
    return Object.fromEntries(questions.map((question) => [question.id, typeof given[question.id] === "boolean" ? (given[question.id] as boolean) : null]));
  });
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });
  const set = (id: string, value: boolean) => setValues((current) => ({ ...current, [id]: value }));

  /** The answers to save: every answered question, not the ones a found slip answers. */
  const answersToSave = () => ({
    [person.id]: Object.fromEntries(
      Object.entries(values).filter(([id, value]) => {
        const slip = rules.questions.get(id)?.slip;
        return value !== null && !(slip && slipsOf(slip).length > 0);
      }),
    ),
  });

  async function save(thenContinue: boolean) {
    setState({ status: "saving" });
    try {
      const saved = await saveAnswersFor(year, answersToSave());
      replace(saved);
      if (thenContinue && stepsOf(saved, person.id)?.applies === "done") navigate(stepPath(year.year, person.id, "confirm"));
      else setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  /** Uploads a missing slip into this return after saving the answers so far, so nothing chosen here is lost. */
  async function upload(file: File) {
    const type = uploadType(file);
    if (!type) {
      setState({ status: "error", error: new ApiError(400, "validation_failed", `${file.name} isn't a PDF, PNG or JPEG.`) });
      return;
    }
    setState({ status: "saving" });
    try {
      const saved = await saveAnswersFor(year, answersToSave());
      const result = await uploadFile(year.year, person.id, file, type);
      replace(result.year.revision > saved.revision ? result.year : saved);
      if (result.status !== "read") setState({ status: "error", error: new ApiError(400, "validation_failed", `${file.name}: ${result.message}`) });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  /** Saves a change to a slip after the answers so far, so nothing chosen here is lost when the form starts again. */
  const saveSlip = (slip: Slip) => async (change: SlipChange) => {
    const saved = await saveAnswersFor(year, answersToSave());
    return apiRequest(routes.updateSlip, { params: { year: year.year, id: slip.id }, body: { revision: saved.revision, ...change } });
  };

  const found = topics.filter((topic) => slipsOf(topic.slip!).length > 0);
  const notFound = topics.filter((topic) => slipsOf(topic.slip!).length === 0);
  const missing = notFound.filter((topic) => values[topic.id] === true).map((topic) => topic.slip!);
  const unanswered = questions.some((question) => values[question.id] === null && !(question.slip && slipsOf(question.slip).length > 0));
  const stale = state.status === "error" && state.error instanceof ApiError && state.error.status === 409;

  return (
    <>
      {missing.length > 0 ? (
        <Banner kind="warning" title="Still missing">
          {missing.map((type) => `the ${type}`).join(", ")}. Upload each one below, or type it in at step 4.
        </Banner>
      ) : null}
      <Card>
        <CardContent className="flex flex-col gap-5">
          <section aria-label="Found in your documents" className="flex flex-col gap-1">
            <h2 className="text-sm font-medium">Found in your documents</h2>
            {found.length === 0 ? <p className="text-sm text-muted-foreground">No slips yet.</p> : null}
            <ul className="flex flex-col divide-y">
              {found.flatMap((topic) =>
                slipsOf(topic.slip!).map((slip) => (
                  <FoundRow key={slip.id} topic={topic} slip={slip} open={open.has(slip.id)} onToggle={() => onToggle(slip.id)} editable={editable} save={saveSlip(slip)} />
                )),
              )}
            </ul>
          </section>
          {notFound.length > 0 ? (
            <section aria-label="Not found" className="flex flex-col gap-1">
              <h2 className="text-sm font-medium">Not found: do you have these?</h2>
              <ul className="flex flex-col divide-y">
                {notFound.map((topic) => (
                  <QuestionRow
                    key={topic.id}
                    question={topic}
                    value={values[topic.id] ?? null}
                    editable={editable}
                    onChange={(value) => set(topic.id, value)}
                    extra={values[topic.id] === true ? <MissingSlip type={topic.slip!} editable={editable} busy={state.status === "saving"} onFile={(file) => void upload(file)} /> : null}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-label="Not handled by this app" className="flex flex-col gap-1">
            <h2 className="text-sm font-medium">Not handled by this app</h2>
            <ul className="flex flex-col divide-y">
              {notHandled.map((question) => (
                <QuestionRow
                  key={question.id}
                  question={question}
                  value={values[question.id] ?? null}
                  editable={editable}
                  onChange={(value) => set(question.id, value)}
                  extra={values[question.id] === true ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Not handled by this app yet.</p> : null}
                />
              ))}
            </ul>
          </section>
        </CardContent>
      </Card>
      {stale ? (
        <Banner kind="error" title="Someone else changed this year" action={<Button variant="outline" size="sm" onClick={reload}>Reload</Button>}>
          {describeError(state.error)}
        </Banner>
      ) : state.status === "error" ? (
        <Banner kind="error" title="That didn't work">{describeError(state.error)}</Banner>
      ) : null}
      {editable ? (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void save(false)} disabled={state.status === "saving"}>
            Save
          </Button>
          <Button onClick={() => void save(true)} disabled={state.status === "saving" || unanswered || missing.length > 0}>
            {state.status === "saving" ? "Saving…" : "Save and continue"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** A slip found: what it shows, and opened, its boxes as read, to change (it goes back to unconfirmed when changed). */
function FoundRow({
  topic,
  slip,
  open,
  onToggle,
  editable,
  save,
}: {
  topic: Question;
  slip: Slip;
  open: boolean;
  onToggle: () => void;
  editable: boolean;
  save: (change: SlipChange) => ReturnType<typeof saveAnswersFor>;
}) {
  const { year } = useYear();
  const panel = useId();
  const slipType = rulesFor(year.year)!.slips.get(slip.type)!;
  const confirmed = slip.status === "confirmed";
  return (
    <li className="py-1 text-sm">
      <button type="button" className="flex w-full items-center gap-2 rounded-md py-1.5 text-left hover:bg-muted/50" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{topic.ask}</span>
          <span className="text-muted-foreground">
            {" "}
            · {slip.type} from {slip.issuer}
          </span>
        </span>
        <Badge variant={confirmed ? "secondary" : "outline"}>{confirmed ? "Confirmed" : "To confirm"}</Badge>
      </button>
      {open ? (
        <div id={panel} className="flex flex-col gap-3 pt-2 pb-3 pl-6">
          {editable ? (
            <SlipForm personId={slip.personId} slip={slip} save={save} inline />
          ) : (
            <SlipBoxTable slipType={slipType} boxes={slip.boxes} unsure={confirmed ? [] : slip.unsure} />
          )}
          <p className="text-xs text-muted-foreground">
            {slip.source === "ai" && slip.documentId ? (
              <>
                Read by AI from{" "}
                <a className="underline underline-offset-2" href={`/api/years/${year.year}/documents/${slip.documentId}/file`} target="_blank" rel="noreferrer">
                  the uploaded file
                </a>
                . Check each amount against it.
              </>
            ) : (
              "Typed in."
            )}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function QuestionRow({ question, value, editable, onChange, extra }: { question: Question; value: boolean | null; editable: boolean; onChange: (value: boolean) => void; extra?: React.ReactNode }) {
  const id = useId();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm font-medium" id={`${id}-label`}>
          {question.ask}
        </p>
        {question.help ? <p className="text-xs text-muted-foreground">{question.help}</p> : null}
        {extra}
      </div>
      <YesNo labelledBy={`${id}-label`} value={value} disabled={!editable} onChange={onChange} />
    </li>
  );
}

function MissingSlip({ type, editable, busy, onFile }: { type: string; editable: boolean; busy: boolean; onFile: (file: File) => void }) {
  const { year } = useYear();
  const { person } = useReturn();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Missing: the {type}</span>
      {editable ? (
        <>
          <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy}>
            <FileUp aria-hidden="true" />
            Upload the {type}
          </Button>
          <input
            ref={input}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            className="hidden"
            aria-label={`Upload the ${type}`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
              event.target.value = "";
            }}
          />
          <Link className="text-xs underline underline-offset-2" to={stepPath(year.year, person.id, "confirm")}>
            Type it in instead
          </Link>
        </>
      ) : null}
    </div>
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
