import { strFromU8, unzipSync } from "fflate";

export interface WorkbookSheet {
  name: string;
  rows: string[][];
  warnings: string[];
  errors?: Array<{ cell: string; row: number; column: string; value: string }>;
}

/** Reads the small, ordinary OOXML subset used by Pulley without ever parsing a numeric cell as a JS float. */
export function readXlsxBytes(bytes: Uint8Array): WorkbookSheet[] {
  let archive: Record<string, Uint8Array>;
  let expanded = 0;
  try {
    archive = unzipSync(bytes, { filter: (entry) => {
      if (entry.originalSize > 64 * 1024 * 1024) throw new Error(`Excel entry ${entry.name} is larger than 64 MiB when decompressed.`);
      expanded += entry.originalSize;
      if (expanded > 128 * 1024 * 1024) throw new Error("The Excel workbook is larger than 128 MiB when decompressed.");
      return true;
    } });
  } catch (error) {
    if (error instanceof Error && /larger than/.test(error.message)) throw error;
    throw new Error("This is not a readable Excel workbook.");
  }

  const workbookXml = textPart(archive, "xl/workbook.xml");
  const relationshipsXml = textPart(archive, "xl/_rels/workbook.xml.rels");
  const sharedStrings = archive["xl/sharedStrings.xml"]
    ? parseSharedStrings(strFromU8(archive["xl/sharedStrings.xml"]))
    : [];
  const styles = archive["xl/styles.xml"] ? parseStyles(strFromU8(archive["xl/styles.xml"])) : [];
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/i.test(workbookXml);
  const relationships = new Map<string, string>();
  for (const attributes of tags(relationshipsXml, "Relationship")) {
    const id = attribute(attributes, "Id");
    const target = attribute(attributes, "Target");
    if (id && target) relationships.set(id, normalizeWorkbookTarget(target));
  }

  const sheets: WorkbookSheet[] = [];
  for (const attributes of tags(workbookXml, "sheet")) {
    const name = attribute(attributes, "name");
    const relationshipId = attribute(attributes, "r:id");
    if (!name || !relationshipId) throw new Error("The Excel workbook has a sheet without a name or relationship.");
    const target = relationships.get(relationshipId);
    if (!target) throw new Error(`The Excel workbook cannot find sheet ${name}.`);
    const parsed = parseWorksheet(textPart(archive, target), sharedStrings, styles, date1904);
    sheets.push({ name, rows: parsed.rows, warnings: parsed.warnings, ...(parsed.errors.length ? { errors: parsed.errors } : {}) });
  }
  if (sheets.length === 0) throw new Error("The Excel workbook has no sheets.");
  return sheets;
}

interface CellStyle {
  date: boolean;
  time: boolean;
}

function parseWorksheet(
  xml: string,
  sharedStrings: string[],
  styles: CellStyle[],
  date1904: boolean,
): { rows: string[][]; warnings: string[]; errors: Array<{ cell: string; row: number; column: string; value: string }> } {
  const rows: string[][] = [];
  const warnings: string[] = [];
  const errors: Array<{ cell: string; row: number; column: string; value: string }> = [];
  let cursor = 0;
  while (true) {
    const rowStart = findTag(xml, "row", cursor);
    if (rowStart < 0) break;
    const rowOpenEnd = xml.indexOf(">", rowStart + 4);
    if (rowOpenEnd < 0) throw new Error("The Excel workbook has an unterminated row.");
    const rowSelfClosing = xml[rowOpenEnd - 1] === "/";
    const rowClose = rowSelfClosing ? rowOpenEnd : xml.indexOf("</row>", rowOpenEnd + 1);
    if (rowClose < 0) throw new Error("The Excel workbook has an unterminated row.");
    const rowAttributes = xml.slice(rowStart + 4, rowOpenEnd);
    const rowNumber = Number(attribute(rowAttributes, "r") ?? rows.length + 1);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) throw new Error("The Excel workbook has an invalid row address.");
    while (rows.length < rowNumber - 1) rows.push([]);
    const row: string[] = [];
    let cellCursor = rowOpenEnd + 1;
    while (!rowSelfClosing && cellCursor < rowClose) {
      const cellStart = findTag(xml, "c", cellCursor, rowClose);
      if (cellStart < 0) break;
      const cellOpenEnd = xml.indexOf(">", cellStart + 2);
      if (cellOpenEnd < 0 || cellOpenEnd > rowClose) throw new Error("The Excel workbook has an unterminated cell.");
      const cellSelfClosing = xml[cellOpenEnd - 1] === "/";
      const cellClose = cellSelfClosing ? cellOpenEnd : xml.indexOf("</c>", cellOpenEnd + 1);
      if (cellClose < 0 || cellClose > rowClose) throw new Error("The Excel workbook has an unterminated cell.");
      const attrs = xml.slice(cellStart + 2, cellOpenEnd);
      const reference = attribute(attrs, "r") ?? `${columnName(row.length + 1)}${rowNumber}`;
      const column = columnIndex(reference);
      if (column < 1) throw new Error(`The Excel workbook has an invalid cell address (${reference}).`);
      const type = attribute(attrs, "t");
      let value = "";
      if (type === "inlineStr") {
        const inlineStart = xml.indexOf("<is", cellOpenEnd + 1);
        const inlineOpenEnd = inlineStart < 0 || inlineStart > cellClose ? -1 : xml.indexOf(">", inlineStart + 3);
        const inlineClose = inlineOpenEnd < 0 ? -1 : xml.indexOf("</is>", inlineOpenEnd + 1);
        if (inlineClose >= 0 && inlineClose <= cellClose) value = richText(xml.slice(inlineOpenEnd + 1, inlineClose));
      } else {
        const valueStart = xml.indexOf("<v>", cellOpenEnd + 1);
        const valueEnd = valueStart < 0 || valueStart > cellClose ? -1 : xml.indexOf("</v>", valueStart + 3);
        const rawValue = valueEnd >= 0 && valueEnd <= cellClose ? xml.slice(valueStart + 3, valueEnd) : null;
        if (type === "s" && rawValue !== null) value = sharedStrings[Number(rawValue)] ?? "";
        else if (type === "b" && rawValue !== null) value = rawValue === "1" ? "TRUE" : "FALSE";
        else if (type === "str" && rawValue !== null) value = decodeXml(rawValue);
        else if (type === "d" && rawValue !== null) value = decodeXml(rawValue).slice(0, 10);
        else if (type === "e") errors.push({ cell: reference, row: rowNumber, column: reference.replace(/\d+$/, ""), value: rawValue === null ? "#ERROR!" : decodeXml(rawValue) });
        else if (rawValue !== null) {
          const numeric = exactDecimal(decodeXml(rawValue));
          if (numeric.significantDigits > 15) warnings.push(`${reference} has ${numeric.significantDigits} significant digits.`);
          const styleIndex = Number(attribute(attrs, "s") ?? 0);
          const style = styles[styleIndex] ?? { date: false, time: false };
          value = style.date ? excelDate(numeric.value, date1904, style.time) : numeric.value;
        }
      }
      while (row.length < column) row.push("");
      row[column - 1] = value;
      cellCursor = cellClose + (cellSelfClosing ? 1 : 4);
    }
    rows.push(row);
    cursor = rowClose + (rowSelfClosing ? 1 : 6);
  }
  return { rows, warnings, errors };
}

function findTag(xml: string, name: string, start: number, limit = xml.length): number {
  const marker = `<${name}`;
  let found = xml.indexOf(marker, start);
  while (found >= 0 && found < limit) {
    const following = xml.charCodeAt(found + marker.length);
    if (following === 32 || following === 9 || following === 10 || following === 13 || following === 47 || following === 62) return found;
    found = xml.indexOf(marker, found + marker.length);
  }
  return -1;
}

function parseStyles(xml: string): CellStyle[] {
  const custom = new Map<number, string>();
  for (const attrs of tags(xml, "numFmt")) {
    const id = Number(attribute(attrs, "numFmtId"));
    const code = attribute(attrs, "formatCode");
    if (Number.isSafeInteger(id) && code !== null) custom.set(id, code);
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  return tags(cellXfs, "xf").map((attrs) => {
    const id = Number(attribute(attrs, "numFmtId") ?? 0);
    const format = custom.get(id) ?? "";
    const visible = format
      .replace(/"[^"]*"/g, "")
      .replace(/\\./g, "")
      .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, "");
    const builtInDate = (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
    return {
      date: builtInDate || /[dmy]/i.test(visible),
      time: (id >= 18 && id <= 22) || (id >= 45 && id <= 47) || /[hs]/i.test(visible),
    };
  });
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => richText(match[1] ?? ""));
}

function richText(xml: string): string {
  const firstTag = xml.indexOf("<t");
  if (firstTag >= 0) {
    const openEnd = xml.indexOf(">", firstTag);
    const close = openEnd < 0 ? -1 : xml.indexOf("</t>", openEnd + 1);
    if (close >= 0 && xml.indexOf("<t", close + 4) < 0) return decodeXml(xml.slice(openEnd + 1, close));
  }
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXml(match[1] ?? ""))
    .join("");
}

function tags(xml: string, name: string): string[] {
  const pattern = TAG_PATTERNS.get(name) ?? new RegExp(`<${name}\\b([^>]*)/?>`, "g");
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
}

function attribute(attributes: string, name: string): string | null {
  const marker = `${name}="`;
  let start = attributes.indexOf(marker);
  while (start > 0 && !isXmlWhitespace(attributes.charCodeAt(start - 1))) start = attributes.indexOf(marker, start + marker.length);
  if (start < 0) return null;
  start += marker.length;
  const end = attributes.indexOf('"', start);
  return end < 0 ? null : decodeXml(attributes.slice(start, end));
}

function isXmlWhitespace(code: number): boolean { return code === 32 || code === 9 || code === 10 || code === 13 }

const TAG_PATTERNS = new Map(["Relationship", "sheet", "numFmt", "xf"].map((name) => [name, new RegExp(`<${name}\\b([^>]*)/?>`, "g")]));

function textPart(archive: Record<string, Uint8Array>, name: string): string {
  const bytes = archive[name];
  if (!bytes) throw new Error(`The Excel workbook is missing ${name}.`);
  return strFromU8(bytes);
}

function normalizeWorkbookTarget(target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`).split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "..") normalized.pop();
    else if (part !== "." && part !== "") normalized.push(part);
  }
  return normalized.join("/");
}

function decodeXml(value: string): string {
  if (!value.includes("&") && !value.includes("_x")) return value;
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/_x([0-9a-f]{4})_/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

/** Expands exponent notation by moving text digits, not by evaluating the number. */
export function exactDecimal(source: string): { value: string; significantDigits: number } {
  const trimmed = source.trim();
  let offset = trimmed[0] === "+" || trimmed[0] === "-" ? 1 : 0;
  let integerOnly = offset < trimmed.length;
  for (let index = offset; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 48 || code > 57) { integerOnly = false; break; }
  }
  if (integerOnly) {
    const negative = trimmed[0] === "-";
    while (offset < trimmed.length - 1 && trimmed.charCodeAt(offset) === 48) offset += 1;
    const digits = trimmed.slice(offset);
    return { value: digits === "0" ? "0" : `${negative ? "-" : ""}${digits}`, significantDigits: digits === "0" ? 1 : digits.length };
  }
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(trimmed);
  if (!match) throw new Error(`The Excel workbook contains a non-decimal numeric cell (${source}).`);
  const sign = match[1] === "-" ? "-" : "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) throw new Error("An Excel number has an exponent that is too large.");
  const significantDigits = `${integer}${fraction}`.replace(/^0+/, "").length || 1;
  const digits = `${integer}${fraction}`;
  const point = integer.length + exponent;
  let expanded: string;
  if (point <= 0) expanded = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) expanded = `${digits}${"0".repeat(point - digits.length)}`;
  else expanded = `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [wholeSource = "0", fractionSource = ""] = expanded.split(".");
  const whole = wholeSource.replace(/^0+(?=\d)/, "") || "0";
  const trimmedFraction = fractionSource.replace(/0+$/, "");
  const canonical = trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
  return { value: canonical === "0" ? "0" : `${sign}${canonical}`, significantDigits };
}

function excelDate(serial: string, date1904: boolean, withTime: boolean): string {
  let integerOnly = serial.length > 0;
  for (let index = 0; index < serial.length; index += 1) {
    const code = serial.charCodeAt(index);
    if (code < 48 || code > 57) { integerOnly = false; break; }
  }
  if (integerOnly) {
    let days = Number(serial);
    if (!Number.isSafeInteger(days)) throw new Error(`An Excel date has an invalid serial number (${serial}).`);
    if (!date1904 && days >= 60) days -= 1;
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const date = new Date(epoch + days * 86_400_000);
    if (Number.isNaN(date.valueOf())) throw new Error(`An Excel date has an invalid serial number (${serial}).`);
    return date.toISOString().slice(0, 10);
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(serial);
  if (!match) throw new Error(`An Excel date has an invalid serial number (${serial}).`);
  let days = BigInt(match[1] ?? "0");
  const fraction = match[2] ?? "";
  if (!date1904 && days >= 60n) days -= 1n;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  let millis = BigInt(epoch) + days * 86_400_000n;
  if (fraction) {
    const denominator = 10n ** BigInt(fraction.length);
    millis += (BigInt(fraction) * 86_400_000n + denominator / 2n) / denominator;
  }
  const iso = new Date(Number(millis)).toISOString();
  return withTime || fraction ? iso.replace(/\.000Z$/, "Z") : iso.slice(0, 10);
}

function columnIndex(name: string): number {
  let result = 0;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    const upper = code >= 97 && code <= 122 ? code - 32 : code;
    if (upper < 65 || upper > 90) break;
    result = result * 26 + upper - 64;
  }
  return result;
}

function columnName(index: number): string {
  let name = "";
  for (let current = index; current > 0; current = Math.floor((current - 1) / 26)) {
    name = String.fromCharCode(65 + ((current - 1) % 26)) + name;
  }
  return name;
}
