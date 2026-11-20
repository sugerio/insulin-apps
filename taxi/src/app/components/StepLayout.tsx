import type { ReactNode } from "react";
import type { Step } from "#shared";
import { EstimateSummary } from "./EstimateCard.tsx";
import { Page, PageHead } from "./Page.tsx";
import { ReturnSwitcher, STEP_LABELS, StepNav, stepPath, useReturn, useYear } from "./YearFrame.tsx";

/**
 * A step of one person's return, across the width of the page: whose return it is and its estimate at the top, the
 * steps in a row below, then the step. Nothing sits beside the step, so its tables and amounts have room; `aside` (notes
 * for the step) goes below it. `estimate={false}` leaves the estimate out (Finish shows the result itself).
 */
export function StepLayout({ step, title, estimate = true, aside, children }: { step: Step; title: string; estimate?: boolean; aside?: ReactNode; children: ReactNode }) {
  const { year } = useYear();
  const { person } = useReturn();
  return (
    <Page
      title={`${person.name} · ${year.year} ${STEP_LABELS[step].toLowerCase()}`}
      crumbs={[["Returns", "/returns"], [String(year.year), `/returns/${year.year}`], [person.name, stepPath(year.year, person.id, "personal")], [STEP_LABELS[step]]]}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ReturnSwitcher />
          {estimate ? <EstimateSummary /> : null}
        </div>
        <StepNav />
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <PageHead title={title} />
        {children}
        {aside}
      </div>
    </Page>
  );
}
