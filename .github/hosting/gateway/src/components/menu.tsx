// A pop-up menu that works without JavaScript: <details>/<summary>, styled like shadcn/ui's DropdownMenu (the content
// and item classes are its own). The pages run no script, so the Radix DropdownMenu can't be used.
//
// - Keyboard: Tab reaches the trigger, Enter or Space opens and closes it, Tab then moves through the items in order.
// - Menus that share a `name` are exclusive (<details name>): opening one closes the others.
// - While a menu is open its trigger's ::before covers the window, so a click anywhere else closes it. (Escape can't,
//   without a script; the trigger closes it again.)
import * as React from "react"
import { cn } from "@/lib/utils"

export function Menu({ className, ...props }: React.ComponentProps<"details">) {
  return <details data-slot="menu" className={cn("group/menu relative", className)} {...props} />
}

export function MenuTrigger({ className, ...props }: React.ComponentProps<"summary">) {
  return (
    <summary
      data-slot="menu-trigger"
      className={cn(
        "list-none [&::-webkit-details-marker]:hidden",
        "group-open/menu:before:fixed group-open/menu:before:inset-0 group-open/menu:before:z-40 group-open/menu:before:cursor-default group-open/menu:before:content-['']",
        className
      )}
      {...props}
    />
  )
}

export function MenuContent({
  className,
  align = "end",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="menu-content"
      className={cn(
        "absolute top-full z-50 mt-2 max-w-[calc(100vw-2rem)] w-max min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
        align === "end" ? "right-0" : "left-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * DropdownMenuItem's look, for the links and buttons inside a menu. Hover and keyboard focus both highlight; keyboard
 * focus also gets the ring, since the highlight alone is too faint to find.
 */
export const menuItemClass = cn(
  "relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none",
  "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
  "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"
)

export function MenuLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="menu-label" className={cn("px-2 py-1.5 text-sm font-medium", className)} {...props} />
}

export function MenuSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return <div role="none" data-slot="menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}
