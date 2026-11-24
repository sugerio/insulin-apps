import { useState } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { canPrepare, routes, type Person, type TaxYear } from "#shared";
import { Button } from "@/components/ui/button.tsx";
import { apiRequest, describeError } from "../api/client.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { RELATIONSHIP_LABELS } from "../lib/format.ts";
import { Banner } from "./Feedback.tsx";
import { MemberPicker } from "./PeopleEditor.tsx";

/**
 * Who is in a started year, and the choice to change it: you always; your spouse or partner to prepare their return
 * too; the dependants who lived with you. Someone taken out loses their facts, answers, slips and uploaded files for
 * that year (a spouse taken out turns a joint return into married filing separately). On the
 * Tax years page and on Personal info; "Add a new person" goes to the Profile page and comes back to `back`. `onSaved`
 * gets the year as saved.
 */
export function YearPeople({
  year,
  revision,
  members: memberIds,
  people,
  onSaved,
  back,
}: {
  year: number;
  revision: number;
  members: string[];
  people: Person[];
  onSaved: (saved: TaxYear) => void;
  back: string;
}) {
  const me = useMe();
  const [changing, setChanging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(memberIds));
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });
  const members = people.filter((person) => memberIds.includes(person.id));
  const leaving = members.filter((person) => person.relationship !== "self" && !selected.has(person.id));
  const addPerson = `/profile?back=${encodeURIComponent(back)}`;

  async function save() {
    setState({ status: "saving" });
    try {
      const ids = people.filter((person) => person.relationship === "self" || selected.has(person.id)).map((person) => person.id);
      const saved = await apiRequest(routes.setYearPeople, { params: { year }, body: { revision, people: ids } });
      setChanging(false);
      setState({ status: "idle" });
      onSaved(saved);
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <section aria-label={`People in ${year}`} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">People in {year}</h3>
        {canPrepare(me) && !changing ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSelected(new Set(memberIds));
              setChanging(true);
            }}
          >
            Change
          </Button>
        ) : null}
      </div>
      {changing ? (
        <>
          <MemberPicker
            people={people}
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
          {leaving.length > 0 ? (
            <Banner kind="warning" title={`Taking ${leaving.map((person) => person.name).join(" and ")} out of ${year}`}>
              Their facts, answers and slips for {year}, and the files uploaded in their return, are deleted when you save.
              {leaving.some((person) => person.relationship === "spouse") ? " Without your spouse in the year, a joint return becomes married filing separately." : ""}
            </Banner>
          ) : null}
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
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {members.map((person) => (
            <li key={person.id} className="min-w-0 wrap-anywhere">
              <span className="font-medium">{person.name}</span> <span className="text-muted-foreground">· {RELATIONSHIP_LABELS[person.relationship]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
