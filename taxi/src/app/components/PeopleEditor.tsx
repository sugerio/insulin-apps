import { useId, useState, type FormEvent, type ReactNode } from "react";
import { routes, type Person, type Relationship } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { RELATIONSHIP_LABELS, formatDate } from "../lib/format.ts";
import { Banner } from "./Feedback.tsx";

// The people in the profile: the list with Add, Edit and Remove (the Profile page), and the picker that chooses who is
// in a tax year (Start a year, and step 1 of a year).

/** The people in the profile, editable by someone who prepares returns. `onChanged` runs after every saved change. */
export function PeopleEditor({ people, editable, onChanged }: { people: Person[]; editable: boolean; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | "new" | null>(people.length === 0 && editable ? "new" : null);
  const [error, setError] = useState<unknown>(null);

  async function remove(person: Person) {
    setError(null);
    try {
      await apiRequest(routes.removePerson, { params: { id: person.id } });
      await onChanged();
    } catch (failure) {
      setError(failure);
    }
  }
  const done = async () => {
    setEditing(null);
    await onChanged();
  };

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
        <ul className="flex flex-col divide-y">
          {people.map((person) =>
            editing === person.id ? (
              <li key={person.id} className="py-3">
                <PersonForm person={person} people={people} onDone={done} onCancel={() => setEditing(null)} />
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
            <PersonForm people={people} onDone={done} onCancel={people.length === 0 ? undefined : () => setEditing(null)} />
          </div>
        ) : null}
        {error ? <Banner kind="error" title="The person wasn't removed">{describeError(error)}</Banner> : null}
      </CardContent>
    </Card>
  );
}

/** The relationships a person may take: one "you" and one spouse or partner per profile. */
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

/**
 * Who is in a tax year: a checkbox per person of the profile. You are always ticked; ticking your spouse prepares
 * both returns together. `footer` sits under the list (the link to add someone to the profile).
 */
export function MemberPicker({ people, selected, onChange, disabled = false, footer }: {
  people: Person[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  footer?: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="sr-only">Who is in this year</legend>
      {people.map((person) => {
        const self = person.relationship === "self";
        return (
          <Label
            key={person.id}
            htmlFor={`${id}-${person.id}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
          >
            <Checkbox
              id={`${id}-${person.id}`}
              aria-labelledby={`${id}-${person.id}-name`}
              aria-describedby={`${id}-${person.id}-note`}
              className="mt-0.5"
              checked={self || selected.has(person.id)}
              disabled={self || disabled}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked === true) next.add(person.id);
                else next.delete(person.id);
                onChange(next);
              }}
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium" id={`${id}-${person.id}-name`}>
                {person.name}
              </span>
              <span className="text-xs text-muted-foreground" id={`${id}-${person.id}-note`}>
                {RELATIONSHIP_LABELS[person.relationship]}
              </span>
            </span>
          </Label>
        );
      })}
      {footer}
    </fieldset>
  );
}
