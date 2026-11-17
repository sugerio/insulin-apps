import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, Check } from "lucide-react";
import { STEPS, canPrepare, filingDeadline, routes, type YearList } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { Page, PageHead } from "../components/Page.tsx";
import { STEP_LABELS, nextStep, stepPath } from "../components/YearFrame.tsx";
import { RELATIONSHIP_LABELS, formatDate } from "../lib/format.ts";
import { useResource } from "../lib/useResource.ts";

// `/returns`: the household's tax years. Each year shows whose returns are prepared, the filing deadline and the six
// steps with their state; a year not yet started can be started by someone who prepares returns.

export function ReturnsPage() {
  const resource = useResource("years", (signal) => apiRequest(routes.listYears, { signal }));
  return (
    <Page title="Returns" crumbs={[["Returns"]]}>
      <PageHead
        title="Tax years"
        sub="One return per adult each year, prepared together. Nothing is sent to the CRA: you get the CRA's own forms, filled in, to sign and mail."
      />
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
        {data.years.map((year) => {
          const done = STEPS.filter((step) => year.steps[step] === "done").length;
          const next = nextStep(year.steps);
          return (
            <Card key={year.year}>
              <CardHeader>
                <CardTitle>
                  <h2 className="text-lg font-semibold">{year.year} tax year</h2>
                </CardTitle>
                <CardDescription>
                  File by {formatDate(filingDeadline(year.year))}.{" "}
                  {year.filers.length > 0 ? <>Returns for {year.filers.join(" and ")}.</> : "Add the household to begin."}
                </CardDescription>
                <CardAction>
                  <Badge variant="secondary">
                    {done} of {STEPS.length} steps done
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ol className="grid gap-2 sm:grid-cols-3" aria-label={`${year.year} steps`}>
                  {STEPS.map((step, index) => (
                    <li key={step} className="flex items-center gap-2 text-sm">
                      <span
                        className={
                          year.steps[step] === "done"
                            ? "flex size-5 items-center justify-center rounded-full bg-emerald-700 text-white"
                            : "flex size-5 items-center justify-center rounded-full border text-xs text-muted-foreground"
                        }
                        aria-hidden="true"
                      >
                        {year.steps[step] === "done" ? <Check className="size-3" /> : index + 1}
                      </span>
                      <span className={year.steps[step] === "not_built" ? "text-muted-foreground" : undefined}>{STEP_LABELS[step]}</span>
                      <span className="sr-only">{year.steps[step] === "done" ? "(done)" : year.steps[step] === "not_built" ? "(not available yet)" : "(to do)"}</span>
                    </li>
                  ))}
                </ol>
                <div>
                  <Button asChild>
                    <Link to={stepPath(year.year, next)}>
                      {canPrepare(me) ? `Continue: ${STEP_LABELS[next]}` : `Open ${year.year}`}
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {notStarted.map((year) => (
          <StartYear key={year} year={year} />
        ))}
      </div>
      <aside className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">Household</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.people.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one yet. Start a tax year to add the household.</p>
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
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function StartYear({ year }: { year: number }) {
  const me = useMe();
  const navigate = useNavigate();
  const [state, setState] = useState<{ status: "idle" | "starting" } | { status: "error"; error: unknown }>({ status: "idle" });
  async function start() {
    setState({ status: "starting" });
    try {
      await apiRequest(routes.startYear, { body: { year } });
      navigate(stepPath(year, "household"));
    } catch (error) {
      setState({ status: "error", error });
    }
  }
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg font-semibold">{year} tax year</h2>
        </CardTitle>
        <CardDescription>
          Not started. File by {formatDate(filingDeadline(year))}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {canPrepare(me) ? (
          <div>
            <Button onClick={() => void start()} disabled={state.status === "starting"}>
              {state.status === "starting" ? "Starting…" : `Start ${year}`}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Someone who prepares returns starts the year. Your role can view returns.</p>
        )}
        {state.status === "error" ? <Banner kind="error" title="The year wasn't started">{describeError(state.error)}</Banner> : null}
      </CardContent>
    </Card>
  );
}
