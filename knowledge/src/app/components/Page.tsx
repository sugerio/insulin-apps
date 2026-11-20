import { createContext, Fragment, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb.tsx'
import { CardAction, CardContent, CardDescription, CardHeader, Card as UiCard } from '@/components/ui/card.tsx'
import { cn } from '@/lib/utils.ts'
import { useDocumentTitle } from '../lib/useDocumentTitle.ts'

// The frame every screen shares, as Cap Table has it: the breadcrumb (in the shell's header above the page), then the
// page's heading with its actions on the right, then shadcn/ui cards.

export type Crumb = readonly [label: string, to?: string]

/** Where a page's breadcrumb goes: the shell's header; null keeps it in the page (tests render pages without a shell). */
export const CrumbSlotContext = createContext<HTMLElement | null>(null)

export function Page({ title, crumbs, children, wide = false }: { title: string; crumbs?: readonly Crumb[]; children: ReactNode; wide?: boolean }) {
  useDocumentTitle(title)
  return (
    <section className={cn('mx-auto flex w-full min-w-0 flex-col gap-4 px-4 pt-6 pb-14 md:px-8', wide ? 'max-w-[1480px]' : 'max-w-[1200px]')}>
      {crumbs ? <Breadcrumbs items={crumbs} /> : null}
      {children}
    </section>
  )
}

export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  const slot = useContext(CrumbSlotContext)
  const crumbs = (
    <Breadcrumb aria-label="Breadcrumb">
      <BreadcrumbList>
        {items.map(([label, to], index) => {
          const last = index === items.length - 1
          return (
            <Fragment key={`${label}-${index}`}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem className="min-w-0">
                {to && !last ? (
                  <BreadcrumbLink asChild><Link to={to}>{label}</Link></BreadcrumbLink>
                ) : last ? (
                  <BreadcrumbPage className="truncate">{label}</BreadcrumbPage>
                ) : (
                  <span>{label}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
  return slot ? createPortal(crumbs, slot) : crumbs
}

export function PageHead({ title, after, sub, actions }: { title: ReactNode; after?: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
          {after}
        </div>
        {sub ? <div className="max-w-3xl text-sm text-muted-foreground">{sub}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** A shadcn/ui Card with an optional heading (h2, or h3 inside a page section), a line under it and actions on the right. */
export function Card({ title, description, right, className, small, children, id }: {
  title?: ReactNode
  description?: ReactNode
  right?: ReactNode
  className?: string
  small?: boolean
  children?: ReactNode
  id?: string
}) {
  const Heading = small ? 'h3' : 'h2'
  return (
    <UiCard id={id} className={cn('min-w-0', className)}>
      {title || right || description ? (
        <CardHeader>
          {title ? <Heading data-slot="card-title" className="text-base leading-snug font-semibold">{title}</Heading> : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
          {right ? <CardAction className="flex flex-wrap items-center gap-2">{right}</CardAction> : null}
        </CardHeader>
      ) : null}
      {children !== undefined && children !== null ? <CardContent className="flex min-w-0 flex-col gap-4">{children}</CardContent> : null}
    </UiCard>
  )
}
