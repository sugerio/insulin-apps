import type { ReactNode } from "react";
import type { NavIconName } from "../lib/navigation.ts";

// Line icons (24×24, stroke = currentColor). Decorative: the text next to them carries
// the meaning, so every icon is aria-hidden.

const ICONS = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 20a6.5 6.5 0 0 0-3-5.5" /></>,
  heart: <path d="M12 20s-7.5-4.6-9.2-9.3C1.7 7.5 3.7 4.5 7 4.5c2 0 3.5 1.2 5 3 1.5-1.8 3-3 5-3 3.3 0 5.3 3 4.2 6.2C19.5 15.4 12 20 12 20z" />,
  shield: <><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3" /></>,
  award: <><circle cx="12" cy="9" r="5.5" /><path d="m8.5 13.5-1.5 7 5-2.5 5 2.5-1.5-7" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chevDown: <path d="m6 9 6 6 6-6" />,
  chevRight: <path d="m9 6 6 6-6 6" />,
  chevLeft: <path d="m15 6-6 6 6 6" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9zM9 11h6M9 15h4" /></>,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  upload: <path d="M12 16V5M7 10l5-5 5 5M5 20h14" />,
  filter: <path d="M4 5h16l-6 8v5l-4 2v-7z" />,
  columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  rows: <path d="M4 6h16M4 12h16M4 18h16" />,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h0" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5h0" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  refresh: <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  database: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  checkCircle: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6 8.5-6" /></>,
  briefcase: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5h6v2M3 12h18" /></>,
  pie: <><path d="M12 3v9h9A9 9 0 1 1 12 3z" /><path d="M15 2.5a8 8 0 0 1 6.5 6.5H15z" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8M12 16.8v.2" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  book: <><path d="M3 5h6a3 3 0 0 1 3 3v12a2.5 2.5 0 0 0-2.5-2.5H3z" /><path d="M21 5h-6a3 3 0 0 0-3 3v12a2.5 2.5 0 0 1 2.5-2.5H21z" /></>,
  // The navigation's: the manifest names Lucide icons (NAV_ICON below), drawn here in Cap Table's own line style.
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 12.5 9 5 9-5" /><path d="m3 16.5 9 5 9-5" /></>,
  fileText: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
  inbox: <><path d="M3 13h5l1.5 3h5l1.5-3h5" /><path d="M5.5 5h13L21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z" /></>,
  files: <><path d="M15 3H9a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" /><path d="M15 3v5h5" /><path d="M4 8v11a2 2 0 0 0 2 2h9" /></>,
  filePen: <><path d="M11 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v2.5" /><path d="M14 3v5h5" /><path d="M14 21v-2.5l5.5-5.5 2.5 2.5-5.5 5.5z" /></>,
  signature: <><path d="M3 16c3-1 4-9 6.5-9S9 17 12 17s3-4 4.5-4 1 3 2.5 3H21" /><path d="M3 21h18" /></>,
  send: <><path d="M21 3 10 14" /><path d="m21 3-7 18-4-7-7-4z" /></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" /></>,
  settings: <><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>,
  plug: <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v4a6 6 0 0 1-12 0z" /><path d="M12 18v3" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2" /></>,
  bot: <><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4H9M2 14h2M20 14h2M9 13v2M15 13v2" /></>,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h0M4.5 12h0M4.5 18h0" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  bell: <><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></>,
  // The shell's own: the collapse toggles, the menus' chevrons, the person's menu.
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  chevrons: <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>,
  user: <><circle cx="12" cy="8" r="4.5" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  logOut: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  contrast: <><circle cx="12" cy="12" r="9" /><path d="M12 3v18a9 9 0 0 0 0-18z" /></>,
} satisfies Record<string, ReactNode>;

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
  return (
    <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}
