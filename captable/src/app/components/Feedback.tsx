import type { ReactNode } from "react";
import { Link } from "react-router";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Badge as UiBadge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from "@/components/ui/empty.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";
import { isApiError, describeError } from "../lib/errors.ts";
import type { Tone } from "../lib/labels.ts";
import type { Resource } from "../lib/useResource.ts";
import { useOptionalWorkspace } from "./OrgWorkspace.tsx";

// Badges, banners and the loading / error / not-found / empty states, on shadcn/ui's Badge, Alert, Spinner and Empty.

/** A status tone as Badge colours: a soft background and the text that reads on it, in light and dark. */
const TONES: Record<Tone, string> = {
  green: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  red: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  blue: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  amber: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  teal: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  grey: "bg-secondary text-secondary-foreground",
};

export function Badge({ tone = "grey", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <UiBadge className={TONES[tone]} title={title} data-tone={tone}>{children}</UiBadge>;
}

type BannerKind = "warn" | "danger" | "info" | "ok";

const BANNERS: Record<BannerKind, { icon: typeof Info; className: string; text: string }> = {
  warn: {
    icon: TriangleAlert,
    className: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
    text: "text-amber-900 dark:text-amber-200",
  },
  danger: { icon: CircleAlert, className: "border-destructive/40", text: "" },
  info: { icon: Info, className: "", text: "" },
  ok: {
    icon: CircleCheck,
    className: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
    text: "text-emerald-900 dark:text-emerald-200",
  },
};

export function Banner({ kind, title, children, action, id }: { kind: BannerKind; title?: ReactNode; children?: ReactNode; action?: ReactNode; id?: string }) {
  const banner = BANNERS[kind];
  const Drawn = banner.icon;
  return (
    <Alert variant={kind === "danger" ? "destructive" : "default"} className={banner.className} id={id} role={kind === "danger" ? "alert" : "note"} data-kind={kind}>
      <Drawn aria-hidden="true" />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {children ? <AlertDescription className={banner.text}>{children}</AlertDescription> : null}
      {action ? <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2">{action}</div> : null}
    </Alert>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground" role="status">
      <Spinner role={undefined} aria-label={undefined} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>Couldn't load this page</AlertTitle>
      <AlertDescription>{describeError(error)}</AlertDescription>
      {onRetry ? (
        <div className="col-start-2 mt-2">
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button>
        </div>
      ) : null}
    </Alert>
  );
}

/** The "does not exist" state; `back` defaults to the admin dashboard (or home outside a workspace). */
export function NotFoundState({ message = "This page or record does not exist.", back }: { message?: string; back?: { to: string; label: string } }) {
  const workspace = useOptionalWorkspace();
  const link = back ?? (workspace ? { to: workspace.href("dashboard"), label: "Back to dashboard" } : { to: "/", label: "Go home" });
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild><Link to={link.to}>{link.label}</Link></Button>
      </EmptyContent>
    </Empty>
  );
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <Empty className="p-6 md:p-8">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

/** "Couldn't load <what>", the reason and Try again: for one part of a page whose own request failed. */
export function InlineError({ what, error, onRetry, inline }: { what: string; error: unknown; onRetry?: () => void; inline?: boolean }) {
  const body = (
    <>
      Couldn't load {what}. {describeError(error)}
      {onRetry ? <> <Button type="button" variant="link" size="sm" className="h-auto p-0 align-baseline" onClick={onRetry}>Try again</Button></> : null}
    </>
  );
  const className = "text-sm font-medium text-destructive";
  return inline ? <span className={className} role="alert">{body}</span> : <p className={cn(className, "mt-1")} role="alert">{body}</p>;
}

/**
 * One part of a page that needs a request of its own (a lookup or a sub-resource): its data once the request has
 * succeeded, else an inline loading line or an inline error with Try again. Nothing in it is ever derived from a
 * request that is still loading or that failed, so a missing answer never reads as zero, "none" or an empty list.
 */
export function Pending<T>({ resource, what, inline, children }: { resource: Resource<T>; what: string; inline?: boolean; children: (data: T) => ReactNode }) {
  if (resource.data !== undefined) return <>{children(resource.data)}</>;
  if (resource.error !== undefined) return <InlineError what={what} error={resource.error} onRetry={resource.reload} inline={inline} />;
  return inline
    ? <span className="text-muted-foreground" role="status" aria-label={`Loading ${what}`}>…</span>
    : <p className="text-xs text-muted-foreground" role="status">Loading {what}…</p>;
}

/**
 * Renders a resource's data, or its loading, not-found and error states. A 404 from the API is the page's "does not
 * exist" state, as rows of other orgs and malformed ids answer 404.
 */
export function ResourceView<T>({ resource, notFound, notFoundBack, children }: { resource: Resource<T>; notFound?: string; notFoundBack?: { to: string; label: string }; children: (data: T) => ReactNode }) {
  if (resource.data !== undefined) return <>{children(resource.data)}</>;
  if (resource.error !== undefined) {
    if (isApiError(resource.error, "not_found")) return <NotFoundState message={notFound} back={notFoundBack} />;
    return <ErrorState error={resource.error} onRetry={resource.reload} />;
  }
  return <Loading />;
}
