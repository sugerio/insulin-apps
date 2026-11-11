// The icons an app's navigation manifest may name (DESIGN.md §3.2): exactly .github/scripts/list-apps.mjs's
// NAVIGATION_ICONS, which a unit test keeps in step. components/nav-icon.tsx maps each to its Lucide component, so the
// gateway draws an app's level 1 with the icons the app itself uses.
export const NAV_ICON_NAMES = [
  'activity', 'archive', 'award', 'banknote', 'bell', 'book-open', 'bot', 'briefcase', 'building', 'calendar',
  'chart-bar', 'chart-pie', 'check-circle', 'circle-check', 'clipboard-list', 'clock', 'download', 'file-pen',
  'file-text', 'files', 'folder', 'gauge', 'heart', 'history', 'home', 'house', 'inbox', 'key', 'landmark', 'layers',
  'layout-dashboard', 'layout-grid', 'list', 'mail', 'percent', 'plug', 'receipt', 'scale', 'search', 'send',
  'settings', 'shield', 'signature', 'table', 'trending-up', 'upload', 'user', 'users', 'wallet',
] as const

export type NavIconName = (typeof NAV_ICON_NAMES)[number]

const NAMES: ReadonlySet<string> = new Set(NAV_ICON_NAMES)

export function isNavIconName(value: unknown): value is NavIconName {
  return typeof value === 'string' && NAMES.has(value)
}
