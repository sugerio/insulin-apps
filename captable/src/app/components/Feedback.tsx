import type { ReactNode } from "react";
import { Link } from "react-router";
import { isApiError, describeError } from "../lib/errors.ts";
import type { Tone } from "../lib/labels.ts";
import type { Resource } from "../lib/useResource.ts";
import { Icon } from "./Icon.tsx";
import { useOptionalWorkspace } from "./OrgWorkspace.tsx";

// Badges, banners and the loading / error / not-found / empty states.

export function Badge({ tone = "grey", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge b-${tone}`} title={title}>{children}</span>;
}

type BannerKind = "warn" | "danger" | "info" | "ok";
const BANNER_ICONS = { warn: "alert", danger: "alert", info: "info", ok: "check" } as const;

export function Banner({ kind, title, children, action, id }: { kind: BannerKind; title?: ReactNode; children?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className={`banner banner-${kind}`} id={id} role={kind === "danger" ? "alert" : "note"}>
      <Icon name={BANNER_ICONS[kind]} />
      <div className="b-body">
        {title ? <div className="b-title">{title}</div> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="card error-state" role="alert">
      <p className="b-title">Couldn't load this page</p>
      <p>{describeError(error)}</p>
      {onRetry ? <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

/** The "does not exist" state; `back` defaults to the admin dashboard (or home outside a workspace). */
export function NotFoundState({ message = "This page or record does not exist.", back }: { message?: string; back?: { to: string; label: string } }) {
  const workspace = useOptionalWorkspace();
  const link = back ?? (workspace ? { to: workspace.href("dashboard"), label: "Back to dashboard" } : { to: "/", label: "Go home" });
  return (
    <div className="card">
      <div className="empty-state">
        {message}
        <div><Link className="btn btn-primary" to={link.to}>{link.label}</Link></div>
      </div>
    </div>
  );
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state">{children}{action ? <div>{action}</div> : null}</div>;
}

/** "Couldn't load <what>", the reason and Try again: for one part of a page whose own request failed. */
export function InlineError({ what, error, onRetry, inline }: { what: string; error: unknown; onRetry?: () => void; inline?: boolean }) {
  const body = (
    <>
      Couldn't load {what}. {describeError(error)}
      {onRetry ? <> <button type="button" className="btn-link" onClick={onRetry}>Try again</button></> : null}
    </>
  );
  return inline ? <span className="err-inline" role="alert">{body}</span> : <p className="err-inline" role="alert">{body}</p>;
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
    ? <span className="muted" role="status" aria-label={`Loading ${what}`}>…</span>
    : <p className="muted small" role="status">Loading {what}…</p>;
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
