import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRight, FileUp, Plus } from "lucide-react";
import { canPrepare, routes, type Estimate, type Slip, type SlipList, type Step } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { AmountField, cleanAmount } from "../components/AmountField.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { SlipBoxTable, SlipForm, type SlipChange } from "../components/SlipForm.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, useReturn, useYear } from "../components/YearFrame.tsx";
import { formatMoney } from "../lib/format.ts";
import { saveAnswersFor } from "../lib/saveAnswers.ts";
import { uploadFile, uploadType } from "../lib/upload.ts";
import { useEstimate, useSlips } from "../lib/useYearData.ts";
import { Evaluation } from "../shared/engine/evaluate.ts";
import type { Question } from "../shared/engine/rules.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Steps 3 to 5, `/returns/:year/:personId/{income,deductions,credits}`: one part of the open return, built from the
// questions of that module in the year's rules (questions.yaml). "On your return" holds what the person has: a kind of
// income or expense shown by a slip (the slips found, each opening into its boxes to change; a yes without one is
// missing, to upload right there), an amount to enter, or something the app doesn't handle yet (named, never ignored).
// "Add to your return" lists the rest of the module. Saving records what isn't on the return as none (no, or 0).
// "From your slips" shows the module's amounts the slips already claim (rule lines with this `module`).

export type ReturnModule = "income" | "deductions" | "credits";

const MODULE_PAGES: Record<ReturnModule, { title: string; about: string; next: Step }> = {
  income: { title: "Income", about: "What you earned in the year: from work, savings and investments, and anything else.", next: "deductions" },
  deductions: { title: "Deductions", about: "Amounts that lower your taxable income.", next: "credits" },
  credits: { title: "Credits", about: "Amounts that lower the tax on your income.", next: "confirm" },
};

type ItemKind = "slip" | "amount" | "unhandled";
interface Item {
  question: Question;
  kind: ItemKind;
}

const kindOf = (question: Question): ItemKind => (question.type === "money" ? "amount" : question.slip ? "slip" : "unhandled");

export function ModuleStep({ module }: { module: ReturnModule }) {
  const { year } = useYear();
  const estimate = useEstimate();
  const slips = useSlips();
  // Kept here, as the form below starts again whenever the year changes (a slip saved, say).
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <StepLayout step={module} title={MODULE_PAGES[module].title}>
      <p className="-mt-3 text-sm text-muted-foreground">{MODULE_PAGES[module].about}</p>
      <ResourceView resource={estimate}>
        {(answers) => (
          <ResourceView resource={slips}>
            {(slipList) => <ModuleForm key={year.revision} module={module} estimate={answers} slips={slipList} open={open} onToggle={toggle} />}
          </ResourceView>
        )}
      </ResourceView>
    </StepLayout>
  );
}

function ModuleForm({
  module,
  estimate,
  slips,
  open,
  onToggle,
}: {
  module: ReturnModule;
  estimate: Estimate;
  slips: SlipList;
  open: ReadonlySet<string>;
  onToggle: (slipId: string) => void;
}) {
  const me = useMe();
  const navigate = useNavigate();
  const { year, replace, reload } = useYear();
  const { person } = useReturn();
  const editable = canPrepare(me);
  const rules = rulesFor(year.year)!;
  const given = estimate.input.answers[person.id] ?? {};
  const result = estimate.result.people.find((each) => each.personId === person.id);
  const reached = new Set(result?.questions ?? []);
  const slipsOf = (type: string) => slips.slips.filter((slip) => slip.personId === person.id && slip.type === type);
  // An amount is asked only when the return reads it (tuition to transfer needs a T2202 and a spouse), or was entered.
  const items: Item[] = [...rules.questions.values()]
    .filter((question) => question.module === module)
    .filter((question) => question.type !== "money" || reached.has(question.id) || question.id in given)
    .map((question) => ({ question, kind: kindOf(question) }));

  const [added, setAdded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      items.map(({ question, kind }) => {
        const answer = given[question.id];
        if (kind === "slip") return [question.id, slipsOf(question.slip!).length > 0 || answer === true];
        if (kind === "amount") return [question.id, typeof answer === "string" && Number(answer) !== 0];
        return [question.id, answer === true];
      }),
    ),
  );
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.filter((item) => item.kind === "amount").map(({ question }) => [question.id, typeof given[question.id] === "string" && Number(given[question.id]) !== 0 ? (given[question.id] as string) : ""])),
  );
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });

  /** Every item of the module: on the return or not (none). A kind of income its slips already show isn't asked. */
  const answersToSave = () => ({
    [person.id]: Object.fromEntries(
      items.flatMap(({ question, kind }): [string, string | boolean][] => {
        if (kind === "slip") return slipsOf(question.slip!).length > 0 ? [] : [[question.id, added[question.id] === true]];
        if (kind === "amount") return [[question.id, added[question.id] ? cleanAmount(amounts[question.id] ?? "") || "0" : "0"]];
        return [[question.id, added[question.id] === true]];
      }),
    ),
  });

  async function save(thenContinue: boolean) {
    setState({ status: "saving" });
    try {
      const saved = await saveAnswersFor(year, answersToSave());
      replace(saved);
      if (thenContinue) navigate(stepPath(year.year, person.id, MODULE_PAGES[module].next));
      else setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  /** Uploads a slip into this return after saving the module so far, so nothing chosen here is lost. */
  async function upload(file: File) {
    const type = uploadType(file);
    if (!type) {
      setState({ status: "error", error: new ApiError(400, "validation_failed", `${file.name} isn't a PDF, PNG or JPEG.`) });
      return;
    }
    setState({ status: "saving" });
    try {
      const saved = await saveAnswersFor(year, answersToSave());
      const uploaded = await uploadFile(year.year, person.id, file, type);
      replace(uploaded.year.revision > saved.revision ? uploaded.year : saved);
      if (uploaded.status !== "read") setState({ status: "error", error: new ApiError(400, "validation_failed", `${file.name}: ${uploaded.message}`) });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  /** Saves a change to a slip after the module so far. */
  const saveSlip = (slip: Slip) => async (change: SlipChange) => {
    const saved = await saveAnswersFor(year, answersToSave());
    return apiRequest(routes.updateSlip, { params: { year: year.year, id: slip.id }, body: { revision: saved.revision, ...change } });
  };

  const onReturn = items.filter((item) => added[item.question.id]);
  const toAdd = items.filter((item) => !added[item.question.id]);
  const missing = onReturn.filter((item) => item.kind === "slip" && slipsOf(item.question.slip!).length === 0).map((item) => item.question.slip!);
  const issues = state.status === "error" && state.error instanceof ApiError ? (state.error.body?.error.issues ?? []) : [];
  const stale = state.status === "error" && state.error instanceof ApiError && state.error.status === 409;
  const busy = state.status === "saving";

  return (
    <>
      {missing.length > 0 ? (
        <Banner kind="warning" title="Still missing">
          {missing.map((type) => `the ${type}`).join(", ")}. Upload each one below, or type it in at Confirm.
        </Banner>
      ) : null}
      <section aria-label="On your return" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">On your return</h2>
        {onReturn.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet. Add what you have below.</p> : null}
        {onReturn.map(({ question, kind }) => (
          <ItemCard
            key={question.id}
            question={question}
            kind={kind}
            editable={editable}
            onRemove={kind === "slip" && slipsOf(question.slip!).length > 0 ? undefined : () => setAdded((current) => ({ ...current, [question.id]: false }))}
          >
            {kind === "slip" ? (
              <SlipItem
                type={question.slip!}
                slips={slipsOf(question.slip!)}
                question={question}
                open={open}
                onToggle={onToggle}
                editable={editable}
                busy={busy}
                onFile={(file) => void upload(file)}
                saveSlip={saveSlip}
              />
            ) : kind === "amount" ? (
              <AmountField
                label={question.ask}
                labelHidden
                value={amounts[question.id] ?? ""}
                disabled={!editable}
                issue={issues.find((issue) => issue.path === `answers.${question.id}`)?.message}
                onChange={(value) => setAmounts((current) => ({ ...current, [question.id]: value }))}
              />
            ) : (
              <p className="text-sm text-amber-700 dark:text-amber-400">This app doesn't handle this yet, so the result leaves it out. Prepare this part of the return another way.</p>
            )}
          </ItemCard>
        ))}
      </section>

      {editable && toAdd.length > 0 ? (
        <section aria-label="Add to your return" className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Add to your return</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {toAdd.map(({ question, kind }) => (
              <li key={question.id}>
                <button
                  type="button"
                  className="flex h-full w-full items-start gap-3 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
                  onClick={() => setAdded((current) => ({ ...current, [question.id]: true }))}
                  aria-label={`Add ${question.ask}`}
                >
                  <Plus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {question.ask}
                      {kind === "unhandled" ? <Badge variant="outline">Not handled yet</Badge> : null}
                    </span>
                    {question.help ? <span className="text-xs text-muted-foreground">{question.help}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <FromYourSlips module={module} estimate={estimate} />

      {stale ? (
        <Banner kind="error" title="Someone else changed this year" action={<Button variant="outline" size="sm" onClick={reload}>Reload</Button>}>
          {describeError(state.error)}
        </Banner>
      ) : state.status === "error" && issues.length === 0 ? (
        <Banner kind="error" title="That didn't work">{describeError(state.error)}</Banner>
      ) : null}
      {editable ? (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void save(false)} disabled={busy}>
            Save
          </Button>
          <Button onClick={() => void save(true)} disabled={busy || missing.length > 0}>
            {busy ? "Saving…" : "Save and continue"}
          </Button>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button asChild>
            <Link to={stepPath(year.year, person.id, MODULE_PAGES[module].next)}>Next</Link>
          </Button>
        </div>
      )}
    </>
  );
}

/** One thing on the return: its name, what it is, and what it holds. */
function ItemCard({ question, kind, editable, onRemove, children }: { question: Question; kind: ItemKind; editable: boolean; onRemove?: () => void; children: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <CardTitle>
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {question.ask}
              {kind === "slip" ? <Badge variant="secondary">{question.slip}</Badge> : null}
              {kind === "unhandled" ? <Badge variant="outline">Not handled yet</Badge> : null}
            </h3>
          </CardTitle>
          {question.help ? <p className="text-xs text-muted-foreground">{question.help}</p> : null}
        </div>
        {editable && onRemove ? (
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${question.ask}`}>
            Remove
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** A kind of income or expense shown by a slip: the slips found, each opening into its boxes, or the slip missing. */
function SlipItem({
  type,
  slips,
  question,
  open,
  onToggle,
  editable,
  busy,
  onFile,
  saveSlip,
}: {
  type: string;
  slips: Slip[];
  question: Question;
  open: ReadonlySet<string>;
  onToggle: (slipId: string) => void;
  editable: boolean;
  busy: boolean;
  onFile: (file: File) => void;
  saveSlip: (slip: Slip) => (change: SlipChange) => ReturnType<typeof saveAnswersFor>;
}) {
  const { year } = useYear();
  const { person } = useReturn();
  return (
    <div className="flex flex-col gap-2">
      {slips.length > 0 ? (
        <ul className="flex flex-col divide-y" aria-label={`${question.ask} slips`}>
          {slips.map((slip) => (
            <FoundSlip key={slip.id} slip={slip} open={open.has(slip.id)} onToggle={() => onToggle(slip.id)} editable={editable} save={saveSlip(slip)} />
          ))}
        </ul>
      ) : (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Missing: the {type}</p>
      )}
      {editable ? (
        <div className="flex flex-wrap items-center gap-3">
          <UploadSlip label={slips.length > 0 ? `Upload another ${type}` : `Upload the ${type}`} busy={busy} onFile={onFile} />
          <Link className="text-xs underline underline-offset-2" to={stepPath(year.year, person.id, "confirm")}>
            Type it in instead
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** A slip found: who issued it and its state; opened, its boxes as read, to change (it goes back to unconfirmed when changed). */
function FoundSlip({ slip, open, onToggle, editable, save }: { slip: Slip; open: boolean; onToggle: () => void; editable: boolean; save: (change: SlipChange) => ReturnType<typeof saveAnswersFor> }) {
  const { year } = useYear();
  const panel = useId();
  const slipType = rulesFor(year.year)!.slips.get(slip.type)!;
  const confirmed = slip.status === "confirmed";
  return (
    <li className="py-1 text-sm">
      <button type="button" className="flex w-full items-center gap-2 rounded-md py-1.5 text-left hover:bg-muted/50" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {slip.type} from {slip.issuer}
        </span>
        <Badge variant={confirmed ? "secondary" : "outline"}>{confirmed ? "Confirmed" : "To confirm"}</Badge>
      </button>
      {open ? (
        <div id={panel} className="flex flex-col gap-3 pt-2 pb-3 pl-6">
          {editable ? <SlipForm personId={slip.personId} slip={slip} save={save} inline /> : <SlipBoxTable slipType={slipType} boxes={slip.boxes} unsure={confirmed ? [] : slip.unsure} />}
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

function UploadSlip({ label, busy, onFile }: { label: string; busy: boolean; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy}>
        <FileUp aria-hidden="true" />
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        className="hidden"
        aria-label={label}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
    </>
  );
}

/** The module's amounts the slips already claim (rule lines with this `module`), when not zero. */
function FromYourSlips({ module, estimate }: { module: ReturnModule; estimate: Estimate }) {
  const { person } = useReturn();
  const rules = rulesFor(estimate.input.year)!;
  const evaluation = useMemo(() => new Evaluation(rules, estimate.input), [rules, estimate.input]);
  if (!estimate.result.people.some((each) => each.personId === person.id)) return null;
  const lines = [...rules.lines.values()]
    .filter((line) => line.module === module)
    .map((line) => ({ line, value: evaluation.explain(person.id, `line.${line.id}`).value }))
    .filter(({ value }) => value !== null && Number(value) !== 0);
  if (lines.length === 0) return null;
  return (
    <section aria-label="From your slips" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">From your slips</h2>
      <p className="text-xs text-muted-foreground">Already on the return from the boxes of your slips. Change them on the slips.</p>
      <ul className="flex flex-col divide-y rounded-lg border bg-card px-3">
        {lines.map(({ line, value }) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
            <span className="min-w-0">
              {line.label}
              {line.source ? <span className="block text-xs text-muted-foreground">{line.source}</span> : null}
            </span>
            <span className="tabular-nums">{formatMoney(value!)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
