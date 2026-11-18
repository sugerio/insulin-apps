import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, Check, Plus } from "lucide-react";
import { STEPS, canPrepare, filingDeadline, routes, type Person, type YearList } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { Page, PageHead } from "../components/Page.tsx";
import { MemberPicker } from "../components/PeopleEditor.tsx";
import { STEP_LABELS, nextStep, stepPath } from "../components/YearFrame.tsx";
import { RELATIONSHIP_LABELS, formatDate } from "../lib/format.ts";
import { useResource } from "../lib/useResource.ts";

// `/returns`: the household's tax years. Each year shows the filing deadline and each adult's return with its six
// steps and their state; a year not yet started can be started by someone who prepares returns.

export function ReturnsPage() {
  const resource = useResource("years", (signal) => apiRequest(routes.listYears, { signal }));
  return (
    <Page title="Returns" crumbs={[["Returns"]]}>
      <PageHead title="Tax years" />
      <ResourceView resource={resource}>{(data) => <Years data={data} />}</ResourceView>
    </Page>
  );
}

function Years({ data }: { data: YearList }) {
  const me = useMe();
  const started = new Set(data.years.map((year) => year.year));
  const notStarted = data.supportedYears.filter((year) => !started.has(year));
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        {data.years.map((year) => (
          <Card key={year.year}>
            <CardHeader>
              <CardTitle>
                <h2 className="text-lg font-semibold">{year.year} tax year</h2>
              </CardTitle>
              <CardDescription>File by {formatDate(filingDeadline(year.year))}.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col divide-y" aria-label={`${year.year} returns`}>
                {year.returns.map((progress) => (
                  <ReturnRow key={progress.personId} year={year.year} progress={progress} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
        {notStarted.map((year) => (
          <StartYear key={year} year={year} people={data.people} />
        ))}
      </div>
      <aside className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">Household</h2>
            </CardTitle>
            <CardAction>
              <Button asChild variant="outline" size="sm">
                <Link to="/household">{canPrepare(me) ? "Edit" : "Open"}</Link>
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
                    <span className="font-medium">{person.name}</span>
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
            <p>Residents of Ontario, British Columbia and Alberta with employment income, investment slips, RRSP, donations and medical expenses.</p>
            <p>Not yet: self-employment, rental income, income from outside Canada, Quebec.</p>
            <p>Nothing is sent to the CRA. You get the CRA's own forms, filled in, to sign and mail.</p>
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
 * A supported year not started yet. Starting it asks who is in it: you always, your spouse to prepare both returns
 * together, and the dependants who lived with you. `?start=<year>` opens the choice (the way back from the Household).
 */
function StartYear({ year, people }: { year: number; people: Person[] }) {
  const me = useMe();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [choosing, setChoosing] = useState(search.get("start") === String(year));
  // Everyone ticked to begin with: most households file with the same people every year.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(people.map((person) => person.id)));
  const [state, setState] = useState<{ status: "idle" | "starting" } | { status: "error"; error: unknown }>({ status: "idle" });
  const self = people.find((person) => person.relationship === "self");
  const addPerson = `/household?back=${encodeURIComponent(`/returns?start=${year}`)}`;

  async function start() {
    setState({ status: "starting" });
    try {
      const ids = people.filter((person) => person.relationship === "self" || selected.has(person.id)).map((person) => person.id);
      await apiRequest(routes.startYear, { body: { year, people: ids } });
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
        <CardDescription>File by {formatDate(filingDeadline(year))}.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!canPrepare(me) ? (
          <p className="text-sm text-muted-foreground">Someone who prepares returns starts the year. Your role can view returns.</p>
        ) : !self ? (
          <div>
            <Button asChild>
              <Link to={addPerson}>Go to Household</Link>
            </Button>
          </div>
        ) : choosing ? (
          <>
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
