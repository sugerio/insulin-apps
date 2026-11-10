// shadcn/ui (MIT), new-york style: ui.shadcn.com/r/styles/new-york-v4/card.json, with createElement instead of JSX.
import React from 'react'
import { cn } from '../../lib/utils.ts'

type Div = React.ComponentProps<'div'>
const part = (slot: string, base: string) => ({ className, ...props }: Div) =>
  React.createElement('div', { 'data-slot': slot, className: cn(base, className), ...props })

export const Card = part('card', 'flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm')
export const CardHeader = part('card-header', '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6')
export const CardTitle = part('card-title', 'leading-none font-semibold')
export const CardDescription = part('card-description', 'text-sm text-muted-foreground')
export const CardAction = part('card-action', 'col-start-2 row-span-2 row-start-1 self-start justify-self-end')
export const CardContent = part('card-content', 'px-6')
export const CardFooter = part('card-footer', 'flex items-center px-6 [.border-t]:pt-6')
