import { createContext, useContext, useRef } from "react";
import { Link, Navigate, Outlet, useLocation, useParams } from "react-router";
import { Check, ChevronRight, ChevronsUpDown } from "lucide-react";
import { STEPS, SUPPORTED_YEARS, routes, type AdultYear, type Estimate, type Person, type SlipList, type Step, type StepStatuses, type TaxYear } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.tsx";
import { cn } from "@/lib/utils.ts";
import { ApiError, apiRequest } from "../api/client.ts";
import { formatMoney } from "../lib/format.ts";
import { useResource, type Resource } from "../lib/useResource.ts";
import { NotFoundPage } from "../pages/Pages.tsx";
import { ResourceView } from "./Feedback.tsx";

// A tax year's pages. The year is loaded once here, with its estimate and slips (again whenever its revision changes),
// and shared through YearContext. Each adult of the year has a return of their own at `/returns/:year/:personId/:step`:
// one person's steps (about them, their documents, their income, deductions and credits, confirming the slips,
// finishing), with a switcher to the other returns of the year. A step that saves replaces the year with what the
// server answered, unless the year held is newer already.

export const STEP_LABELS: Record<Step, string> = {
  household: "Personal info",
  upload: "Upload documents",
  income: "Income",
  deductions: "Deductions",
  credits: "Credits",
  confirm: "Confirm",
  finish: "Finish",
};

/** Steps that were renamed: an old link to one opens the step that took its place. */
export const RENAMED_STEPS: Record<string, Step> = { applies: "income" };

/** A step's name from a path segment, old names included; null when it names no step. */
export function stepFrom(segment: string): Step | null {
  if ((STEPS as readonly string[]).includes(segment)) return segment as Step;
  return RENAMED_STEPS[segment] ?? null;
}

export const stepPath = (year: number, personId: string, step: Step) => `/returns/${year}/${personId}/${step}`;

interface YearValue {
  year: TaxYear;
  replace: (year: TaxYear) => void;
  reload: () => void;
  estimate: Resource<Estimate>;
  slips: Resource<SlipList>;
}
const YearContext = createContext<YearValue | null>(null);

export function useYear(): YearValue {
  const value = useContext(YearContext);
  if (!value) throw new Error("useYear must be used inside YearFrame");
  return value;
}

/** The return open: whose it is, their facts for the year and how far each step is. */
export interface ReturnValue {
  person: Person;
  adult: AdultYear;
  steps: StepStatuses;
}
const ReturnContext = createContext<ReturnValue | null>(null);

export function useReturn(): ReturnValue {
  const value = useContext(ReturnContext);
  if (!value) throw new Error("useReturn must be used inside ReturnFrame");
  return value;
}

/** A return's steps in a year the server answered with (null when the person no longer has a return in it). */
export function stepsOf(year: TaxYear, personId: string): StepStatuses | null {
  return year.returns.find((each) => each.personId === personId)?.steps ?? null;
}

/** The first step that isn't done: where "Continue" leads. */
export function nextStep(steps: StepStatuses): Step {
  return STEPS.find((step) => steps[step] === "todo") ?? STEPS.find((step) => steps[step] !== "done") ?? "finish";
}

export function YearFrame() {
  const year = Number(useParams().year);
  const known = (SUPPORTED_YEARS as readonly number[]).includes(year);
  const resource = useResource(`year-${year}`, (signal) => apiRequest(routes.getYear, { params: { year }, signal }));
  // Answers arrive in any order, some for a page no longer open (an upload in the other return): one with an older
  // revision than the year held would undo a newer change here, and the next save would be refused.
  const held = useRef<TaxYear | null>(null);
  held.current = resource.status === "ready" ? resource.data : null;
  const replace = (next: TaxYear) => {
    const current = held.current;
    if (resource.status !== "ready" || current === null || next.year !== current.year || next.revision < current.revision) return;
    held.current = next;
    resource.replace(next);
  };
  if (!known) return <NotFoundPage />;
  // A year that hasn't been started opens on the list of years, where it can be.
  if (resource.status === "error" && resource.error instanceof ApiError && resource.error.status === 404) {
    return <Navigate to="/returns" replace />;
  }
  return (
    <ResourceView resource={resource}>
      {(data) => <YearData year={data} replace={replace} reload={resource.reload} />}
    </ResourceView>
  );
}

function YearData({ year, replace, reload }: Pick<YearValue, "year" | "replace" | "reload">) {
  const estimate = useResource(`estimate-${year.year}-${year.revision}`, (signal) => apiRequest(routes.getEstimate, { params: { year: year.year }, signal }));
  const slips = useResource(`slips-${year.year}-${year.revision}`, (signal) => apiRequest(routes.listSlips, { params: { year: year.year }, signal }));
  return (
    <YearContext value={{ year, replace, reload, estimate, slips }}>
      <Outlet />
    </YearContext>
  );
}

/** `/returns/:year`: the person preparing's return, at its first step still to do. */
export function YearIndex() {
  const { year } = useYear();
  const first = year.returns[0];
  if (!first) return <NotFoundPage />;
  return <Navigate to={stepPath(year.year, first.personId, nextStep(first.steps))} replace />;
}

/**
 * `/returns/:year/:personId`: one adult's return. A link from before returns were per person (`/returns/2025/upload`)
 * opens that step of the person preparing's return; a person who no longer has a return this year opens the year.
 */
export function ReturnFrame() {
  const { year } = useYear();
  const param = useParams().person ?? "";
  const progress = year.returns.find((each) => each.personId === param);
  const adult = year.adults.find((each) => each.personId === param);
  const person = year.people.find((each) => each.id === param);
  if (!progress || !adult || !person) {
    const first = year.returns[0];
    if (!first) return <NotFoundPage />;
    const step = stepFrom(param);
    if (step) return <Navigate to={stepPath(year.year, first.personId, step)} replace />;
    return <Navigate to={`/returns/${year.year}`} replace />;
  }
  // The switcher keeps the step: a new key starts its form again from the other person's stored facts, so a draft of
  // one return is never shown, or saved, as the other's.
  return (
    <ReturnContext value={{ person, adult, steps: progress.steps }}>
      <Outlet key={person.id} />
    </ReturnContext>
  );
}

/** `/returns/:year/:personId`: that return's first step still to do. */
export function ReturnIndex() {
  const { year } = useYear();
  const { person, steps } = useReturn();
  return <Navigate to={stepPath(year.year, person.id, nextStep(steps))} replace />;
}

/** The step open, from the path. */
function useCurrentStep(): Step | null {
  const { pathname } = useLocation();
  return stepFrom(pathname.split("/").pop() ?? "");
}

/** A return's result in a few words: the refund or balance owing, when it can be worked out. */
export function resultOf(estimate: Resource<Estimate>, personId: string): string | null {
  if (estimate.status !== "ready") return null;
  const lines = estimate.data.result.people.find((person) => person.personId === personId)?.lines ?? [];
  const refund = lines.find((line) => line.id === "T1.48400")?.value;
  const owing = lines.find((line) => line.id === "T1.48500")?.value;
  if (refund === undefined || owing === undefined || refund === null || owing === null) return null;
  return Number(owing) ? `Owing ${formatMoney(owing)}` : `Refund ${formatMoney(refund)}`;
}

/** Whose return is open, and the others of the year to switch to, at the same step. */
export function ReturnSwitcher() {
  const { year, estimate } = useYear();
  const { person } = useReturn();
  const step = useCurrentStep() ?? "household";
  const returns = year.returns.map((progress) => year.people.find((each) => each.id === progress.personId)!).filter(Boolean);
  const trigger = (
    <span className="flex min-w-0 flex-col items-start text-left">
      <span className="text-xs font-normal text-muted-foreground">Return of</span>
      <span className="max-w-full truncate font-semibold">{person.name}</span>
    </span>
  );
  if (returns.length < 2) return <div className="flex px-1 text-sm">{trigger}</div>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-auto justify-between gap-3 px-2 py-1.5" aria-label={`Return of ${person.name}: switch return`}>
          {trigger}
          <ChevronsUpDown className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel>{year.year} returns</DropdownMenuLabel>
        {returns.map((each) => {
          const other = resultOf(estimate, each.id);
          return (
            <DropdownMenuItem key={each.id} asChild>
              <Link to={stepPath(year.year, each.id, step)} aria-current={each.id === person.id ? "page" : undefined} className="flex items-center gap-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{each.name}</span>
                  {other ? <span className="text-xs text-muted-foreground tabular-nums">{other}</span> : null}
                </span>
                {each.id === person.id ? <Check className="size-4" aria-hidden="true" /> : null}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The steps of the open return, in a row above the step (wrapping when narrow): number, label and state; the open one marked as current. */
export function StepNav() {
  const { year } = useYear();
  const { person, steps } = useReturn();
  const currentStep = useCurrentStep();
  return (
    <nav aria-label="Steps" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1 rounded-xl border bg-card p-1.5">
        {STEPS.map((step, index) => {
          const current = currentStep === step;
          const status = steps[step];
          return (
            <li key={step} className="flex items-center gap-1">
              {index > 0 ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" /> : null}
              <Link
                to={stepPath(year.year, person.id, step)}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap hover:bg-muted",
                  current && "bg-primary/10 font-medium text-primary hover:bg-primary/10",
                  status === "not_built" && !current && "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-semibold",
                    status === "done" ? "border-emerald-700 bg-emerald-700 text-white" : current ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                  )}
                  aria-hidden="true"
                >
                  {status === "done" ? <Check className="size-3" /> : index + 1}
                </span>
                <span>{STEP_LABELS[step]}</span>
                <span className="sr-only">{status === "done" ? "(done)" : status === "not_built" ? "(not available yet)" : "(to do)"}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
