import { formatCompact, formatExact, formatRatioPercent, formatRounded, isPositive } from "./decimal.ts";

// Display formats: shares with thousands separators and the company's decimals, prices in USD
// with 2–4 decimals (more only when the value has them), percentages with 2 decimals, dates as "Oct 21, 2026". Legal
// dates are YYYY-MM-DD strings in the org's time zone and are formatted without a Date, so no zone can shift them.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DASH = "—";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(iso: string): { y: number; m: number; d: number } | null {
  const match = ISO_DATE.exec(iso.slice(0, 10));
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

/** "Oct 21, 2026", or "—". */
export function formatDate(iso: string | null | undefined): string {
  const p = iso ? parts(iso) : null;
  return p ? `${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : DASH;
}

/** "Oct 21". */
export function formatMonthDay(iso: string | null | undefined): string {
  const p = iso ? parts(iso) : null;
  return p ? `${MONTHS[p.m - 1]} ${p.d}` : DASH;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return 0;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** The date `days` after `iso`. */
export function addDays(iso: string, days: number): string {
  const p = parts(iso);
  if (!p) return iso;
  return new Date(Date.UTC(p.y, p.m - 1, p.d + days)).toISOString().slice(0, 10);
}

/** The date `years` after `iso`, clamped to the month's last day (Feb 29 → Feb 28). */
export function addYears(iso: string, years: number): string {
  const p = parts(iso);
  if (!p) return iso;
  const last = new Date(Date.UTC(p.y + years, p.m, 0)).getUTCDate();
  return `${String(p.y + years).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(Math.min(p.d, last)).padStart(2, "0")}`;
}

/** "15 days", "1 day" or "passed": time left until a deadline. */
export function formatDaysLeft(today: string, deadline: string): string {
  const days = daysBetween(today, deadline);
  return days < 0 ? "passed" : `${days} day${days === 1 ? "" : "s"}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

export interface DisplaySettings {
  shareDecimals: number;
  priceDecimals: number;
}

export interface Formatter {
  /** Share and option quantities. */
  shares(value: string | null | undefined): string;
  /** A per-share price: "$0.95", "$0.00001". */
  price(value: string | null | undefined): string;
  /** Money: "$16,147,718.60"; `digits` 0 for round amounts such as a SAFE principal. */
  money(value: string | null | undefined, digits?: number): string;
  /** An exact fraction of the whole as a percentage: "17.69%". */
  percent(ratio: string | null | undefined): string;
  compact(value: string | null | undefined): string;
  date(iso: string | null | undefined): string;
  /** An instant (epoch ms) in the org's time zone: "Oct 21, 2026 at 9:40am". */
  dateTime(ms: number | null | undefined): string;
  /** "Today 9:40am", "Yesterday", "3 days ago". */
  relative(ms: number | null | undefined): string;
  /** The org-local date of an instant. */
  localDate(ms: number): string;
}

export function createFormatter(display: DisplaySettings, timeZone: string | undefined, today: string): Formatter {
  // One formatter per org: building an Intl.DateTimeFormat is expensive and tables call this per row.
  const clockParts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timeZone), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const partsOf = (ms: number) => {
    const values = Object.fromEntries(clockParts.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour), minute: values.minute ?? "00" };
  };
  const clock = (hour: number, minute: string) => `${((hour + 11) % 12) + 1}:${minute}${hour >= 12 ? "pm" : "am"}`;
  return {
    shares: (value) => (value === null || value === undefined ? DASH : formatExact(value, display.shareDecimals)),
    price: (value) => (value === null || value === undefined ? DASH : `$${formatExact(value, display.priceDecimals)}`),
    money: (value, digits = 2) => (value === null || value === undefined ? DASH : `$${formatRounded(value, digits)}`),
    percent: (ratio) => formatRatioPercent(ratio),
    compact: (value) => formatCompact(value),
    date: formatDate,
    dateTime: (ms) => {
      if (ms === null || ms === undefined) return DASH;
      const p = partsOf(ms);
      return `${formatDate(p.date)} at ${clock(p.hour, p.minute)}`;
    },
    relative: (ms) => {
      if (ms === null || ms === undefined) return "";
      const p = partsOf(ms);
      const days = daysBetween(p.date, today);
      if (days <= 0) return `Today ${clock(p.hour, p.minute)}`;
      if (days === 1) return "Yesterday";
      if (days < 30) return `${days} days ago`;
      if (days < 365) {
        const months = Math.round(days / 30);
        return `${months} month${months > 1 ? "s" : ""} ago`;
      }
      const years = Math.round(days / 365);
      return `${years} year${years > 1 ? "s" : ""} ago`;
    },
    localDate: (ms) => partsOf(ms).date,
  };
}

function safeZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** A file's size in the binary units the upload limits use: "47 KiB", "3.5 MiB". */
export function formatBytes(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes < mib ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-US")} KiB` : `${(bytes / mib).toFixed(1)} MiB`;
}

/** A quantity cell: a dash for zero, so the figures that are there stand out. */
export function sharesOrDash(format: Formatter, value: string | null | undefined): string {
  return isPositive(value) ? format.shares(value) : DASH;
}
