import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  PROVINCES,
  SUPPORTED_PROVINCES,
  canPrepare,
  isIssueOf,
  maritalStatusesFor,
  routes,
  type Country,
  type FilingStatus,
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
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());
  const [showMissing, setShowMissing] = useState(false);
  const requests: Requests = {
    state: request,
    edited,
    edit: (path) => setEdited((current) => (current.has(path) ? current : new Set(current).add(path))),
    async run(calls, thenContinue) {
      const last: { year: TaxYear | null } = { year: null };
      setRequest({ status: "saving" });
      setEdited(new Set());
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
    <StepLayout step="personal" title="Personal info" aside={year.country === "us" ? <UsTaxNotes /> : <TaxNotes year={year.year} />}>
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
  /** The fields changed since the last save started (`answers.<question>`): a refusal no longer shows at them. */
  edited: ReadonlySet<string>;
  edit: (path: string) => void;
  /**
   * Runs the save's calls; the facts are locked until they end. `answered` keeps the year each call answered with: the
   * last one is applied when they end, even if a later call failed, so the next save isn't refused as stale. With
   * `thenContinue`, a save that leaves nothing missing goes on to the next step, and one that does lists what is left.
   */
  run: (calls: (answered: (year: TaxYear) => TaxYear) => Promise<void>, thenContinue: boolean) => Promise<void>;
  /** Loads the year again, and clears what the last save said. */
  reload: () => void;
}

/** What each answer means for a US return. */
function UsTaxNotes() {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-sm font-semibold">How these answers affect the tax</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>
          <b className="text-foreground">Filing status.</b> It follows the marital status on December 31. Unmarried (single, divorced, legally
          separated under a decree, or widowed) files Single. A married couple chooses: jointly, one return with both incomes, which usually
          costs less; or separately, a return each.
        </p>
        <p>
          <b className="text-foreground">Standard deduction.</b> $15,750, plus $2,000 ($1,600 if married) for being 65 or older and again for being
          blind. Someone who can be claimed as a dependent gets less. Itemized deductions aren't handled yet.
        </p>
        <p>
          <b className="text-foreground">Residency.</b> This is the federal return of a U.S. citizen or resident alien for the whole year. A
          nonresident or dual-status alien files Form 1040-NR, which the app doesn't prepare. State returns aren't prepared.
        </p>
      </CardContent>
    </Card>
  );
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
  const { person: owner, members } = useReturn();
  const editable = canPrepare(me);
  // A joint return asks about both spouses: the owner's fields keep their plain keys, a spouse's are prefixed with their id.
  const keyOf = (personId: string, key: string) => (personId === owner.id ? key : `${personId}:${key}`);
  const adultOf = (personId: string) => year.adults.find((each) => each.personId === personId)!;
  // Locked while it is saved, as a save starts the form again from what it saved.
  const locked = !editable || requests.state.status === "saving";
  const error = requests.state.status === "error" ? requests.state.error : null;
  /** A field's value: what was typed on it while the stored value it was typed over still holds, else the stored one. */
  const valueOf = <T extends string | boolean | null>(key: string, stored: T): T => {
    const change = draft[key];
    return change !== undefined && change.basis === JSON.stringify(stored) ? (change.to as T) : stored;
  };
  const type = (key: string, stored: string | boolean | null, to: string | boolean | null) => {
    onDraft((current) => ({ ...current, [key]: { basis: JSON.stringify(stored), to } }));
    requests.edit(key);
  };
  // The spouse or partner in the Profile, in this year or not: it decides which statuses there are to choose from.
  const partner = year.people.find((person) => person.relationship === "spouse");
  const statuses = maritalStatusesFor(year.country, partner !== undefined);
  // A status saved before the people in the Profile changed no longer fits: start from none, so a save can't send it back.
  const storedStatus = year.maritalStatus !== null && statuses.includes(year.maritalStatus) ? year.maritalStatus : null;
  const maritalStatus = valueOf<MaritalStatus | null>("maritalStatus", storedStatus);
  // A married couple on a US return chooses to file jointly or separately.
  const asksFilingStatus = year.country === "us" && maritalStatus === "married";
  const filingStatus = valueOf<FilingStatus | null>("filingStatus", year.filingStatus);
  const factsOf = (personId: string): AdultDraft => {
    const adult = adultOf(personId);
    return { province: valueOf(keyOf(personId, "province"), adult.province), residentAllYear: valueOf(keyOf(personId, "residentAllYear"), adult.residentAllYear) };
  };
  // The questions about each person on the return that it reads, once the estimate says which.
  const estimate = useEstimate();
  const rules = rulesFor(year.country, year.year)!;
  const givenOf = (personId: string) => (estimate.status === "ready" ? (estimate.data.input.answers[personId] ?? {}) : {});
  const aboutOf = (personId: string) => {
    const reached = new Set(estimate.status === "ready" ? (estimate.data.result.people.find((each) => each.personId === personId)?.questions ?? []) : []);
    const given = givenOf(personId);
    return [...rules.questions.values()].filter((question) => question.module === "about" && (reached.has(question.id) || question.id in given));
  };
  const about = aboutOf(owner.id);
  const storedAmount = (id: string, personId = owner.id) => (typeof givenOf(personId)[id] === "string" ? (givenOf(personId)[id] as string) : "");
  const amountOf = (id: string, personId = owner.id) => valueOf(keyOf(personId, `answers.${id}`), storedAmount(id, personId));
  // A yes/no question (spouseSameDays) is null until answered.
  const storedChoice = (id: string, personId = owner.id) => (typeof givenOf(personId)[id] === "boolean" ? (givenOf(personId)[id] as boolean) : null);
  const choiceOf = (id: string, personId = owner.id) => valueOf<boolean | null>(keyOf(personId, `answers.${id}`), storedChoice(id, personId));
  const answerOf = (question: (typeof about)[number], personId = owner.id) =>
    question.type === "boolean" ? choiceOf(question.id, personId) : cleanAmount(amountOf(question.id, personId));
  // What was typed over a stored value that has changed since (someone else's save) has given way to it for good: it is
  // dropped, so it can't come back if the stored value later returns to what it was typed over. Answers are checked
  // once the estimate, which holds them, is loaded for this year.
  const storedOf = (full: string): { value: string | boolean | null } | null => {
    if (full === "maritalStatus") return { value: storedStatus };
    if (full === "filingStatus") return { value: year.filingStatus };
    const colon = full.indexOf(":");
    const personId = colon >= 0 ? full.slice(0, colon) : owner.id;
    const key = colon >= 0 ? full.slice(colon + 1) : full;
    const adult = year.adults.find((each) => each.personId === personId);
    if (!adult) return { value: null };
    if (key === "province") return { value: adult.province };
    if (key === "residentAllYear") return { value: adult.residentAllYear };
    if (estimate.status !== "ready") return null;
    const id = key.slice("answers.".length);
    return { value: rules.questions.get(id)?.type === "boolean" ? storedChoice(id, personId) : storedAmount(id, personId) };
  };
  const superseded = Object.entries(draft).flatMap(([key, change]) => {
    const stored = storedOf(key);
    return stored !== null && change.basis !== JSON.stringify(stored.value) ? [key] : [];
  });
  useEffect(() => {
    if (superseded.length === 0) return;
    onDraft((current) => Object.fromEntries(Object.entries(current).filter(([key, entry]) => !(superseded.includes(key) && entry === draft[key]))));
  }, [superseded.join("\n")]);
  // Saving waits for the answers: until the estimate is loaded the questions about the person aren't known, and what
  // was typed for them can't be checked against what is stored.
  const answersReady = estimate.status === "ready";
  const others = members.filter((member) => member.id !== owner.id);
  const unanswered = [
    ...about.filter((question) => answerOf(question) === null || answerOf(question) === ""),
    ...others.flatMap((member) =>
      aboutOf(member.id)
        .filter((question) => answerOf(question, member.id) === null || answerOf(question, member.id) === "")
        .map((question) => ({ ...question, ask: `${member.name}: ${question.ask}` })),
    ),
  ];
  // The spouse's questions (spouseNetIncome and the like) are asked under the spouse; the others are about where this
  // person lived.
  const spouseQuestions = about.filter((question) => question.id.startsWith("spouse"));
  const fields = new Set([
    ...about.map((question) => `answers.${question.id}`),
    ...others.flatMap((member) => aboutOf(member.id).map((question) => keyOf(member.id, `answers.${question.id}`))),
  ]);
  const { issueFor, unshown, inBanner } = fieldIssues(error, (path) => fields.has(path), requests.edited);
  const field = (question: (typeof about)[number], personId = owner.id) => {
    const key = keyOf(personId, `answers.${question.id}`);
    return question.type === "boolean" ? (
      <YesNoField
        key={key}
        label={question.ask}
        help={question.help}
        value={choiceOf(question.id, personId)}
        disabled={locked}
        issue={issueFor(key)}
        onChange={(value) => type(key, storedChoice(question.id, personId), value)}
      />
    ) : (
      <AmountField
        key={key}
        label={question.ask}
        help={question.help}
        unit={question.type === "count" ? "" : "$"}
        max={question.max}
        value={amountOf(question.id, personId)}
        disabled={locked}
        issue={issueFor(key)}
        onChange={(value) => type(key, storedAmount(question.id, personId), value)}
      />
    );
  };

  async function save(thenContinue: boolean) {
    const sent = draft;
    // Each answer given; one emptied here is cleared (null), so the field and what is stored agree: unanswered, and
    // listed as missing. Unlike an amount on Income or Deductions, an empty answer here doesn't mean 0.
    const answersOf = (personId: string) =>
      Object.fromEntries(
        aboutOf(personId).flatMap((question): [string, string | boolean | null][] => {
          const value = answerOf(question, personId);
          if (value !== null && value !== "") return [[question.id, value]];
          return keyOf(personId, `answers.${question.id}`) in draft ? [[question.id, null]] : [];
        }),
      );
    const byPerson = Object.fromEntries(members.map((member) => [member.id, answersOf(member.id)]));
    await requests.run(async (answered) => {
      const body = {
        revision: year.revision,
        maritalStatus,
        ...(year.country === "us" ? { filingStatus: asksFilingStatus ? filingStatus : null } : {}),
        adults: members.map((member) => ({ personId: member.id, ...factsOf(member.id) })),
      };
      const saved = answered(await apiRequest(routes.savePersonalInfo, { params: { year: year.year }, body }));
      answered(await saveAnswersFor(saved, byPerson));
      // What this save sent is stored now, so it is no longer a change: the facts, and the answers it sent.
      const stored = (full: string) => {
        const colon = full.indexOf(":");
        const personId = colon >= 0 && !full.startsWith("answers.") ? full.slice(0, colon) : owner.id;
        const key = colon >= 0 && !full.startsWith("answers.") ? full.slice(colon + 1) : full;
        return !key.startsWith("answers.") || key.slice("answers.".length) in (byPerson[personId] ?? {});
      };
      onDraft((current) => Object.fromEntries(Object.entries(current).filter(([key, entry]) => !(sent[key] === entry && stored(key)))));
    }, thenContinue);
  }

  const stale = error instanceof ApiError && error.status === 409;
  // This return's issues: its adults', and those of the facts the year's returns share.
  const issues = year.issues.filter((issue, index, all) => members.some((member) => isIssueOf(issue, member.id)) && all.indexOf(issue) === index);
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
              <Choice key={status} value={status} label={year.country === "us" && status === "separated" ? "Legally separated" : MARITAL_STATUS_LABELS[status]} />
            ))}
          </RadioGroup>
          {partner ? null : (
            <Link to={`/profile?back=${encodeURIComponent(stepPath(year.year, owner.id, "personal"))}`} className="text-sm underline underline-offset-2">
              Add a spouse or partner
            </Link>
          )}
        </CardContent>
      </Card>

      {asksFilingStatus ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold" id="filing-status">
                Filing status
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <RadioGroup
              aria-labelledby="filing-status"
              value={filingStatus ?? ""}
              onValueChange={(value) => type("filingStatus", year.filingStatus, value)}
              disabled={locked}
              className="grid gap-2 sm:grid-cols-2"
            >
              <Choice value="joint" label="Married filing jointly" />
              <Choice value="separate" label="Married filing separately" />
            </RadioGroup>
            <p className="text-sm text-muted-foreground">
              {year.adults.length > 1
                ? "Jointly, you file one return with both incomes on it. Separately, each of you files a return of your own."
                : `To file jointly, add ${partner?.name ?? "your spouse"} to this year on the Returns page.`}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <AdultCard
        country={year.country}
        title={others.length > 0 ? `Where you lived: ${owner.name}` : undefined}
        draft={factsOf(owner.id)}
        editable={!locked}
        onChange={(change) => {
          const adult = adultOf(owner.id);
          if (change.province !== undefined) type("province", adult.province, change.province);
          if (change.residentAllYear !== undefined) type("residentAllYear", adult.residentAllYear, change.residentAllYear);
        }}
      >
        {about.filter((question) => !spouseQuestions.includes(question)).map((question) => field(question))}
      </AdultCard>

      {/* On a joint return, the spouse's facts and the questions about them. */}
      {others.map((member) => (
        <AdultCard
          key={member.id}
          country={year.country}
          title={`Where you lived: ${member.name}`}
          draft={factsOf(member.id)}
          editable={!locked}
          onChange={(change) => {
            const adult = adultOf(member.id);
            if (change.province !== undefined) type(keyOf(member.id, "province"), adult.province, change.province);
            if (change.residentAllYear !== undefined) type(keyOf(member.id, "residentAllYear"), adult.residentAllYear, change.residentAllYear);
          }}
        >
          {aboutOf(member.id)
            .filter((question) => !question.id.startsWith("spouse"))
            .map((question) => field({ ...question, ask: askedOf(question.ask, member.name), help: question.help && askedOf(question.help, member.name) }, member.id))}
        </AdultCard>
      ))}

      {spouseQuestions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">Your spouse or partner</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">{spouseQuestions.map((question) => field(question))}</CardContent>
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

      <div className="flex flex-wrap items-center justify-end gap-3">
        {editable && estimate.status === "loading" ? (
          <p role="status" className="mr-auto text-xs text-muted-foreground">
            Loading your answers…
          </p>
        ) : editable && estimate.status === "error" ? (
          <p className="mr-auto flex items-center gap-2 text-xs text-destructive">
            Your answers couldn't be loaded, so nothing can be saved yet.
            <Button variant="outline" size="sm" onClick={estimate.reload}>
              Try again
            </Button>
          </p>
        ) : null}
        {editable ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void save(false)} disabled={locked || !answersReady}>
              Save
            </Button>
            <Button onClick={() => void save(true)} disabled={locked || !answersReady}>
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

/**
 * The province and residency, then `children`: the questions for someone who didn't live in Canada all year. A US
 * return is federal only: it asks no state, only whether the person was a U.S. citizen or resident all year.
 */
function AdultCard({
  country,
  title,
  draft,
  editable,
  onChange,
  children,
}: {
  country: Country;
  title?: string;
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
          <h2 className="text-base font-semibold wrap-anywhere">{title ?? "Where you lived"}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {country === "ca" ? (
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
        ) : null}
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium" id={`${id}-resident`}>
            {country === "ca" ? "Lived in Canada all year?" : "A U.S. citizen or resident alien all year?"}
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


/**
 * A question about the person preparing, asked about someone else on the return: "You are blind" becomes "Sam Rivera
 * is blind", "Someone can claim you" becomes "Someone can claim Sam Rivera".
 */
function askedOf(ask: string, name: string): string {
  return ask
    .replace(/^You are\b/, `${name} is`)
    .replace(/^You were\b/, `${name} was`)
    .replace(/^You\b/, name)
    .replace(/\byou\b/, name);
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

