import type { LucideIcon } from "lucide-react";
import { Calendar, FileText, Folder, House, List, Receipt, Users } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import type { NavIconName } from "../lib/navigation.ts";

// The navigation's icons, from lucide-react (the set shadcn/ui uses), by the names the manifest may use. Decorative: the
// label next to each carries the meaning.

const NAV_ICON: Record<NavIconName, LucideIcon> = {
  "file-text": FileText,
  users: Users,
  calendar: Calendar,
  folder: Folder,
  list: List,
  receipt: Receipt,
  home: House,
};

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Drawn = NAV_ICON[name];
  return <Drawn className={cn("size-4 shrink-0", className)} aria-hidden="true" focusable="false" />;
}
