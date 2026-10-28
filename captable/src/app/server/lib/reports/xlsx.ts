const encoder = new TextEncoder();

export interface XlsxColumn { header: string; width?: number; }
export interface XlsxDateCell { type: "date"; value: string; }
export interface XlsxDecimalCell { type: "decimal"; value: string; }
export type XlsxCell = string | number | boolean | XlsxDateCell | XlsxDecimalCell | null | undefined;
export interface XlsxSheet { name: string; columns: readonly XlsxColumn[]; rows: readonly (readonly XlsxCell[])[]; }

function xml(value: string): string {
  return value
    .replace(/_x[0-9a-fA-F]{4}_/g, (match) => `_x005F_${match}`)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (character) =>
      `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function columnName(index: number): string {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function excelDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid XLSX date: ${value}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new Error(`Invalid XLSX date: ${value}`);
  return date.valueOf() / 86_400_000 + 25_569;
}

function validateText(value: string): void {
  if (value.length > 32_767) throw new Error("XLSX cells cannot exceed 32,767 characters");
}

function validateSheet(sheet: XlsxSheet): void {
  if (!sheet.name || sheet.name.length > 31 || /[\\/*?:[\]]/.test(sheet.name)
    || sheet.name.startsWith("'") || sheet.name.endsWith("'") || sheet.name.toLowerCase() === "history") {
    throw new Error(`Invalid XLSX sheet name: ${sheet.name}`);
  }
  if (sheet.columns.length === 0 || sheet.columns.length > 16_384) throw new Error("An XLSX sheet needs 1–16,384 columns");
  if (sheet.rows.length > 1_048_575) throw new Error("An XLSX sheet cannot exceed 1,048,576 rows including its header");
  for (const column of sheet.columns) validateText(column.header);
  for (const row of sheet.rows) {
    if (row.length > sheet.columns.length) throw new Error(`Row in ${sheet.name} has more cells than columns`);
    for (const cell of row) {
      if (typeof cell === "string") validateText(cell);
      else if (cell && typeof cell === "object" && cell.type === "decimal") validateText(cell.value);
    }
  }
}

interface SharedStrings {
  values: string[];
  index(value: string): number;
  count: number;
}

function collectStrings(sheets: readonly XlsxSheet[]): SharedStrings {
  const values: string[] = [];
  const indexes = new Map<string, number>();
  let count = 0;
  const collect = (value: string) => {
    count += 1;
    const existing = indexes.get(value);
    if (existing !== undefined) return existing;
    const next = values.length;
    values.push(value);
    indexes.set(value, next);
    return next;
  };
  for (const sheet of sheets) {
    for (const column of sheet.columns) collect(column.header);
    for (const row of sheet.rows) for (const cell of row) {
      if (typeof cell === "string") collect(cell);
      else if (cell && typeof cell === "object" && cell.type === "decimal") collect(cell.value);
    }
  }
  return {
    values, count,
    index(value) {
      const found = indexes.get(value);
      if (found === undefined) throw new Error("Shared string was not collected");
      return found;
    },
  };
}

function worksheetXml(sheet: XlsxSheet, strings: SharedStrings): string {
  const columns = sheet.columns.map((column, index) => {
    const width = column.width ?? Math.max(10, Math.min(60, column.header.length + 2));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const cellXml = (cell: XlsxCell, row: number, column: number, header = false): string => {
    const reference = `${columnName(column)}${row}`;
    if (cell === null || cell === undefined) return `<c r="${reference}"/>`;
    if (typeof cell === "number") {
      if (!Number.isFinite(cell)) throw new Error(`Non-finite number at ${reference}`);
      return `<c r="${reference}" t="n"><v>${cell}</v></c>`;
    }
    if (typeof cell === "boolean") return `<c r="${reference}" t="b"><v>${cell ? 1 : 0}</v></c>`;
    if (typeof cell === "object") {
      if (cell.type === "date") return `<c r="${reference}" s="1" t="n"><v>${excelDate(cell.value)}</v></c>`;
      return `<c r="${reference}" t="s"><v>${strings.index(cell.value)}</v></c>`;
    }
    return `<c r="${reference}"${header ? ' s="2"' : ""} t="s"><v>${strings.index(cell)}</v></c>`;
  };
  const header = `<row r="1">${sheet.columns.map((column, index) => cellXml(column.header, 1, index, true)).join("")}</row>`;
  const rows = sheet.rows.map((row, rowIndex) =>
    `<row r="${rowIndex + 2}">${row.map((cell, column) => cellXml(cell, rowIndex + 2, column)).join("")}</row>`,
  ).join("");
  const endCell = `${columnName(sheet.columns.length - 1)}${sheet.rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${endCell}"/><sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/><cols>${columns}</cols><sheetData>${header}${rows}</sheetData>` +
    `<autoFilter ref="A1:${endCell}"/></worksheet>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

interface ZipEntry { name: string; data: Uint8Array; crc: number; offset: number; }
let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: readonly { name: string; contents: string }[]): Uint8Array {
  const entries: ZipEntry[] = [];
  const localChunks: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.contents);
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true); view.setUint16(10, 0, true); view.setUint16(12, 0x0021, true);
    const crc = crc32(data);
    view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true); view.setUint16(28, 0, true); header.set(name, 30);
    entries.push({ name: file.name, data, crc, offset });
    localChunks.push(header, data);
    offset += header.length + data.length;
  }
  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const header = new Uint8Array(46 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true); view.setUint16(10, 0, true); view.setUint16(12, 0, true); view.setUint16(14, 0x0021, true);
    view.setUint32(16, entry.crc, true); view.setUint32(20, entry.data.length, true); view.setUint32(24, entry.data.length, true);
    view.setUint16(28, name.length, true); view.setUint16(30, 0, true); view.setUint16(32, 0, true);
    view.setUint16(34, 0, true); view.setUint16(36, 0, true); view.setUint32(38, 0, true); view.setUint32(42, entry.offset, true);
    header.set(name, 46); centralChunks.push(header); centralSize += header.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(4, 0, true); endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true); endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true); endView.setUint16(20, 0, true);
  const total = offset + centralSize + end.length;
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...localChunks, ...centralChunks, end]) { output.set(chunk, cursor); cursor += chunk.length; }
  return output;
}

/** Builds a dependency-free, uncompressed OOXML workbook suitable for bounded Worker exports. */
export function writeXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("An XLSX workbook needs at least one sheet");
  for (const sheet of sheets) validateSheet(sheet);
  if (new Set(sheets.map((sheet) => sheet.name.toLowerCase())).size !== sheets.length) {
    throw new Error("XLSX sheet names must be unique ignoring case");
  }
  const strings = collectStrings(sheets);
  const sheetOverrides = sheets.map((_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${sheetOverrides}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.count}" uniqueCount="${strings.values.length}">` +
    strings.values.map((value) => `<si><t xml:space="preserve">${xml(value)}</t></si>`).join("") + `</sst>`;
  const files = [
    { name: "[Content_Types].xml", contents: contentTypes }, { name: "_rels/.rels", contents: rootRels },
    { name: "xl/workbook.xml", contents: workbook }, { name: "xl/_rels/workbook.xml.rels", contents: workbookRels },
    { name: "xl/styles.xml", contents: stylesXml() }, { name: "xl/sharedStrings.xml", contents: sharedStrings },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, contents: worksheetXml(sheet, strings) })),
  ];
  return zip(files);
}

export const xlsxDate = (value: string): XlsxDateCell => {
  excelDate(value);
  return { type: "date", value };
};
export const xlsxDecimal = (value: string): XlsxDecimalCell => {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)) throw new Error(`Invalid XLSX decimal: ${value}`);
  return { type: "decimal", value };
};
