import { useId } from "react";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

/** An amount in dollars, as typed: `$`, separators and spaces are taken out when it is saved. */
export const cleanAmount = (value: string) => value.replace(/[$,\s]/g, "");

/** An amount to enter. `labelHidden` keeps the label for screen readers only, where the card around it names it. */
export function AmountField({ label, labelHidden = false, help, value, onChange, disabled, issue }: { label: string; labelHidden?: boolean; help?: string; value: string; onChange: (value: string) => void; disabled: boolean; issue?: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className={labelHidden ? "sr-only" : undefined}>
        {label}
      </Label>
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
      <div className="relative w-48">
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        <Input id={id} inputMode="decimal" className="pl-6 text-right tabular-nums" placeholder="0" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-invalid={issue ? true : undefined} />
      </div>
      {issue ? <p className="text-xs text-destructive">{issue}</p> : null}
    </div>
  );
}

