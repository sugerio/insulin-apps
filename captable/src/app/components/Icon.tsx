import type { LucideIcon } from "lucide-react";
import {
  Archive, Award, Bell, BookOpen, Bot, Briefcase, Building, Calendar, ChartPie, Check, ChevronDown, ChevronLeft, ChevronRight,
  ChevronsUpDown, CircleAlert, CircleCheck, CircleHelp, ClipboardList, Clock, Columns3, Contrast, Database, Download, Eye, File,
  FilePen, Files, FileText, Folder, Funnel, Heart, House, Inbox, Info, Key, Layers, LayoutDashboard, LayoutGrid, List, Lock,
  LogOut, Mail, PanelLeft, Pencil, Plug, Plus, RefreshCw, Rows3, Search, Send, Settings, Shield, Signature, Table, Upload, User,
  Users, X,
} from "lucide-react";
import { cn } from "@/lib/utils.ts";
import type { NavIconName } from "../lib/navigation.ts";

// Line icons from lucide-react, the set shadcn/ui uses. Decorative: the text next to them carries the meaning, so every
// icon is aria-hidden.

const ICONS = {
  home: House,
  table: Table,
  users: Users,
  heart: Heart,
  shield: Shield,
  building: Building,
  award: Award,
  plus: Plus,
  chevDown: ChevronDown,
  chevRight: ChevronRight,
  chevLeft: ChevronLeft,
  search: Search,
  clipboard: ClipboardList,
  download: Download,
  upload: Upload,
  filter: Funnel,
  columns: Columns3,
  rows: Rows3,
  eye: Eye,
  x: X,
  check: Check,
  alert: CircleAlert,
  info: Info,
  file: File,
  lock: Lock,
  refresh: RefreshCw,
  edit: Pencil,
  clock: Clock,
  database: Database,
  checkCircle: CircleCheck,
  mail: Mail,
  briefcase: Briefcase,
  pie: ChartPie,
  help: CircleHelp,
  folder: Folder,
  book: BookOpen,
  // The navigation's: the manifest names Lucide icons (NAV_ICON below).
  dashboard: LayoutDashboard,
  layers: Layers,
  fileText: FileText,
  inbox: Inbox,
  files: Files,
  filePen: FilePen,
  signature: Signature,
  send: Send,
  archive: Archive,
  settings: Settings,
  plug: Plug,
  key: Key,
  bot: Bot,
  list: List,
  calendar: Calendar,
  bell: Bell,
  // The shell's own: the collapse toggles, the menus' chevrons, the person's menu.
  panel: PanelLeft,
  chevrons: ChevronsUpDown,
  grid: LayoutGrid,
  user: User,
  logOut: LogOut,
  contrast: Contrast,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** The icon for each name the navigation manifest may use (Lucide's names). */
export const NAV_ICON: Record<NavIconName, IconName> = {
  "layout-dashboard": "dashboard", home: "home", table: "table", layers: "layers", "chart-pie": "pie", shield: "shield",
  heart: "heart", users: "users", building: "building", "file-text": "fileText", award: "award", inbox: "inbox",
  files: "files", "file-pen": "filePen", signature: "signature", send: "send", clock: "clock", "check-circle": "checkCircle",
  archive: "archive", settings: "settings", "book-open": "book", plug: "plug", key: "key", bot: "bot", folder: "folder",
  list: "list", calendar: "calendar", bell: "bell", search: "search",
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const Drawn = ICONS[name];
  return <Drawn className={cn("size-4 shrink-0", className)} aria-hidden="true" focusable="false" />;
}
