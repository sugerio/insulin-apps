import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx'
import { Badge as UiBadge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { cn } from '@/lib/utils.ts'
import { describeError } from '../lib/api.ts'
import type { Tone } from '../lib/format.ts'

// Badges, banners and the loading and error states, on shadcn/ui's Badge, Alert and Spinner, as Cap Table has them.

const TONES: Record<Tone, string> = {
  green: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  red: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  blue: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  grey: 'bg-secondary text-secondary-foreground',
}

export function Badge({ tone = 'grey', children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return <UiBadge className={cn('h-auto min-h-5 max-w-full whitespace-normal', TONES[tone], className)} title={title} data-tone={tone}>{children}</UiBadge>
}

export type BannerKind = 'warn' | 'danger' | 'info' | 'ok'

const BANNERS: Record<BannerKind, { icon: typeof Info; className: string; text: string }> = {
  warn: {
    icon: TriangleAlert,
    className: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100',
    text: 'text-amber-900 dark:text-amber-200',
  },
  danger: { icon: CircleAlert, className: 'border-destructive/40', text: '' },
  info: { icon: Info, className: '', text: '' },
  ok: {
    icon: CircleCheck,
    className: 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
    text: 'text-emerald-900 dark:text-emerald-200',
  },
}

export function Banner({ kind, title, children, action, className }: { kind: BannerKind; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const banner = BANNERS[kind]
  const Drawn = banner.icon
  return (
    <Alert variant={kind === 'danger' ? 'destructive' : 'default'} className={cn(banner.className, className)} role={kind === 'danger' ? 'alert' : 'status'} data-kind={kind}>
      <Drawn aria-hidden="true" />
      {title ? <AlertTitle className="line-clamp-none">{title}</AlertTitle> : null}
      {children ? <AlertDescription className={cn('[overflow-wrap:anywhere]', banner.text)}>{children}</AlertDescription> : null}
      {action ? <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2">{action}</div> : null}
    </Alert>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground" role="status">
      <Spinner role={undefined} aria-label={undefined} aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

/** A failed load: what happened, in the API's words, and a way to try again. */
export function ErrorState({ error, title = "Couldn't load this", onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  return (
    <Banner kind="danger" title={title} action={onRetry ? <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try again</Button> : undefined}>
      {describeError(error)}
    </Banner>
  )
}

/** A failed change: what happened, and that nothing else changed. */
export function ActionError({ error, kept = 'Nothing was changed.' }: { error: unknown; kept?: string | null }) {
  if (!error) return null
  return (
    <Banner kind="danger" title="That didn't work">
      {describeError(error)}{kept ? ` ${kept}` : ''}
    </Banner>
  )
}

/** A short, quiet line of text under a card or a form. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-sm text-muted-foreground', className)}>{children}</p>
}
