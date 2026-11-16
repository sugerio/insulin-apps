import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";

/** What a dialog's review shows beside the server's preview: a muted panel, named "Review" unless told otherwise. */
export function ReviewPanel({ children, label = "Review", className }: { children: ReactNode; label?: string; className?: string }) {
  return <div aria-label={label} className={cn("flex flex-col gap-2 rounded-lg border bg-muted/50 p-4 text-sm", className)}>{children}</div>;
}
