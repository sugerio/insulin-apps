import { useState } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { canPrepare, routes, type Person, type Slip, type SlipList } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { OriginalFile, SlipForm } from "../components/SlipForm.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, useReturn, useYear } from "../components/YearFrame.tsx";
import { byBox, formatMoney } from "../lib/format.ts";
import { useSlips } from "../lib/useYearData.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Step 4, `/returns/:year/:personId/confirm`: the slips of the open return, read by AI from the uploads or typed in,
// to check against the paper slips. The form for a slip is built from its type in the year's rules (slips.yaml): its
// boxes as printed. A slip that is the other adult's moves to their return.

export function ConfirmStep() {
  const slips = useSlips();
  return (
    <StepLayout step="confirm" title="Confirm your slips">
      <ResourceView resource={slips}>{(data) => <ReturnSlips data={data} />}</ResourceView>
    </StepLayout>
  );
}

function ReturnSlips({ data }: { data: SlipList }) {
  const me = useMe();
  const { year, replace, reload } = useYear();
  const { person } = useReturn();
  const editable = canPrepare(me);
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });
  const slips = data.slips.filter((slip) => slip.personId === person.id);
  const unconfirmed = slips.filter((slip) => slip.status === "unconfirmed").length;

  async function confirmAll() {
    setState({ status: "saving" });
    try {
      replace(await apiRequest(routes.confirmSlips, { params: { year: year.year }, body: { revision: year.revision, personId: person.id } }));
      setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <>
      <PersonSlips personId={person.id} slips={slips} editable={editable} />
      {state.status === "error" ? (
        state.error instanceof ApiError && state.error.status === 409 ? (
          <Banner kind="error" title="Someone else changed this year" action={<Button variant="outline" size="sm" onClick={reload}>Reload</Button>}>
            {describeError(state.error)}
          </Banner>
        ) : (
          <Banner kind="error" title="The slips weren't confirmed">{describeError(state.error)}</Banner>
        )
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {editable ? (
          <Button variant="outline" onClick={() => void confirmAll()} disabled={unconfirmed === 0 || state.status === "saving"}>
            {unconfirmed === 0 ? "All slips confirmed" : `Confirm ${unconfirmed} ${unconfirmed === 1 ? "slip" : "slips"}`}
          </Button>
        ) : null}
        <Button asChild>
          <Link to={stepPath(year.year, person.id, "deductions")}>Next: deductions</Link>
        </Button>
      </div>
    </>
  );
}

function PersonSlips({ personId, slips, editable }: { personId: string; slips: Slip[]; editable: boolean }) {
  const { year } = useYear();
  const types = rulesFor(year.year)!.slips;
  const others = year.adults.filter((adult) => adult.personId !== personId).map((adult) => year.people.find((person) => person.id === adult.personId)!);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Slips</h2>
        </CardTitle>
        {editable && editing === null ? (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
              <Plus aria-hidden="true" />
              Add a slip
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {slips.length === 0 && editing !== "new" ? <p className="text-sm text-muted-foreground">No slips yet.</p> : null}
        <ul className="flex flex-col divide-y">
          {slips.map((slip) =>
            editing === slip.id ? (
              <li key={slip.id} className="py-3">
                <SlipForm personId={personId} slip={slip} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={slip.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {slip.type} · {slip.issuer}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {byBox(Object.entries(slip.boxes)).map(([box, amount], index) => (
                      <span key={box} className={slip.unsure.includes(box) && slip.status !== "confirmed" ? "font-medium text-amber-700 dark:text-amber-400" : undefined}>
                        {index > 0 ? " · " : ""}
                        Box {box} {types.get(slip.type)?.boxes[box] ?? ""}: {formatMoney(amount)}
                        {slip.unsure.includes(box) && slip.status !== "confirmed" ? " (check)" : ""}
                      </span>
                    ))}
                  </p>
                  {slip.documentId ? (
                    <p className="text-xs">
                      <OriginalFile year={year.year} documentId={slip.documentId} />
                    </p>
                  ) : null}
                  {editable && editing === null
                    ? others.map((other) => (
                        <MoveSlip key={other.id} slip={slip} to={other} />
                      ))
                    : null}
                </div>
                <Badge variant={slip.status === "confirmed" ? "secondary" : "outline"}>{slip.status === "confirmed" ? "Confirmed" : "To confirm"}</Badge>
                {editable && editing === null ? (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(slip.id)} aria-label={`Edit ${slip.type} from ${slip.issuer}`}>
                      Edit
                    </Button>
                    <RemoveSlip slip={slip} />
                  </div>
                ) : null}
              </li>
            ),
          )}
        </ul>
        {editing === "new" ? (
          <div className="rounded-lg border bg-muted/30 p-4">
            <SlipForm personId={personId} onDone={() => setEditing(null)} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RemoveSlip({ slip }: { slip: Slip }) {
  const { year, replace } = useYear();
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Remove ${slip.type} from ${slip.issuer}`}
        onClick={() => {
          setError(null);
          apiRequest(routes.removeSlip, { params: { year: year.year, id: slip.id }, body: { revision: year.revision } }).then(replace, setError);
        }}
      >
        Remove
      </Button>
      {error ? <span className="basis-full text-xs text-destructive">{describeError(error)}</span> : null}
    </>
  );
}

/** A slip that is the other adult's goes to their return, unconfirmed. */
function MoveSlip({ slip, to }: { slip: Slip; to: Person }) {
  const { year, replace } = useYear();
  const [error, setError] = useState<unknown>(null);
  const first = to.name.split(/\s+/)[0] ?? to.name;
  return (
    <p className="text-xs">
      <button
        type="button"
        className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
        aria-label={`Move ${slip.type} from ${slip.issuer} to ${to.name}'s return`}
        onClick={() => {
          setError(null);
          apiRequest(routes.updateSlip, { params: { year: year.year, id: slip.id }, body: { revision: year.revision, personId: to.id } }).then(replace, setError);
        }}
      >
        Not yours? Move to {first}'s return
      </button>
      {error ? <span className="block text-destructive">{describeError(error)}</span> : null}
    </p>
  );
}
