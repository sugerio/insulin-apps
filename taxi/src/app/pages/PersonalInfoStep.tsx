import { useId, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  PROVINCES,
  SUPPORTED_PROVINCES,
  canPrepare,
  isIssueOf,
  maritalStatusesFor,
  routes,
  type MaritalStatus,
  type Province,
  type TaxYear,
} from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { ApiError, apiRequest, describeError, fieldIssues } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { AmountField, cleanAmount } from "../components/AmountField.tsx";
import { Banner, RefusedBanner } from "../components/Feedback.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, stepsOf, useReturn, useYear } from "../components/YearFrame.tsx";
import { MARITAL_STATUS_LABELS, PROVINCE_LABELS } from "../lib/format.ts";
import { saveAnswersFor } from "../lib/saveAnswers.ts";
import { useEstimate } from "../lib/useYearData.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Step 1, `/returns/:year/:personId/personal`: the facts of the open return that no document tells the app: the
// adult's province and residency, the marital status on December 31, which the year's returns share, and the questions
// about the person the return reads (`module: about`, such as a spouse's net income when their return isn't here). Who is in the
// year is chosen on the Tax years page, and how each person is related on the Profile page. The facts are saved
// together, under the year's revision.

export function PersonalInfoStep() {
  const { year, replace, reload } = useYear();
  const { person } = useReturn();
  const navigate = useNavigate();
  // Kept here, as the facts below start again whenever the year changes (a save, or an upload finishing on another
  // step): what was typed and not saved yet, the save running or how the last one ended, and whether "Save and
  // continue" stopped on something missing. This step is mounted once per return, so each has its own.
  const [draft, setDraft] = useState<FactsDraft>({});
  const [request, setRequest] = useState<RequestState>({ status: "idle" });
  const [showMissing, setShowMissing] = useState(false);
  const requests: Requests = {
    state: request,
    async run(calls, thenContinue) {
      const last: { year: TaxYear | null } = { year: null };
      setRequest({ status: "saving" });
      try {
        await calls((answered) => (last.year = answered));
        setRequest({ status: "idle" });
        if (!last.year) return;
        replace(last.year);
        if (!thenContinue) return;
        if (stepsOf(last.year, person.id)?.personal === "done") navigate(stepPath(year.year, person.id, "upload"));
        else setShowMissing(true);
      } catch (error) {
        setRequest({ status: "error", error });
        if (last.year) replace(last.year);
      }
    },
    reload() {
      setRequest({ status: "idle" });
      reload();
    },
  };
  return (
    <StepLayout step="personal" title="Personal info" aside={<TaxNotes year={year.year} />}>
      {/* A new revision (a save, or someone else's) starts the form again from what is stored. */}
      <YearFacts key={year.revision} draft={draft} onDraft={setDraft} requests={requests} showMissing={showMissing} />
    </StepLayout>
  );
}

/**
 * What was typed and not saved yet, by field (`maritalStatus`, `province`, `residentAllYear`, `answers.<question>`):
 * the value, and the stored value it was typed over. Once that stored value changes (saved, or someone else's change),
 * the stored one shows instead.
 */
type FactsDraft = Record<string, { basis: string; to: string | boolean | null }>;

type RequestState = { status: "idle" | "saving" } | { status: "error"; error: unknown };

/** The step's save, held by PersonalInfoStep: the facts below start again whenever the year changes, the save goes on. */
interface Requests {
  state: RequestState;
  /**
   * Runs the save's calls; the facts are locked until they end. `answered` keeps the year each call answered with: the
   * last one is applied when they end, even if a later call failed, so the next save isn't refused as stale. With
   * `thenContinue`, a save that leaves nothing missing goes on to the next step, and one that does lists what is left.
   */
  run: (calls: (answered: (year: TaxYear) => TaxYear) => Promise<void>, thenContinue: boolean) => Promise<void>;
  /** Loads the year again, and clears what the last save said. */
  reload: () => void;
}

/** What each answer means for the tax. */
function TaxNotes({ year }: { year: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-sm font-semibold">How these answers affect the tax</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>
          <b className="text-foreground">Spouse in the year.</b> Each of you files a return. Prepared together, credits such as donations and
          medical expenses go to whichever of you saves more. The marital status and the people in the year are the same on both returns.
        </p>
        <p>
          <b className="text-foreground">Marital status.</b> The status on December 31 counts. Married and common-law are taxed the same; the T1
          has a box for each. The year of a separation isn't handled yet.
        </p>
        <p>
          <b className="text-foreground">Province.</b> The province on December 31 sets the provincial tax for all of {year}.
        </p>
        <p>
          <b className="text-foreground">Lived in Canada all year.</b> If you moved to or from Canada in {year}, answer No: the app then asks
          for the days you lived here and your income for the rest of the year, and reduces the personal amounts (such as the basic personal
          amount) by the days in Canada, unless at least 90% of that income came from Canada. A Quebec return for the year of a move isn't
          handled yet.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The year's facts

interface AdultDraft {
  province: Province | null;
  residentAllYear: boolean | null;
}

function YearFacts({
  draft,
  onDraft,
  requests,
  showMissing,
}: {
  draft: FactsDraft;
  onDraft: (change: (current: FactsDraft) => FactsDraft) => void;
  requests: Requests;
  showMissing: boolean;
}) {
  const me = useMe();
  const { year } = useYear();
  const { person: owner, adult } = useReturn();
  const editable = canPrepare(me);
  // Locked while it is saved, as a save starts the form again from what it saved.
  const locked = !editable || requests.state.status === "saving";
  const error = requests.state.status === "error" ? requests.state.error : null;
  /** A field's value: what was typed on it while the stored value it was typed over still holds, else the stored one. */
  const valueOf = <T extends string | boolean | null>(key: string, stored: T): T => {
    const change = draft[key];
    return change !== undefined && change.basis === JSON.stringify(stored) ? (change.to as T) : stored;
  };
  const type = (key: string, stored: string | boolean | null, to: string | boolean | null) =>
    onDraft((current) => ({ ...current, [key]: { basis: JSON.stringify(stored), to } }));
  // The spouse or partner in the Profile, in this year or not: it decides which statuses there are to choose from.
  const partner = year.people.find((person) => person.relationship === "spouse");
  const statuses = maritalStatusesFor(partner !== undefined);
  // A status saved before the people in the Profile changed no longer fits: start from none, so a save can't send it back.
  const storedStatus = year.maritalStatus !== null && statuses.includes(year.maritalStatus) ? year.maritalStatus : null;
  const maritalStatus = valueOf<MaritalStatus | null>("maritalStatus", storedStatus);
  const facts: AdultDraft = { province: valueOf("province", adult.province), residentAllYear: valueOf("residentAllYear", adult.residentAllYear) };
  // The questions about this person that the return reads, once the estimate says which.
  const estimate = useEstimate();
  const given = estimate.status === "ready" ? (estimate.data.input.answers[owner.id] ?? {}) : {};
  const reached = new Set(estimate.status === "ready" ? (estimate.data.result.people.find((each) => each.personId === owner.id)?.questions ?? []) : []);
  const about = [...rulesFor(year.year)!.questions.values()].filter((question) => question.module === "about" && (reached.has(question.id) || question.id in given));
  const storedAmount = (id: string) => (typeof given[id] === "string" ? (given[id] as string) : "");
  const amountOf = (id: string) => valueOf(`answers.${id}`, storedAmount(id));
  // A yes/no question (spouseSameDays) is null until answered.
  const storedChoice = (id: string) => (typeof given[id] === "boolean" ? (given[id] as boolean) : null);
  const choiceOf = (id: string) => valueOf<boolean | null>(`answers.${id}`, storedChoice(id));
  const answerOf = (question: (typeof about)[number]) => (question.type === "boolean" ? choiceOf(question.id) : cleanAmount(amountOf(question.id)));
  const unanswered = about.filter((question) => answerOf(question) === null || answerOf(question) === "");
  // The spouse's questions (spouseNetIncome and the like) are asked under the spouse; the others are about where this
  // person lived.
  const spouseQuestions = about.filter((question) => question.id.startsWith("spouse"));
  const fields = new Set(about.map((question) => `answers.${question.id}`));
  const { issueFor, unshown, inBanner } = fieldIssues(error, (path) => fields.has(path));
  const field = (question: (typeof about)[number]) =>
    question.type === "boolean" ? (
      <YesNoField
        key={question.id}
        label={question.ask}
        help={question.help}
        value={choiceOf(question.id)}
        disabled={locked}
        issue={issueFor(`answers.${question.id}`)}
        onChange={(value) => type(`answers.${question.id}`, storedChoice(question.id), value)}
      />
    ) : (
      <AmountField
        key={question.id}
        label={question.ask}
        help={question.help}
        unit={question.type === "count" ? "" : "$"}
        max={question.max}
        value={amountOf(question.id)}
        disabled={locked}
        issue={issueFor(`answers.${question.id}`)}
        onChange={(value) => type(`answers.${question.id}`, storedAmount(question.id), value)}
      />
    );

  async function save(thenContinue: boolean) {
    const sent = draft;
    const answers = Object.fromEntries(
      about.map((question) => [question.id, answerOf(question)] as const).filter((entry): entry is readonly [string, string | boolean] => entry[1] !== null && entry[1] !== ""),
    );
    await requests.run(async (answered) => {
      const saved = answered(
        await apiRequest(routes.savePersonalInfo, { params: { year: year.year }, body: { revision: year.revision, maritalStatus, adults: [{ personId: owner.id, ...facts }] } }),
      );
      answered(await saveAnswersFor(saved, { [owner.id]: answers }));
      // What this save sent is stored now, so it is no longer a change.
      onDraft((current) => Object.fromEntries(Object.entries(current).filter(([key, entry]) => sent[key] !== entry)));
    }, thenContinue);
  }

  const stale = error instanceof ApiError && error.status === 409;
  // This return's issues: its adult's, and those of the facts the year's returns share.
  const issues = year.issues.filter((issue) => isIssueOf(issue, owner.id));
  const blocking = issues.filter((issue) => issue.kind === "blocking");
  const unsupported = issues.filter((issue) => issue.kind === "unsupported");

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold" id="marital-status">
              Marital status on December 31, {year.year}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <RadioGroup
            aria-labelledby="marital-status"
            value={maritalStatus ?? ""}
            onValueChange={(value) => type("maritalStatus", storedStatus, value)}
            disabled={locked}
            className={partner ? "grid gap-2 sm:grid-cols-2" : "grid gap-2 sm:grid-cols-4"}
          >
            {statuses.map((status) => (
              <Choice key={status} value={status} label={MARITAL_STATUS_LABELS[status]} />
            ))}
          </RadioGroup>
          {partner ? null : (
            <Link to={`/profile?back=${encodeURIComponent(stepPath(year.year, owner.id, "personal"))}`} className="text-sm underline underline-offset-2">
              Add a spouse or partner
            </Link>
          )}
        </CardContent>
      </Card>

      <AdultCard
        draft={facts}
        editable={!locked}
        onChange={(change) => {
          if (change.province !== undefined) type("province", adult.province, change.province);
          if (change.residentAllYear !== undefined) type("residentAllYear", adult.residentAllYear, change.residentAllYear);
        }}
      >
        {about.filter((question) => !spouseQuestions.includes(question)).map(field)}
      </AdultCard>

      {spouseQuestions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">Your spouse or partner</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">{spouseQuestions.map(field)}</CardContent>
        </Card>
      ) : null}

      {unsupported.map((issue) => (
        <Banner key={`${issue.code}-${issue.personId ?? ""}`} kind="warning" title="Not handled by this app">
          {issue.message}
        </Banner>
      ))}
      {stale ? (
        <Banner kind="error" title="Someone else changed this year" action={<Button variant="outline" size="sm" onClick={requests.reload}>Reload</Button>}>
          {describeError(error)}
        </Banner>
      ) : inBanner ? (
        <RefusedBanner title="Your personal info wasn't saved" error={error} unshown={unshown} />
      ) : null}

      {showMissing && blocking.length + unanswered.length > 0 ? (
        <Banner kind="error" title="Fill these in to continue">
          <ul className="list-disc pl-5">
            {blocking.map((issue) => (
              <li key={`${issue.code}-${issue.personId ?? ""}`}>{issue.message}</li>
            ))}
            {unanswered.map((question) => (
              <li key={question.id}>{question.ask}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <div className="flex justify-end">
        {editable ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void save(false)} disabled={locked}>
              Save
            </Button>
            <Button onClick={() => void save(true)} disabled={locked}>
              {requests.state.status === "saving" ? "Saving…" : "Save and continue"}
            </Button>
          </div>
        ) : (
          <Button asChild variant="outline">
            <Link to={stepPath(year.year, owner.id, "upload")}>Next step</Link>
          </Button>
        )}
      </div>
    </>
  );
}

/** The province and residency, then `children`: the questions for someone who didn't live in Canada all year. */
function AdultCard({
  draft,
  editable,
  onChange,
  children,
}: {
  draft: AdultDraft;
  editable: boolean;
  onChange: (change: Partial<AdultDraft>) => void;
  children: ReactNode;
}) {
  const id = useId();
  const others = PROVINCES.filter((province) => !SUPPORTED_PROVINCES.includes(province));
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Where you lived</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-province`}>Province on December 31</Label>
          <NativeSelect
            id={`${id}-province`}
            value={draft.province ?? ""}
            onChange={(event) => onChange({ province: (event.target.value || null) as Province | null })}
            disabled={!editable}
          >
            <NativeSelectOption value="">Choose…</NativeSelectOption>
            {SUPPORTED_PROVINCES.map((province) => (
              <NativeSelectOption key={province} value={province}>
                {PROVINCE_LABELS[province]}
              </NativeSelectOption>
            ))}
            {others.length > 0 ? (
              <NativeSelectOptGroup label="Not handled by this app yet">
                {others.map((province) => (
                  <NativeSelectOption key={province} value={province}>
                    {PROVINCE_LABELS[province]}
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            ) : null}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium" id={`${id}-resident`}>
            Lived in Canada all year?
          </p>
          <RadioGroup
            aria-labelledby={`${id}-resident`}
            value={draft.residentAllYear === null ? "" : draft.residentAllYear ? "yes" : "no"}
            onValueChange={(value) => onChange({ residentAllYear: value === "yes" })}
            disabled={!editable}
            className="grid grid-cols-2 gap-2"
          >
            <Choice value="yes" label="Yes" />
            <Choice value="no" label="No" />
          </RadioGroup>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}


/** A yes/no question about the person, answered with two choices; null until one is chosen. */
function YesNoField({
  label,
  help,
  value,
  onChange,
  disabled,
  issue,
}: {
  label: string;
  help?: string;
  value: boolean | null;
  onChange: (value: boolean) => void;
  disabled: boolean;
  issue?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium" id={`${id}-label`}>
        {label}
      </p>
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={value === null ? "" : value ? "yes" : "no"}
        onValueChange={(choice) => onChange(choice === "yes")}
        disabled={disabled}
        aria-invalid={issue ? true : undefined}
        className="grid grid-cols-2 gap-2"
      >
        <Choice value="yes" label="Yes" />
        <Choice value="no" label="No" />
      </RadioGroup>
      {issue ? <p className="text-xs text-destructive">{issue}</p> : null}
    </div>
  );
}

/** One option of a radio group, drawn as a bordered row that is wholly clickable. */
function Choice({ value, label }: { value: string; label: string }) {
  const id = useId();
  return (
    <Label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 has-disabled:cursor-default"
    >
      <RadioGroupItem id={id} value={value} />
      {label}
    </Label>
  );
}

