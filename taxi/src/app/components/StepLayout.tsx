import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { Step } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { describeError } from "../api/client.ts";
import { useEstimateColumnCollapsed, useMediaQuery, WIDE_QUERY } from "../lib/useEstimateColumn.ts";
import { EstimateColumn, EstimateSummary } from "./EstimateCard.tsx";
import { Banner } from "./Feedback.tsx";
import { Page, PageHead } from "./Page.tsx";
import { ReturnSwitcher, STEP_LABELS, StepNav, stepPath, useReturn, useYear } from "./YearFrame.tsx";

/**
 * A step of one person's return. On a wide screen: a column beside the step with whose return it is and its estimate,
 * every result line in view, then the steps in a row above the step. The column collapses into a bar above the steps,
 * which is also the layout of a narrower screen: whose return it is and the result in one line, with "Details". `aside`
 * (notes for the step) goes below the step. `estimate={false}` leaves the result lines out (Finish shows the result
 * itself): the column keeps the result in one line, and the bar leaves it out.
 */
export function StepLayout({ step, title, estimate = true, aside, children }: { step: Step; title: string; estimate?: boolean; aside?: ReactNode; children: ReactNode }) {
  const { year, reload, reloadError } = useYear();
  const { person } = useReturn();
  const wide = useMediaQuery(WIDE_QUERY);
  const [collapsed, setCollapsed] = useEstimateColumnCollapsed();
  const beside = wide && !collapsed;
  const content = (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHead title={title} />
      {/* The year as last loaded stays, with what was typed in it: a save is refused (409) if the year has moved on. */}
      {reloadError ? (
        <Banner kind="error" title="The year couldn't be loaded again" action={<Button variant="outline" size="sm" onClick={reload}>Try again</Button>}>
          {describeError(reloadError)}
        </Banner>
      ) : null}
      {children}
      {aside}
    </div>
  );
  return (
    <Page
      title={`${person.name} · ${year.year} ${STEP_LABELS[step].toLowerCase()}`}
      crumbs={[["Returns", "/returns"], [String(year.year), `/returns/${year.year}`], [person.name, stepPath(year.year, person.id, "personal")], [STEP_LABELS[step]]]}
      wide={beside}
    >
      {beside ? (
        <div className="grid grid-cols-[18rem_minmax(0,1fr)] items-start gap-8">
          <EstimateColumn switcher={<ReturnSwitcher />} lines={estimate} onCollapse={() => setCollapsed(true)} />
          <div className="flex min-w-0 flex-col gap-5">
            <StepNav />
            {content}
          </div>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* The collapsed column opens again from where it was: the left, before whose return it is. */}
              <div className="flex min-w-0 items-center gap-1">
                {wide ? (
                  <Button variant="outline" size="icon-sm" onClick={() => setCollapsed(false)} aria-label="Show the estimate beside the step" title="Show the estimate beside the step">
                    <ChevronDown aria-hidden="true" />
                  </Button>
                ) : null}
                <ReturnSwitcher />
              </div>
              {estimate ? <EstimateSummary /> : null}
            </div>
            <StepNav />
          </div>
          {content}
        </>
      )}
    </Page>
  );
}
