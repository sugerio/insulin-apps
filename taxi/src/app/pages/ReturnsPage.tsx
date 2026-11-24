import { useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, Check, Plus } from "lucide-react";
import { COUNTRY_NAMES, STEPS, canPrepare, filingDeadline, routes, type Country, type Person, type YearList } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { Page, PageHead } from "../components/Page.tsx";
import { MemberPicker } from "../components/PeopleEditor.tsx";
import { YearPeople } from "../components/YearPeople.tsx";
import { STEP_LABELS, nextStep, stepPath } from "../components/YearFrame.tsx";
import { RELATIONSHIP_LABELS, formatDate } from "../lib/format.ts";
import { useResource } from "../lib/useResource.ts";

// `/returns`: the tax years. Each year shows its country, the filing deadline and each adult's return with its
// steps and their state; a year not yet started can be started, for Canada or the United States, by someone who
// prepares returns.

export function ReturnsPage() {
  const resource = useResource("years", (signal) => apiRequest(routes.listYears, { signal }));
  return (
    <Page title="Returns" crumbs={[["Returns"]]}>
      <PageHead title="Tax years" />
      <ResourceView resource={resource}>{(data) => <Years data={data} reload={resource.reload} />}</ResourceView>
    </Page>
  );
}

function Years({ data, reload }: { data: YearList; reload: () => void }) {
  const me = useMe();
  const started = new Set(data.years.map((year) => year.year));
  // A year is of one country: each year not started yet, with the countries that have rules for it.
  const notStarted = [...new Set(data.supported.flatMap((each) => each.years))]
    .filter((year) => !started.has(year))
    .sort((a, b) => b - a)
    .map((year) => ({ year, countries: data.supported.filter((each) => each.years.includes(year)).map((each) => each.country) }));
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        {data.years.map((year) => (
          <Card key={year.year}>
            <CardHeader>
              <CardTitle>
                <h2 className="text-lg font-semibold">{year.year} tax year</h2>
              </CardTitle>
              <CardDescription>
                {COUNTRY_NAMES[year.country]}. File by {formatDate(filingDeadline(year.country, year.year))}.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <YearPeople year={year.year} revision={year.revision} members={year.members} people={data.people} onSaved={reload} back="/returns" />
              <ul className="flex flex-col divide-y" aria-label={`${year.year} returns`}>
                {year.returns.map((progress) => (
                  <ReturnRow key={progress.personId} year={year.year} progress={progress} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
        {notStarted.map(({ year, countries }) => (
          <StartYear key={year} year={year} countries={countries} people={data.people} />
        ))}
      </div>
      <aside className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">Profile</h2>
            </CardTitle>
            <CardAction>
              <Button asChild variant="outline" size="sm">
                <Link to="/profile">{canPrepare(me) ? "Edit" : "Open"}</Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {data.people.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one yet.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {data.people.map((person) => (
                  <li key={person.id} className="flex justify-between gap-3">
                    <span className="min-w-0 font-medium wrap-anywhere">{person.name}</span>
                    <span className="text-muted-foreground">{RELATIONSHIP_LABELS[person.relationship]}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">What this app covers</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>Residents of every province and territory, with income from work, pensions, benefits, investments, a business or rent.</p>
            <p>Quebec residents get both returns: the federal T1 and Revenu Québec's TP-1, worked out from their RL slips.</p>
            <p>Nothing is sent to the CRA. You get the CRA's own forms, filled in, to sign and mail.</p>
            <p>
              United States: the federal Form 1040 for wages and interest, in every filing status, with dependants, the child tax credit, the
              earned income credit and the credit for child care, printed on the IRS's own forms.
            </p>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

/** One adult's return in a year: its steps and the way to the first one still to do. */
function ReturnRow({ year, progress }: { year: number; progress: YearList["years"][number]["returns"][number] }) {
  const me = useMe();
  const done = STEPS.filter((step) => progress.steps[step] === "done").length;
  const next = nextStep(progress.steps);
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h3 className="truncate font-semibold">{progress.name}</h3>
          <Badge variant="secondary">
            {done} of {STEPS.length} steps done
          </Badge>
        </div>
        <Button asChild size="sm">
          <Link to={stepPath(year, progress.personId, next)} aria-label={`${progress.name}: ${canPrepare(me) ? `continue, ${STEP_LABELS[next]}` : "open"}`}>
            {canPrepare(me) ? `Continue: ${STEP_LABELS[next]}` : "Open"}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
      <ol className="grid gap-2 sm:grid-cols-3" aria-label={`${progress.name}'s steps`}>
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-center gap-2 text-sm">
            <span
              className={
                progress.steps[step] === "done"
                  ? "flex size-5 items-center justify-center rounded-full bg-emerald-700 text-white"
                  : "flex size-5 items-center justify-center rounded-full border text-xs text-muted-foreground"
              }
              aria-hidden="true"
            >
              {progress.steps[step] === "done" ? <Check className="size-3" /> : index + 1}
            </span>
            <span>{STEP_LABELS[step]}</span>
            <span className="sr-only">{progress.steps[step] === "done" ? "(done)" : "(to do)"}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}

/**
 * A supported year not started yet. Starting it asks whose return it is (Canada's or the United States') and who is in
 * it: you always, and whoever you choose of the profile (your spouse to prepare their return too, the dependants who
 * lived with you). `?start=<year>` opens the choice (the way back from the Profile), and `&country=us` keeps the country.
 */
function StartYear({ year, countries, people }: { year: number; countries: Country[]; people: Person[] }) {
  const me = useMe();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [choosing, setChoosing] = useState(search.get("start") === String(year));
  const asked = search.get("country");
  const [country, setCountry] = useState<Country>(countries.find((each) => each === asked) ?? countries[0]!);
  const countryChoice = useId();
  // Only you to begin with: everyone else is added by choice.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<{ status: "idle" | "starting" } | { status: "error"; error: unknown }>({ status: "idle" });
  const self = people.find((person) => person.relationship === "self");
  const addPerson = `/profile?back=${encodeURIComponent(`/returns?start=${year}&country=${country}`)}`;

  async function start() {
    setState({ status: "starting" });
    try {
      const ids = people.filter((person) => person.relationship === "self" || selected.has(person.id)).map((person) => person.id);
      await apiRequest(routes.startYear, { body: { year, country, people: ids } });
      navigate(`/returns/${year}`);
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <Card className={choosing ? undefined : "border-dashed"}>
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg font-semibold">{choosing ? `Start ${year}: who is in this year?` : `${year} tax year`}</h2>
        </CardTitle>
        <CardDescription>
          {choosing ? `${COUNTRY_NAMES[country]}. File by ${formatDate(filingDeadline(country, year))}.` : `Canada or the United States, one return each year.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!canPrepare(me) ? (
          <p className="text-sm text-muted-foreground">Someone who prepares returns starts the year. Your role can view returns.</p>
        ) : !self ? (
          <div>
            <Button asChild>
              <Link to={addPerson}>Go to Profile</Link>
            </Button>
          </div>
        ) : choosing ? (
          <>
            {countries.length > 1 ? (
              <fieldset className="flex flex-col gap-2">
                <legend id={countryChoice} className="mb-2 text-sm font-medium">
                  Which country's return?
                </legend>
                <RadioGroup aria-labelledby={countryChoice} value={country} onValueChange={(value) => setCountry(value as Country)} className="flex gap-4">
                  {countries.map((each) => (
                    <Label key={each} className="flex items-center gap-2 font-normal">
                      <RadioGroupItem value={each} disabled={state.status === "starting"} />
                      {COUNTRY_NAMES[each]}
                    </Label>
                  ))}
                </RadioGroup>
              </fieldset>
            ) : null}
            <MemberPicker
              people={people}
              selected={selected}
              onChange={setSelected}
              disabled={state.status === "starting"}
              footer={
                <Link to={addPerson} className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm font-medium hover:bg-muted">
                  <Plus className="size-4" aria-hidden="true" />
                  Add a new person
                </Link>
              }
            />
            <div className="flex gap-2">
              <Button onClick={() => void start()} disabled={state.status === "starting"}>
                {state.status === "starting" ? "Starting…" : `Start ${year}`}
              </Button>
              <Button variant="ghost" onClick={() => setChoosing(false)} disabled={state.status === "starting"}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Button onClick={() => setChoosing(true)}>Start {year}</Button>
          </div>
        )}
        {state.status === "error" ? <Banner kind="error" title="The year wasn't started">{describeError(state.error)}</Banner> : null}
      </CardContent>
    </Card>
  );
}
