/**
 * An amount as a person types it or a slip prints it, written the way the API takes it: no `$`, `%`, spaces or
 * thousands separators, and a point as the decimal mark. A comma followed by one or two digits at the end, with no
 * point anywhere, is a decimal comma (Quebec slips print 45 000,00); any other comma separates thousands (60,000). A
 * value with both marks is left with its point, so the amount checks refuse it instead of a guess saving a wrong sum.
 */
export function normalizeAmount(value: string): string {
  const compact = value.replace(/[$%\s]/g, "");
  if (!compact.includes(".") && /,\d{1,2}$/.test(compact)) {
    const mark = compact.lastIndexOf(",");
    return `${compact.slice(0, mark).replace(/,/g, "")}.${compact.slice(mark + 1)}`;
  }
  return compact.replace(/,/g, "");
}
