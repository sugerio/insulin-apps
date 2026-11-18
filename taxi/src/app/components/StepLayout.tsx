import type { ReactNode } from "react";
import type { Step } from "#shared";
import { EstimateCard } from "./EstimateCard.tsx";
import { Page, PageHead } from "./Page.tsx";
import { ReturnSwitcher, STEP_LABELS, StepNav, stepPath, useReturn, useYear } from "./YearFrame.tsx";

/**
 * A step of one person's return: whose return it is and its steps on the left, the step in the middle, and beside it
 * the return's estimate (or `aside`, or nothing with `estimate={false}`).
 */
export function StepLayout({ step, title, estimate = true, aside, children }: { step: Step; title: string; estimate?: boolean; aside?: ReactNode; children: ReactNode }) {
  const { year } = useYear();
  const { person } = useReturn();
  const side = aside ?? (estimate ? <EstimateCard /> : null);
  return (
    <Page
      title={`${person.name} · ${year.year} ${STEP_LABELS[step].toLowerCase()}`}
      crumbs={[["Returns", "/returns"], [String(year.year), `/returns/${year.year}`], [person.name, stepPath(year.year, person.id, "household")], [STEP_LABELS[step]]]}
      wide
    >
      <div
        className={
          side
            ? "grid items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_300px]"
            : "grid items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)]"
        }
      >
        <div className="flex flex-col gap-3 lg:sticky lg:top-6">
          <ReturnSwitcher />
          <StepNav />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <PageHead title={title} />
          {children}
        </div>
        {side ? <aside className="lg:col-start-2 xl:col-start-auto">{side}</aside> : null}
      </div>
    </Page>
  );
}
