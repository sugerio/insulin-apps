import { strToU8, zipSync } from "fflate";

export type WorkbookCell = string | boolean | { number: string } | { date: string } | { shared: string } | { dateText: string } | { error: string };

export interface TestSheet {
  name: string;
  rows: WorkbookCell[][];
}

interface SharedStrings {
  values: string[];
  indexes: Map<string, number>;
}

/** Creates actual OOXML bytes from text fixtures; no binary file is stored in the repository. */
export function buildWorkbook(sheets: readonly TestSheet[], options: { date1904?: boolean } = {}): Uint8Array {
  if (sheets.length === 0) throw new Error("A workbook needs a sheet");
  const shared: SharedStrings = { values: [], indexes: new Map() };
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": xml(contentTypes(sheets.length)),
    "_rels/.rels": xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": xml(workbook(sheets, options.date1904 === true)),
    "xl/_rels/workbook.xml.rels": xml(relationships(sheets.length)),
    "xl/styles.xml": xml('<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>'),
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = xml(worksheet(sheet.rows, shared, options.date1904 === true));
  });
  if (shared.values.length > 0) {
    files["xl/sharedStrings.xml"] = xml(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.values.length}" uniqueCount="${shared.values.length}">${shared.values.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join("")}</sst>`);
  }
  return zipSync(files, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") });
}

export function table(headers: readonly string[], records: readonly Record<string, WorkbookCell>[], title?: string): WorkbookCell[][] {
  return [
    ...(title ? [[title], []] : []),
    [...headers],
    ...records.map((record) => headers.map((header) => record[header] ?? "")),
  ];
}

function worksheet(rows: readonly WorkbookCell[][], shared: SharedStrings, date1904: boolean): string {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => cell(`${columnName(columnIndex + 1)}${rowIndex + 1}`, value, shared, date1904)).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function cell(reference: string, value: WorkbookCell, shared: SharedStrings, date1904: boolean): string {
  if (value === "") return "";
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === "object" && "number" in value) return `<c r="${reference}"><v>${escapeXml(value.number)}</v></c>`;
  if (typeof value === "object" && "date" in value) return `<c r="${reference}" s="1"><v>${dateSerial(value.date, date1904)}</v></c>`;
  if (typeof value === "object" && "shared" in value) {
    let index = shared.indexes.get(value.shared);
    if (index === undefined) {
      index = shared.values.length;
      shared.values.push(value.shared);
      shared.indexes.set(value.shared, index);
    }
    return `<c r="${reference}" t="s"><v>${index}</v></c>`;
  }
  if (typeof value === "object" && "dateText" in value) return `<c r="${reference}" t="d"><v>${escapeXml(value.dateText)}</v></c>`;
  if (typeof value === "object" && "error" in value) return `<c r="${reference}" t="e"><v>${escapeXml(value.error)}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function dateSerial(date: string, date1904: boolean): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(year, month - 1, day);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  let days = Math.floor((target - epoch) / 86_400_000);
  if (!date1904 && days >= 60) days += 1;
  return String(days);
}

function workbook(sheets: readonly TestSheet[], date1904: boolean): string {
  return `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${date1904 ? '<workbookPr date1904="1"/>' : ""}<sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`;
}

function relationships(count: number): string {
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`;
}

function contentTypes(count: number): string {
  return `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${Array.from({ length: count }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
}

function columnName(index: number): string {
  let name = "";
  for (let current = index; current > 0; current = Math.floor((current - 1) / 26)) name = String.fromCharCode(65 + ((current - 1) % 26)) + name;
  return name;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xml(value: string): Uint8Array {
  return strToU8(value);
}
