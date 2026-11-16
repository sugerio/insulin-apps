import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";
import { cn } from "@/lib/utils.ts";
import { UnsettledScope } from "../lib/unsettled.ts";

// A modal dialog and a side drawer, on shadcn/ui's Dialog and Sheet (Radix): focus moves in on open, Tab stays inside,
// Escape or the backdrop closes, and focus returns to what opened it. A modal that can't be dismissed (a write whose
// outcome isn't known yet) ignores Escape and the backdrop and disables its close button. Both are open while mounted:
// the caller unmounts them in onClose.

interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export const NOT_DISMISSIBLE = "Settle the write first: Try again, or Check what was recorded.";

/** Whether a write inside the open modal (an upload in its form) is unsettled: its own close buttons wait too. */
const NestedHeld = createContext(false);

/**
 * A footer's Cancel or Close: disabled while a write inside the dialog is unsettled, like the dialog's own ✕. An outline
 * Button; `className` adds to it.
 */
export function DismissButton({ onClick, children, className, disabled }: { onClick: () => void; children: ReactNode; className?: string; disabled?: boolean }) {
  const held = useContext(NestedHeld);
  return (
    <Button type="button" variant="outline" className={className} onClick={onClick} disabled={held || disabled} title={held ? NOT_DISMISSIBLE : undefined}>
      {children}
    </Button>
  );
}

/** The opener a dialog that just unmounted gives back, unless the dialog that replaces it takes it over first. */
let handoff: { opener: HTMLElement | null; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Gives focus back to what had it when the dialog opened. Radix returns it to a DialogTrigger; these dialogs have none
 * (the caller mounts them), so they note the opener and focus it once they have unmounted, after Radix's focus trap has
 * let go. A dialog that replaces another in the same flow (its form after its loading state) takes over that opener.
 */
export function useReturnFocus(): (event: Event) => void {
  useLayoutEffect(() => {
    let opener = document.activeElement as HTMLElement | null;
    if (handoff) {
      clearTimeout(handoff.timer);
      opener = handoff.opener;
      handoff = null;
    }
    return () => {
      const timer = setTimeout(() => {
        if (handoff?.timer === timer) handoff = null;
        if (opener?.isConnected) opener.focus();
      }, 0);
      handoff = { opener, timer };
    };
  }, []);
  return (event: Event) => event.preventDefault();
}

/** The ✕ in a dialog's corner: a ghost icon Button named "Close". */
function CloseButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" className="absolute top-3 right-3" aria-label="Close" onClick={onClick} disabled={disabled} title={disabled ? NOT_DISMISSIBLE : undefined}>
      <XIcon aria-hidden="true" />
    </Button>
  );
}

export function Drawer({ title, onClose, children, footer }: DialogProps) {
  const returnFocus = useReturnFocus();
  return (
    <Sheet open onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="right" showCloseButton={false} aria-describedby={undefined} onCloseAutoFocus={returnFocus} className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b pr-14">
          <SheetTitle className="text-base font-semibold">{title}</SheetTitle>
        </SheetHeader>
        <CloseButton onClick={onClose} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</div>
        {footer ? <SheetFooter className="flex-row flex-wrap justify-end border-t">{footer}</SheetFooter> : null}
      </SheetContent>
    </Sheet>
  );
}

export function Modal({ title, onClose, children, footer, dismissible = true, className }: DialogProps & { dismissible?: boolean; className?: string }) {
  // Writes inside the dialog (an upload in a command's form) whose outcome isn't known yet hold it open too.
  const [nested, setNested] = useState(0);
  const change = useCallback((delta: number) => setNested((count) => Math.max(0, count + delta)), []);
  const open = dismissible && nested === 0;
  const close = () => {
    if (open) onClose();
  };
  const hold = (event: Event) => {
    if (!open) event.preventDefault();
  };
  const returnFocus = useReturnFocus();
  return (
    <UnsettledScope value={change}>
      <NestedHeld value={nested > 0}>
        <Dialog open onOpenChange={(next) => { if (!next) close(); }}>
          <DialogContent
            showCloseButton={false}
            aria-describedby={undefined}
            onEscapeKeyDown={hold}
            onPointerDownOutside={hold}
            onInteractOutside={hold}
            onCloseAutoFocus={returnFocus}
            className={cn("flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-xl", className)}
          >
            <DialogHeader className="border-b px-5 py-4 pr-14">
              <DialogTitle className="text-base leading-snug font-semibold">{title}</DialogTitle>
            </DialogHeader>
            <CloseButton onClick={close} disabled={!open} />
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
            {footer ? <DialogFooter className="mx-0 mb-0 flex-row flex-wrap justify-end">{footer}</DialogFooter> : null}
          </DialogContent>
        </Dialog>
      </NestedHeld>
    </UnsettledScope>
  );
}
