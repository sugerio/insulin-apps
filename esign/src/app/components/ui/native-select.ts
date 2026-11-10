// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/native-select.json, with createElement instead of
// JSX: a native <select> styled like the Select component, with its chevron.
import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return React.createElement('div', { 'data-slot': 'native-select-wrapper', className: 'group/native-select relative w-full has-[select:disabled]:opacity-50' },
    React.createElement('select', {
      'data-slot': 'native-select',
      className: cn(
        'h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-2 pr-9 text-sm shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className,
      ),
      ...props,
    }),
    React.createElement(ChevronDown, { className: 'pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground opacity-50 select-none', 'aria-hidden': true }))
}

export const NativeSelectOption = (props: React.ComponentProps<'option'>) => React.createElement('option', { 'data-slot': 'native-select-option', ...props })
