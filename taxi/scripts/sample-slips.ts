import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { rulesFor } from "../src/app/shared/rules/index.ts";

// npm run sample-slips -- [--country ca|us] [--out <dir>] [--self <name>] [--spouse <name>] [--child <name>]
//
// Writes sample 2025 slips as PDFs, for trying the app and for testing AI reading. Canada (the default): a T4 for each adult, two T5s (two banks) for the
// person preparing, a T4E and a T2202 for the spouse, and receipts and notices: a donation receipt, a dental receipt for the
// spouse, an RRSP receipt for early 2026, and each adult's 2024 notice of assessment. The United States: a W-2 for each
// adult, two 1099-INTs and a 1098-E for the person preparing, a 1099-NEC and a 1098-T for the spouse, and a 1098-T for a
// child (a dependant's, which isn't added to a return). Every page says it is a synthetic sample. The repository keeps no
// binary files, so the PDFs are made here and never committed; the default folder is ignored by git and by the app
// checks. Box labels come from the year's rules (slips.yaml), so a sample shows the boxes the app reads.

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const country = option("country", "ca");
if (country !== "ca" && country !== "us") throw new Error("--country is ca or us");
const out = resolve(option("out", join(import.meta.dirname, country === "us" ? "../.suger/data/sample-slips-us" : "../.suger/data/sample-slips")));
const self = option("self", "Alex Martin");
const spouse = option("spouse", "Sam Martin");
const child = option("child", "Riley Martin");

const YEAR = 2025;
const rules = rulesFor(country, YEAR)!;

interface Sample {
  file: string;
  /** The slip type, as slips.yaml names it. */
  type: string;
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
    // A second bank: interest from each institution comes on its own T5, and they add up.
    file: `T5-${slug(self)}-Northwind-Bank.pdf`,
    type: "T5",
    title: "Statement of Investment Income",
    issuer: { name: "Northwind Bank", lines: ["250 Bay Street", "Toronto ON  M5J 2S1"] },
    recipient: { name: self, lines: home },
    boxes: { 13: "380.00" },
  },
  {
    file: `T4E-${slug(spouse)}-Service-Canada.pdf`,
    type: "T4E",
    title: "Statement of Employment Insurance and Other Benefits",
    issuer: { name: "Service Canada", lines: ["Employment Insurance", "Ottawa ON  K1A 0J9"] },
    recipient: { name: spouse, lines: home },
    boxes: { 7: "30", 14: "4200.00", 15: "4200.00", 22: "420.00" },
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

/** A receipt or notice: no numbered boxes, but labelled amounts, as these are printed. */
interface Receipt {
  file: string;
  heading: string;
  /** The year printed on it (an RRSP receipt for early next year, a notice of assessment for last year). */
  year: number;
  issuer: { name: string; lines: string[] };
  who: { label: string; name: string; lines: string[] };
  rows: [string, string][];
}

const usHome = ["123 Sample Street", "Springfield IL  62701"];
const usSamples: Sample[] = [
  {
    file: `W-2-${slug(self)}-Maple-Corp.pdf`,
    type: "W2",
    title: "Wage and Tax Statement",
    issuer: { name: "Maple Corp", lines: ["100 Main Street", "Springfield IL  62701"] },
    recipient: { name: self, lines: usHome },
    boxes: { 1: "60000.00", 2: "6500.00", 3: "60000.00", 4: "3720.00", 5: "60000.00", 6: "870.00", 16: "60000.00", 17: "2970.00" },
  },
  {
    file: `W-2-${slug(spouse)}-Island-Grocers.pdf`,
    type: "W2",
    title: "Wage and Tax Statement",
    issuer: { name: "Island Grocers Inc.", lines: ["55 Harbor Road", "Springfield IL  62702"] },
    recipient: { name: spouse, lines: usHome },
    boxes: { 1: "31000.00", 2: "1800.00", 3: "31000.00", 4: "1922.00", 5: "31000.00", 6: "449.50", 16: "31000.00", 17: "1534.50" },
  },
  {
    file: `1099-INT-${slug(self)}-Lakeview-Credit-Union.pdf`,
    type: "INT",
    title: "Interest Income",
    issuer: { name: "Lakeview Credit Union", lines: ["8 Lakeshore Boulevard", "Springfield IL  62703"] },
    recipient: { name: self, lines: usHome },
    boxes: { 1: "1250.00" },
  },
  {
    // A second bank: interest from each payer comes on its own 1099-INT, and they add up.
    file: `1099-INT-${slug(self)}-Northwind-Bank.pdf`,
    type: "INT",
    title: "Interest Income",
    issuer: { name: "Northwind Bank", lines: ["250 Bay Street", "Springfield IL  62704"] },
    recipient: { name: self, lines: usHome },
    boxes: { 1: "380.00" },
  },
  {
    file: `1099-NEC-${slug(spouse)}-Harbor-Design.pdf`,
    type: "NEC",
    title: "Nonemployee Compensation",
    issuer: { name: "Harbor Design Studio LLC", lines: ["12 Dock Street", "Springfield IL  62705"] },
    recipient: { name: spouse, lines: usHome },
    boxes: { 1: "8400.00" },
  },
  {
    file: `1098-T-${slug(spouse)}-Lakeview-University.pdf`,
    type: "F1098T",
    title: "Tuition Statement",
    issuer: { name: "Lakeview University", lines: ["1 University Avenue", "Springfield IL  62706"] },
    recipient: { name: spouse, lines: usHome },
    boxes: { 1: "6000.00", 5: "1500.00" },
  },
  {
    file: `1098-T-${slug(child)}-Prairie-Community-College.pdf`,
    type: "F1098T",
    title: "Tuition Statement",
    issuer: { name: "Prairie Community College", lines: ["400 College Drive", "Springfield IL  62707"] },
    recipient: { name: child, lines: usHome },
    boxes: { 1: "3800.00" },
  },
  {
    file: `1098-E-${slug(self)}-Great-Lakes-Loans.pdf`,
    type: "F1098E",
    title: "Student Loan Interest Statement",
    issuer: { name: "Great Lakes Student Loans", lines: ["900 Lender Way", "Madison WI  53703"] },
    recipient: { name: self, lines: usHome },
    boxes: { 1: "1800.00" },
  },
];

const receipts: Receipt[] = [
  {
    file: `Donation-${slug(self)}-Lakeview-Food-Bank.pdf`,
    heading: "Official receipt for income tax purposes",
    year: YEAR,
    issuer: { name: "Lakeview Food Bank", lines: ["Registered charity 12345 6789 RR0001", "20 Market Street, Toronto ON  M5E 1M6"] },
    who: { label: "Donor", name: self, lines: home },
    rows: [["Date the gift was received", `${YEAR}-11-20`], ["Total amount of the gift", "450.00"], ["Eligible amount of the gift", "450.00"]],
  },
  {
    file: `Medical-${slug(spouse)}-Lakeview-Dental.pdf`,
    heading: "Receipt for payment",
    year: YEAR,
    issuer: { name: "Lakeview Dental Clinic", lines: ["300 Queen Street East", "Toronto ON  M5A 1S7"] },
    who: { label: "Patient", name: spouse, lines: home },
    rows: [["Date of service", `${YEAR}-05-14`], ["Service", "Dental cleaning and filling"], ["Amount paid", "1,280.00"]],
  },
  {
    file: `RRSP-${slug(self)}-Lakeview-Credit-Union.pdf`,
    heading: "Contribution receipt: registered retirement savings plan",
    year: YEAR + 1,
    issuer: { name: "Lakeview Credit Union", lines: ["8 Lakeshore Boulevard", "Toronto ON  M5E 1A1"] },
    who: { label: "Annuitant and contributor", name: self, lines: home },
    rows: [["Contribution period", `First 60 days of ${YEAR + 1}`], ["Date of contribution", `${YEAR + 1}-02-10`], ["Amount of contribution", "2,000.00"]],
  },
  {
    file: `NOA-${slug(self)}-${YEAR - 1}.pdf`,
    heading: `Notice of assessment, tax year ${YEAR - 1}`,
    year: YEAR - 1,
    issuer: { name: "Canada Revenue Agency", lines: ["Sample office", "Ottawa ON  K1A 0L5"] },
    who: { label: "Taxpayer", name: self, lines: home },
    rows: [
      [`RRSP deduction limit for ${YEAR}`, "17,000.00"],
      [`Unused RRSP contributions available to deduct for ${YEAR}`, "0.00"],
      ["Federal: unused tuition, education and textbook amounts available for future years", "0.00"],
    ],
  },
  {
    file: `NOA-${slug(spouse)}-${YEAR - 1}.pdf`,
    heading: `Notice of assessment, tax year ${YEAR - 1}`,
    year: YEAR - 1,
    issuer: { name: "Canada Revenue Agency", lines: ["Sample office", "Ottawa ON  K1A 0L5"] },
    who: { label: "Taxpayer", name: spouse, lines: home },
    rows: [
      [`RRSP deduction limit for ${YEAR}`, "5,580.00"],
      [`Unused RRSP contributions available to deduct for ${YEAR}`, "0.00"],
      ["Federal: unused tuition, education and textbook amounts available for future years", "1,500.00"],
    ],
  },
];

async function renderReceipt(receipt: Receipt): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${receipt.heading} (sample)`);
  pdf.setSubject("Synthetic sample for testing Taxi. Not a real tax document.");
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const muted = rgb(0.4, 0.4, 0.45);
  page.drawText(receipt.heading, { x: 40, y: 740, size: 16, font: bold });
  page.drawText(`${receipt.year}`, { x: 40, y: 718, size: 13, font, color: muted });
  page.drawText("SAMPLE - synthetic test data, not issued by any charity, clinic, plan or government", { x: 40, y: 700, size: 9, font: bold, color: rgb(0.75, 0.1, 0.1) });
  block(page, "Issued by", receipt.issuer, 40, 670, font, bold);
  block(page, receipt.who.label, receipt.who, 320, 670, font, bold);
  receipt.rows.forEach(([label, value], index) => {
    const y = 540 - index * 28;
    page.drawLine({ start: { x: 40, y: y - 8 }, end: { x: 572, y: y - 8 }, thickness: 0.5, color: muted });
    page.drawText(fit(label, font, 10, 400), { x: 40, y, size: 10, font });
    page.drawText(value, { x: 572 - bold.widthOfTextAtSize(value, 11), y, size: 11, font: bold });
  });
  page.drawText("This page was made by Taxi's sample-slips script for testing. It has no value for filing.", { x: 40, y: 40, size: 8, font, color: muted });
  return pdf.save();
}

function slug(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "person";
}

async function render(sample: Sample): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${rules.slips.get(sample.type)!.name ?? sample.type} ${YEAR} ${sample.title} (sample)`);
  pdf.setSubject("Synthetic sample slip for testing Taxi. Not a real tax document.");
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.4, 0.4, 0.45);
  const red = rgb(0.75, 0.1, 0.1);
  const text = (value: string, x: number, y: number, size: number, f: PDFFont = font, color = ink) => page.drawText(value, { x, y, size, font: f, color });

  // Header: the form's printed name (W-2, 1098-T), else its type (T4)
  const name = rules.slips.get(sample.type)!.name ?? sample.type;
  text(name, 40, 740, 28, bold);
  text(`${YEAR}`, 40 + bold.widthOfTextAtSize(name, 28) + 10, 740, 28, font, muted);
  text(sample.title, 40, 718, 13, bold);
  text("SAMPLE - synthetic test data, not issued by any employer or institution", 40, 700, 9, bold, red);

  // Issuer and recipient
  block(page, "Issued by", sample.issuer, 40, 670, font, bold);
  block(page, sample.type === "T2202" || sample.type === "F1098T" ? "Student" : sample.type === "F1098E" ? "Borrower" : "Recipient", sample.recipient, 320, 670, font, bold);
  text(country === "us" ? "Social security number: not shown on samples" : "Social insurance number: not shown on samples", 320, 604, 8, font, muted);

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
    const count = rules.slips.get(sample.type)!.counts.includes(box);
    const shown = count ? amount : Number(amount).toLocaleString("en-CA", { minimumFractionDigits: 2 });
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

  text(`This page was made by Taxi's sample-slips script for testing. It is not ${country === "us" ? "an IRS" : "a CRA"} form and has no value for filing.`, 40, 40, 8, font, muted);
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
for (const sample of country === "us" ? usSamples : samples) {
  writeFileSync(join(out, sample.file), await render(sample));
  console.log(`sample-slips: wrote ${join(out, sample.file)}`);
}
for (const receipt of country === "us" ? [] : receipts) {
  writeFileSync(join(out, receipt.file), await renderReceipt(receipt));
  console.log(`sample-slips: wrote ${join(out, receipt.file)}`);
}
