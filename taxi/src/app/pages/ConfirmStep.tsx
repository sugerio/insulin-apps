import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { canPrepare, routes, type Slip, type SlipList } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ResourceView } from "../components/Feedback.tsx";
import { StepLayout, useAdults } from "../components/StepLayout.tsx";
import { stepPath, useYear } from "../components/YearFrame.tsx";
import { byBox, formatMoney } from "../lib/format.ts";
import { useSlips } from "../lib/useYearData.ts";
import { rulesFor } from "../shared/rules/index.ts";
import type { SlipType } from "../shared/engine/rules.ts";

// Step 4, `/returns/:year/confirm`: every slip of the year's adults, entered by hand for now (AI reading comes with
// step 2). The form for a slip is built from its type in the year's rules (slips.yaml): its boxes as printed.

export function ConfirmStep() {
  const slips = useSlips();
  return (
    <StepLayout step="confirm" title="Confirm your slips">
      <ResourceView resource={slips}>{(data) => <SlipsByPerson data={data} />}</ResourceView>
    </StepLayout>
  );
}

function SlipsByPerson({ data }: { data: SlipList }) {
  const me = useMe();
  const { year, replace, reload } = useYear();
  const adults = useAdults();
  const editable = canPrepare(me);
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });
  const unconfirmed = data.slips.filter((slip) => slip.status === "unconfirmed").length;

  async function confirmAll() {
    setState({ status: "saving" });
    try {
      replace(await apiRequest(routes.confirmSlips, { params: { year: year.year }, body: { revision: year.revision } }));
      setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <>
      {adults.map((adult) => (
        <PersonSlips key={adult.personId} personId={adult.personId} name={adult.person.name} slips={data.slips.filter((slip) => slip.personId === adult.personId)} editable={editable} />
      ))}
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
          <Link to={stepPath(year.year, "deductions")}>Next: deductions</Link>
        </Button>
      </div>
    </>
  );
}

function PersonSlips({ personId, name, slips, editable }: { personId: string; name: string; slips: Slip[]; editable: boolean }) {
  const { year } = useYear();
  const types = rulesFor(year.year)!.slips;
  const [editing, setEditing] = useState<string | "new" | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">{name}</h2>
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
                    {byBox(Object.entries(slip.boxes))
                      .map(([box, amount]) => `Box ${box} ${types.get(slip.type)?.boxes[box] ?? ""}: ${formatMoney(amount)}`)
                      .join(" · ")}
                  </p>
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

/** Add a slip (no `slip`) or change one: its type's boxes, each blank or an amount. */
function SlipForm({ personId, slip, onDone }: { personId: string; slip?: Slip; onDone: () => void }) {
  const id = useId();
  const { year, replace } = useYear();
  const types = [...rulesFor(year.year)!.slips.values()];
  const [type, setType] = useState(slip?.type ?? types[0]!.id);
  const [issuer, setIssuer] = useState(slip?.issuer ?? "");
  const [boxes, setBoxes] = useState<Record<string, string>>(slip?.boxes ?? {});
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });
  const slipType: SlipType = types.find((each) => each.id === type)!;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState({ status: "saving" });
    const filled = Object.fromEntries(Object.entries(boxes).map(([box, amount]) => [box, amount.replace(/[$,\s]/g, "")]).filter(([, amount]) => amount !== ""));
    try {
      const saved = slip
        ? await apiRequest(routes.updateSlip, { params: { year: year.year, id: slip.id }, body: { revision: year.revision, issuer, boxes: filled } })
        : await apiRequest(routes.addSlip, { params: { year: year.year }, body: { revision: year.revision, personId, type, issuer, boxes: filled } });
      replace(saved);
      onDone();
    } catch (error) {
      setState({ status: "error", error });
    }
  }
  const issues = state.status === "error" && state.error instanceof ApiError ? (state.error.body?.error.issues ?? []) : [];
  const issueFor = (path: string) => issues.find((issue) => issue.path === path)?.message;

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} aria-label={slip ? `Edit ${slip.type} from ${slip.issuer}` : "Add a slip"}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-type`}>Slip</Label>
          <NativeSelect id={`${id}-type`} value={type} onChange={(event) => setType(event.target.value)} disabled={slip !== undefined}>
            {types.map((each) => (
              <NativeSelectOption key={each.id} value={each.id}>
                {each.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-issuer`}>Issued by</Label>
          <Input id={`${id}-issuer`} value={issuer} onChange={(event) => setIssuer(event.target.value)} required maxLength={100} aria-invalid={issueFor("issuer") ? true : undefined} />
          {issueFor("issuer") ? <p className="text-xs text-destructive">{issueFor("issuer")}</p> : null}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {byBox(Object.entries(slipType.boxes)).map(([box, label]) => (
          <div key={box} className="flex flex-col gap-1">
            <Label htmlFor={`${id}-box-${box}`} className="text-xs font-normal">
              <span className="font-medium">Box {box}</span> {label}
            </Label>
            <Input
              id={`${id}-box-${box}`}
              inputMode="decimal"
              value={boxes[box] ?? ""}
              onChange={(event) => setBoxes((current) => ({ ...current, [box]: event.target.value }))}
              aria-invalid={issueFor(`boxes.${box}`) ? true : undefined}
            />
            {issueFor(`boxes.${box}`) ? <p className="text-xs text-destructive">{issueFor(`boxes.${box}`)}</p> : null}
          </div>
        ))}
      </div>
      {state.status === "error" && issues.length === 0 ? <Banner kind="error" title="The slip wasn't saved">{describeError(state.error)}</Banner> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={state.status === "saving"}>
          {state.status === "saving" ? "Saving…" : slip ? "Save" : "Add"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
