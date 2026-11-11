// The Lucide component for each icon name an app's navigation may use (nav-icons.ts, the same list as list-apps.mjs's
// NAVIGATION_ICONS). The record is typed by the name list, so a name without a component fails the typecheck.
import {
  Activity, Archive, Award, Banknote, Bell, BookOpen, Bot, Briefcase, Building, Calendar, ChartBar, ChartPie, CircleCheck,
  ClipboardList, Clock, Download, FilePen, FileText, Files, Folder, Gauge, Heart, History, House, Inbox, Key, Landmark, Layers,
  LayoutDashboard, LayoutGrid, List, Mail, Percent, Plug, Receipt, Scale, Search, Send, Settings, Shield, Signature, Table,
  TrendingUp, Upload, User, Users, Wallet, type LucideIcon,
} from "lucide-react"
import type { NavIconName } from "../nav-icons.ts"

export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  activity: Activity,
  archive: Archive,
  award: Award,
  banknote: Banknote,
  bell: Bell,
  "book-open": BookOpen,
  bot: Bot,
  briefcase: Briefcase,
  building: Building,
  calendar: Calendar,
  "chart-bar": ChartBar,
  "chart-pie": ChartPie,
  "check-circle": CircleCheck,
  "circle-check": CircleCheck,
  "clipboard-list": ClipboardList,
  clock: Clock,
  download: Download,
  "file-pen": FilePen,
  "file-text": FileText,
  files: Files,
  folder: Folder,
  gauge: Gauge,
  heart: Heart,
  history: History,
  home: House,
  house: House,
  inbox: Inbox,
  key: Key,
  landmark: Landmark,
  layers: Layers,
  "layout-dashboard": LayoutDashboard,
  "layout-grid": LayoutGrid,
  list: List,
  mail: Mail,
  percent: Percent,
  plug: Plug,
  receipt: Receipt,
  scale: Scale,
  search: Search,
  send: Send,
  settings: Settings,
  shield: Shield,
  signature: Signature,
  table: Table,
  "trending-up": TrendingUp,
  upload: Upload,
  user: User,
  users: Users,
  wallet: Wallet,
}

/** An icon by name, decorative: the label next to it (or the link's aria-label, collapsed) names the item. */
export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = NAV_ICONS[name]
  return <Icon aria-hidden="true" className={className} />
}
