/**
 * One RFC 4180 CSV field of text, for a file a spreadsheet opens: the Worker's report exports and the migration tool's
 * reports. Text a spreadsheet would run as a formula (= + - @, after any spaces, or a leading tab or carriage return) is
 * neutralized by an apostrophe. Every field is quoted: locale-specific separators (notably `;`) cannot split a safe value
 * into a formula cell.
 */
export function csvTextField(value: string): string {
  const text = /^[\t\r]/.test(value) || /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}
