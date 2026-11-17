import { Link } from "react-router";
import type { Step } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Page, PageHead } from "../components/Page.tsx";
import { STEP_LABELS, StepNav, stepPath, useYear } from "../components/YearFrame.tsx";

// Steps 2 to 6 of a year: not available yet. Each says what it will do, so the whole flow reads the same today as it
// will once the step is built; the household (step 1) is the only step that works so far.

const WHAT_IT_WILL_DO: Record<Exclude<Step, "household">, string> = {
  upload:
    "Choose one folder with this year's slips and receipts and last year's notices of assessment. AI sorts each file by type and person, and skips duplicates and files that aren't tax documents.",
  applies:
    "See what your documents show applies to the household, with the file each finding came from. Tick anything that wasn't found and add its file right there.",
  confirm: "One table of every number AI read, grouped by person. Check the flagged ones against the file, then confirm them all.",
  deductions:
    "The deductions and credits from your documents, who claims each one and what it saves, then questions about the ones documents don't show, such as working from home.",
  finish: "Each person's refund or balance owing, the checks, why each key number is what it is, and the CRA forms filled in to download.",
};

export function LaterStep({ step }: { step: Exclude<Step, "household"> }) {
  const { year } = useYear();
  return (
    <Page title={`${year.year} ${STEP_LABELS[step].toLowerCase()}`} crumbs={[["Returns", "/returns"], [String(year.year), `/returns/${year.year}`], [STEP_LABELS[step]]]} wide>
      <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <StepNav />
        <div className="flex min-w-0 flex-col gap-5">
          <PageHead title={STEP_LABELS[step]} />
          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">Not available yet</h2>
              </CardTitle>
              <CardDescription>This step comes in a later version of the app.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <p>
                <b>What it will do:</b> {WHAT_IT_WILL_DO[step]}
              </p>
              <div>
                <Button asChild variant="outline">
                  <Link to={stepPath(year.year, "household")}>Back to the household</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Page>
  );
}
