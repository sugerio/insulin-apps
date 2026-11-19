import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Document, parse, visit } from "yaml";
import { RULES_ROOT } from "./rules-source.ts";

// npm run form-layout -- <country>/<year> <FORM>=<print PDF> ...
//
// Measures where each amount goes on the CRA's print version of a form (for example 5006-r-25e.pdf, downloaded from
// canada.ca) and writes rules/<country>/<year>/form-layout.yaml. Every amount row of a CRA form has its number printed
// at the right of its box, in one of three columns; the box ends 6 points left of that number, and its last 18 points
// hold the cents. So each row's place is the page, the x of the line between dollars and cents, and the baseline.
// Rows whose number appears twice on a form (a chart below the form's own lines) are keyed `p<page>:<row>`. A table
// row with preprinted amounts in several columns (a bracket table) also gets each column's cents line. A box with only a
// five-digit line code (no row number) is keyed by the code. Rows whose box already holds a printed amount are listed as
// `printed`, so nothing is written over them.
//
// The layout records the SHA-256 of the PDF it measured: the app refuses to fill a different file. The PDFs themselves
// are never committed (Crown copyright; the repository holds no binary files).

const ROW_COLUMNS = [576, 468, 360];
const STANDARD_FONTS = new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname;
/** From a row number's x to the line between dollars and cents. */
const CENTS_LINE_OFFSET = 24;
/** From a line code's x to the line between dollars and cents of the box right of it. */
const CODE_CENTS_LINE_OFFSET = 88;
/** Helvetica widths, per 1000 em, of what a preprinted amount holds. */
const WIDTH: Record<string, number> = { ",": 278, ".": 278 };
const widthOf = (char: string) => WIDTH[char] ?? 556;

interface Item {
  page: number;
  x: number;
  y: number;
  width: number;
  text: string;
}

const [target, ...specs] = process.argv.slice(2);
if (!target || specs.length === 0 || specs.some((spec) => !/^[A-Z0-9]+=.+\.pdf$/i.test(spec))) {
  console.error("usage: npm run form-layout -- ca/2025 T1=5006-r-25e.pdf ON428=5006-c-25e.pdf ...");
  process.exit(1);
}
const file = join(RULES_ROOT, target, "form-layout.yaml");
const current = existsSync(file) ? ((parse(readFileSync(file, "utf8")) as { formLayout?: Record<string, unknown> }).formLayout ?? {}) : {};

for (const spec of specs) {
  const [form, path] = spec.split("=") as [string, string];
  const bytes = readFileSync(path);
  const doc = await getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS }).promise;
  const items: Item[] = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    for (const item of (await (await doc.getPage(page)).getTextContent()).items) {
      if (!("str" in item) || !item.str.trim()) continue;
      items.push({ page, x: item.transform[4] as number, y: item.transform[5] as number, width: item.width, text: item.str.trim() });
    }
  }
  const rows: Record<string, [number, number, number]> = {};
  const seen = new Set<string>();
  for (const item of items.sort((a, b) => a.page - b.page || b.y - a.y)) {
    const column = ROW_COLUMNS.find((x) => Math.abs(item.x - x) < 1.5);
    if (column === undefined || !/^\d{1,3}$/.test(item.text)) continue;
    const key = seen.has(item.text) ? `p${item.page}:${item.text}` : item.text;
    seen.add(item.text);
    rows[key] = [item.page, column - CENTS_LINE_OFFSET, round(item.y)];
  }
  // A box with a five-digit line code at its left and no row number (inner columns, the refund and balance owing): its
  // cents line is 88 points right of the code. Keyed by the code.
  const numberedRows = Object.values(rows);
  for (const item of items) {
    if (!/^\d{5}$/.test(item.text) || Math.abs(item.width - 22.8) > 0.6) continue;
    const numbered = numberedRows.some(([page, , y]) => page === item.page && Math.abs(y - item.y) < 3);
    if (!numbered && !(item.text in rows)) rows[item.text] = [item.page, round(item.x + CODE_CENTS_LINE_OFFSET), round(item.y)];
  }
  // A bracket table: a row with preprinted amounts ("57,375.00") in two or more columns.
  const columns: Record<string, number[]> = {};
  for (const [key, [page, , y]] of Object.entries(rows)) {
    const amounts = items.filter((item) => item.page === page && Math.abs(item.y - y) < 3 && /^[\d,]+\.\d\d$/.test(item.text)).sort((a, b) => a.x - b.x);
    if (amounts.length < 2) continue;
    columns[key] = amounts.map((item) => {
      const chars = [...item.text];
      const total = chars.reduce((sum, char) => sum + widthOf(char), 0);
      const dot = chars.indexOf(".");
      const before = chars.slice(0, dot).reduce((sum, char) => sum + widthOf(char), 0) + widthOf(".") / 2;
      return round(item.x + (item.width * before) / total);
    });
  }
  // A box that already holds a printed amount (a base amount, "294.00"): nothing is written there.
  const printed = Object.entries(rows)
    .filter(([, [page, x, y]]) =>
      items.some((item) => item.page === page && Math.abs(item.y - y) < 4 && item.x + item.width > x - 68 && item.x < x + 18 && /^\$?[\d,]*\d(\.\d\d)?%?$/.test(item.text) && !/^\d{5}$/.test(item.text)),
    )
    .map(([key]) => key);
  current[form] = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    pages: doc.numPages,
    rows,
    ...(Object.keys(columns).length > 0 ? { columns } : {}),
    ...(printed.length > 0 ? { printed } : {}),
  };
  console.log(`form-layout: ${form}: ${doc.numPages} pages, ${Object.keys(rows).length} rows, ${Object.keys(columns).length} table rows`);
}

const header = `# Where each amount goes on the CRA's print forms: page, the x of the line between dollars and cents, and the
# baseline, in PDF points from the bottom left. Generated by scripts/form-layout.ts from the PDFs with these SHA-256
# hashes; don't edit by hand. forms.yaml says what goes in each row.
`;
// One line per row: [page, x, y].
const document = new Document({ formLayout: current });
visit(document, {
  Seq(_, node) {
    node.flow = true;
  },
});
writeFileSync(file, header + document.toString({ lineWidth: 0 }));
console.log(`form-layout: wrote ${file}`);

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
