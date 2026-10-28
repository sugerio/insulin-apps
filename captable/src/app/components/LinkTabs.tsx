import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";

// Tabs whose selection lives in the URL (`?tab=…`), so a view can be linked and survives a reload. Arrow keys, Home and
// End move between tabs as in the WAI-ARIA tabs pattern; each tab is a link, so it also opens in a new browser tab.

export interface LinkTab {
  id: string;
  label: ReactNode;
  to: string;
}

export function LinkTabs({ tabs, selected, label }: { tabs: readonly LinkTab[]; selected: string; label: string }) {
  const navigate = useNavigate();
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    const tab = next === null ? undefined : tabs[next];
    if (!tab) return;
    event.preventDefault();
    navigate(tab.to);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`)?.focus());
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={list}>
      {tabs.map((tab, index) => {
        const active = tab.id === selected;
        return (
          <Link
            key={tab.id}
            to={tab.to}
            role="tab"
            data-tab={tab.id}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={active ? "tab active" : "tab"}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
