import type { ReactNode } from "react";

export interface TimelineItem {
  key: string;
  title: ReactNode;
  meta: ReactNode;
}

/** The activity timeline of a record or the dashboard (newest first unless the caller orders it otherwise). */
export function Timeline({ items, empty = "No activity yet.", label }: { items: readonly TimelineItem[]; empty?: string; label?: string }) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ol className="flex flex-col" aria-label={label}>
      {items.map((item) => (
        <li className="relative grid grid-cols-[0.875rem_minmax(0,1fr)] gap-3 pb-4 before:absolute before:top-4 before:bottom-0 before:left-1.5 before:w-px before:bg-border last:pb-0 last:before:hidden" key={item.key}>
          <span className="mt-1 size-3.5 rounded-full border-2 border-primary bg-background" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-sm font-medium">{item.title}</div>
            <div className="text-xs text-muted-foreground">{item.meta}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
