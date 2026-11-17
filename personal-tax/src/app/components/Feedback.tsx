import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";
import { describeError } from "../api/client.ts";
import type { Resource } from "../lib/useResource.ts";

// Messages on a page: banners, the loading state, and a failed load with its retry.

type BannerKind = "info" | "success" | "warning" | "error";
const BANNER_ICON = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const;
const BANNER_TONE: Record<BannerKind, string> = {
  info: "",
  success: "border-emerald-600/30 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100",
  warning: "border-amber-500/40 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100",
  error: "",
};

export function Banner({ kind, title, children, action }: { kind: BannerKind; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Glyph = BANNER_ICON[kind];
  return (
    <Alert variant={kind === "error" ? "destructive" : "default"} className={cn(BANNER_TONE[kind])} role={kind === "error" ? "alert" : "status"}>
      <Glyph aria-hidden="true" />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {children || action ? (
        <AlertDescription>
          {children}
          {action ? <div className="mt-2">{action}</div> : null}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground" role="status">
      <Spinner />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Banner kind="error" title="Couldn't load this page" action={onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button> : undefined}>
      {describeError(error)}
    </Banner>
  );
}

/** A resource's states: loading, its error with a retry, then `children` with the data. */
export function ResourceView<T>({ resource, children }: { resource: Resource<T>; children: (data: T) => ReactNode }) {
  if (resource.status === "loading") return <Loading />;
  if (resource.status === "error") return <ErrorState error={resource.error} onRetry={resource.reload} />;
  return <>{children(resource.data)}</>;
}
