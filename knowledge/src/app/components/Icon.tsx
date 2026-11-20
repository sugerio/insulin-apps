import type { LucideIcon } from 'lucide-react'
import { Activity, Bell, BookOpen, Circle, House, Shield } from 'lucide-react'
import { cn } from '@/lib/utils.ts'

// The navigation manifest's icons (Lucide names, as package.json `insulin.navigation` gives them). Decorative: the
// label next to an icon carries its meaning, so every icon is aria-hidden.

const NAV_ICONS: Record<string, LucideIcon> = {
  house: House,
  'book-open': BookOpen,
  bell: Bell,
  shield: Shield,
  activity: Activity,
}

export function NavIcon({ name, className }: { name: string; className?: string }) {
  const Drawn = NAV_ICONS[name] ?? Circle
  return <Drawn className={cn('size-4 shrink-0', className)} aria-hidden="true" focusable="false" />
}
