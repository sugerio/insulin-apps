import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { showsWrite, type WriteAccess } from "../lib/permissions.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";

// The page's Actions menu and inline write buttons. Write items are hidden from editors; every item leads to its flow
// (`onSelect` or `to`, `onClick` or `to`), and one disabled for a reason of its own shows that reason (see
// lib/permissions.ts).

const OwnRecordContext = createContext(false);

/**
 * Wraps a page (or a row) about the admin's own holdings or stakeholder record: no write affordance inside it is shown
 * — not the Actions menu, not Upload, not an inline button — because no admin records a write on their own holdings
 * (the server refuses with 403 self_dealing). Reads such as Download stay.
 */
export function OwnRecordScope({ own, children }: { own: boolean; children: ReactNode }) {
  const outer = useContext(OwnRecordContext);
  return <OwnRecordContext value={outer || own}>{children}</OwnRecordContext>;
}

/** The workspace's write access, narrowed to nothing inside an OwnRecordScope. */
export function useWriteAccess(): WriteAccess {
  const { canWrite } = useWorkspace();
  const own = useContext(OwnRecordContext);
  return { canWrite: canWrite && !own };
}

interface ActionBase {
  label: string;
  icon?: IconName;
  /** A second line, e.g. what "Reverse last transaction" would reverse. */
  sub?: string;
  danger?: boolean;
  /** False for reads such as Download: shown to every admin. Default true. */
  write?: boolean;
  /** Disabled, with this reason shown. */
  disabledReason?: string;
}

/** A menu item, and where it leads: a dialog it opens (`onSelect`) or a page (`to`). */
export type ActionItem = ActionBase & ({ onSelect: () => void; to?: undefined } | { to: string; onSelect?: undefined });

export type ActionEntry = ActionItem | "separator" | null | false | undefined;

type ResolvedItem = ActionItem & {
  disabled: boolean;
  reason: string | undefined;
};

function useVisible(entries: readonly ActionEntry[]): (ResolvedItem | "separator")[] {
  const access = useWriteAccess();
  const visible: (ResolvedItem | "separator")[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "separator") {
      visible.push(entry);
      continue;
    }
    if (entry.write !== false && !showsWrite(access)) continue;
    visible.push({ ...entry, disabled: entry.disabledReason !== undefined, reason: entry.disabledReason });
  }
  while (visible[0] === "separator") visible.shift();
  while (visible.at(-1) === "separator") visible.pop();
  return visible.filter((item, index) => !(item === "separator" && visible[index - 1] === "separator"));
}

export function ActionsMenu({ items, label = "Actions" }: { items: readonly ActionEntry[]; label?: string }) {
  const visible = useVisible(items);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (visible.length === 0) return null;
  const focusable = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const focusItem = (index: number) => {
    const elements = focusable();
    elements[(index + elements.length) % elements.length]?.focus();
  };
  const openAndFocus = (index: number) => {
    setOpen(true);
    requestAnimationFrame(() => focusItem(index));
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAndFocus(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAndFocus(-1);
    }
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const elements = focusable();
    const index = elements.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") focusItem(index + 1);
    else if (event.key === "ArrowUp") focusItem(index - 1);
    else if (event.key === "Home") focusItem(0);
    else if (event.key === "End") focusItem(elements.length - 1);
    else if (event.key === "Escape") close();
    else if (event.key === "Tab") close(false);
    else return;
    if (event.key !== "Tab") event.preventDefault();
  };
  return (
    <div className={open ? "menu open" : "menu"} ref={root}>
      <button
        ref={button}
        type="button"
        className="btn btn-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onButtonKey}
      >
        {label} <Icon name="chevDown" />
      </button>
      {open ? (
        <div className="menu-pop" role="menu" id={menuId} aria-label={label} onKeyDown={onMenuKey}>
          {visible.map((item, index) => {
            if (item === "separator") return <div className="menu-sep" role="separator" key={`sep-${index}`} />;
            const content = (
              <>
                {item.icon ? <Icon name={item.icon} /> : null}
                <span>
                  {item.label}
                  {item.sub ? <span className="mi-sub">{item.sub}</span> : null}
                  {item.reason ? <span className="mi-sub">{item.reason}</span> : null}
                </span>
              </>
            );
            const className = item.danger ? "menu-item danger" : "menu-item";
            if (item.to && !item.disabled) {
              return (
                <Link key={item.label} role="menuitem" className={className} to={item.to} onClick={() => setOpen(false)}>
                  {content}
                </Link>
              );
            }
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={className}
                aria-disabled={item.disabled || undefined}
                title={item.reason}
                onClick={() => {
                  if (item.disabled) return;
                  close();
                  item.onSelect?.();
                }}
              >
                {content}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

type WriteButtonProps = {
  label: ReactNode;
  icon?: IconName;
  kind?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "xs";
  /** Disabled, with this reason as its title. */
  disabledReason?: string;
  /** The accessible name, when the visible label alone is ambiguous in a table row. */
  ariaLabel?: string;
} & (
  | { onClick: () => void; to?: undefined }
  // A flow on a page of its own (Record FMV).
  | { to: string; onClick?: undefined }
);

/** An inline write button (Mark executed, Upload): hidden from those who can't use it. */
export function WriteButton({ label, icon, kind = "ghost", size, disabledReason, onClick, to, ariaLabel }: WriteButtonProps) {
  const access = useWriteAccess();
  if (!showsWrite(access)) return null;
  const className = `btn btn-${kind}${size ? ` btn-${size}` : ""}`;
  const content = <>{icon ? <Icon name={icon} /> : null}{label}</>;
  if (to && disabledReason === undefined) return <Link className={className} to={to} aria-label={ariaLabel}>{content}</Link>;
  return (
    <button type="button" className={className} disabled={disabledReason !== undefined} title={disabledReason} aria-label={ariaLabel} onClick={onClick}>
      {content}
    </button>
  );
}
