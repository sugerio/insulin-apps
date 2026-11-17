import { cn } from "@/lib/utils.ts";

/** The app's mark: three bars of a breakdown, in the theme's primary colour. */
export function BrandMark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg className={cn("shrink-0 text-primary", className)} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <rect className="fill-primary-foreground" x="8" y="9" width="16" height="3.2" rx="1.6" />
      <rect className="fill-primary-foreground" x="8" y="14.4" width="11" height="3.2" rx="1.6" opacity=".82" />
      <rect className="fill-primary-foreground" x="8" y="19.8" width="6" height="3.2" rx="1.6" opacity=".64" />
    </svg>
  );
}
