import type { ReactNode } from "react";
import type { Step } from "#shared";
import { EstimateCard } from "./EstimateCard.tsx";
import { Page, PageHead } from "./Page.tsx";
import { STEP_LABELS, StepNav, useYear } from "./YearFrame.tsx";

/** A step of a year: the steps on the left, the step in the middle, and the estimate on the right. */
export function StepLayout({ step, title, estimate = true, children }: { step: Step; title: string; estimate?: boolean; children: ReactNode }) {
  const { year } = useYear();
  return (
    <Page title={`${year.year} ${STEP_LABELS[step].toLowerCase()}`} crumbs={[["Returns", "/returns"], [String(year.year), `/returns/${year.year}`], [STEP_LABELS[step]]]} wide>
      <div
        className={
          estimate
            ? "grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px]"
            : "grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]"
        }
      >
        <StepNav />
        <div className="flex min-w-0 flex-col gap-5">
          <PageHead title={title} />
          {children}
        </div>
        {estimate ? (
          <aside className="lg:col-start-2 xl:col-start-auto">
            <EstimateCard />
          </aside>
        ) : null}
      </div>
    </Page>
  );
}

/** The year's adults, in order: you, then your spouse when in the year. */
export function useAdults() {
  const { year } = useYear();
  return year.adults.map((adult) => ({ ...adult, person: year.people.find((person) => person.id === adult.personId)! }));
}
