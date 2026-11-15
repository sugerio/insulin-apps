import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.tsx";
import { showsWrite, type WriteAccess } from "../lib/permissions.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { useWorkspace } from "./OrgWorkspace.tsx";

// The page's Actions menu (shadcn/ui's DropdownMenu) and inline write buttons. Write items are hidden from editors;
// every item leads to its flow (`onSelect` or `to`, `onClick` or `to`), and one disabled for a reason of its own shows
// that reason (see lib/permissions.ts).

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
  // Radix opens the menu on a primary pointerdown (and on Enter, Space or ArrowDown); a click that follows a pointerdown
  // it already handled is ignored, and a click with no pointerdown before it (assistive technology) toggles it.
  const pointerHandled = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (visible.length === 0) return null;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          type="button"
          onPointerDown={(event) => {
            pointerHandled.current = event.button === 0 && !event.ctrlKey;
          }}
          onClick={() => {
            if (pointerHandled.current) {
              pointerHandled.current = false;
              return;
            }
            setOpen((value) => !value);
          }}
        >
          {label} <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" loop className="w-72">
        {visible.map((item, index) => {
          if (item === "separator") return <DropdownMenuSeparator key={`sep-${index}`} />;
          const content = (
            <>
              {item.icon ? <Icon name={item.icon} /> : null}
              <span className="min-w-0 flex-1">
                {item.label}
                {item.sub ? <span className="block text-xs text-muted-foreground">{item.sub}</span> : null}
                {item.reason ? <span className="block text-xs text-muted-foreground">{item.reason}</span> : null}
              </span>
            </>
          );
          const variant = item.danger ? "destructive" : "default";
          if (item.to && !item.disabled) {
            return (
              <DropdownMenuItem key={item.label} variant={variant} asChild>
                <Link to={item.to}>{content}</Link>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem
              key={item.label}
              variant={variant}
              disabled={item.disabled}
              title={item.reason}
              className="items-start"
              onSelect={() => {
                // The dialog an item opens takes what has focus as the place to return to when it closes: the menu
                // button, not the item, which is gone once the menu closes.
                trigger.current?.focus();
                item.onSelect?.();
              }}
            >
              {content}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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

const BUTTON_VARIANTS = { primary: "default", secondary: "outline", ghost: "ghost", danger: "destructive" } as const;

/** An inline write button (Mark executed, Upload): hidden from those who can't use it. */
export function WriteButton({ label, icon, kind = "ghost", size, disabledReason, onClick, to, ariaLabel }: WriteButtonProps) {
  const access = useWriteAccess();
  if (!showsWrite(access)) return null;
  const variant = BUTTON_VARIANTS[kind];
  const content = <>{icon ? <Icon name={icon} /> : null}{label}</>;
  if (to && disabledReason === undefined) {
    return (
      <Button asChild variant={variant} size={size}>
        <Link to={to} aria-label={ariaLabel}>{content}</Link>
      </Button>
    );
  }
  return (
    <Button type="button" variant={variant} size={size} disabled={disabledReason !== undefined} title={disabledReason} aria-label={ariaLabel} onClick={onClick}>
      {content}
    </Button>
  );
}
