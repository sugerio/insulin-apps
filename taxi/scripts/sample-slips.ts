import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { rulesFor } from "../src/app/shared/rules/index.ts";

// npm run sample-slips -- [--out <dir>] [--self <name>] [--spouse <name>]
//
// Writes sample 2025 slips as PDFs, for trying the app and for testing AI reading: a T4 for each adult, a T5 for the
// person preparing, and a T2202 for the spouse. Every page says it is a synthetic sample. The repository keeps no
// binary files, so the PDFs are made here and never committed; the default folder is ignored by git and by the app
// checks. Box labels come from the year's rules (slips.yaml), so a sample shows the boxes the app reads.

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const out = resolve(option("out", join(import.meta.dirname, "../.suger/data/sample-slips")));
const self = option("self", "Alex Martin");
const spouse = option("spouse", "Sam Martin");

const YEAR = 2025;
const rules = rulesFor(YEAR)!;

interface Sample {
  file: string;
  type: "T4" | "T5" | "T2202";
  title: string;
  issuer: { name: string; lines: string[] };
  recipient: { name: string; lines: string[] };
  boxes: Record<string, string>;
  /** Extra rows printed under the boxes, such as the study periods on a T2202. */
  table?: { heading: string[]; rows: string[][] };
}

const money = (value: number) => value.toFixed(2);
/** A T4's boxes for a year of employment income, with CPP, CPP2 and EI at the 2025 rates. */
function t4(income: number, tax: number, extra: Record<string, number> = {}): Record<string, string> {
  const cpp = Math.round(0.0595 * (Math.min(income, 71300) - 3500) * 100) / 100;
  const cpp2 = Math.round(0.04 * Math.max(0, Math.min(income, 81200) - 71300) * 100) / 100;
  const ei = Math.round(0.0164 * Math.min(income, 65700) * 100) / 100;
  return {
    14: money(income),
    16: money(cpp),
    ...(cpp2 > 0 ? { "16A": money(cpp2) } : {}),
    18: money(ei),
    22: money(tax),
    24: money(Math.min(income, 65700)),
    26: money(Math.min(income, 71300)),
    ...Object.fromEntries(Object.entries(extra).map(([box, amount]) => [box, money(amount)])),
  };
}

const home = ["123 Sample Street", "Toronto ON  M5V 0A1"];
const samples: Sample[] = [
  {
    file: `T4-${slug(self)}-Maple-Corp.pdf`,
    type: "T4",
    title: "Statement of Remuneration Paid",
    issuer: { name: "Maple Corp", lines: ["100 King Street West", "Toronto ON  M5X 1A9"] },
    recipient: { name: self, lines: home },
    boxes: t4(60000, 9000, { 44: 620, 46: 200 }),
  },
  {
    file: `T4-${slug(spouse)}-Island-Grocers.pdf`,
    type: "T4",
    title: "Statement of Remuneration Paid",
    issuer: { name: "Island Grocers Ltd.", lines: ["55 Harbour Road", "Toronto ON  M5J 2N1"] },
    recipient: { name: spouse, lines: home },
    boxes: t4(31000, 2400),
  },
  {
    file: `T5-${slug(self)}-Lakeview-Credit-Union.pdf`,
    type: "T5",
    title: "Statement of Investment Income",
    issuer: { name: "Lakeview Credit Union", lines: ["8 Lakeshore Boulevard", "Toronto ON  M5E 1A1"] },
    recipient: { name: self, lines: home },
    boxes: { 13: "1250.00", 24: "2000.00", 25: "2760.00", 26: "414.55" },
  },
  {
    file: `T2202-${slug(spouse)}-Lakeview-University.pdf`,
    type: "T2202",
    title: "Tuition and Enrolment Certificate",
    issuer: { name: "Lakeview University", lines: ["1 University Avenue", "Toronto ON  M5S 1A1"] },
    recipient: { name: spouse, lines: home },
    boxes: { 24: "0", 25: "8", 26: "6000.00" },
    table: {
      heading: ["Session", "Part-time months", "Full-time months", "Eligible tuition fees"],
      rows: [
        ["2025-01 to 2025-04", "0", "4", "3000.00"],
        ["2025-09 to 2025-12", "0", "4", "3000.00"],
      ],
    },
  },
];

function slug(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "person";
}

async function render(sample: Sample): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${sample.type} ${YEAR} ${sample.title} (sample)`);
  pdf.setSubject("Synthetic sample slip for testing Taxi. Not a real tax document.");
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.4, 0.4, 0.45);
  const red = rgb(0.75, 0.1, 0.1);
  const text = (value: string, x: number, y: number, size: number, f: PDFFont = font, color = ink) => page.drawText(value, { x, y, size, font: f, color });

  // Header
  text(`${sample.type}`, 40, 740, 28, bold);
  text(`${YEAR}`, 40 + bold.widthOfTextAtSize(sample.type, 28) + 10, 740, 28, font, muted);
  text(sample.title, 40, 718, 13, bold);
  text("SAMPLE - synthetic test data, not issued by any employer or institution", 40, 700, 9, bold, red);

  // Issuer and recipient
  block(page, "Issued by", sample.issuer, 40, 670, font, bold);
  block(page, sample.type === "T2202" ? "Student" : "Recipient", sample.recipient, 320, 670, font, bold);
  text("Social insurance number: not shown on samples", 320, 604, 8, font, muted);

  // Boxes, in printed order, three per row
  const labels = rules.slips.get(sample.type)!.boxes;
  const boxes = Object.entries(sample.boxes).sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b));
  const width = 170;
  const height = 46;
  boxes.forEach(([box, amount], index) => {
    const x = 40 + (index % 3) * (width + 11);
    const y = 530 - Math.floor(index / 3) * (height + 10);
    page.drawRectangle({ x, y, width, height, borderColor: muted, borderWidth: 0.8 });
    page.drawRectangle({ x, y: y + height - 14, width: 26, height: 14, color: rgb(0.15, 0.15, 0.2) });
    text(box, x + 4, y + height - 11, 8, bold, rgb(1, 1, 1));
    text(fit(labels[box] ?? "", font, 7, width - 34), x + 30, y + height - 11, 7, font, muted);
    const shown = sample.type === "T2202" && box !== "26" ? amount : Number(amount).toLocaleString("en-CA", { minimumFractionDigits: 2 });
    text(shown, x + width - 8 - font.widthOfTextAtSize(shown, 14), y + 9, 14, font);
  });

  // Extra table
  let y = 530 - (Math.ceil(boxes.length / 3) - 1) * (height + 10) - 30;
  if (sample.table) {
    const columns = [40, 190, 320, 450];
    sample.table.heading.forEach((heading, index) => text(heading, columns[index]!, y, 8, bold, muted));
    for (const row of sample.table.rows) {
      y -= 16;
      row.forEach((cell, index) => text(cell, columns[index]!, y, 10, font));
    }
  }

  text("This page was made by Taxi's sample-slips script for testing. It is not a CRA form and has no value for filing.", 40, 40, 8, font, muted);
  return pdf.save();
}

function block(page: PDFPage, heading: string, who: { name: string; lines: string[] }, x: number, y: number, font: PDFFont, bold: PDFFont) {
  page.drawText(heading, { x, y, size: 8, font: bold, color: rgb(0.4, 0.4, 0.45) });
  page.drawText(who.name, { x, y: y - 16, size: 12, font: bold });
  who.lines.forEach((line, index) => page.drawText(line, { x, y: y - 32 - index * 13, size: 10, font }));
}

function fit(value: string, font: PDFFont, size: number, width: number): string {
  let shown = value;
  while (shown.length > 1 && font.widthOfTextAtSize(shown, size) > width) shown = shown.slice(0, -1);
  return shown === value ? value : `${shown.slice(0, -1)}…`;
}

mkdirSync(out, { recursive: true });
for (const sample of samples) {
  writeFileSync(join(out, sample.file), await render(sample));
  console.log(`sample-slips: wrote ${join(out, sample.file)}`);
}
