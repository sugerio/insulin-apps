import { useId } from "react";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { cn } from "@/lib/utils.ts";

/** An amount in dollars, as typed: `$`, separators and spaces are taken out when it is saved. */
export const cleanAmount = (value: string) => value.replace(/[$,%\s]/g, "");

/**
 * An amount to enter, in dollars, as a percent, or a count (no unit). `labelHidden` keeps the label for screen readers only, where the card
 * around it names it.
 */
export function AmountField({
  label,
  labelHidden = false,
  help,
  value,
  onChange,
  disabled,
  issue,
  unit = "$",
}: {
  label: string;
  labelHidden?: boolean;
  help?: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  issue?: string;
  unit?: "$" | "%" | "";
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className={labelHidden ? "sr-only" : undefined}>
        {label}
      </Label>
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
      <div className="relative w-48">
        {unit ? (
          <span className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-sm text-muted-foreground", unit === "$" ? "left-2.5" : "right-2.5")}>{unit}</span>
        ) : null}
        <Input
          id={id}
          inputMode={unit ? "decimal" : "numeric"}
          className={cn("text-right tabular-nums", unit === "$" ? "pl-6" : unit === "%" ? "pr-7" : undefined)}
          placeholder="0"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={issue ? true : undefined}
        />
      </div>
      {issue ? <p className="text-xs text-destructive">{issue}</p> : null}
    </div>
  );
}

