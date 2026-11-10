// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/label.json. The Radix primitive renders a <label>;
// this is that element, with createElement instead of JSX.
import React from 'react'
import { cn } from '../../lib/utils.ts'

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return React.createElement('label', {
    'data-slot': 'label',
    className: cn('flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50', className),
    ...props,
  })
}
