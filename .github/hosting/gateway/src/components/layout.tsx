// Page layout pieces. Headings stay plain <h1>/<h2>/<h3> elements; the component around them sets their type, the way
// shadcn's CardTitle does, so every page keeps a correct heading outline.
import * as React from "react"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const WIDTHS = {
  narrow: "max-w-md",
  default: "max-w-4xl",
  prose: "max-w-3xl",
  wide: "max-w-6xl",
} as const

export function Container({
  width = "default",
  className,
  ...props
}: React.ComponentProps<"div"> & { width?: keyof typeof WIDTHS }) {
  return <div className={cn("mx-auto w-full px-4 sm:px-6", WIDTHS[width], className)} {...props} />
}

/** A page's title (its <h1>), with an optional description and actions beside it. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div data-slot="page-title" className="text-2xl font-semibold tracking-tight text-balance break-words sm:text-3xl">
          <h1>{title}</h1>
        </div>
        {description ? <div className="text-muted-foreground">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** A section title (an <h2>) outside a card. */
export function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div data-slot="section-title" className={cn("text-xl font-semibold tracking-tight", className)}>
      <h2>{children}</h2>
    </div>
  )
}

/**
 * The sign-in, sign-up and other single-task pages: one centred card with the page's <h1> as its title, and links
 * that lead elsewhere below it.
 */
export function AuthCard({
  title,
  description,
  children,
  below,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  below?: React.ReactNode
}) {
  return (
    <Container width="narrow" className="flex flex-col gap-6 py-10 sm:py-16">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl leading-snug">
            <h1>{title}</h1>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        {children ? <CardContent className="flex flex-col gap-6">{children}</CardContent> : null}
      </Card>
      {below ? (
        <div className="flex flex-col gap-2 text-center text-sm text-muted-foreground [&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4">
          {below}
        </div>
      ) : null}
    </Container>
  )
}

/** Running text with inline links: links are underlined, so they don't rely on colour alone. */
export const proseLinks = "[&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4"
