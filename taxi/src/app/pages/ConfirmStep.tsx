import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { canPrepare, possibleDuplicates, routes, unreadBoxes, type Person, type Slip, type SlipList } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner, ErrorState, Loading } from "../components/Feedback.tsx";
import { OriginalFile, SlipForm, type SlipFormHost, type SlipValues } from "../components/SlipForm.tsx";
import { StepLayout } from "../components/StepLayout.tsx";
import { stepPath, useReturn, useYear } from "../components/YearFrame.tsx";
import { byBox, formatBox } from "../lib/format.ts";
import { useSlips } from "../lib/useYearData.ts";
import { documentName } from "../shared/engine/rules.ts";
import { rulesFor } from "../shared/rules/index.ts";

// Step 4, `/returns/:year/:personId/confirm`: the slips of the open return, read by AI from the uploads or typed in,
// to check against the paper slips. The form for a slip is built from its type in the year's rules (slips.yaml): its
// boxes as printed. A slip that is the other adult's moves to their return. A slip that may be the same as one above
// it (another reading of it, never merged on its own) says so, for the person to remove one or keep both.

export function ConfirmStep() {
  const slips = useSlips();
  const { year, replace } = useYear();
  const { person } = useReturn();
  // Kept here, over the slips, which load again whenever the year changes (a save, an upload finishing on another step):
  // the slip open to change ("new" for one being added), what was typed in it and why its save failed, and what the page
  // has to say about it. This step is mounted once per return, so each has its own.
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const values = useRef<Record<string, SlipValues>>({});
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The slips as last loaded, shown while they load again so an open form stays open; until they are loaded, nothing
  // that rests on them can be done (ReturnSlips' `waiting`, SlipFormHost.waiting).
  const last = useRef<SlipList | null>(null);
  if (slips.status === "ready") last.current = slips.data;
  const fresh = slips.status === "ready" ? slips.data : null;
  const forget = (key: string) => {
    delete values.current[key];
    setErrors(({ [key]: _forgotten, ...others }) => others);
  };

  // Once the slips are loaded again, the slip being changed: gone, its form closes. Changed meanwhile, its form starts
  // again from what is stored, dropping what was typed and why its save was refused, and says so (SlipForm).
  useEffect(() => {
    if (!fresh || editing === null || editing === "new") return;
    if (!fresh.slips.some((each) => each.id === editing && each.personId === person.id)) {
      forget(editing);
      setEditing(null);
      setNotice("The slip you were changing was removed or replaced.");
    }
  }, [fresh, editing, person.id]);

  const hostOf = (key: string): SlipFormHost => ({
    async save(send) {
      setSaving(true);
      setErrors(({ [key]: _forgotten, ...others }) => others);
      try {
        replace(await send(year.revision));
        delete values.current[key];
        return true;
      } catch (error) {
        setErrors((current) => ({ ...current, [key]: error }));
        return false;
      } finally {
        setSaving(false);
      }
    },
    values: values.current[key],
    onValues: (next) => (next ? void (values.current[key] = next) : forget(key)),
    error: errors[key] ?? null,
    busy: saving,
    waiting: fresh === null,
  });

  const shown = fresh ?? last.current;
  return (
    <StepLayout step="confirm" title="Confirm your slips">
      {shown ? (
        <ReturnSlips
          data={shown}
          waiting={fresh === null}
          reloadError={slips.status === "error" ? slips.error : null}
          onRetry={slips.reload}
          editing={editing}
          onEditing={(next) => {
            setNotice(null);
            setEditing(next);
          }}
          hostOf={hostOf}
          notice={notice}
        />
      ) : slips.status === "error" ? (
        <ErrorState error={slips.error} onRetry={slips.reload} />
      ) : (
        <Loading />
      )}
    </StepLayout>
  );
}

function ReturnSlips({
  data,
  waiting,
  reloadError,
  onRetry,
  editing,
  onEditing: setEditing,
  hostOf,
  notice,
}: {
  data: SlipList;
  /** The slips are loading again (the list shown may not be the one stored): confirming, adding, removing and moving wait. */
  waiting: boolean;
  /** Why loading them again failed, or null. */
  reloadError: unknown;
  onRetry: () => void;
  /** The slip open to change, or "new" for one being added. Confirming waits for it: it would confirm the slip as stored. */
  editing: string | "new" | null;
  onEditing: (editing: string | "new" | null) => void;
  hostOf: (key: string) => SlipFormHost;
  notice: string | null;
}) {
  const me = useMe();
  const { year, replace, reload } = useYear();
  const { person } = useReturn();
  const editable = canPrepare(me);
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });
  const slips = data.slips.filter((slip) => slip.personId === person.id);
  const unconfirmed = slips.filter((slip) => slip.status === "unconfirmed").length;
  // The server refuses to confirm a slip with a box AI couldn't read and no amount.
  const unread = slips.some((slip) => slip.status === "unconfirmed" && unreadBoxes(slip).length > 0);

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
      {notice ? <Banner kind="warning" title={notice} /> : null}
      {reloadError ? (
        <Banner kind="error" title="The slips couldn't be loaded again" action={<Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}>
          {describeError(reloadError)} Until they are, nothing here can be saved or confirmed.
        </Banner>
      ) : null}
      {/* Confirming confirms the slips as stored: nothing in them changes until it ends. */}
      <PersonSlips
        personId={person.id}
        slips={slips}
        editable={editable}
        busy={state.status === "saving" || waiting}
        editing={editing}
        onEditing={setEditing}
        hostOf={hostOf}
      />
      {state.status === "error" ? (
        state.error instanceof ApiError && state.error.status === 409 ? (
          <Banner
            kind="error"
            title="Someone else changed this year"
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setState({ status: "idle" });
                  reload();
                }}
              >
                Reload
              </Button>
            }
          >
            {describeError(state.error)}
          </Banner>
        ) : (
          <Banner kind="error" title="The slips weren't confirmed">{describeError(state.error)}</Banner>
        )
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {editable && waiting && !reloadError ? (
          <p className="mr-auto text-xs text-muted-foreground">Loading the slips again…</p>
        ) : editable && editing !== null && unconfirmed > 0 ? (
          <p className="mr-auto text-xs text-muted-foreground">Save or cancel the slip you're changing before confirming.</p>
        ) : editable && unread ? (
          <p className="mr-auto text-xs text-muted-foreground">Before confirming, enter each box that couldn't be read, or 0 if it is blank on the slip: choose Edit on its slip.</p>
        ) : null}
        {editable ? (
          <Button
            variant="outline"
            onClick={() => void confirmAll()}
            disabled={unconfirmed === 0 || unread || editing !== null || waiting || state.status === "saving"}
          >
            {unconfirmed === 0 ? "All slips confirmed" : `Confirm ${unconfirmed} ${unconfirmed === 1 ? "slip" : "slips"}`}
          </Button>
        ) : null}
        <Button asChild>
          <Link to={stepPath(year.year, person.id, "finish")}>Next: finish</Link>
        </Button>
      </div>
    </>
  );
}

function PersonSlips({
  personId,
  slips,
  editable,
  busy,
  editing,
  onEditing: setEditing,
  hostOf,
}: {
  personId: string;
  slips: Slip[];
  editable: boolean;
  /** The slips are being confirmed, or loaded again: none can be added, opened, removed or moved meanwhile. */
  busy: boolean;
  editing: string | "new" | null;
  onEditing: (editing: string | "new" | null) => void;
  /** Runs and keeps each slip form's save, by slip (or "new"), over the slips loading again. */
  hostOf: (key: string) => SlipFormHost;
}) {
  const { year } = useYear();
  const types = rulesFor(year.country, year.year)!.slips;
  const duplicates = possibleDuplicates(rulesFor(year.country, year.year)!, slips);
  const others = year.adults.filter((adult) => adult.personId !== personId).map((adult) => year.people.find((person) => person.id === adult.personId)!);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Slips</h2>
        </CardTitle>
        {editable && editing === null ? (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setEditing("new")} disabled={busy}>
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
                {/* A new version of the slip (someone else's change) starts the form again from it. */}
                <SlipForm key={slip.updatedAt} personId={personId} slip={slip} host={hostOf(slip.id)} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={slip.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1 wrap-anywhere">
                  <p className="text-sm font-medium">
                    {documentName(types.get(slip.type), slip.type)} · {slip.issuer}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {/* A box AI couldn't read has no amount: it is shown, so the slip isn't confirmed without it. */}
                    {byBox<string | null>([...Object.entries(slip.boxes), ...unreadBoxes(slip).map((box): [string, null] => [box, null])]).map(([box, amount], index) => {
                      const check = amount === null || (slip.unsure.includes(box) && slip.status !== "confirmed");
                      return (
                        <span key={box} className={check ? "font-medium text-amber-700 dark:text-amber-400" : undefined}>
                          {index > 0 ? " · " : ""}
                          {types.get(slip.type)?.receipt ? "" : `Box ${box} `}
                          {types.get(slip.type)?.boxes[box] ?? ""}: {amount === null ? "couldn't be read" : formatBox(types.get(slip.type), box, amount)}
                          {check ? " (check)" : ""}
                        </span>
                      );
                    })}
                  </p>
                  {slip.documentId ? (
                    <p className="text-xs">
                      <OriginalFile year={year.year} documentId={slip.documentId} />
                    </p>
                  ) : null}
                  {duplicates.has(slip.id) ? (
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                      May be the same slip as the {documentName(types.get(slip.type), slip.type)} from {duplicates.get(slip.id)!.issuer} above: if so, remove one; if
                      they're different slips, keep both.
                    </p>
                  ) : null}
                  {editable && editing === null
                    ? others.map((other) => (
                        <MoveSlip key={other.id} slip={slip} to={other} disabled={busy} />
                      ))
                    : null}
                </div>
                <Badge variant={slip.status === "confirmed" ? "secondary" : "outline"}>{slip.status === "confirmed" ? "Confirmed" : "To confirm"}</Badge>
                {editable && editing === null ? (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(slip.id)} disabled={busy} aria-label={`Edit ${slip.type} from ${slip.issuer}`}>
                      Edit
                    </Button>
                    <RemoveSlip slip={slip} disabled={busy} />
                  </div>
                ) : null}
              </li>
            ),
          )}
        </ul>
        {editing === "new" ? (
          <div className="rounded-lg border bg-muted/30 p-4">
            <SlipForm personId={personId} host={hostOf("new")} onDone={() => setEditing(null)} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RemoveSlip({ slip, disabled }: { slip: Slip; disabled: boolean }) {
  const { year, replace } = useYear();
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
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
function MoveSlip({ slip, to, disabled }: { slip: Slip; to: Person; disabled: boolean }) {
  const { year, replace } = useYear();
  const [error, setError] = useState<unknown>(null);
  const first = to.name.split(/\s+/)[0] ?? to.name;
  return (
    <p className="text-xs">
      <button
        type="button"
        disabled={disabled}
        className="text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
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
