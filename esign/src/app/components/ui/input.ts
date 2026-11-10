// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/input.json, with createElement instead of JSX.
import React from 'react'
import { cn } from '../../lib/utils.ts'

export const inputClass = cn(
  'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
  'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
  'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
)

export function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return React.createElement('input', { type, 'data-slot': 'input', className: cn(inputClass, className), ...props })
}

/** A native checkbox or radio styled to sit with shadcn's inputs (the Radix Checkbox renders a button, not an input). */
export const checkClass = 'size-4 shrink-0 accent-primary disabled:cursor-not-allowed disabled:opacity-50'
