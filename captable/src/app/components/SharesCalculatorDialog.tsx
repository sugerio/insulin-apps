import { useId, useState, type ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { api } from "#shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { apiRequest } from "../api/request.ts";
import { useReturnFocus } from "./Dialog.tsx";
import { compareDecimals, formatFractionPercent, fractionOf, fromUnits, isPositive, multiplyDecimals, toUnits } from "../lib/decimal.ts";
import { describeError } from "../lib/errors.ts";
import { allOf, useResource } from "../lib/useResource.ts";
import { useWorkspace } from "./OrgWorkspace.tsx";

// The % shares calculator: what a target share of the company comes to, read-only and for admins (fully diluted figures
// never reach the holder view). Options needed = floor(fully diluted × target %), with no gross-up:
// fully diluted already counts the unissued pool a grant comes from. The value uses a preferred class's original issue
// price, the cost the common FMV of the 409A in effect today. Exact decimals throughout; nothing is recorded.

const ONE = toUnits("1");
/** A percentage as typed: up to 6 decimals, above 0 and at most 100. */
const PERCENT = /^\d{1,3}(?:\.\d{1,6})?$/;

/** The whole options that come to at most `percent`% of `fullyDiluted`. */
export function optionsForPercent(fullyDiluted: string, percent: string): string {
  return fromUnits(((toUnits(fullyDiluted) * toUnits(percent)) / (ONE * 100n) / ONE) * ONE);
}

function percentError(value: string): string | null {
  if (value.trim() === "") return "Enter a percentage.";
  if (!PERCENT.test(value.trim())) return "Enter a percentage such as 0.25, with at most 6 decimals.";
  if (!isPositive(value.trim()) || compareDecimals(value.trim(), "100") > 0) return "Enter a percentage above 0 and at most 100.";
  return null;
}

export function SharesCalculatorDialog({ fullyDiluted, onClose }: { fullyDiluted: string; onClose: () => void }) {
  const { orgId, format, today } = useWorkspace();
  const ids = { percent: useId(), price: useId() };
  const classes = useResource((signal) => apiRequest(api.routes.listStockClasses, { params: { orgId }, signal }), [orgId]);
  const fmv = useResource((signal) => apiRequest(api.routes.getFmv, { params: { orgId }, query: { date: today }, signal }), [orgId, today]);
  const [percent, setPercent] = useState("");
  const [classId, setClassId] = useState<string | null>(null);
  const loaded = allOf(classes, fmv);
  const error = percentError(percent);
  const preferred = (classes.data?.items ?? []).filter((item) => item.classType === "PREFERRED" && item.originalIssuePrice !== null);
  // The latest round is the usual yardstick: the highest original issue price, until another class is chosen.
  const chosen = preferred.find((item) => item.id === classId)
    ?? [...preferred].sort((a, b) => compareDecimals(b.originalIssuePrice, a.originalIssuePrice))[0] ?? null;
  const options = error ? null : optionsForPercent(fullyDiluted, percent.trim());
  const commonFmv = fmv.data?.fmv ?? null;

  const returnFocus = useReturnFocus();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent onCloseAutoFocus={returnFocus} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>% shares calculator</DialogTitle>
          <DialogDescription>
            How many options a share of the company comes to, what they are worth at a preferred price, and what they cost to exercise at today's 409A FMV. Estimate — not tax
            advice. Nothing is recorded.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-invalid={percent !== "" && error ? true : undefined}>
            <FieldLabel htmlFor={ids.percent}>Target % of fully diluted</FieldLabel>
            <Input id={ids.percent} inputMode="decimal" placeholder="0.25" value={percent} aria-invalid={percent !== "" && error ? true : undefined}
              onChange={(event) => setPercent(event.target.value)} />
            <FieldDescription>Of {format.shares(fullyDiluted)} fully diluted shares today, which already count the unissued pool.</FieldDescription>
            {percent !== "" && error ? <FieldError>{error}</FieldError> : null}
          </Field>
          {preferred.length ? (
            <Field>
              <FieldLabel htmlFor={ids.price}>Value at the price of</FieldLabel>
              <Select value={chosen?.id ?? ""} onValueChange={setClassId}>
                <SelectTrigger id={ids.price} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {preferred.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.name} ({format.price(item.originalIssuePrice)})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </FieldGroup>
        {loaded.data === undefined ? (
          loaded.error !== undefined ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Couldn't load the prices</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                {describeError(loaded.error)}
                <Button variant="outline" size="sm" onClick={loaded.reload}>Try again</Button>
              </AlertDescription>
            </Alert>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">Loading the prices…</p>
          )
        ) : options === null ? null : (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 rounded-lg border p-3" aria-label="Estimate">
            <Line term="Options needed">{format.shares(options)}</Line>
            <Line term="Share of fully diluted">{formatFractionPercent(fractionOf(options, fullyDiluted), 4)}</Line>
            {chosen ? (
              <Line term={`Value at ${chosen.name} price (${format.price(chosen.originalIssuePrice)})`}>{format.money(multiplyDecimals(options, chosen.originalIssuePrice))}</Line>
            ) : (
              <Line term="Value at a preferred price">No preferred class has an original issue price</Line>
            )}
            {commonFmv ? (
              <Line term={`Cost to exercise at the 409A FMV (${format.price(commonFmv.pricePerShare)})`}>{format.money(multiplyDecimals(options, commonFmv.pricePerShare))}</Line>
            ) : (
              <Line term="Cost to exercise">No 409A is in effect today</Line>
            )}
          </dl>
        )}
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Close</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Line({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="text-right font-medium tabular-nums">{children}</dd>
    </>
  );
}
