// shadcn/ui (MIT), new-york style: the class names of ui.shadcn.com/r/styles/new-york-v4/sidebar.json (SidebarGroupLabel,
// SidebarMenuButton, SidebarTrigger), without its context, sheet and tooltip, which need Radix: the members' shell
// (member/Shell.ts) draws the columns itself, collapses each with its own toggle and gives a collapsed item its label as
// a `title` tooltip. The colours are the theme's --sidebar-* tokens (styles.css).
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils.ts'

/** A small uppercase heading over a group of items (SidebarGroupLabel, uppercase as the members' navigation wants). */
export const sidebarGroupLabel = 'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70'

const menuButton = cva(
  'flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm text-sidebar-foreground outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      size: { default: 'h-8', lg: 'h-12' },
      // A long label ends with an ellipsis, or (in level 2, where Docs topics are long) wraps onto a second line.
      wrap: { false: '[&>span:last-child]:truncate', true: 'h-auto min-h-8 py-1.5 [&>span:last-child]:whitespace-normal' },
      // From 768px a collapsed column shows the icon alone in a square (in the drawer, below 768px, labels stay).
      collapsed: { true: 'md:size-8 md:justify-center md:p-2', false: '' },
    },
    compoundVariants: [{ size: 'lg', collapsed: true, class: 'md:p-0' }],
    defaultVariants: { size: 'default', wrap: false, collapsed: false },
  },
)

/** An item: icon and label, highlighted when active (SidebarMenuButton). */
export function sidebarMenuButton(options: { size?: 'default' | 'lg'; wrap?: boolean; collapsed?: boolean } = {}): string {
  return cn(menuButton(options))
}

/** An icon button in a column's header or footer: the collapse toggles, the drawer's menu button (SidebarTrigger). */
export const sidebarIconButton = 'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4'
