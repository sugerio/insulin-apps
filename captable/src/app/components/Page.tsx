import { createContext, Fragment, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge.tsx";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb.tsx";
import { Button } from "@/components/ui/button.tsx";
import { CardAction, CardContent, CardHeader, Card as UiCard } from "@/components/ui/card.tsx";
import { cn } from "@/lib/utils.ts";
import { useDocumentTitle } from "../lib/useDocumentTitle.ts";
import { useOptionalWorkspace, useWorkspace } from "./OrgWorkspace.tsx";

// The page frame every admin screen shares: the breadcrumb, then shadcn/ui cards; the page header has the H1 on the
// left and actions on the right, with a "Read-only" badge next to the H1 for read-only admins. Inside the app's shell
// the breadcrumb shows in the header above the page (section › item).

export type Crumb = readonly [label: string, to?: string];

export function Page({ title, crumbs, children }: { title: string; crumbs?: readonly Crumb[]; children: ReactNode }) {
  useDocumentTitle(title);
  const workspace = useWorkspace();
  return (
    <section className="mx-auto flex w-full max-w-[1480px] min-w-0 flex-col gap-4 px-4 pt-6 pb-14 md:px-8">
      {crumbs ? <Breadcrumbs items={[[workspace.name, workspace.href("dashboard")], ...crumbs]} /> : null}
      {children}
    </section>
  );
}

/**
 * Where a page's breadcrumb goes: the shell's page header; null keeps it in the page (no shell around it), and "hidden"
 * leaves it out (the holder's page in an admin's preview, which shows the page without the holder's shell).
 */
export const CrumbSlotContext = createContext<HTMLElement | "hidden" | null>(null);

export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  const slot = useContext(CrumbSlotContext);
  if (slot === "hidden") return null;
  const crumbs = (
    <Breadcrumb aria-label="Breadcrumb">
      <BreadcrumbList>
        {items.map(([label, to], index) => {
          const last = index === items.length - 1;
          return (
            <Fragment key={`${label}-${index}`}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem>
                {to && !last ? (
                  <BreadcrumbLink asChild><Link to={to}>{label}</Link></BreadcrumbLink>
                ) : last ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : (
                  <span>{label}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
  return slot ? createPortal(crumbs, slot) : crumbs;
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
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {title}
            {after}
          </h1>
          {readOnly ? <Badge variant="outline">Read-only</Badge> : null}
        </div>
        {sub ? <div className="text-sm text-muted-foreground">{sub}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
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

/**
 * A shadcn/ui Card. The `<section>` around it (no box of its own) keeps the card a landmark when it is labelled, and
 * a section for code that looks one up.
 */
export function Card({ title, right, id, className, small, children, labelledBy }: CardProps) {
  const Heading = small ? "h3" : "h2";
  return (
    <section className="contents" aria-labelledby={labelledBy}>
      <UiCard id={id} className={className}>
        {title || right ? (
          <CardHeader>
            {title ? <Heading data-slot="card-title" className="text-base leading-snug font-semibold">{title}</Heading> : null}
            {right ? <CardAction className="flex flex-wrap items-center gap-2">{right}</CardAction> : null}
          </CardHeader>
        ) : null}
        {children !== undefined && children !== null ? <CardContent className="flex min-w-0 flex-col gap-4">{children}</CardContent> : null}
      </UiCard>
    </section>
  );
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return <h3 className={cn("mt-2 text-base font-semibold first:mt-0")} id={id}>{children}</h3>;
}

/** A "See more" link in a card header. */
export function SeeMore({ to }: { to: string }) {
  return <Button asChild variant="link" size="sm" className="h-auto p-0"><Link to={to}>See more</Link></Button>;
}
