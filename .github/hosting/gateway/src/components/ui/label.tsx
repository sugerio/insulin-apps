// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/label.json. Server-rendered only, so the Radix
// Label primitive (a <label> plus a client-side mouse handler) is replaced by the <label> it renders.
import * as React from "react"
import { cn } from "@/lib/utils"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
