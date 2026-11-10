// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/badge.json, with createElement instead of JSX and
// without `asChild`.
import React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils.ts'

export const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        destructive: 'bg-destructive text-white dark:bg-destructive/60',
        outline: 'border-border text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export function Badge({ className, variant = 'default', ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return React.createElement('span', { 'data-slot': 'badge', 'data-variant': variant, className: cn(badgeVariants({ variant }), className), ...props })
}
