import { Link } from "react-router";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { EstimateCard } from "../components/EstimateCard.tsx";
import { Page, PageHead } from "../components/Page.tsx";
import { STEP_LABELS, StepNav, stepPath, useYear } from "../components/YearFrame.tsx";

// Step 2 of a year (upload documents): not available yet. It says what it will do; slips are entered in step 4.

const WHAT_IT_WILL_DO: Record<"upload", string> = {
  upload:
    "Choose one folder with this year's slips and receipts and last year's notices of assessment. AI sorts each file by type and person, and skips duplicates and files that aren't tax documents. Until then, enter slips in step 4.",
};

export function LaterStep({ step }: { step: "upload" }) {
  const { year } = useYear();
  return (
    <Page title={`${year.year} ${STEP_LABELS[step].toLowerCase()}`} crumbs={[["Returns", "/returns"], [String(year.year), `/returns/${year.year}`], [STEP_LABELS[step]]]} wide>
      <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px]">
        <StepNav />
        <div className="flex min-w-0 flex-col gap-5">
          <PageHead title={STEP_LABELS[step]} />
          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">Not available yet</h2>
              </CardTitle>
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
        <aside className="lg:col-start-2 xl:col-start-auto">
          <EstimateCard />
        </aside>
      </div>
    </Page>
  );
}
