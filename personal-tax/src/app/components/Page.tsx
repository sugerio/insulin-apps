import { createContext, Fragment, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb.tsx";
import { cn } from "@/lib/utils.ts";
import { useDocumentTitle } from "../lib/useDocumentTitle.ts";

// The frame every page shares: the breadcrumb (in the shell's header, through CrumbSlotContext), then the page.

export type Crumb = readonly [label: string, to?: string];

/** Where a page's breadcrumb goes: the shell's header; null keeps it in the page (no shell around it). */
export const CrumbSlotContext = createContext<HTMLElement | null>(null);

export function Page({ title, crumbs, wide, children }: { title: string; crumbs: readonly Crumb[]; wide?: boolean; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <section className={cn("mx-auto flex w-full min-w-0 flex-col gap-5 px-4 pt-6 pb-14 md:px-8", wide ? "max-w-[1480px]" : "max-w-[1280px]")}>
      <Breadcrumbs items={crumbs} />
      {children}
    </section>
  );
}

export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  const slot = useContext(CrumbSlotContext);
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
                  <BreadcrumbLink asChild>
                    <Link to={to}>{label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
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

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {sub ? <div className="max-w-3xl text-sm text-muted-foreground">{sub}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
