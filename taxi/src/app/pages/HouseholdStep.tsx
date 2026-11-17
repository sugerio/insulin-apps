import { useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  PROVINCES,
  SUPPORTED_PROVINCES,
  canPrepare,
  maritalStatusesFor,
  routes,
  type MaritalStatus,
  type Person,
  type Province,
} from "#shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Label } from "@/components/ui/label.tsx";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { MemberPicker } from "../components/PeopleEditor.tsx";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner } from "../components/Feedback.tsx";
import { Page, PageHead } from "../components/Page.tsx";
import { StepNav, stepPath, useYear } from "../components/YearFrame.tsx";
import { MARITAL_STATUS_LABELS, PROVINCE_LABELS, RELATIONSHIP_LABELS, formatDate } from "../lib/format.ts";

// Step 1, `/returns/:year/household`: who is in the year, and the facts no document tells the app. The people come
// from the Household page; the year picks among them (your spouse in the year means both returns are prepared
// together). The year's facts (marital status on December 31, each adult's province and residency) are saved
// together, under the year's revision.

export function HouseholdStep() {
  const { year } = useYear();
  // Set once "Save and continue" stops on something missing; kept here because a save remounts the facts below.
  const [showMissing, setShowMissing] = useState(false);
  return (
    <Page title={`${year.year} household`} crumbs={[["Returns", "/returns"], [String(year.year), `/returns/${year.year}`], ["Household"]]} wide>
      <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px]">
        <StepNav />
        <div className="flex min-w-0 flex-col gap-5">
          <PageHead title={`Your household in ${year.year}`} />
          <YearPeopleCard />
          {/* A new revision (a save, or someone else's) starts the form again from what is stored. */}
          <YearFacts key={year.revision} showMissing={showMissing} onMissing={() => setShowMissing(true)} />
        </div>
        <aside className="lg:col-start-2 xl:col-start-auto">
          <TaxNotes year={year.year} />
        </aside>
      </div>
    </Page>
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
          medical expenses go to whichever of you saves more.
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
// Who is in the year

function YearPeopleCard() {
  const me = useMe();
  const { year, replace } = useYear();
  const editable = canPrepare(me);
  const [changing, setChanging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(year.members));
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });
  const members = year.people.filter((person) => year.members.includes(person.id));
  const addPerson = `/household?back=${encodeURIComponent(stepPath(year.year, "household"))}`;

  async function save() {
    setState({ status: "saving" });
    try {
      const ids = year.people.filter((person) => person.relationship === "self" || selected.has(person.id)).map((person) => person.id);
      replace(await apiRequest(routes.setYearPeople, { params: { year: year.year }, body: { revision: year.revision, people: ids } }));
      setChanging(false);
      setState({ status: "idle" });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Who is in {year.year}</h2>
        </CardTitle>
        {editable && !changing ? (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => { setSelected(new Set(year.members)); setChanging(true); }}>
              Change
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {changing ? (
          <>
            <MemberPicker
              people={year.people}
              selected={selected}
              onChange={setSelected}
              disabled={state.status === "saving"}
              footer={
                <Link to={addPerson} className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm font-medium hover:bg-muted">
                  <Plus className="size-4" aria-hidden="true" />
                  Add a new person
                </Link>
              }
            />
            {state.status === "error" ? <Banner kind="error" title="Who is in the year wasn't changed">{describeError(state.error)}</Banner> : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void save()} disabled={state.status === "saving"}>
                {state.status === "saving" ? "Saving…" : "Save people"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setChanging(false)} disabled={state.status === "saving"}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <ul className="flex flex-col divide-y">
            {members.map((person) => (
              <li key={person.id} className="flex flex-wrap justify-between gap-3 py-2.5 text-sm">
                <span className="font-medium">{person.name}</span>
                <span className="text-muted-foreground">
                  {RELATIONSHIP_LABELS[person.relationship]} · Born {formatDate(person.birthDate)}
                </span>
              </li>
            ))}
          </ul>
        )}
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
  const editable = canPrepare(me);
  // The Household's spouse or partner, in this year or not: it decides which statuses there are to choose from.
  const partner = year.people.find((person) => person.relationship === "spouse");
  const statuses = maritalStatusesFor(partner !== undefined);
  // A status saved before the Household changed no longer fits: start from none, so a save can't send it back.
  const [maritalStatus, setMaritalStatus] = useState<MaritalStatus | null>(() =>
    year.maritalStatus !== null && statuses.includes(year.maritalStatus) ? year.maritalStatus : null,
  );
  const [adults, setAdults] = useState<Record<string, AdultDraft>>(() =>
    Object.fromEntries(year.adults.map((adult) => [adult.personId, { province: adult.province, residentAllYear: adult.residentAllYear }])),
  );
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });

  const self = year.people.find((person) => person.relationship === "self");
  // The year's adults: you, and your spouse when in the year (their returns are prepared together).
  const prepared = year.adults.map((adult) => year.people.find((person) => person.id === adult.personId)).filter((person): person is Person => person !== undefined);
  const draftOf = (personId: string): AdultDraft => adults[personId] ?? { province: null, residentAllYear: null };
  const setAdult = (personId: string, change: Partial<AdultDraft>) => setAdults((current) => ({ ...current, [personId]: { ...draftOf(personId), ...change } }));

  async function save(thenContinue: boolean) {
    setState({ status: "saving" });
    try {
      const saved = await apiRequest(routes.saveHousehold, {
        params: { year: year.year },
        body: {
          revision: year.revision,
          maritalStatus,
          adults: prepared.map((person) => ({ personId: person.id, ...draftOf(person.id) })),
        },
      });
      if (thenContinue && saved.steps.household !== "done") onMissing();
      replace(saved);
      if (thenContinue && saved.steps.household === "done") navigate(stepPath(year.year, "upload"));
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  const stale = state.status === "error" && state.error instanceof ApiError && state.error.status === 409;
  const blocking = year.issues.filter((issue) => issue.kind === "blocking");
  const unsupported = year.issues.filter((issue) => issue.kind === "unsupported");

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold" id="marital-status">
              {partner && self && year.prepareTogether
                ? `${firstName(self)} and ${firstName(partner)}'s status on December 31, ${year.year}`
                : `Your marital status on December 31, ${year.year}`}
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
            <Link to={`/household?back=${encodeURIComponent(`/returns/${year.year}/household`)}`} className="text-sm underline underline-offset-2">
              Add a spouse or partner
            </Link>
          )}
        </CardContent>
      </Card>

      {prepared.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {prepared.map((person) => (
            <AdultCard key={person.id} person={person} draft={draftOf(person.id)} editable={editable} onChange={(change) => setAdult(person.id, change)} />
          ))}
        </div>
      ) : null}

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
            <Link to={stepPath(year.year, "upload")}>Next step</Link>
          </Button>
        )}
      </div>
    </>
  );
}

function AdultCard({ person, draft, editable, onChange }: { person: Person; draft: AdultDraft; editable: boolean; onChange: (change: Partial<AdultDraft>) => void }) {
  const id = useId();
  const others = PROVINCES.filter((province) => !SUPPORTED_PROVINCES.includes(province));
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">{person.name}</h2>
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

/** The first word of a person's name, for labels that name both adults. */
const firstName = (person: Person) => person.name.split(/\s+/)[0] ?? person.name;

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

