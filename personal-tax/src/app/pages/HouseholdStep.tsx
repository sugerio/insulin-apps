import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  MARITAL_STATUSES,
  PROVINCES,
  SUPPORTED_PROVINCES,
  canPrepare,
  hasPartner,
  routes,
  type MaritalStatus,
  type Person,
  type Province,
  type Relationship,
} from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { Banner } from "../components/Feedback.tsx";
import { Page, PageHead } from "../components/Page.tsx";
import { StepNav, stepPath, useYear } from "../components/YearFrame.tsx";
import { MARITAL_STATUS_LABELS, PROVINCE_LABELS, RELATIONSHIP_LABELS, formatDate } from "../lib/format.ts";

// Step 1, `/returns/:year/household`: who is in the household, and the facts no document tells the app. People are the
// household's (the same every year) and are saved one at a time; the year's facts (marital status on December 31,
// preparing together, each adult's province and residency) are saved together, under the year's revision.

export function HouseholdStep() {
  const { year } = useYear();
  return (
    <Page title={`${year.year} household`} crumbs={[["Returns", "/returns"], [String(year.year), `/returns/${year.year}`], ["Household"]]} wide>
      <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px]">
        <StepNav />
        <div className="flex min-w-0 flex-col gap-5">
          <PageHead
            title={`Your household in ${year.year}`}
            sub="Who is in the household, and a few facts the documents can't tell us. AI will use the names to sort each document to the right person."
          />
          <PeopleCard />
          {/* A new revision (a save, or someone else's) starts the form again from what is stored. */}
          <YearFacts key={year.revision} />
        </div>
        <aside className="flex flex-col gap-4 lg:col-start-2 xl:col-start-auto">
          <Card size="sm">
            <CardHeader>
              <CardTitle>
                <h2 className="text-sm font-semibold">Next: one folder</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Put this year's slips and receipts, and last year's notices of assessment, in one folder. You'll pick that folder in the next step.
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle>
                <h2 className="text-sm font-semibold">What we don't store</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              No SIN, home address or bank details. You write them on the paper return when you sign it.
            </CardContent>
          </Card>
        </aside>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// People

function PeopleCard() {
  const me = useMe();
  const { year, replace } = useYear();
  const editable = canPrepare(me);
  const [editing, setEditing] = useState<string | "new" | null>(year.people.length === 0 && editable ? "new" : null);
  const [error, setError] = useState<unknown>(null);
  const hasSelf = year.people.some((person) => person.relationship === "self");

  /** After a change to the people, the year as the server now sees it (no loading state: the form keeps its draft). */
  async function refresh() {
    replace(await apiRequest(routes.getYear, { params: { year: year.year } }));
  }
  async function remove(person: Person) {
    setError(null);
    try {
      await apiRequest(routes.removePerson, { params: { id: person.id } });
      await refresh();
    } catch (failure) {
      setError(failure);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">People</h2>
        </CardTitle>
        {editable && editing === null ? (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
              Add person
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {!hasSelf && editing !== "new" ? <p className="text-sm text-muted-foreground">Start with yourself: the person preparing the returns.</p> : null}
        <ul className="flex flex-col divide-y">
          {year.people.map((person) =>
            editing === person.id ? (
              <li key={person.id} className="py-3">
                <PersonForm person={person} people={year.people} onDone={async () => { setEditing(null); await refresh(); }} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <li key={person.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{person.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {RELATIONSHIP_LABELS[person.relationship]} · Born {formatDate(person.birthDate)}
                  </p>
                </div>
                {editable && editing === null ? (
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(person.id)} aria-label={`Edit ${person.name}`}>
                      Edit
                    </Button>
                    {person.relationship === "self" ? null : (
                      <Button variant="ghost" size="sm" onClick={() => void remove(person)} aria-label={`Remove ${person.name}`}>
                        Remove
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            ),
          )}
        </ul>
        {editing === "new" ? (
          <div className="rounded-lg border bg-muted/30 p-4">
            <PersonForm people={year.people} onDone={async () => { setEditing(null); await refresh(); }} onCancel={year.people.length === 0 ? undefined : () => setEditing(null)} />
          </div>
        ) : null}
        {error ? <Banner kind="error" title="The person wasn't removed">{describeError(error)}</Banner> : null}
      </CardContent>
    </Card>
  );
}

/** The relationships a person may take: one "you" and one spouse or partner per household. */
function allowedRelationships(people: Person[], person?: Person): Relationship[] {
  const taken = (relationship: Relationship) => people.some((other) => other.relationship === relationship && other.id !== person?.id);
  if (person?.relationship === "self") return ["self"];
  const options: Relationship[] = taken("self") ? [] : ["self"];
  if (!taken("spouse")) options.push("spouse");
  options.push("child", "other_dependant");
  return options;
}

function PersonForm({ person, people, onDone, onCancel }: { person?: Person; people: Person[]; onDone: () => Promise<void>; onCancel?: () => void }) {
  const id = useId();
  const options = allowedRelationships(people, person);
  const [name, setName] = useState(person?.name ?? "");
  const [relationship, setRelationship] = useState<Relationship>(person?.relationship ?? options[0] ?? "child");
  const [birthDate, setBirthDate] = useState(person?.birthDate ?? "");
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState({ status: "saving" });
    try {
      const body = { name, relationship, birthDate };
      if (person) await apiRequest(routes.updatePerson, { params: { id: person.id }, body });
      else await apiRequest(routes.addPerson, { body });
      await onDone();
    } catch (error) {
      setState({ status: "error", error });
    }
  }
  const issues = state.status === "error" && state.error instanceof ApiError ? (state.error.body?.error.issues ?? []) : [];
  const issueFor = (field: string) => issues.find((issue) => issue.path === field)?.message;

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} aria-label={person ? `Edit ${person.name}` : "Add a person"}>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} autoComplete="off"
            aria-invalid={issueFor("name") ? true : undefined} />
          {issueFor("name") ? <p className="text-xs text-destructive">{issueFor("name")}</p> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-relationship`}>Relationship</Label>
          <NativeSelect id={`${id}-relationship`} value={relationship} onChange={(event) => setRelationship(event.target.value as Relationship)}
            disabled={options.length === 1}>
            {options.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {RELATIONSHIP_LABELS[option]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-birth`}>Birth date</Label>
          <Input id={`${id}-birth`} type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} required
            aria-invalid={issueFor("birthDate") ? true : undefined} />
          {issueFor("birthDate") ? <p className="text-xs text-destructive">{issueFor("birthDate")}</p> : null}
        </div>
      </div>
      {state.status === "error" && issues.length === 0 ? (
        <Banner kind="error" title={person ? "The change wasn't saved" : "The person wasn't added"}>{describeError(state.error)}</Banner>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={state.status === "saving"}>
          {state.status === "saving" ? "Saving…" : person ? "Save" : "Add"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The year's facts

interface AdultDraft {
  province: Province | null;
  residentAllYear: boolean | null;
}

function YearFacts() {
  const me = useMe();
  const navigate = useNavigate();
  const { year, replace, reload } = useYear();
  const editable = canPrepare(me);
  const [maritalStatus, setMaritalStatus] = useState<MaritalStatus | null>(year.maritalStatus);
  const [prepareTogether, setPrepareTogether] = useState(year.prepareTogether);
  const [adults, setAdults] = useState<Record<string, AdultDraft>>(() =>
    Object.fromEntries(year.adults.map((adult) => [adult.personId, { province: adult.province, residentAllYear: adult.residentAllYear }])),
  );
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });

  const self = year.people.find((person) => person.relationship === "self");
  const spouse = year.people.find((person) => person.relationship === "spouse");
  const partnered = hasPartner(maritalStatus);
  const prepared = [self, spouse && partnered && prepareTogether ? spouse : undefined].filter((person): person is Person => person !== undefined);
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
          prepareTogether,
          adults: year.people
            .filter((person) => person.relationship === "self" || person.relationship === "spouse")
            .map((person) => ({ personId: person.id, ...draftOf(person.id) })),
        },
      });
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
              {spouse && self ? `${firstName(self)} and ${firstName(spouse)}'s status on December 31, ${year.year}` : `Your marital status on December 31, ${year.year}`}
            </h2>
          </CardTitle>
          <CardDescription>As the T1 asks it. It decides whose credits can be shared and whose return is prepared with yours.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            aria-labelledby="marital-status"
            value={maritalStatus ?? ""}
            onValueChange={(value) => setMaritalStatus(value as MaritalStatus)}
            disabled={!editable}
            className="grid gap-2 sm:grid-cols-3"
          >
            {MARITAL_STATUSES.map((status) => (
              <Choice key={status} value={status} label={MARITAL_STATUS_LABELS[status]} />
            ))}
          </RadioGroup>
        </CardContent>
      </Card>

      {spouse && self && partnered ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold" id="together">
                Prepare both returns together?
              </h2>
            </CardTitle>
            <CardDescription>
              Together, the app can move donations, medical expenses and other credits between you to pay less. Each of you still files your own return.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup
              aria-labelledby="together"
              value={prepareTogether ? "together" : "self"}
              onValueChange={(value) => setPrepareTogether(value === "together")}
              disabled={!editable}
              className="grid gap-2 sm:grid-cols-2"
            >
              <Choice value="together" label="Yes, together" />
              <Choice value="self" label={`Only ${firstName(self)}`} />
            </RadioGroup>
          </CardContent>
        </Card>
      ) : null}

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

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card px-5 py-4">
        {blocking.length > 0 ? (
          <div className="text-sm">
            <p className="font-medium">Before you continue</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {blocking.map((issue) => (
                <li key={`${issue.code}-${issue.personId ?? ""}`}>{issue.message}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">As last saved.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">The household is complete for {year.year}.</p>
        )}
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

