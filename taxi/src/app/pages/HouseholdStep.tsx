import { useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  PROVINCES,
  SUPPORTED_PROVINCES,
  canPrepare,
  isIssueOf,
  maritalStatusesFor,
  routes,
  type MaritalStatus,
  type Province,
} from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner } from "../components/Feedback.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, stepsOf, useReturn, useYear } from "../components/YearFrame.tsx";
import { MARITAL_STATUS_LABELS, PROVINCE_LABELS } from "../lib/format.ts";

// Step 1, `/returns/:year/:personId/household`: the facts of the open return that no document tells the app: the
// adult's province and residency, and the marital status on December 31, which the year's returns share. Who is in the
// year is chosen on the Tax years page, and how each person is related on the Household page. The facts are saved
// together, under the year's revision.

export function HouseholdStep() {
  const { year } = useYear();
  // Set once "Save and continue" stops on something missing; kept here because a save remounts the facts below.
  const [showMissing, setShowMissing] = useState(false);
  return (
    <StepLayout step="household" title="Personal info" aside={<TaxNotes year={year.year} />}>
      {/* A new revision (a save, or someone else's) starts the form again from what is stored. */}
      <YearFacts key={year.revision} showMissing={showMissing} onMissing={() => setShowMissing(true)} />
    </StepLayout>
  );
}

/** What each answer means for the tax. */
function TaxNotes({ year }: { year: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2 className="text-sm font-semibold">How these answers affect the tax</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>
          <b className="text-foreground">Spouse in the year.</b> Each of you files a return. Prepared together, credits such as donations and
          medical expenses go to whichever of you saves more. The marital status and the people in the year are the same on both returns.
        </p>
        <p>
          <b className="text-foreground">Marital status.</b> The status on December 31 counts. Married and common-law are taxed the same; the T1
          has a box for each. The year of a separation isn't handled yet.
        </p>
        <p>
          <b className="text-foreground">Province.</b> The province on December 31 sets the provincial tax for all of {year}.
        </p>
        <p>
          <b className="text-foreground">Lived in Canada all year.</b> Moving to or from Canada in {year} changes how income is taxed. This app
          doesn't handle it yet.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The year's facts

interface AdultDraft {
  province: Province | null;
  residentAllYear: boolean | null;
}

function YearFacts({ showMissing, onMissing }: { showMissing: boolean; onMissing: () => void }) {
  const me = useMe();
  const navigate = useNavigate();
  const { year, replace, reload } = useYear();
  const { person: owner, adult } = useReturn();
  const editable = canPrepare(me);
  // The Household's spouse or partner, in this year or not: it decides which statuses there are to choose from.
  const partner = year.people.find((person) => person.relationship === "spouse");
  const statuses = maritalStatusesFor(partner !== undefined);
  // A status saved before the Household changed no longer fits: start from none, so a save can't send it back.
  const [maritalStatus, setMaritalStatus] = useState<MaritalStatus | null>(() =>
    year.maritalStatus !== null && statuses.includes(year.maritalStatus) ? year.maritalStatus : null,
  );
  const [draft, setDraft] = useState<AdultDraft>({ province: adult.province, residentAllYear: adult.residentAllYear });
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });

  async function save(thenContinue: boolean) {
    setState({ status: "saving" });
    try {
      const saved = await apiRequest(routes.saveHousehold, {
        params: { year: year.year },
        body: { revision: year.revision, maritalStatus, adults: [{ personId: owner.id, ...draft }] },
      });
      const done = stepsOf(saved, owner.id)?.household === "done";
      if (thenContinue && !done) onMissing();
      replace(saved);
      if (thenContinue && done) navigate(stepPath(year.year, owner.id, "upload"));
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  const stale = state.status === "error" && state.error instanceof ApiError && state.error.status === 409;
  // This return's issues: its adult's, and those of the facts the year's returns share.
  const issues = year.issues.filter((issue) => isIssueOf(issue, owner.id));
  const blocking = issues.filter((issue) => issue.kind === "blocking");
  const unsupported = issues.filter((issue) => issue.kind === "unsupported");

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold" id="marital-status">
              Marital status on December 31, {year.year}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <RadioGroup
            aria-labelledby="marital-status"
            value={maritalStatus ?? ""}
            onValueChange={(value) => setMaritalStatus(value as MaritalStatus)}
            disabled={!editable}
            className={partner ? "grid gap-2 sm:grid-cols-2" : "grid gap-2 sm:grid-cols-4"}
          >
            {statuses.map((status) => (
              <Choice key={status} value={status} label={MARITAL_STATUS_LABELS[status]} />
            ))}
          </RadioGroup>
          {partner ? null : (
            <Link to={`/household?back=${encodeURIComponent(stepPath(year.year, owner.id, "household"))}`} className="text-sm underline underline-offset-2">
              Add a spouse or partner
            </Link>
          )}
        </CardContent>
      </Card>

      <AdultCard draft={draft} editable={editable} onChange={(change) => setDraft((current) => ({ ...current, ...change }))} />

      {unsupported.map((issue) => (
        <Banner key={`${issue.code}-${issue.personId ?? ""}`} kind="warning" title="Not handled by this app">
          {issue.message}
        </Banner>
      ))}
      {stale ? (
        <Banner kind="error" title="Someone else changed this household" action={<Button variant="outline" size="sm" onClick={reload}>Reload</Button>}>
          {describeError(state.error)}
        </Banner>
      ) : state.status === "error" ? (
        <Banner kind="error" title="The household wasn't saved">{describeError(state.error)}</Banner>
      ) : null}

      {showMissing && blocking.length > 0 ? (
        <Banner kind="error" title="Fill these in to continue">
          <ul className="list-disc pl-5">
            {blocking.map((issue) => (
              <li key={`${issue.code}-${issue.personId ?? ""}`}>{issue.message}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <div className="flex justify-end">
        {editable ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void save(false)} disabled={state.status === "saving"}>
              Save
            </Button>
            <Button onClick={() => void save(true)} disabled={state.status === "saving"}>
              {state.status === "saving" ? "Saving…" : "Save and continue"}
            </Button>
          </div>
        ) : (
          <Button asChild variant="outline">
            <Link to={stepPath(year.year, owner.id, "upload")}>Next step</Link>
          </Button>
        )}
      </div>
    </>
  );
}

function AdultCard({ draft, editable, onChange }: { draft: AdultDraft; editable: boolean; onChange: (change: Partial<AdultDraft>) => void }) {
  const id = useId();
  const others = PROVINCES.filter((province) => !SUPPORTED_PROVINCES.includes(province));
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Where you lived</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-province`}>Province on December 31</Label>
          <NativeSelect
            id={`${id}-province`}
            value={draft.province ?? ""}
            onChange={(event) => onChange({ province: (event.target.value || null) as Province | null })}
            disabled={!editable}
          >
            <NativeSelectOption value="">Choose…</NativeSelectOption>
            {SUPPORTED_PROVINCES.map((province) => (
              <NativeSelectOption key={province} value={province}>
                {PROVINCE_LABELS[province]}
              </NativeSelectOption>
            ))}
            <NativeSelectOptGroup label="Not handled by this app yet">
              {others.map((province) => (
                <NativeSelectOption key={province} value={province}>
                  {PROVINCE_LABELS[province]}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium" id={`${id}-resident`}>
            Lived in Canada all year?
          </p>
          <RadioGroup
            aria-labelledby={`${id}-resident`}
            value={draft.residentAllYear === null ? "" : draft.residentAllYear ? "yes" : "no"}
            onValueChange={(value) => onChange({ residentAllYear: value === "yes" })}
            disabled={!editable}
            className="grid grid-cols-2 gap-2"
          >
            <Choice value="yes" label="Yes" />
            <Choice value="no" label="No" />
          </RadioGroup>
        </div>
      </CardContent>
    </Card>
  );
}


/** One option of a radio group, drawn as a bordered row that is wholly clickable. */
function Choice({ value, label }: { value: string; label: string }) {
  const id = useId();
  return (
    <Label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 has-disabled:cursor-default"
    >
      <RadioGroupItem id={id} value={value} />
      {label}
    </Label>
  );
}

