import { useId, useState, type FormEvent } from "react";
import { routes, type Slip, type TaxYear } from "#shared";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { cn } from "@/lib/utils.ts";
import { ApiError, apiRequest, describeError } from "../api/client.ts";
import { byBox, formatMoney } from "../lib/format.ts";
import { rulesFor } from "../shared/rules/index.ts";
import type { SlipType } from "../shared/engine/rules.ts";
import { Banner } from "./Feedback.tsx";
import { useYear } from "./YearFrame.tsx";

// A slip's boxes as a table, built from its type in the year's rules (slips.yaml): each box as printed, what it is, and
// its amount. Step 3 shows it open under a found slip; step 4 uses it to add a slip or change one.

export interface SlipChange {
  issuer: string;
  boxes: Record<string, string>;
}

/** A slip's boxes: number, what it is, and the amount, as an input when it can be changed. Boxes AI wasn't sure of are marked. */
export function SlipBoxTable({
  slipType,
  boxes,
  unsure = [],
  onChange,
  issueFor = () => undefined,
}: {
  slipType: SlipType;
  boxes: Record<string, string>;
  unsure?: string[];
  /** Without it the amounts are shown, not edited. */
  onChange?: (box: string, amount: string) => void;
  issueFor?: (path: string) => string | undefined;
}) {
  const id = useId();
  return (
    <Table aria-label={`${slipType.id} boxes`}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">Box</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="w-40 text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {byBox(Object.entries(slipType.boxes)).map(([box, label]) => {
          const check = unsure.includes(box);
          const issue = issueFor(`boxes.${box}`);
          return (
            <TableRow key={box} className={cn(check && "bg-amber-50 dark:bg-amber-950/30")}>
              <TableCell className="font-medium tabular-nums">{box}</TableCell>
              <TableCell className="whitespace-normal">
                <label htmlFor={onChange ? `${id}-${box}` : undefined}>{label}</label>
                {check ? (
                  <Badge variant="outline" className="ml-2 border-amber-500/50 text-amber-800 dark:text-amber-300">
                    check
                  </Badge>
                ) : null}
                {issue ? <p className="text-xs text-destructive">{issue}</p> : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {onChange ? (
                  <Input
                    id={`${id}-${box}`}
                    inputMode="decimal"
                    className="h-8 text-right tabular-nums"
                    value={boxes[box] ?? ""}
                    onChange={(event) => onChange(box, event.target.value)}
                    aria-label={`Box ${box} ${label}`}
                    aria-invalid={issue ? true : undefined}
                  />
                ) : boxes[box] !== undefined ? (
                  formatMoney(boxes[box])
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The boxes with an amount, as the API takes them: no `$`, separators or spaces, and empty boxes left out. */
function filled(boxes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(boxes)
      .map(([box, amount]) => [box, amount.replace(/[$,\s]/g, "")] as const)
      .filter(([, amount]) => amount !== ""),
  );
}

function sameBoxes(a: Record<string, string>, b: Record<string, string>): boolean {
  const left = Object.entries(filled(a));
  const right = filled(b);
  return left.length === Object.keys(right).length && left.every(([box, amount]) => right[box] !== undefined && Number(right[box]) === Number(amount));
}

/**
 * Add a slip (no `slip`) or change one: its issuer and its boxes. `inline` is the form shown open under a slip: its
 * buttons appear once something changed, and Cancel puts the slip's values back. `save` replaces how a change to an
 * existing slip is saved (step 3 saves its answers first); it answers with the year as saved.
 */
export function SlipForm({
  personId,
  slip,
  onDone = () => {},
  save,
  inline = false,
}: {
  personId: string;
  slip?: Slip;
  onDone?: () => void;
  save?: (change: SlipChange) => Promise<TaxYear>;
  inline?: boolean;
}) {
  const id = useId();
  const { year, replace } = useYear();
  const types = [...rulesFor(year.year)!.slips.values()];
  const [type, setType] = useState(slip?.type ?? types[0]!.id);
  const [issuer, setIssuer] = useState(slip?.issuer ?? "");
  const [boxes, setBoxes] = useState<Record<string, string>>(slip?.boxes ?? {});
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });
  const slipType: SlipType = types.find((each) => each.id === type)!;
  const changed = !slip || issuer !== slip.issuer || !sameBoxes(boxes, slip.boxes);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState({ status: "saving" });
    const change = { issuer, boxes: filled(boxes) };
    try {
      const saved = slip
        ? save
          ? await save(change)
          : await apiRequest(routes.updateSlip, { params: { year: year.year, id: slip.id }, body: { revision: year.revision, ...change } })
        : await apiRequest(routes.addSlip, { params: { year: year.year }, body: { revision: year.revision, personId, type, ...change } });
      replace(saved);
      setState({ status: "idle" });
      onDone();
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  function reset() {
    setIssuer(slip?.issuer ?? "");
    setBoxes(slip?.boxes ?? {});
    setState({ status: "idle" });
  }

  const issues = state.status === "error" && state.error instanceof ApiError ? (state.error.body?.error.issues ?? []) : [];
  const issueFor = (path: string) => issues.find((issue) => issue.path === path)?.message;
  const showActions = !inline || changed || state.status === "error";

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} aria-label={slip ? `Edit ${slip.type} from ${slip.issuer}` : "Add a slip"}>
      <div className="grid gap-4 sm:grid-cols-2">
        {slip ? null : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-type`}>Slip</Label>
            <NativeSelect id={`${id}-type`} value={type} onChange={(event) => setType(event.target.value)}>
              {types.map((each) => (
                <NativeSelectOption key={each.id} value={each.id}>
                  {each.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-issuer`}>Issued by</Label>
          <Input id={`${id}-issuer`} value={issuer} onChange={(event) => setIssuer(event.target.value)} required maxLength={100} aria-invalid={issueFor("issuer") ? true : undefined} />
          {issueFor("issuer") ? <p className="text-xs text-destructive">{issueFor("issuer")}</p> : null}
        </div>
      </div>
      <SlipBoxTable
        slipType={slipType}
        boxes={boxes}
        unsure={slip && slip.status !== "confirmed" ? slip.unsure : []}
        onChange={(box, amount) => setBoxes((current) => ({ ...current, [box]: amount }))}
        issueFor={issueFor}
      />
      {state.status === "error" && issues.length === 0 ? <Banner kind="error" title="The slip wasn't saved">{describeError(state.error)}</Banner> : null}
      {showActions ? (
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={state.status === "saving" || !changed}>
            {state.status === "saving" ? "Saving…" : slip ? "Save" : "Add"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={inline ? reset : onDone}>
            Cancel
          </Button>
        </div>
      ) : null}
    </form>
  );
}
