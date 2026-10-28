import { Dec } from "./decimal.ts";
import { EngineError } from "./errors.ts";

/**
 * Legal dates as `YYYY-MM-DD` (the ledger rules): grants, vests, windows and deadlines are calendar dates in the org's
 * time zone, so they carry no time and no zone. Arithmetic runs on day numbers (days since 1970-01-01, proleptic
 * Gregorian), never on `Date`, so results don't depend on the host's zone. Valid ISO dates sort as plain strings.
 */
export type IsoDate = string;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The number spelled by `length` ASCII digits from `start`, or -1 when one isn't a digit. Character codes instead of
 * a regex and Number(): replay reads dates in its inner loops.
 */
function digitsAt(text: string, start: number, length: number): number {
  let value = 0;
  for (let i = start; i < start + length; i++) {
    const digit = text.charCodeAt(i) - 48;
    if (!(digit >= 0 && digit <= 9)) return -1;
    value = value * 10 + digit;
  }
  return value;
}

function isValidDay(year: number, month: number, day: number): boolean {
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** True for a real calendar date with a four-digit year from 0001. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string" || value.length !== 10 || value.charCodeAt(4) !== 45 || value.charCodeAt(7) !== 45) return false;
  return isValidDay(digitsAt(value, 0, 4), digitsAt(value, 5, 2), digitsAt(value, 8, 2));
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export function parseIsoDate(value: string): DateParts {
  if (!isIsoDate(value)) throw new EngineError("DATE_INVALID", `Not a date: ${JSON.stringify(value)}`);
  return { year: digitsAt(value, 0, 4), month: digitsAt(value, 5, 2), day: digitsAt(value, 8, 2) };
}

export function formatIsoDate(year: number, month: number, day: number): IsoDate {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || year > 9999 || !isValidDay(year, month, day)) {
    throw new EngineError("DATE_INVALID", `Not a date: ${year}-${month}-${day}`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's days_from_civil).
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): DateParts {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: era * 400 + yoe + (month <= 2 ? 1 : 0), month, day };
}

export function toEpochDay(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  return daysFromCivil(year, month, day);
}

export function fromEpochDay(days: number): IsoDate {
  if (!Number.isSafeInteger(days)) throw new EngineError("DATE_INVALID", `Not a day number: ${days}`);
  const { year, month, day } = civilFromDays(days);
  return formatIsoDate(year, month, day);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) throw new EngineError("DATE_INVALID", `Not a whole number of days: ${days}`);
  return fromEpochDay(toEpochDay(date) + days);
}

/**
 * Adds calendar months on the same day of month, clamped to the month's last day: Jan 31 + 1 month = Feb 28 (29 in a
 * leap year). Each call counts from `date`, so a schedule computes every tranche from its start (Jan 31 → Feb 28 →
 * Mar 31) instead of chaining clamped dates (the ledger rules).
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  if (!Number.isInteger(months)) throw new EngineError("DATE_INVALID", `Not a whole number of months: ${months}`);
  const { year, month, day } = parseIsoDate(date);
  const index = year * 12 + (month - 1) + months;
  const newYear = Math.floor(index / 12);
  const newMonth = index - newYear * 12 + 1;
  return formatIsoDate(newYear, newMonth, Math.min(day, daysInMonth(newYear, newMonth)));
}

export function addYears(date: IsoDate, years: number): IsoDate {
  return addMonths(date, years * 12);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: IsoDate): number {
  return (((toEpochDay(date) + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

export function isWeekend(date: IsoDate): boolean {
  const day = weekday(date);
  return day === 0 || day === 6;
}

export function yearOf(date: IsoDate): number {
  return parseIsoDate(date).year;
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** A period of a termination window or repurchase window: DAYS, MONTHS, QUARTERS or YEARS, in whole units. */
export type PeriodUnit = "DAYS" | "MONTHS" | "QUARTERS" | "YEARS";

export function addPeriod(date: IsoDate, period: number | string | Dec, unit: PeriodUnit): IsoDate {
  const amount = Dec.from(period);
  if (!amount.isInteger() || amount.isNegative() || amount.gt(100_000)) {
    throw new EngineError("PERIOD_INVALID", `A period must be a whole, non-negative number: ${String(period)}`);
  }
  const count = Number(amount.mantissa);
  switch (unit) {
    case "DAYS":
      return addDays(date, count);
    case "MONTHS":
      return addMonths(date, count);
    case "QUARTERS":
      return addMonths(date, count * 3);
    case "YEARS":
      return addMonths(date, count * 12);
  }
}

// ---------------------------------------------------------------------------
// Business days. Only where the law says so: IRC §7503 moves a tax deadline (an 83(b) election, the Form 3921 copies)
// that falls on a Saturday, Sunday or legal holiday to the next day that is none of them. Legal holidays here are the
// federal holidays (5 U.S.C. §6103, with the weekend observance rule) plus District of Columbia Emancipation Day, which
// the IRS observes for filing deadlines. A product rule that counts business days (such as a future payment due date) uses the
// same calendar.

function nthWeekdayOfMonth(year: number, month: number, dayOfWeek: number, n: number): IsoDate {
  if (n > 0) {
    const first = weekday(formatIsoDate(year, month, 1));
    return formatIsoDate(year, month, 1 + ((dayOfWeek - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = daysInMonth(year, month);
  const last = weekday(formatIsoDate(year, month, lastDay));
  return formatIsoDate(year, month, lastDay - ((last - dayOfWeek + 7) % 7));
}

function observed(date: IsoDate): IsoDate {
  const day = weekday(date);
  if (day === 6) return addDays(date, -1);
  if (day === 0) return addDays(date, 1);
  return date;
}

const HOLIDAY_CACHE = new Map<number, ReadonlySet<IsoDate>>();

/** Observed legal holidays falling in `year` (a Saturday New Year's Day is observed on Dec 31 of the year before). */
export function legalHolidays(year: number): ReadonlySet<IsoDate> {
  const cached = HOLIDAY_CACHE.get(year);
  if (cached) return cached;
  const candidates: IsoDate[] = [
    observed(formatIsoDate(year, 1, 1)),
    nthWeekdayOfMonth(year, 1, 1, 3), // Birthday of Martin Luther King, Jr.
    nthWeekdayOfMonth(year, 2, 1, 3), // Washington's Birthday
    observed(formatIsoDate(year, 4, 16)), // DC Emancipation Day (IRS filing deadlines)
    nthWeekdayOfMonth(year, 5, 1, -1), // Memorial Day
    nthWeekdayOfMonth(year, 9, 1, 1), // Labor Day
    nthWeekdayOfMonth(year, 10, 1, 2), // Columbus Day
    observed(formatIsoDate(year, 11, 11)), // Veterans Day
    nthWeekdayOfMonth(year, 11, 4, 4), // Thanksgiving Day
    observed(formatIsoDate(year, 12, 25)),
    observed(formatIsoDate(year, 7, 4)),
  ];
  if (year >= 2021) candidates.push(observed(formatIsoDate(year, 6, 19))); // Juneteenth, a legal holiday since 2021
  const nextNewYear = observed(formatIsoDate(year + 1, 1, 1));
  if (yearOf(nextNewYear) === year) candidates.push(nextNewYear);
  const holidays = new Set(candidates.filter((date) => yearOf(date) === year));
  HOLIDAY_CACHE.set(year, holidays);
  return holidays;
}

export function isLegalHoliday(date: IsoDate): boolean {
  return legalHolidays(yearOf(date)).has(date);
}

export function isBusinessDay(date: IsoDate): boolean {
  return !isWeekend(date) && !isLegalHoliday(date);
}

/** The date itself when it is a business day, else the next business day (IRC §7503). */
export function rollToBusinessDay(date: IsoDate): IsoDate {
  let current = date;
  while (!isBusinessDay(current)) current = addDays(current, 1);
  return current;
}

export function addBusinessDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days) || days < 0) throw new EngineError("DATE_INVALID", `Not a whole number of days: ${days}`);
  let current = date;
  let left = days;
  while (left > 0) {
    current = addDays(current, 1);
    if (isBusinessDay(current)) left -= 1;
  }
  return current;
}

/** The 83(b) election deadline: 30 days after the transfer, rolled forward under §7503 (the product rules). */
export function election83bDeadline(transferDate: IsoDate): { date: IsoDate; unrolled: IsoDate; rolled: boolean } {
  const unrolled = addDays(transferDate, 30);
  const date = rollToBusinessDay(unrolled);
  return { date, unrolled, rolled: date !== unrolled };
}

/** Form 3921 due dates for a tax year: Copy B to employees by Jan 31, Copy A e-filed by Mar 31, each rolled. */
export function form3921Deadlines(taxYear: number): { copyB: IsoDate; copyAElectronic: IsoDate } {
  return {
    copyB: rollToBusinessDay(formatIsoDate(taxYear + 1, 1, 31)),
    copyAElectronic: rollToBusinessDay(formatIsoDate(taxYear + 1, 3, 31)),
  };
}

/**
 * The org's local date at an instant: "today" for jobs and for "no ledger date after today" (the ledger rules). The time
 * zone only decides which date it is now; it never changes a stored date.
 */
export function orgToday(timeZone: string, nowMs: number): IsoDate {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    nowMs,
  );
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return formatIsoDate(Number(get("year")), Number(get("month")), Number(get("day")));
}
