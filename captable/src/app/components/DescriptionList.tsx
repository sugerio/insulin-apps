import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

// Label/value rows, as a real <dl> so each value is announced with its label.

export type DlRow = readonly [label: ReactNode, value: ReactNode] | null | false | undefined;

function isEmpty(value: ReactNode): boolean {
  return value === null || value === undefined || value === "";
}

export function DescriptionList({ rows, split, label }: { rows: readonly DlRow[]; split?: boolean; label?: string }) {
  return (
    <dl className="flex flex-col divide-y text-sm" aria-label={label}>
      {rows.filter((row): row is readonly [ReactNode, ReactNode] => Boolean(row)).map(([term, value], index) => (
        <div
          className={cn(
            "grid gap-0.5 py-2 sm:items-baseline sm:gap-4",
            split ? "sm:grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)]" : "sm:grid-cols-[minmax(9rem,13.5rem)_minmax(0,1fr)]",
          )}
          key={index}
        >
          <dt className="text-muted-foreground">{term}</dt>
          <dd className={cn("wrap-anywhere text-foreground", split && "sm:text-right")}>{isEmpty(value) ? "—" : value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The company page's two-column label-over-value grid. */
export function KeyValueGrid({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid gap-x-12 sm:grid-cols-2">
      {rows.map(([term, value]) => (
        <div className="border-b py-2.5" key={term}>
          <dt className="text-xs font-medium text-muted-foreground">{term}</dt>
          <dd className="mt-0.5 text-base">{isEmpty(value) ? "—" : value}</dd>
        </div>
      ))}
    </dl>
  );
}
