import type { XlsxCell } from "./xlsx.ts";

function valueOf(cell: XlsxCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) throw new Error("CSV cannot contain non-finite numbers");
    return String(cell);
  }
  if (typeof cell === "object") return cell.value;
  return cell;
}

/** RFC 4180 rows with spreadsheet formula prefixes neutralized by an apostrophe. */
export function csvCell(cell: XlsxCell): string {
  let value = valueOf(cell);
  if (typeof cell !== "number" && (/^[\t\r]/.test(value) || /^\s*[=+\-@]/.test(value))) value = `'${value}`;
  // Quote every field: locale-specific separators (notably `;`) cannot split a safe value into a formula cell.
  return `"${value.replace(/"/g, '""')}"`;
}

export function writeCsv(rows: readonly (readonly XlsxCell[])[]): string {
  // Excel needs the BOM for non-ASCII holder names and masked e-mail bullets.
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
