import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRight, FileUp, PencilLine, Plus } from "lucide-react";
import { canPrepare, isAsked, leftInModule, type Estimate, type Slip, type SlipList, type Step, type TaxYear } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { cn } from "@/lib/utils.ts";
import { ApiError, describeError, fieldIssues } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { AmountField, cleanAmount } from "../components/AmountField.tsx";
import { Banner, RefusedBanner, ResourceView } from "../components/Feedback.tsx";
import { OriginalFile, SlipBoxTable, SlipForm, type SlipFormHost, type SlipValues } from "../components/SlipForm.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, useReturn, useYear } from "../components/YearFrame.tsx";
import { formatMoney } from "../lib/format.ts";
import { saveAnswersFor } from "../lib/saveAnswers.ts";
import { uploadFile, uploadType } from "../lib/upload.ts";
import { useEstimate, useSlips } from "../lib/useYearData.ts";
import { Evaluation } from "../shared/engine/evaluate.ts";
import { documentName, type Question } from "../shared/engine/rules.ts";
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

/** slip: shown by its slips. amount: an amount to enter. group: yes/no, then its parts. fact: yes/no, with a note. */
type ItemKind = "slip" | "amount" | "group" | "fact";
interface Item {
  question: Question;
  kind: ItemKind;
}

const kindOf = (question: Question, parts: Question[]): ItemKind =>
  question.type === "money" ? "amount" : question.slip ? "slip" : parts.length > 0 ? "group" : "fact";

/** A slip form in a card, by its key (`slip:<id>` for a slip's own, `new:<question>` for one adding a slip): its page host. */
type HostOf = (key: string) => SlipFormHost;

/**
 * What was changed in the form and not saved yet: each value with the stored facts it was changed from (`basis`, as
 * JSON). What the form showed isn't compared: it may be worked out (a group shown because its parts are answered) or
 * suggested from documents, and change without anyone changing the answer.
 */
interface Draft {
  added: Record<string, { basis: string; to: boolean }>;
  amounts: Record<string, { basis: string; to: string }>;
}

/**
 * The form's values from what is stored, with the changes not saved put back where the stored facts they were made
 * from are unchanged; a change whose answer was saved otherwise meanwhile gives way to it, and is dropped.
 */
function withDraft<T>(shown: Record<string, T>, changes: Record<string, { basis: string; to: T }>, basisOf: (id: string) => string): Record<string, T> {
  const values = { ...shown };
  for (const [id, change] of Object.entries(changes)) {
    if (id in shown && basisOf(id) === change.basis) values[id] = change.to;
    else delete changes[id];
  }
  return values;
}

/** The draft's entries as a request sends them; each change makes a new entry, so one changed since isn't among them. */
const sentOf = (draft: Draft): Draft => ({ added: { ...draft.added }, amounts: { ...draft.amounts } });

/** Once the answers a request sent are saved, its entries are no longer changes; an entry changed since stays. */
function clearSent(draft: Draft, sent: Draft) {
  for (const [id, entry] of Object.entries(sent.added)) if (draft.added[id] === entry) delete draft.added[id];
  for (const [id, entry] of Object.entries(sent.amounts)) if (draft.amounts[id] === entry) delete draft.amounts[id];
}

type RequestState = { status: "idle" | "working" } | { status: "error"; error: unknown };

/** The module's request, held by ModuleStep: the form below starts again whenever the year changes, the request goes on. */
interface Requests {
  state: RequestState;
  /** The fields changed since the last request started (`answers.<question>`): a refusal no longer shows at them. */
  edited: ReadonlySet<string>;
  edit: (path: string) => void;
  /**
   * Runs one request, which may make several calls; the form is locked until it ends. `answered` keeps the year each
   * call answered with: the last one is applied when the request ends, even if a later call failed, so the next save
   * isn't refused as stale. With `thenNext`, a request that succeeded goes on to the next step. Answers whether every
   * call succeeded.
   */
  run: (calls: (answered: (year: TaxYear) => TaxYear) => Promise<void>, options?: { thenNext?: boolean }) => Promise<boolean>;
  /** A request refused before it was sent. */
  fail: (error: unknown) => void;
  /** Loads the year again, and clears what the last request said. */
  reload: () => void;
}

/** The slip forms in the cards, by key: which cards have one open to add a slip, what each holds, and why its save failed. */
interface SlipForms {
  entering: ReadonlySet<string>;
  setEntering: (question: string, open: boolean) => void;
  values: Record<string, SlipValues>;
  errors: Record<string, unknown>;
  /** Keeps a form's values; undefined forgets them and its error. */
  keep: (key: string, values: SlipValues | undefined) => void;
  fail: (key: string, error: unknown) => void;
}

export function ModuleStep({ module }: { module: ReturnModule }) {
  const { year, replace, reload } = useYear();
  const { person } = useReturn();
  const navigate = useNavigate();
  const estimate = useEstimate();
  const slips = useSlips();
  // Kept here, as the form below starts again whenever the year changes (a slip saved, or an upload finishing on another
  // step): which slips are open, what was changed and not saved yet, the request running or how the last one ended,
  // and what an upload in a card said. This step is mounted once per return and module, so each has its own.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const draft = useRef<Draft>({ added: {}, amounts: {} });
  const [note, setNote] = useState<string | null>(null);
  const [request, setRequest] = useState<RequestState>({ status: "idle" });
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());
  const slipValues = useRef<Record<string, SlipValues>>({});
  const [slipErrors, setSlipErrors] = useState<Record<string, unknown>>({});
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set());
  const slipForms: SlipForms = {
    entering,
    setEntering: (question, open) =>
      setEntering((current) => {
        const next = new Set(current);
        if (open) next.add(question);
        else next.delete(question);
        return next;
      }),
    values: slipValues.current,
    errors: slipErrors,
    keep(key, values) {
      if (values) {
        slipValues.current[key] = values;
        return;
      }
      delete slipValues.current[key];
      setSlipErrors(({ [key]: _forgotten, ...others }) => others);
    },
    fail: (key, error) => setSlipErrors((current) => ({ ...current, [key]: error })),
  };
  const requests: Requests = {
    state: request,
    edited,
    edit: (path) => setEdited((current) => (current.has(path) ? current : new Set(current).add(path))),
    async run(calls, { thenNext = false } = {}) {
      const last: { year: TaxYear | null } = { year: null };
      setRequest({ status: "working" });
      setEdited(new Set());
      setNote(null);
      try {
        await calls((answered) => (last.year = answered));
        setRequest({ status: "idle" });
        if (last.year) replace(last.year);
        if (thenNext) navigate(stepPath(year.year, person.id, MODULE_PAGES[module].next));
        return true;
      } catch (error) {
        setRequest({ status: "error", error });
        if (last.year) replace(last.year);
        return false;
      }
    },
    fail: (error) => setRequest({ status: "error", error }),
    reload() {
      setRequest({ status: "idle" });
      reload();
    },
  };
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
            {(slipList) => (
              <ModuleForm
                key={year.revision}
                module={module}
                estimate={answers}
                slips={slipList}
                open={open}
                onToggle={toggle}
                draft={draft.current}
                requests={requests}
                slipForms={slipForms}
                note={note}
                onNote={setNote}
              />
            )}
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
  draft,
  requests,
  slipForms,
  note,
  onNote,
}: {
  module: ReturnModule;
  estimate: Estimate;
  slips: SlipList;
  open: ReadonlySet<string>;
  onToggle: (slipId: string) => void;
  draft: Draft;
  requests: Requests;
  slipForms: SlipForms;
  /** What the last upload in a card said, when its file wasn't read into slips. */
  note: string | null;
  onNote: (note: string | null) => void;
}) {
  const me = useMe();
  const { year } = useYear();
  const { person } = useReturn();
  const editable = canPrepare(me);
  const rules = rulesFor(year.year)!;
  const given = estimate.input.answers[person.id] ?? {};
  const result = estimate.result.people.find((each) => each.personId === person.id);
  const reached = new Set(result?.questions ?? []);
  const slipsOf = (type: string) => slips.slips.filter((slip) => slip.personId === person.id && slip.type === type);
  const evaluation = useMemo(() => new Evaluation(rules, estimate.input), [rules, estimate.input]);
  /** A starting amount the rules work out from documents (receipts, a notice of assessment), when there is one. */
  const suggestionOf = (question: Question): string | null => {
    if (!question.suggest || !result) return null;
    const value = evaluation.line(person.id, question.suggest).value;
    return value && !value.isZero() ? value.toString() : null;
  };
  const receiptsOf = (question: Question) => (question.receipts ? slipsOf(question.receipts) : []);
  const partsOf = (question: Question) => [...rules.questions.values()].filter((part) => part.parent === question.id);
  const items: Item[] = [...rules.questions.values()]
    .filter((question) => question.module === module && question.parent === undefined)
    .filter((question) => isAsked(question, reached, question.id in given))
    .map((question) => ({ question, kind: kindOf(question, partsOf(question)) }));
  const parts = items.filter((item) => item.kind === "group").flatMap((item) => partsOf(item.question));

  const [shown] = useState(() => ({
    added: Object.fromEntries(
      items.map(({ question, kind }) => {
        const answer = given[question.id];
        if (kind === "slip") return [question.id, slipsOf(question.slip!).length > 0 || answer === true];
        if (kind === "amount") return [question.id, (typeof answer === "string" && Number(answer) !== 0) || receiptsOf(question).length > 0 || (answer === undefined && suggestionOf(question) !== null)];
        return [question.id, answer === true];
      }),
    ) as Record<string, boolean>,
    amounts: Object.fromEntries([
      ...items
        .filter((item) => item.kind === "amount")
        .map(({ question }) => {
          const answer = given[question.id];
          // Not answered yet: start from what the documents show.
          if (answer === undefined) return [question.id, suggestionOf(question) ?? ""];
          return [question.id, typeof answer === "string" && Number(answer) !== 0 ? answer : ""];
        }),
      // A group's parts: an amount or percent as entered (0 shown empty), a choice as chosen.
      ...parts.map((part) => {
        const answer = given[part.id];
        if (typeof answer !== "string") return [part.id, ""];
        return [part.id, part.type === "choice" || Number(answer) !== 0 ? answer : ""];
      }),
    ]) as Record<string, string>,
  }));
  /** What an item's place on the return rests on: its answer, a group's parts' answers, and the slips or receipts showing it. */
  const addedBasis = (id: string) => {
    const item = items.find((each) => each.question.id === id);
    if (!item) return "";
    const { question, kind } = item;
    const parts = kind === "group" ? partsOf(question).map((part) => given[part.id] ?? null) : [];
    return JSON.stringify([given[id] ?? null, ...parts, kind === "slip" ? slipsOf(question.slip!).length : receiptsOf(question).length]);
  };
  /** An amount rests on its answer alone: a starting amount suggested from documents isn't one. */
  const amountBasis = (id: string) => JSON.stringify(given[id] ?? null);
  const [added, setAdded] = useState(() => withDraft(shown.added, draft.added, addedBasis));
  const [amounts, setAmounts] = useState(() => withDraft(shown.amounts, draft.amounts, amountBasis));
  const setAddedOf = (id: string, value: boolean) => {
    setAdded((current) => ({ ...current, [id]: value }));
    draft.added[id] = { basis: addedBasis(id), to: value };
    requests.edit(`answers.${id}`);
  };
  const setAmountOf = (id: string, value: string) => {
    setAmounts((current) => ({ ...current, [id]: value }));
    draft.amounts[id] = { basis: amountBasis(id), to: value };
    requests.edit(`answers.${id}`);
  };
  /** A group's parts that apply: one asked only for some options of a choice waits for that choice. */
  const shownPartsOf = (question: Question) =>
    partsOf(question).filter((part) => !part.askedWhen || part.askedWhen.options.includes(amounts[part.askedWhen.question] ?? ""));

  /** Every item of the module: on the return or not (none). A kind of income its slips already show isn't asked. */
  const answersToSave = () => ({
    [person.id]: Object.fromEntries(
      items.flatMap(({ question, kind }): [string, string | boolean][] => {
        if (kind === "slip") return slipsOf(question.slip!).length > 0 ? [] : [[question.id, added[question.id] === true]];
        if (kind === "amount") return [[question.id, added[question.id] ? cleanAmount(amounts[question.id] ?? "") || "0" : "0"]];
        if (kind === "group" && added[question.id]) {
          // Its parts are saved with it; a choice not made is left unanswered, so the step says so. A part that doesn't
          // apply to the choice made isn't saved: the rules don't read it.
          return [
            [question.id, true],
            ...shownPartsOf(question).flatMap((part): [string, string][] => {
              const value = amounts[part.id] ?? "";
              if (part.type === "choice") return value ? [[part.id, value]] : [];
              return [[part.id, cleanAmount(value) || "0"]];
            }),
          ];
        }
        return [[question.id, added[question.id] === true]];
      }),
    ),
  });

  async function save(thenContinue: boolean) {
    const answers = answersToSave();
    const sent = sentOf(draft);
    await requests.run(
      async (answered) => {
        answered(await saveAnswersFor(year, answers));
        clearSent(draft, sent);
      },
      { thenNext: thenContinue },
    );
  }

  /** Uploads a slip into this return after saving the module so far, so nothing chosen here is lost. */
  async function upload(file: File) {
    const type = uploadType(file);
    if (!type) {
      requests.fail(new ApiError(400, "validation_failed", `${file.name} isn't a PDF, PNG or JPEG.`));
      return;
    }
    const answers = answersToSave();
    const sent = sentOf(draft);
    await requests.run(async (answered) => {
      const saved = answered(await saveAnswersFor(year, answers));
      clearSent(draft, sent);
      const uploaded = await uploadFile(year.year, person.id, file, type);
      // Said above this form, which starts again with the year it answered with.
      if (uploaded.status !== "read") onNote(`${file.name}: ${uploaded.message}`);
      if (uploaded.year.revision > saved.revision) answered(uploaded.year);
    });
  }

  /**
   * A slip added or changed in a card (its form's host): the slip first, then the module so far, so nothing chosen here
   * is lost. A slip refused changes nothing: its form shows why, and keeps what was typed, even if it started again
   * meanwhile.
   */
  async function saveSlip(key: string, send: (revision: number) => Promise<TaxYear>): Promise<boolean> {
    const answers = answersToSave();
    const sent = sentOf(draft);
    const outcome = { refused: false };
    slipForms.fail(key, null);
    const saved = await requests.run(async (answered) => {
      let withSlip: TaxYear;
      try {
        withSlip = answered(await send(year.revision));
      } catch (error) {
        outcome.refused = true;
        slipForms.fail(key, error);
        return;
      }
      slipForms.keep(key, undefined);
      answered(await saveAnswersFor(withSlip, answers));
      clearSent(draft, sent);
    });
    return saved && !outcome.refused;
  }

  const onReturn = items.filter((item) => added[item.question.id]);
  const toAdd = items.filter((item) => !added[item.question.id]);
  const missing = onReturn.filter((item) => item.kind === "slip" && slipsOf(item.question.slip!).length === 0).map((item) => item.question.slip!);
  const error = requests.state.status === "error" ? requests.state.error : null;
  const stale = error instanceof ApiError && error.status === 409;
  const busy = requests.state.status === "working";
  const hostOf: HostOf = (key) => ({
    save: (send) => saveSlip(key, send),
    values: slipForms.values[key],
    onValues: (values) => slipForms.keep(key, values),
    error: slipForms.errors[key] ?? null,
    busy,
  });
  // The issues shown beside their field (an amount, a group's part, on the return); the banner says the others.
  const fields = new Set(
    onReturn.flatMap(({ question, kind }) => (kind === "amount" ? [question.id] : kind === "group" ? partsOf(question).map((part) => part.id) : [])).map((id) => `answers.${id}`),
  );
  const { issueFor, unshown, inBanner } = fieldIssues(error, (path) => fields.has(path), requests.edited);
  // What keeps this step from done, as saved (the step's state in the row of steps says the same).
  const left = leftInModule(rules, module, given, slips.slips.filter((slip) => slip.personId === person.id), result?.questions ?? []);
  const unanswered = left.filter((item) => item.reason === "unanswered");
  const waiting = left.filter((item) => item.reason === "slip");

  return (
    <>
      {left.length > 0 ? (
        <Banner kind="info" title="To finish this step">
          <span className="flex flex-col gap-1">
            {unanswered.length > 0 ? (
              <span>
                Not answered yet: {unanswered.map((item) => item.ask).join(", ")}.{" "}
                {editable ? "Add what applies below, then choose Save and continue: what you don't add is saved as none." : null}
              </span>
            ) : null}
            {waiting.length > 0 ? (
              <span>Waiting for a slip: {waiting.map((item) => `the ${slipName(year.year, item.slip!)} (${item.ask})`).join(", ")}. Upload or enter it below, or remove the item.</span>
            ) : null}
          </span>
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
            busy={busy}
            onRemove={
              (kind === "slip" && slipsOf(question.slip!).length > 0) || receiptsOf(question).length > 0 ? undefined : () => setAddedOf(question.id, false)
            }
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
                hostOf={hostOf}
                entering={slipForms.entering.has(question.id)}
                onEntering={(open) => slipForms.setEntering(question.id, open)}
              />
            ) : kind === "amount" ? (
              <AmountItem
                question={question}
                receipts={receiptsOf(question)}
                suggestion={suggestionOf(question)}
                value={amounts[question.id] ?? ""}
                editable={editable}
                busy={busy}
                issue={issueFor(`answers.${question.id}`)}
                onChange={(value) => setAmountOf(question.id, value)}
                open={open}
                onToggle={onToggle}
                onFile={(file) => void upload(file)}
                hostOf={hostOf}
                entering={slipForms.entering.has(question.id)}
                onEntering={(open) => slipForms.setEntering(question.id, open)}
              />
            ) : kind === "group" ? (
              <div className="flex flex-col gap-4">
                {shownPartsOf(question).map((part) =>
                  part.type === "choice" ? (
                    <ChoiceField
                      key={part.id}
                      question={part}
                      value={amounts[part.id] ?? ""}
                      disabled={!editable || busy}
                      issue={issueFor(`answers.${part.id}`)}
                      onChange={(value) => setAmountOf(part.id, value)}
                    />
                  ) : part.receipts ? (
                    <div key={part.id} className="flex flex-col gap-1">
                      <p className="text-sm font-medium">{part.ask}</p>
                      {part.help ? <p className="text-xs text-muted-foreground">{part.help}</p> : null}
                      <AmountItem
                        question={part}
                        receipts={receiptsOf(part)}
                        suggestion={null}
                        value={amounts[part.id] ?? ""}
                        editable={editable}
                        busy={busy}
                        issue={issueFor(`answers.${part.id}`)}
                        onChange={(value) => setAmountOf(part.id, value)}
                        open={open}
                        onToggle={onToggle}
                        onFile={(file) => void upload(file)}
                        hostOf={hostOf}
                        entering={slipForms.entering.has(part.id)}
                        onEntering={(open) => slipForms.setEntering(part.id, open)}
                      />
                    </div>
                  ) : (
                    <AmountField
                      key={part.id}
                      label={part.ask}
                      help={part.help}
                      unit={part.type === "percent" ? "%" : part.type === "count" ? "" : "$"}
                      max={part.max}
                      value={amounts[part.id] ?? ""}
                      disabled={!editable || busy}
                      issue={issueFor(`answers.${part.id}`)}
                      onChange={(value) => setAmountOf(part.id, value)}
                    />
                  ),
                )}
              </div>
            ) : question.note ? (
              <p className="text-sm text-muted-foreground">{question.note}</p>
            ) : null}
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
                  className="flex h-full w-full items-start gap-3 rounded-lg border bg-card p-3 text-left hover:bg-muted/50 disabled:opacity-50"
                  onClick={() => setAddedOf(question.id, true)}
                  disabled={busy}
                  aria-label={`Add ${question.ask}`}
                >
                  <Plus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {question.ask}
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
        <Banner kind="error" title="Someone else changed this year" action={<Button variant="outline" size="sm" onClick={requests.reload}>Reload</Button>}>
          {describeError(error)}
        </Banner>
      ) : inBanner ? (
        <RefusedBanner title="That didn't work" error={error} unshown={unshown} />
      ) : note ? (
        <Banner kind="error" title="That didn't work">{note}</Banner>
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
function ItemCard({
  question,
  kind,
  editable,
  busy,
  onRemove,
  children,
}: {
  question: Question;
  kind: ItemKind;
  editable: boolean;
  busy: boolean;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const { year } = useYear();
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <CardTitle>
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {question.ask}
              {kind === "slip" ? <Badge variant="secondary">{slipName(year.year, question.slip!)}</Badge> : null}
            </h3>
          </CardTitle>
          {question.help ? <p className="text-xs text-muted-foreground">{question.help}</p> : null}
        </div>
        {editable && onRemove ? (
          <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy} aria-label={`Remove ${question.ask}`}>
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
  hostOf,
  entering,
  onEntering,
}: {
  type: string;
  slips: Slip[];
  question: Question;
  open: ReadonlySet<string>;
  onToggle: (slipId: string) => void;
  editable: boolean;
  busy: boolean;
  onFile: (file: File) => void;
  hostOf: HostOf;
  /** Its form to add a slip is open (kept by ModuleStep, like the form's values). */
  entering: boolean;
  onEntering: (open: boolean) => void;
}) {
  const { person } = useReturn();
  const { year } = useYear();
  const name = slipName(year.year, type);
  return (
    <div className="flex flex-col gap-2">
      {slips.length > 0 ? (
        <ul className="flex flex-col divide-y" aria-label={`${question.ask} slips`}>
          {slips.map((slip) => (
            <FoundSlip key={slip.id} slip={slip} open={open.has(slip.id)} onToggle={() => onToggle(slip.id)} editable={editable} hostOf={hostOf} />
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
          No {name} yet. Upload it, or enter its boxes.
        </p>
      )}
      {entering ? (
        <div className="rounded-lg border bg-muted/30 p-4">
          <SlipForm personId={person.id} type={type} host={hostOf(`new:${question.id}`)} onDone={() => onEntering(false)} />
        </div>
      ) : editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <UploadSlip label={slips.length > 0 ? `Upload another ${name}` : `Upload the ${name}`} busy={busy} onFile={onFile} />
          <Button variant="ghost" size="sm" onClick={() => onEntering(true)} disabled={busy}>
            <PencilLine aria-hidden="true" />
            {slips.length > 0 ? `Enter another ${name}` : `Enter the ${name}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A slip found: who issued it and its state; opened, its boxes, to check and change (a changed slip goes back to unconfirmed). */
function FoundSlip({ slip, open, onToggle, editable, hostOf }: { slip: Slip; open: boolean; onToggle: () => void; editable: boolean; hostOf: HostOf }) {
  const { year } = useYear();
  const panel = useId();
  const slipType = rulesFor(year.year)!.slips.get(slip.type)!;
  const confirmed = slip.status === "confirmed";
  return (
    <li className="py-1 text-sm">
      <button type="button" className="flex w-full items-center gap-2 rounded-md py-1.5 text-left hover:bg-muted/50" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span className="min-w-0 flex-1 wrap-anywhere">
          {documentName(slipType, slip.type)} from {slip.issuer}
        </span>
        <Badge variant={confirmed ? "secondary" : "outline"}>{confirmed ? "Confirmed" : "To confirm"}</Badge>
      </button>
      {open ? (
        <div id={panel} className="flex flex-col gap-3 pt-2 pb-3 pl-6">
          {editable ? <SlipForm personId={slip.personId} slip={slip} host={hostOf(`slip:${slip.id}`)} inline /> : <SlipBoxTable slipType={slipType} boxes={slip.boxes} unsure={confirmed ? [] : slip.unsure} />}
          {slip.documentId ? <OriginalFile year={year.year} documentId={slip.documentId} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * An amount on the return, with its receipts when the year's rules name some: each receipt opens into its amounts, and
 * more can be uploaded or entered. Receipts a line adds make the amount entered what isn't on one; receipts that only
 * suggest a starting amount (RRSP, a notice of assessment) show it, to use or change.
 */
function AmountItem({
  question,
  receipts,
  suggestion,
  value,
  editable,
  busy,
  issue,
  onChange,
  open,
  onToggle,
  onFile,
  hostOf,
  entering,
  onEntering,
}: {
  question: Question;
  receipts: Slip[];
  suggestion: string | null;
  value: string;
  editable: boolean;
  busy: boolean;
  issue?: string;
  onChange: (value: string) => void;
  open: ReadonlySet<string>;
  onToggle: (slipId: string) => void;
  onFile: (file: File) => void;
  hostOf: HostOf;
  /** Its form to add a receipt is open (kept by ModuleStep, like the form's values). */
  entering: boolean;
  onEntering: (open: boolean) => void;
}) {
  const { year } = useYear();
  const { person } = useReturn();
  const type = question.receipts ? rulesFor(year.year)!.slips.get(question.receipts)! : null;
  const added = type !== null && question.suggest === undefined;
  // A receipt by its title in lower case ("medical expense receipt"), keeping acronyms (RRSP); a slip by its code (T4FHSA).
  const noun = !type ? "" : type.receipt ? lowerCaseTitle(type.title.replace(/^Official /, "")) : documentName(type, type.id);
  return (
    <div className="flex flex-col gap-3">
      {receipts.length > 0 ? (
        <ul className="flex flex-col divide-y" aria-label={`${question.ask} receipts`}>
          {receipts.map((slip) => (
            <FoundSlip key={slip.id} slip={slip} open={open.has(slip.id)} onToggle={() => onToggle(slip.id)} editable={editable} hostOf={hostOf} />
          ))}
        </ul>
      ) : null}
      {type && editable ? (
        entering ? (
          <div className="rounded-lg border bg-muted/30 p-4">
            <SlipForm personId={person.id} type={type.id} host={hostOf(`new:${question.id}`)} onDone={() => onEntering(false)} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <UploadSlip label={`Upload ${receipts.length > 0 ? "another" : article(noun)} ${noun}`} busy={busy} onFile={onFile} />
            <Button variant="ghost" size="sm" onClick={() => onEntering(true)} disabled={busy}>
              <PencilLine aria-hidden="true" />
              Enter {receipts.length > 0 ? "another" : article(noun)} {noun}
            </Button>
          </div>
        )
      ) : null}
      <AmountField
        label={added ? "Not on an uploaded receipt" : question.ask}
        labelHidden={!added}
        value={value}
        disabled={!editable || busy}
        issue={issue}
        onChange={onChange}
      />
      {suggestion !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          From your documents: {formatMoney(suggestion)}.
          {editable && cleanAmount(value) !== suggestion ? (
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onChange(suggestion)} disabled={busy}>
              Use {formatMoney(suggestion)}
            </Button>
          ) : null}
        </p>
      ) : null}
    </div>
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

/** A choice among a question's options, by their words on screen. */
function ChoiceField({ question, value, disabled, issue, onChange }: { question: Question; value: string; disabled: boolean; issue?: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{question.ask}</Label>
      {question.help ? <p className="text-xs text-muted-foreground">{question.help}</p> : null}
      <NativeSelect id={id} className="w-full max-w-md" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-invalid={issue ? true : undefined}>
        <NativeSelectOption value="">Choose…</NativeSelectOption>
        {question.options!.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {question.optionLabels?.[option] ?? option}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {issue ? <p className="text-xs text-destructive">{issue}</p> : null}
    </div>
  );
}

/** How a slip type is named on screen: T4A(OAS) for T4AOAS. */
function slipName(year: number, type: string): string {
  return rulesFor(year)?.slips.get(type)?.name ?? type;
}

/** A title in lower case, but for its acronyms and codes (RRSP, T2202), which stay as printed. */
function lowerCaseTitle(title: string): string {
  return title
    .split(" ")
    .map((word) => (/^[A-Z0-9()]{2,}$/.test(word) ? word : word.toLowerCase()))
    .join(" ");
}

/** "a" or "an", as the noun is said: an RRSP receipt, a T4FHSA, an official receipt. */
function article(noun: string): string {
  const first = noun.split(" ")[0] ?? "";
  if (/^[A-Z0-9]{2,}/.test(first)) return /^[AEFHILMNORSX]/.test(first) ? "an" : "a";
  return /^[aeiou]/i.test(first) ? "an" : "a";
}
