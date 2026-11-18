import { createContext, useContext } from "react";
import { Link, Navigate, Outlet, useLocation, useParams } from "react-router";
import { Check, ChevronsUpDown } from "lucide-react";
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
// one person's six steps (about them, their documents, what applies, confirming what AI read, deductions, finishing),
// with a switcher to the other returns of the year. A step that saves replaces the year with what the server answered.

export const STEP_LABELS: Record<Step, string> = {
  household: "Personal info",
  upload: "Upload documents",
  applies: "What applies",
  confirm: "Confirm",
  deductions: "Deductions",
  finish: "Finish",
};

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
  if (!known) return <NotFoundPage />;
  // A year that hasn't been started opens on the list of years, where it can be.
  if (resource.status === "error" && resource.error instanceof ApiError && resource.error.status === 404) {
    return <Navigate to="/returns" replace />;
  }
  return (
    <ResourceView resource={resource}>
      {(data) => <YearData year={data} replace={resource.status === "ready" ? resource.replace : () => {}} reload={resource.reload} />}
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
    if ((STEPS as readonly string[]).includes(param)) return <Navigate to={stepPath(year.year, first.personId, param as Step)} replace />;
    return <Navigate to={`/returns/${year.year}`} replace />;
  }
  return (
    <ReturnContext value={{ person, adult, steps: progress.steps }}>
      <Outlet />
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
  const last = pathname.split("/").pop() ?? "";
  return (STEPS as readonly string[]).includes(last) ? (last as Step) : null;
}

/** A return's result in a few words: the refund or balance owing, when it can be worked out. */
function resultOf(estimate: Resource<Estimate>, personId: string): string | null {
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
  const result = resultOf(estimate, person.id);
  const returns = year.returns.map((progress) => year.people.find((each) => each.id === progress.personId)!).filter(Boolean);
  const trigger = (
    <span className="flex min-w-0 flex-1 flex-col items-start text-left">
      <span className="text-xs font-normal text-muted-foreground">Return of</span>
      <span className="w-full truncate font-semibold">{person.name}</span>
      {result ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{result}</span> : null}
    </span>
  );
  if (returns.length < 2) return <div className="flex rounded-xl border bg-card px-4 py-3 text-sm">{trigger}</div>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-auto w-full justify-between rounded-xl bg-card px-4 py-3" aria-label={`Return of ${person.name}: switch return`}>
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

/** The steps of the open return: number, label and state; the open one marked as the current step. */
export function StepNav() {
  const { year } = useYear();
  const { person, steps } = useReturn();
  const currentStep = useCurrentStep();
  return (
    <nav aria-label="Steps" className="flex flex-col gap-0.5 rounded-xl border bg-card p-2">
      <ol className="flex flex-col gap-0.5">
        {STEPS.map((step, index) => {
          const current = currentStep === step;
          const status = steps[step];
          return (
            <li key={step}>
              <Link
                to={stepPath(year.year, person.id, step)}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm hover:bg-muted",
                  current && "bg-primary/10 font-medium text-primary hover:bg-primary/10",
                  status === "not_built" && !current && "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold",
                    status === "done" ? "border-emerald-700 bg-emerald-700 text-white" : current ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                  )}
                  aria-hidden="true"
                >
                  {status === "done" ? <Check className="size-3.5" /> : index + 1}
                </span>
                <span className="min-w-0 flex-1">{STEP_LABELS[step]}</span>
                <span className="sr-only">{status === "done" ? "(done)" : status === "not_built" ? "(not available yet)" : "(to do)"}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
