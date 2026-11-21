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
import { byBox, formatBox } from "../lib/format.ts";
import { normalizeAmount } from "../shared/amount.ts";
import { rulesFor } from "../shared/rules/index.ts";
import type { SlipType } from "../shared/engine/rules.ts";
import { Banner } from "./Feedback.tsx";
import { useYear } from "./YearFrame.tsx";

// A slip's boxes as a table, built from its type in the year's rules (slips.yaml): each box as printed, what it is, and
// its amount. Step 3 shows it open under a found slip; step 4 uses it to add a slip or change one.

/** A slip's boxes: number, what it is, and the amount, as an input when it can be changed. Boxes AI wasn't sure of are marked. */
export function SlipBoxTable({
  slipType,
  boxes,
  unsure = [],
  onChange,
  disabled = false,
  issueFor = () => undefined,
}: {
  slipType: SlipType;
  boxes: Record<string, string>;
  unsure?: string[];
  /** Without it the amounts are shown, not edited. */
  onChange?: (box: string, amount: string) => void;
  disabled?: boolean;
  issueFor?: (path: string) => string | undefined;
}) {
  const id = useId();
  return (
    <Table aria-label={`${slipType.id} boxes`}>
      <TableHeader>
        <TableRow>
          {slipType.receipt ? null : <TableHead className="w-16">Box</TableHead>}
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
              {slipType.receipt ? null : <TableCell className="font-medium tabular-nums">{box}</TableCell>}
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
                    disabled={disabled}
                    aria-label={slipType.receipt ? label : `Box ${box} ${label}`}
                    aria-invalid={issue ? true : undefined}
                  />
                ) : boxes[box] !== undefined ? (
                  formatBox(slipType, box, boxes[box])
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

/** A link to the file a slip came from, to check its amounts against. */
export function OriginalFile({ year, documentId }: { year: number; documentId: string }) {
  return (
    <a className="self-start text-xs underline underline-offset-2" href={`/api/years/${year}/documents/${documentId}/file`} target="_blank" rel="noreferrer">
      Open the original file
    </a>
  );
}

/** The boxes with an amount, as the API takes them: no `$`, separators or spaces, and empty boxes left out. */
function filled(boxes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(boxes)
      .map(([box, amount]) => [box, normalizeAmount(amount)] as const)
      .filter(([, amount]) => amount !== ""),
  );
}

function sameBoxes(a: Record<string, string>, b: Record<string, string>): boolean {
  const left = Object.entries(filled(a));
  const right = filled(b);
  return left.length === Object.keys(right).length && left.every(([box, amount]) => right[box] !== undefined && Number(right[box]) === Number(amount));
}

/** What a slip form holds: its type, issuer and boxes as typed, over the version of the slip they were typed on. */
export interface SlipValues {
  type: string;
  issuer: string;
  boxes: Record<string, string>;
  /** The slip's `updatedAt` (null for a new slip): values typed on an older version of the slip give way to it. */
  basis: number | null;
}

/**
 * A page that runs and keeps a slip form's save (Income): the form starts again whenever the year changes, which can
 * happen while it saves (an upload finishing on another step), so what was typed and why the save failed are kept there.
 */
export interface SlipFormHost {
  /** Calls `send` with the revision to save under, applies the year, and answers whether everything was saved. */
  save: (send: (revision: number) => Promise<TaxYear>) => Promise<boolean>;
  values: SlipValues | undefined;
  /** Keeps the values typed; undefined forgets them and the last error. */
  onValues: (values: SlipValues | undefined) => void;
  /** Why the form's last save failed, or null. */
  error: unknown;
  /** A request of the page is running: nothing here can change. */
  busy: boolean;
}

/**
 * Add a slip (no `slip`; of `type` when given, else chosen) or change one: its issuer and its boxes. `inline` is the
 * form shown open under a slip: its buttons appear once something changed, and Cancel puts the slip's values back.
 * With a `host`, the page around runs the save (Income saves what was added with it) and keeps the form's values and
 * error; without one, the form saves the slip itself.
 */
export function SlipForm({
  personId,
  slip,
  type: presetType,
  onDone = () => {},
  host,
  inline = false,
}: {
  personId: string;
  slip?: Slip;
  type?: string;
  onDone?: () => void;
  host?: SlipFormHost;
  inline?: boolean;
}) {
  const id = useId();
  const { year, replace } = useYear();
  const types = [...rulesFor(year.year)!.slips.values()];
  const basis = slip?.updatedAt ?? null;
  const kept = host?.values?.basis === basis ? host.values : undefined;
  const [type, setType] = useState(kept?.type ?? slip?.type ?? presetType ?? types[0]!.id);
  const [issuer, setIssuer] = useState(kept?.issuer ?? slip?.issuer ?? "");
  const [boxes, setBoxes] = useState<Record<string, string>>(kept?.boxes ?? slip?.boxes ?? {});
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "error"; error: unknown }>({ status: "idle" });
  const slipType: SlipType = types.find((each) => each.id === type)!;
  const changed = !slip || issuer !== slip.issuer || !sameBoxes(boxes, slip.boxes);
  const disabled = host?.busy ?? false;
  const keep = (change: Partial<SlipValues>) => host?.onValues({ type, issuer, boxes, basis, ...change });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState({ status: "saving" });
    const change = { issuer, boxes: filled(boxes) };
    const send = (revision: number) =>
      slip
        ? apiRequest(routes.updateSlip, { params: { year: year.year, id: slip.id }, body: { revision, ...change } })
        : apiRequest(routes.addSlip, { params: { year: year.year }, body: { revision, personId, type, ...change } });
    if (host) {
      // The page keeps why it failed: this form may have started again by the time it answers.
      const saved = await host.save(send);
      setState({ status: "idle" });
      if (saved) onDone();
      return;
    }
    try {
      replace(await send(year.revision));
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
    host?.onValues(undefined);
  }

  const error = host ? (host.error ?? null) : state.status === "error" ? state.error : null;
  const issues = error instanceof ApiError ? (error.body?.error.issues ?? []) : [];
  const issueFor = (path: string) => issues.find((issue) => issue.path === path)?.message;
  // The issues shown beside a field (the issuer, the type's boxes); the banner says the others.
  const unshown = issues.filter((issue) => issue.path !== "issuer" && !(issue.path.startsWith("boxes.") && issue.path.slice("boxes.".length) in slipType.boxes));
  const showActions = !inline || changed || error !== null;

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} aria-label={slip ? `Edit ${slip.type} from ${slip.issuer}` : "Add a slip"}>
      <div className="grid gap-4 sm:grid-cols-2">
        {slip || presetType ? null : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-type`}>Slip</Label>
            <NativeSelect
              id={`${id}-type`}
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                keep({ type: event.target.value });
              }}
              disabled={disabled}
            >
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
          <Input
            id={`${id}-issuer`}
            value={issuer}
            onChange={(event) => {
              setIssuer(event.target.value);
              keep({ issuer: event.target.value });
            }}
            required
            maxLength={100}
            disabled={disabled}
            aria-invalid={issueFor("issuer") ? true : undefined}
          />
          {issueFor("issuer") ? <p className="text-xs text-destructive">{issueFor("issuer")}</p> : null}
        </div>
      </div>
      <SlipBoxTable
        slipType={slipType}
        boxes={boxes}
        unsure={slip && slip.status !== "confirmed" ? slip.unsure : []}
        onChange={(box, amount) => {
          const next = { ...boxes, [box]: amount };
          setBoxes(next);
          keep({ boxes: next });
        }}
        disabled={disabled}
        issueFor={issueFor}
      />
      {error !== null && (issues.length === 0 || unshown.length > 0) ? (
        <Banner kind="error" title="The slip wasn't saved">
          {describeError(error)}
          {unshown.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {unshown.map((issue) => (
                <li key={issue.path}>{issue.message}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
      {showActions ? (
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={disabled || state.status === "saving" || !changed}>
            {state.status === "saving" ? "Saving…" : slip ? "Save" : "Add"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (inline) return reset();
              host?.onValues(undefined);
              onDone();
            }}
            disabled={disabled}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </form>
  );
}
