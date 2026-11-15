import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { cn } from "@/lib/utils.ts";

// Tabs whose selection lives in the URL (`?tab=…`), so a view can be linked and survives a reload. Arrow keys, Home and
// End move between tabs as in the WAI-ARIA tabs pattern; each tab is a link, so it also opens in a new browser tab.
// Drawn as shadcn/ui's TabsList and TabsTrigger (default variant), which are Radix's in-page tabs; these are links.

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
    <div
      className="no-scrollbar mb-4 inline-flex h-9 w-fit max-w-full items-center overflow-x-auto rounded-lg bg-muted p-[3px] text-muted-foreground"
      role="tablist"
      aria-label={label}
      ref={list}
    >
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
            data-active={active || undefined}
            className={cn(
              "inline-flex h-full items-center justify-center rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:text-muted-foreground dark:hover:text-foreground",
              active && "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground",
            )}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
