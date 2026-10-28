import "./workspace.css";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useDocumentTitle } from "../lib/useDocumentTitle.ts";
import { useOptionalWorkspace, useWorkspace } from "./OrgWorkspace.tsx";

// The page frame every admin screen shares: breadcrumb, then white cards; the card header has the
// H1 on the left and actions on the right, with a "Read-only" badge next to the H1 for read-only admins.

export type Crumb = readonly [label: string, to?: string];

export function Page({ title, crumbs, children }: { title: string; crumbs?: readonly Crumb[]; children: ReactNode }) {
  useDocumentTitle(title);
  const workspace = useWorkspace();
  return (
    <section className="page">
      {crumbs ? <Breadcrumbs items={[[workspace.name, workspace.href("dashboard")], ...crumbs]} /> : null}
      {children}
    </section>
  );
}

export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {items.map(([label, to], index) => (
          <li key={`${label}-${index}`}>
            {to && index < items.length - 1 ? <Link to={to}>{label}</Link> : <span aria-current={index === items.length - 1 ? "page" : undefined}>{label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface PageHeadProps {
  title: ReactNode;
  badges?: ReactNode;
  /** Inline after the title (a status badge, the preview icon). */
  after?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}

export function PageHead({ title, badges, after, sub, actions }: PageHeadProps) {
  // The "Read-only" badge is an admin's; a holder's portal pages have no workspace and no badge.
  const readOnly = useOptionalWorkspace()?.readOnly ?? false;
  return (
    <div className="page-h">
      <div className="titles">
        {badges ? <div className="badges">{badges}</div> : null}
        <div className="h1-row">
          <h1>
            {title}
            {after}
          </h1>
          {readOnly ? <span className="ro-badge">Read-only</span> : null}
        </div>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {actions ? <div className="acts">{actions}</div> : null}
    </div>
  );
}

interface CardProps {
  title?: ReactNode;
  /** Right side of the card header ("See more", a note). */
  right?: ReactNode;
  id?: string;
  className?: string;
  /** Use h3 for the title (cards inside a page that already has a card H1). */
  small?: boolean;
  children?: ReactNode;
  labelledBy?: string;
}

export function Card({ title, right, id, className, small, children, labelledBy }: CardProps) {
  return (
    <section className={className ? `card ${className}` : "card"} id={id} aria-labelledby={labelledBy}>
      {title || right ? (
        <div className="card-h">
          {title ? (small ? <h3>{title}</h3> : <h2>{title}</h2>) : <span className="spacer" />}
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return <h3 className="section-title" id={id}>{children}</h3>;
}

/** A "See more" link in a card header. */
export function SeeMore({ to }: { to: string }) {
  return <Link className="see" to={to}>See more</Link>;
}
