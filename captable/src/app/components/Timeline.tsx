import type { ReactNode } from "react";

export interface TimelineItem {
  key: string;
  title: ReactNode;
  meta: ReactNode;
}

/** The activity timeline of a record or the dashboard (newest first unless the caller orders it otherwise). */
export function Timeline({ items, empty = "No activity yet.", label }: { items: readonly TimelineItem[]; empty?: string; label?: string }) {
  if (items.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ol className="timeline" aria-label={label}>
      {items.map((item) => (
        <li className="tl-item" key={item.key}>
          <span className="tl-dot" aria-hidden="true" />
          <div>
            <div className="tl-t">{item.title}</div>
            <div className="tl-m">{item.meta}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
