import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Document, parse, visit } from "yaml";
import { measureIrsForm, readIrsFields, type IrsPlace } from "./form-irs.ts";
import { measureForm, measureRqForm, type LabelPlace, type PlaceSpec, type Shape, type TextItem } from "./form-measure.ts";
import { RULES_ROOT } from "./rules-source.ts";

// npm run form-layout -- <country>/<year> <FORM>=<print PDF> <FORM>-fr=<French print PDF> ...
//
// Measures where each amount, name, date and tick goes on the CRA's print version of a form (for example
// 5006-r-25e.pdf, downloaded from canada.ca), on Revenu Québec's form (TP-1.D-V(2025-12).pdf, from revenuquebec.ca) or
// on the IRS's fill-in form (f1040--2025.pdf, from irs.gov), and writes rules/<country>/<year>/form-layout.yaml. A form with a French version (`french` in forms.yaml, such as
// TP-1.D(2025-12).pdf) is measured again from that PDF as <FORM>-fr: the two versions' boxes are not in the same places. This file reads the PDF (its text, and the lines and boxes it
// draws); scripts/form-measure.ts says how a place is found from them. The two publishers draw their boxes differently,
// so a form whose url in forms.yaml is on revenuquebec.ca is measured Revenu Québec's way. An IRS form isn't measured
// from its drawing: its fields' boxes and labels place it (scripts/form-irs.ts), with the places in IRS_PLACES.
//
// The layout records the SHA-256 of the PDF it measured: the app refuses to fill a different file. The PDFs themselves
// are never committed (the CRA's are Crown copyright; the repository holds no binary files).

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

/** `<name>@1` to `<name>@<n>`, each the field given for it, with the same piece of label. */
const columns = (name: string, label: string, fields: string[]): Record<string, IrsPlace> =>
  Object.fromEntries(fields.map((field, index) => [`${name}@${index + 1}`, { field, label }]));
/** Each schedule's "Name(s) shown on return". */
const names = (field: string): Record<string, IrsPlace> => ({ names: { field, label: "Name(s) shown on" } });

/**
 * The places on an IRS form that aren't amount rows found by their line number, by their field and a piece of its
 * label: the names, the filing status and other ticks, a count, an amount whose label doesn't start with its line
 * number, and each column of a table of dependants (`<name>@<column>`). The social security numbers, the address and
 * the other boxes Taxi doesn't know stay for the person to fill in.
 */
const IRS_PLACES: Record<string, Record<string, IrsPlace>> = {
  F1040: {
    firstName: { field: "f1_14[0]", label: "Your first name" },
    lastName: { field: "f1_15[0]", label: "Last name" },
    spouseFirstName: { field: "f1_17[0]", label: "spouse's first name" },
    spouseLastName: { field: "f1_18[0]", label: "Last name" },
    single: { field: "Checkbox_ReadOrder[0].c1_8[0]", label: "Single" },
    joint: { field: "Checkbox_ReadOrder[0].c1_8[1]", label: "Married filing jointly" },
    separate: { field: "Checkbox_ReadOrder[0].c1_8[2]", label: "Married filing separately" },
    separateSpouseName: { field: "Checkbox_ReadOrder[0].f1_28[0]", label: "full name here" },
    hoh: { field: "c1_8[0]", label: "Head of household" },
    qss: { field: "c1_8[1]", label: "Qualifying surviving spouse" },
    livedApart: { field: "c1_32[0]", label: "lived apart from your spouse" },
    moreDependants: { field: "Dependents_ReadOrder[0].c1_11[0]", label: "more than four dependents" },
    ...columns("firstName", "(1) First name", ["f1_31", "f1_32", "f1_33", "f1_34"].map((each) => `Table_Dependents[0].Row1[0].${each}[0]`)),
    ...columns("lastName", "(2) Last name", ["f1_35", "f1_36", "f1_37", "f1_38"].map((each) => `Table_Dependents[0].Row2[0].${each}[0]`)),
    ...columns("relationship", "(4) Relationship", ["f1_43", "f1_44", "f1_45", "f1_46"].map((each) => `Table_Dependents[0].Row4[0].${each}[0]`)),
    ...columns("livedWithYou", "(a) Yes", ["c1_12", "c1_14", "c1_16", "c1_18"].map((each, index) => `Table_Dependents[0].Row5[0].Dependent${index + 1}[0].${each}[0]`)),
    ...columns("student", "Full-time student", ["c1_20", "c1_22", "c1_24", "c1_26"].map((each, index) => `Table_Dependents[0].Row6[0].Dependent${index + 1}[0].${each}[0]`)),
    ...columns("disabled", "Permanently and totally disabled", ["c1_21", "c1_23", "c1_25", "c1_27"].map((each, index) => `Table_Dependents[0].Row6[0].Dependent${index + 1}[0].${each}[0]`)),
    ...columns("childTaxCredit", "Child tax credit", ["c1_28", "c1_29", "c1_30", "c1_31"].map((each, index) => `Table_Dependents[0].Row7[0].Dependent${index + 1}[0].${each}[0]`)),
    ...columns("otherDependents", "Credit for other dependents", ["c1_28", "c1_29", "c1_30", "c1_31"].map((each, index) => `Table_Dependents[0].Row7[0].Dependent${index + 1}[0].${each}[1]`)),
    claimYou: { field: "c2_1[0]", label: "You as a dependent" },
    claimSpouse: { field: "c2_2[0]", label: "Your spouse as a dependent" },
    youSenior: { field: "c2_5[0]", label: "You: Were born before January 2, 1961" },
    youBlind: { field: "c2_6[0]", label: "Are blind" },
    spouseSenior: { field: "c2_7[0]", label: "Spouse: Was born before January 2, 1961" },
    spouseBlind: { field: "c2_8[0]", label: "Is blind" },
  },
  S1A: names("f1_01[0]"),
  S2: names("f1_01[0]"),
  S3: names("f1_01[0]"),
  S8812: {
    ...names("f1_1[0]"),
    "4": { field: "f1_9[0]", label: "Number of qualifying children", count: true },
    "6": { field: "Line6ReadOrder[0].f1_11[0]", label: "Number of other dependents", count: true },
    "13": { field: "f1_18[0]", label: "Credit Limit Worksheet A" },
    "16bChildren": { field: "f2_3[0]", label: "Number of qualifying children", count: true },
    line12No: { field: "c1_1[0]", label: "12. No" },
    line12Yes: { field: "c1_1[1]", label: "12. Yes" },
    line19No: { field: "c2_1[0]", label: "No" },
    line19Yes: { field: "c2_1[1]", label: "19. Yes" },
    line20No: { field: "c2_2[0]", label: "No" },
    line20Yes: { field: "c2_2[1]", label: "20. Yes" },
  },
  SEIC: {
    ...names("f1_01[0]"),
    "name@1": { field: "f1_03[0]", label: "Child" },
    "name@2": { field: "f1_04[0]", label: "Child 2" },
    "name@3": { field: "f1_05[0]", label: "Child 3" },
    "birthYear@1": { field: "Year1_ReadOrder[0].f1_09[0]", label: "Child 1. Year", cells: ["f1_10", "f1_11", "f1_12"].map((each) => `Year1_ReadOrder[0].${each}[0]`) },
    "birthYear@2": { field: "Year2_ReadOrder[0].f1_13[0]", label: "Child 2. Year", cells: ["f1_14", "f1_15", "f1_16"].map((each) => `Year2_ReadOrder[0].${each}[0]`) },
    "birthYear@3": { field: "f1_17[0]", label: "Child 3. Year", cells: ["f1_18[0]", "f1_19[0]", "f1_20[0]"] },
    "studentYes@1": { field: "Line4a_Child1_ReadOrder[0].Yes_ReadOrder[0].c1_1[0]", label: "a student" },
    "studentNo@1": { field: "Line4a_Child1_ReadOrder[0].c1_1[0]", label: "4a. No" },
    "studentYes@2": { field: "Line4a_Child2_ReadOrder[0].Yes_ReadOrder[0].c1_2[0]", label: "4a. Child 2. Yes" },
    "studentNo@2": { field: "Line4a_Child2_ReadOrder[0].c1_2[0]", label: "4a. No" },
    "studentYes@3": { field: "Line4a_Child3_Yes_ReadOrder[0].c1_3[0]", label: "4a. Child 3. Yes" },
    "studentNo@3": { field: "c1_3[0]", label: "4a. No" },
    "disabledYes@1": { field: "Line4b_Child1_ReadOrder[0].Yes_ReadOrder[0].c1_4[0]", label: "totally disabled" },
    "disabledNo@1": { field: "Line4b_Child1_ReadOrder[0].c1_4[0]", label: "4b. No" },
    "disabledYes@2": { field: "Line4b_Child2_ReadOrder[0].Yes_ReadOrder[0].c1_5[0]", label: "4b. Child 2. Yes" },
    "disabledNo@2": { field: "Line4b_Child2_ReadOrder[0].c1_5[0]", label: "4b. No" },
    "disabledYes@3": { field: "Line4b_Child3_Yes_ReadOrder[0].c1_6[0]", label: "4b. Child 3. Yes" },
    "disabledNo@3": { field: "c1_6[0]", label: "4b. No" },
    "relationship@1": { field: "f1_21[0]", label: "relationship to you" },
    "relationship@2": { field: "f1_22[0]", label: "5. Child 2" },
    "relationship@3": { field: "f1_23[0]", label: "5. Child 3" },
    "months@1": { field: "Line6_Child1_ReadOrder[0].f1_24[0]", label: "Number of months", count: true },
    "months@2": { field: "Line6_Child2_ReadOrder[0].f1_25[0]", label: "6. Child 2", count: true },
    "months@3": { field: "f1_26[0]", label: "6. Child 3", count: true },
  },
  F2441: {
    ...names("f1_1[0]"),
    livedApart: { field: "c1_1[0]", label: "married filing separately" },
    deemedIncome: { field: "c1_2[0]", label: "student or was disabled" },
    moreQualifying: { field: "c1_7[0]", label: "more than three qualifying persons" },
    line22No: { field: "c2_1[0]", label: "22. Is any amount on line 12 or 13" },
    ...columns("firstName", "Qualifying person's name. First", [1, 2, 3].map((row, index) => `Table_Line2[0].Row${row}[0].f1_${15 + index * 4}[0]`)),
    ...columns("lastName", "Qualifying person's name. Last", [1, 2, 3].map((row, index) => `Table_Line2[0].Row${row}[0].f1_${16 + index * 4}[0]`)),
    ...columns("disabled", "over age 12 and was disabled", [1, 2, 3].map((row, index) => `Table_Line2[0].Row${row}[0].c1_${8 + index}[0]`)),
    ...columns("expenses", "Qualified expenses you incurred", [1, 2, 3].map((row, index) => `Table_Line2[0].Row${row}[0].f1_${18 + index * 4}[0]`)),
  },
  F8959: names("f1_1[0]"),
  F8960: names("f1_1[0]"),
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
  console.error("       npm run form-layout -- us/2025 F1040=f1040--2025.pdf S8812=f1040s8--2025.pdf ...");
  process.exit(1);
}
const file = join(RULES_ROOT, target, "form-layout.yaml");
const current = existsSync(file) ? ((parse(readFileSync(file, "utf8")) as { formLayout?: Record<string, unknown> }).formLayout ?? {}) : {};
const formsFile = join(RULES_ROOT, target, "forms.yaml");
const urls = existsSync(formsFile) ? ((parse(readFileSync(formsFile, "utf8")) as { forms?: Record<string, { url?: string } | null> }).forms ?? {}) : {};
const publishedOn = (form: string, site: string) => {
  const url = urls[baseOf(form)]?.url;
  return url !== undefined && new URL(url).hostname.endsWith(site);
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
  const measured = publishedOn(form, "irs.gov")
    ? measureIrsForm(await readIrsFields(new Uint8Array(bytes)), IRS_PLACES[form])
    : (publishedOn(form, "revenuquebec.ca") ? measureRqForm : measureForm)(items, shapes, placesOf(form));
  current[form] = { sha256: createHash("sha256").update(bytes).digest("hex"), pages: doc.numPages, ...measured };
  console.log(`form-layout: ${form}: ${doc.numPages} pages, ${Object.keys(measured.rows).length} rows, ${Object.keys(measured.columns ?? {}).length} rows with columns`);
}

const header = `# Where things go on the official forms, in PDF points from the bottom left: each row's page, the x of the line
# between dollars and cents (for a plain box with no such line, its right end), and the baseline; the boxes beside a
# row (columns); and the text boxes, date boxes and tick boxes. Generated by scripts/form-layout.ts from the PDFs with
# these SHA-256 hashes; don't edit by hand. forms.yaml says what goes where.
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
