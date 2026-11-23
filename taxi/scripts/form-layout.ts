import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Document, parse, visit } from "yaml";
import { measureForm, measureRqForm, type LabelPlace, type PlaceSpec, type Shape, type TextItem } from "./form-measure.ts";
import { RULES_ROOT } from "./rules-source.ts";

// npm run form-layout -- <country>/<year> <FORM>=<print PDF> <FORM>-fr=<French print PDF> ...
//
// Measures where each amount, name, date and tick goes on the CRA's print version of a form (for example
// 5006-r-25e.pdf, downloaded from canada.ca) or on Revenu Québec's form (TP-1.D-V(2025-12).pdf, from revenuquebec.ca),
// and writes rules/<country>/<year>/form-layout.yaml. A form with a French version (`french` in forms.yaml, such as
// TP-1.D(2025-12).pdf) is measured again from that PDF as <FORM>-fr: the two versions' boxes are not in the same places. This file reads the PDF (its text, and the lines and boxes it
// draws); scripts/form-measure.ts says how a place is found from them. The two publishers draw their boxes differently,
// so a form whose url in forms.yaml is on revenuquebec.ca is measured Revenu Québec's way.
//
// The layout records the SHA-256 of the PDF it measured: the app refuses to fill a different file. The PDFs themselves
// are never committed (Crown copyright; the repository holds no binary files).

const STANDARD_FONTS = new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname;

/**
 * The places on a form that aren't amount rows, by the label printed at them: the T1's Step 1 (the person's name, birth
 * date, marital status and province, their spouse's first name and net income, and the foreign property question; the
 * other Step 1 boxes, such as the SIN and address, stay for the person to fill in) and Schedule 3's questions about a
 * home sold (a flipped property, the principal residence designation). On Revenu Québec's forms a box is found by the
 * line number beside it, and an answer's tick box by its label.
 */
const PLACES: Record<string, Record<string, PlaceSpec>> = {
  T1: {
    firstName: { kind: "text", page: 1, label: "First name" },
    lastName: { kind: "text", page: 1, label: "Last name" },
    birthDate: { kind: "comb", page: 1, label: "Date of birth" },
    married: { kind: "tick", page: 1, label: "Married" },
    commonLaw: { kind: "tick", page: 1, label: "Living common-law" },
    widowed: { kind: "tick", page: 1, label: "Widowed" },
    divorced: { kind: "tick", page: 1, label: "Divorced" },
    separated: { kind: "tick", page: 1, label: "Separated" },
    single: { kind: "tick", page: 1, label: "Single" },
    province: { kind: "text", page: 1, label: "Your province or territory of residence on December 31" },
    spouseFirstName: { kind: "text", page: 1, label: "Their first name" },
    spouseSelfEmployed: { kind: "tick", page: 1, label: "Tick this box if they were self-employed" },
    spouseNetIncome: { kind: "amount", page: 1, label: "Net income from line 23600 of their return" },
    foreignPropertyYes: { kind: "tick", page: 2, label: "Yes", below: "Foreign property" },
    foreignPropertyNo: { kind: "tick", page: 2, label: "No", below: "Foreign property" },
  },
  // The T1 for residents of Quebec (5005-R) prints Step 1 with the same labels.
  get T1QC() {
    return PLACES.T1!;
  },
  // The TP-1's Step 1 ("Information about you", "Information about your spouse"): its boxes are found by their line
  // numbers; the answers' tick boxes by the option beside them.
  TP1: {
    lastName: { kind: "text", page: 1, line: "1" },
    firstName: { kind: "text", page: 1, line: "2" },
    birthDate: { kind: "comb", page: 1, line: "6" },
    spouseNo: { kind: "tick", page: 1, label: "No", below: "Situation" },
    spouseYes: { kind: "tick", page: 1, label: "Yes", below: "Situation" },
    foreignPropertyYes: { kind: "tick", page: 1, label: "Yes", below: "Foreign property" },
    foreignPropertyNo: { kind: "tick", page: 1, label: "No", below: "Foreign property" },
    spouseLastName: { kind: "text", page: 2, line: "31" },
    spouseFirstName: { kind: "text", page: 2, line: "32" },
    spouseBirthDate: { kind: "comb", page: 2, line: "36" },
    spouseSelfEmployed: { kind: "tick", page: 2, line: "50" },
  },
  // Schedule G's designation of a principal residence, and Schedule J's level of dependence.
  QCG: {
    principalResidence: { kind: "tick", page: 1, line: "109" },
  },
  QCJ: {
    youNonDependent: { kind: "tick", page: 1, label: "non-dependent", below: "Level of dependence" },
  },
  S3: {
    flippedYes: { kind: "tick", page: 1, label: "Yes", below: "Did you dispose of a housing unit" },
    flippedNo: { kind: "tick", page: 1, label: "No", below: "Did you dispose of a housing unit" },
    principalResidenceAllYears: { kind: "tick", page: 2, label: "I designate the property as my principal residence for all" },
  },
};

/**
 * The French versions' places found by a label, in French; a place found by its line number is the same in both. On
 * Schedule J, "autonome" is the English "non-dependent".
 */
const FRENCH_LABELS: Record<string, Record<string, Pick<LabelPlace, "label" | "below">>> = {
  TP1: {
    spouseNo: { label: "sans", below: "Situation" },
    spouseYes: { label: "avec", below: "Situation" },
    foreignPropertyYes: { label: "Oui", below: "Biens étrangers" },
    foreignPropertyNo: { label: "Non", below: "Biens étrangers" },
  },
  QCJ: {
    youNonDependent: { label: "autonome", below: "Niveau d’autonomie" },
  },
};

/** A form's places: for a French version (`<FORM>-fr`), the English ones with their French labels. */
function placesOf(form: string): Record<string, PlaceSpec> | undefined {
  const base = baseOf(form);
  if (base === form) return PLACES[form];
  const french = FRENCH_LABELS[base] ?? {};
  return Object.fromEntries(Object.entries(PLACES[base] ?? {}).map(([key, place]) => [key, { ...place, ...french[key] } as PlaceSpec]));
}
const baseOf = (form: string) => form.replace(/-fr$/, "");

const [target, ...specs] = process.argv.slice(2);
if (!target || specs.length === 0 || specs.some((spec) => !/^[A-Z0-9]+(-fr)?=.+\.pdf$/i.test(spec))) {
  console.error("usage: npm run form-layout -- ca/2025 T1=5006-r-25e.pdf ON428=5006-c-25e.pdf TP1-fr='TP-1.D(2025-12).pdf' ...");
  process.exit(1);
}
const file = join(RULES_ROOT, target, "form-layout.yaml");
const current = existsSync(file) ? ((parse(readFileSync(file, "utf8")) as { formLayout?: Record<string, unknown> }).formLayout ?? {}) : {};
const formsFile = join(RULES_ROOT, target, "forms.yaml");
const urls = existsSync(formsFile) ? ((parse(readFileSync(formsFile, "utf8")) as { forms?: Record<string, { url?: string } | null> }).forms ?? {}) : {};
const isRevenuQuebec = (form: string) => {
  const url = urls[baseOf(form)]?.url;
  return url !== undefined && new URL(url).hostname.endsWith("revenuquebec.ca");
};

for (const spec of specs) {
  const [form, path] = spec.split("=") as [string, string];
  const bytes = readFileSync(path);
  const doc = await getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS, verbosity: 0 }).promise;
  const items: TextItem[] = [];
  const shapes: Shape[] = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const pdfPage = await doc.getPage(page);
    for (const item of (await pdfPage.getTextContent()).items) {
      if (!("str" in item) || !item.str.trim()) continue;
      items.push({ page, x: item.transform[4] as number, y: item.transform[5] as number, width: item.width, height: item.height, text: item.str.trim() });
    }
    shapes.push(...shapesOf(page, await pdfPage.getOperatorList()));
  }
  const measured = (isRevenuQuebec(form) ? measureRqForm : measureForm)(items, shapes, placesOf(form));
  current[form] = { sha256: createHash("sha256").update(bytes).digest("hex"), pages: doc.numPages, ...measured };
  console.log(`form-layout: ${form}: ${doc.numPages} pages, ${Object.keys(measured.rows).length} rows, ${Object.keys(measured.columns ?? {}).length} rows with columns`);
}

const header = `# Where things go on the CRA's and Revenu Québec's print forms, in PDF points from the bottom left: each row's
# page, the x of the line between dollars and cents (for a plain box with no such line, its right end), and the
# baseline; the boxes beside a row (columns); and Step 1's text boxes, date boxes and tick boxes. Generated by
# scripts/form-layout.ts from the PDFs with these SHA-256 hashes; don't edit by hand. forms.yaml says what goes where.
`;
// One line per place: [page, x, y].
const document = new Document({ formLayout: current });
visit(document, {
  Seq(_, node) {
    node.flow = true;
  },
});
writeFileSync(file, header + document.toString({ lineWidth: 0 }));
console.log(`form-layout: wrote ${file}`);

/** The lines and boxes a page draws, with their bounding boxes in page coordinates. */
function shapesOf(page: number, list: { fnArray: number[]; argsArray: unknown[][] }): Shape[] {
  type Matrix = [number, number, number, number, number, number];
  const times = (a: Matrix, b: Matrix): Matrix => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const saved: Matrix[] = [];
  const shapes: Shape[] = [];
  list.fnArray.forEach((fn, index) => {
    const args = list.argsArray[index]!;
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      saved.push(matrix);
      if (fn === OPS.paintFormXObjectBegin && args[0]) matrix = times(matrix, args[0] as Matrix);
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
      matrix = saved.pop() ?? matrix;
    } else if (fn === OPS.transform) {
      matrix = times(matrix, args as Matrix);
    } else if (fn === OPS.constructPath) {
      const [paint, , box] = args as [number, unknown, number[] | null];
      const kind = paint === OPS.stroke || paint === OPS.closeStroke ? "stroke" : paint === OPS.fill || paint === OPS.eoFill ? "fill" : null;
      if (!kind || !box) return;
      const [x0, y0] = [matrix[0] * box[0]! + matrix[2] * box[1]! + matrix[4], matrix[1] * box[0]! + matrix[3] * box[1]! + matrix[5]];
      const [x1, y1] = [matrix[0] * box[2]! + matrix[2] * box[3]! + matrix[4], matrix[1] * box[2]! + matrix[3] * box[3]! + matrix[5]];
      shapes.push({ page, paint: kind, x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
    }
  });
  return shapes;
}
