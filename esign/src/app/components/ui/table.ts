// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/table.json, with createElement instead of JSX.
import React from 'react'
import { cn } from '../../lib/utils.ts'

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return React.createElement('div', { 'data-slot': 'table-container', className: 'relative w-full overflow-x-auto' },
    React.createElement('table', { 'data-slot': 'table', className: cn('w-full caption-bottom text-sm', className), ...props }))
}
export const TableHeader = ({ className, ...props }: React.ComponentProps<'thead'>) => React.createElement('thead', { 'data-slot': 'table-header', className: cn('[&_tr]:border-b', className), ...props })
export const TableBody = ({ className, ...props }: React.ComponentProps<'tbody'>) => React.createElement('tbody', { 'data-slot': 'table-body', className: cn('[&_tr:last-child]:border-0', className), ...props })
export const TableRow = ({ className, ...props }: React.ComponentProps<'tr'>) => React.createElement('tr', { 'data-slot': 'table-row', className: cn('border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted', className), ...props })
export const TableHead = ({ className, ...props }: React.ComponentProps<'th'>) => React.createElement('th', { 'data-slot': 'table-head', className: cn('h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground', className), ...props })
export const TableCell = ({ className, ...props }: React.ComponentProps<'td'>) => React.createElement('td', { 'data-slot': 'table-cell', className: cn('p-2 align-middle whitespace-nowrap', className), ...props })
export const TableCaption = ({ className, ...props }: React.ComponentProps<'caption'>) => React.createElement('caption', { 'data-slot': 'table-caption', className: cn('mt-4 text-sm text-muted-foreground', className), ...props })
