import { createContext, useContext } from "react";
import { Link, Navigate, Outlet, useLocation, useParams } from "react-router";
import { Check } from "lucide-react";
import { STEPS, SUPPORTED_YEARS, routes, type Step, type TaxYear } from "#shared";
import { cn } from "@/lib/utils.ts";
import { ApiError, apiRequest } from "../api/client.ts";
import { useResource } from "../lib/useResource.ts";
import { NotFoundPage } from "../pages/Pages.tsx";
import { ResourceView } from "./Feedback.tsx";

// A tax year's pages: the six steps of the year on the left (the household, the documents, what applies, confirming
// what AI read, deductions, finishing), the open step beside them. The year is loaded once here and shared with the
// step through YearContext; a step that saves replaces it with what the server answered.

export const STEP_LABELS: Record<Step, string> = {
  household: "Household",
  upload: "Upload documents",
  applies: "What applies",
  confirm: "Confirm",
  deductions: "Deductions",
  finish: "Finish",
};

export const stepPath = (year: number, step: Step) => `/returns/${year}/${step}`;

interface YearValue {
  year: TaxYear;
  replace: (year: TaxYear) => void;
  reload: () => void;
}
const YearContext = createContext<YearValue | null>(null);

export function useYear(): YearValue {
  const value = useContext(YearContext);
  if (!value) throw new Error("useYear must be used inside YearFrame");
  return value;
}

/** The first step that isn't done: where "Continue" leads. */
export function nextStep(steps: TaxYear["steps"]): Step {
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
      {(data) => (
        <YearContext value={{ year: data, replace: resource.status === "ready" ? resource.replace : () => {}, reload: resource.reload }}>
          <Outlet />
        </YearContext>
      )}
    </ResourceView>
  );
}

/** `/returns/:year`: the first step still to do. */
export function YearIndex() {
  const { year } = useYear();
  return <Navigate to={stepPath(year.year, nextStep(year.steps))} replace />;
}

/** The steps beside a step's page: number, label and state; the open one marked as the current step. */
export function StepNav() {
  const { year } = useYear();
  const { pathname } = useLocation();
  return (
    <nav aria-label="Steps" className="flex flex-col gap-0.5 rounded-xl border bg-card p-2 lg:sticky lg:top-6">
      <ol className="flex flex-col gap-0.5">
        {STEPS.map((step, index) => {
          const current = pathname === stepPath(year.year, step);
          const status = year.steps[step];
          return (
            <li key={step}>
              <Link
                to={stepPath(year.year, step)}
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
