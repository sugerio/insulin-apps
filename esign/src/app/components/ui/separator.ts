// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/separator.json. The Radix primitive renders a <div>
// with role "separator" (or "none" when decorative); this is that element, with createElement instead of JSX.
import React from 'react'
import { cn } from '../../lib/utils.ts'

export function Separator({ className, orientation = 'horizontal', decorative = true, ...props }: React.ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical'; decorative?: boolean }) {
  return React.createElement('div', {
    'data-slot': 'separator',
    'data-orientation': orientation,
    role: decorative ? 'none' : 'separator',
    'aria-orientation': decorative ? undefined : orientation,
    className: cn('shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px', className),
    ...props,
  })
}
