// The operator console's frame (DESIGN.md §11.2): its own sidebar in shadcn's sidebar colours (Overview,
// Organizations, People, Apps, Cloudflare, Audit log), the operator and their role at the bottom with Sign out, and on
// narrow screens a top bar whose <details> menu holds the same items. It shares nothing with the customers' navigation:
// no organization switcher, no account pages. Rendered on the server like every gateway page, without a script.
import type { ReactNode } from "react"
import { Building2, Cloud, LayoutDashboard, LayoutGrid, LogOut, Menu as MenuIcon, ScrollText, Users, X, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { InsulinMark } from "@/components/brand"
import { Container, PageHeader } from "@/components/layout"
import type { Context } from "../../context.ts"
import { htmlResponse } from "../../http/response.ts"
import type { OperatorSession } from "../../super/auth.ts"
import { renderDocument } from "../document.tsx"

export type SuperSection = "overview" | "orgs" | "users" | "apps" | "cloudflare" | "audit"

const ITEMS: { key: SuperSection; label: string; href: string; icon: LucideIcon }[] = [
  { key: "overview", label: "Overview", href: "/super", icon: LayoutDashboard },
  { key: "orgs", label: "Organizations", href: "/super/orgs", icon: Building2 },
  { key: "users", label: "People", href: "/super/users", icon: Users },
  { key: "apps", label: "Apps", href: "/super/apps", icon: LayoutGrid },
  { key: "cloudflare", label: "Cloudflare", href: "/super/cloudflare", icon: Cloud },
  { key: "audit", label: "Audit log", href: "/super/audit", icon: ScrollText },
]

const focusRing = "outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
const itemClass = cn(
  "flex h-8 w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm text-sidebar-foreground",
  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  "data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground",
  "[&>span]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  focusRing
)

function Items({ current }: { current: SuperSection | null }) {
  return (
    <ul className="flex flex-col gap-1">
      {ITEMS.map((item) => (
        <li key={item.key}>
          <a href={item.href} className={itemClass} data-active={item.key === current ? "true" : undefined} aria-current={item.key === current ? "page" : undefined}>
            <item.icon aria-hidden="true" />
            <span>{item.label}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

function Brand() {
  return (
    <a href="/super" className={cn("flex h-12 items-center gap-2 rounded-md p-2 text-sm", focusRing)}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
        <InsulinMark className="size-5" />
      </span>
      <span className="grid leading-tight">
        <span className="font-semibold">Insulin Apps</span>
        <span className="text-xs text-muted-foreground">Operator console</span>
      </span>
    </a>
  )
}

function Operator({ session }: { session: OperatorSession }) {
  return (
    <div className="flex flex-col gap-2 border-t border-sidebar-border p-2 pt-3">
      <div className="grid gap-1 px-2 text-sm leading-tight">
        <span className="truncate font-medium">{session.operator.name}</span>
        <span className="truncate text-xs text-muted-foreground">{session.operator.email}</span>
        <span>
          <Badge variant={session.admin ? "default" : "secondary"}>{session.admin ? "Admin" : "Operator"}</Badge>
        </span>
      </div>
      <form method="post" action="/super/logout">
        <button type="submit" className={itemClass}>
          <LogOut aria-hidden="true" />
          <span>Sign out</span>
        </button>
      </form>
    </div>
  )
}

function Shell({ session, current, children }: { session: OperatorSession; current: SuperSection | null; children: ReactNode }) {
  return (
    <div data-slot="super-shell" className="flex min-h-svh flex-col md:flex-row">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:flex md:h-svh">
        <div className="p-2">
          <Brand />
        </div>
        <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
          <Items current={current} />
        </nav>
        <Operator session={session} />
      </aside>
      <details className="group/drawer border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:hidden">
        <summary className={cn("flex cursor-pointer list-none items-center justify-between p-2 [&::-webkit-details-marker]:hidden", focusRing)}>
          <Brand />
          <span className="flex size-9 items-center justify-center rounded-md">
            <MenuIcon aria-hidden="true" className="size-5 group-open/drawer:hidden" />
            <X aria-hidden="true" className="hidden size-5 group-open/drawer:block" />
            <span className="sr-only">Menu</span>
          </span>
        </summary>
        <nav aria-label="Primary" className="p-2">
          <Items current={current} />
        </nav>
        <Operator session={session} />
      </details>
      <main id="main" className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  )
}

const BODY = "flex min-h-svh flex-col bg-background font-sans text-foreground antialiased"

function Document({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{`${title} · Insulin Apps operator console`}</title>
        <link rel="stylesheet" href="/__insulin/gateway.css" />
        <link rel="icon" href="/__insulin/icon.svg" type="image/svg+xml" />
      </head>
      <body className={BODY}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  )
}

export interface SuperPageOptions {
  title: string
  current: SuperSection | null
  description?: ReactNode
  actions?: ReactNode
  status?: number
}

/** A console page: the frame, the page's title (its <h1>) with an optional description and actions, and the content. */
export function superPage(ctx: Context, session: OperatorSession, options: SuperPageOptions, content: ReactNode): Response {
  void ctx
  return htmlResponse(renderDocument(
    <Document title={options.title}>
      <Shell session={session} current={options.current}>
        <Container width="wide" className="flex flex-col gap-6 py-8">
          <PageHeader title={options.title} description={options.description} actions={options.actions} />
          {content}
        </Container>
      </Shell>
    </Document>
  ), { status: options.status ?? 200 })
}

/** A short message inside the frame (not found, admins only). */
export function superMessage(ctx: Context, session: OperatorSession, status: number, title: string, text: string): Response {
  return superPage(ctx, session, { title, current: null, status }, <p className="text-muted-foreground">{text}</p>)
}

/** A page outside the frame, for someone without a console session: the sign-in page and its failures. */
export function superBarePage(title: string, status: number, content: ReactNode): Response {
  return htmlResponse(renderDocument(
    <Document title={title}>
      <main id="main" className="flex flex-1 items-center">
        {content}
      </main>
    </Document>
  ), { status })
}
