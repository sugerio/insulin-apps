import type { ReactNode } from "react";

// Label/value rows, as a real <dl> so each value is announced with its label.

export type DlRow = readonly [label: ReactNode, value: ReactNode] | null | false | undefined;

function isEmpty(value: ReactNode): boolean {
  return value === null || value === undefined || value === "";
}

export function DescriptionList({ rows, split, label }: { rows: readonly DlRow[]; split?: boolean; label?: string }) {
  return (
    <dl className={split ? "dl split" : "dl"} aria-label={label}>
      {rows.filter((row): row is readonly [ReactNode, ReactNode] => Boolean(row)).map(([term, value], index) => (
        <div className="dl-row" key={index}>
          <dt className="dl-k">{term}</dt>
          <dd className="dl-v">{isEmpty(value) ? "—" : value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The company page's two-column label-over-value grid. */
export function KeyValueGrid({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="kv-grid">
      {rows.map(([term, value]) => (
        <div className="kv" key={term}>
          <dt className="k">{term}</dt>
          <dd className="v">{isEmpty(value) ? "—" : value}</dd>
        </div>
      ))}
    </dl>
  );
}
