// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/alert.json, with createElement instead of JSX. The
// role is a prop here (default "alert") so a notice can be a polite status instead.
import React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils.ts'

const alertVariants = cva(
  'relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        destructive: 'bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export function Alert({ className, variant, role = 'alert', ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return React.createElement('div', { 'data-slot': 'alert', role, className: cn(alertVariants({ variant }), className), ...props })
}
export function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return React.createElement('div', { 'data-slot': 'alert-title', className: cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className), ...props })
}
export function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return React.createElement('div', { 'data-slot': 'alert-description', className: cn('col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed', className), ...props })
}
