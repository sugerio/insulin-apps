import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Document, parse, visit } from "yaml";
import { ftbLineOf, measureIrsForm, nyLineOf, readFtbFields, readIrsFields, readNyFields, type IrsPlace } from "./form-irs.ts";
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
// from its drawing: its fields' boxes and labels place it (scripts/form-irs.ts), with the places in IRS_PLACES. A
// California form (its url on ftb.ca.gov) is placed the same way, from its fields' tooltips, and a New York form (its
// url on tax.ny.gov) from its fields' names.
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
/** Form 8863's Part III for one student: the name, the answers of lines 23 to 26 for the American opportunity credit, and lines 27 to 31. */
const partIII = (suffix: string): Record<string, IrsPlace> => ({
  [`student${suffix}`]: { field: "f2-5[0]", label: "20. Student name" },
  [`line23No${suffix}`]: { field: "c2_5[1]", label: "23. No" },
  [`line24Yes${suffix}`]: { field: "c2_6[0]", label: "Yes — Go to line 25" },
  [`line25No${suffix}`]: { field: "c2_7[1]", label: "25. No" },
  [`line26No${suffix}`]: { field: "c2_8[1]", label: "26. No" },
  ...Object.fromEntries([27, 28, 29, 30, 31].map((line, index) => [`${line}${suffix}`, { field: `f2_${31 + index}[0]`, label: `${line}.` }])),
});
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
    spouseItemizes: { field: "c2_3[0]", label: "Spouse itemizes on a separate return" },
    iraRollover: { field: "c1_35[0]", label: "1. Rollover" },
    pensionRollover: { field: "c1_38[0]", label: "1. Rollover" },
    benefitsLivedApart: { field: "c1_42[0]", label: "lived apart from your spouse the entire year" },
    noScheduleD: { field: "c1_43[0]", label: "Schedule D not required" },
  },
  // Line 22's table: each car's interest deducted here, column (iii), one row for each spouse's car.
  S1A: {
    ...names("f1_01[0]"),
    "22a": { field: "Table_Line22[0].Line22a[0].f2_03[0]", label: "Row: 22a. Column: Interest for this loan: (i i i) Schedule 1-A" },
    "22b": { field: "Table_Line22[0].Line22b[0].f2_06[0]", label: "Row: 22b. Column: Interest for this loan: (i i i) Schedule 1-A" },
  },
  // Line 7 has a second box for the amount repaid.
  S1: { ...names("f1_01[0]"), "7": { field: "f1_12[0]", label: "7. Amount" } },
  S2: { ...names("f1_01[0]"), line8NoForm: { field: "Line8_ReadOrder[0].c1_6[0]", label: "If not required, check here" } },
  SA: names("f1_1[0]"),
  // Lines 1a and 8a are table rows with no line number in their labels: their columns are named.
  SD: {
    ...names("f1_1[0]"),
    qofNo: { field: "c1_1[1]", label: "No." },
    "1aD": { field: "Table_PartI[0].Row1a[0].f1_3[0]", label: "(d) Proceeds" },
    "1aE": { field: "Table_PartI[0].Row1a[0].f1_4[0]", label: "(e) Cost" },
    "1aH": { field: "Table_PartI[0].Row1a[0].f1_6[0]", label: "(h) Gain or (loss)" },
    "8aD": { field: "Table_PartII[0].Row8a[0].f1_23[0]", label: "(d) Proceeds" },
    "8aE": { field: "Table_PartII[0].Row8a[0].f1_24[0]", label: "(e) Cost" },
    "8aH": { field: "Table_PartII[0].Row8a[0].f1_26[0]", label: "(h) Gain or (loss)" },
    line17Yes: { field: "c2_1[0]", label: "17. Are lines 15 and 16 both gains? Yes" },
    line17No: { field: "c2_1[1]", label: "17. No" },
    line20Yes: { field: "c2_2[0]", label: "Complete the Qualified Dividends and Capital Gain Tax Worksheet" },
    line22Yes: { field: "c2_3[0]", label: "line 3a? Yes" },
    line22No: { field: "c2_3[1]", label: "22. No" },
  },
  F6251: names("f1_1[0]"),
  F8889: { ...names("f1_1[0]"), selfOnly: { field: "c1_1[0]", label: "Self-only" }, family: { field: "c1_1[1]", label: "1. Family" } },
  // Part V's rows are numbered 1 to 9 like page 1's lines: they are named, and only its first row is used.
  SC: {
    name: { field: "f1_1[0]", label: "Name of proprietor" },
    "1": { field: "f1_10[0]", label: "1. Gross receipts or sales" },
    otherKind: { field: "PartVTable[0].Item1[0].f2_15[0]", label: "Part V. Other Expenses" },
    otherAmount: { field: "PartVTable[0].Item1[0].f2_16[0]", label: "1. Amount" },
    ...Object.fromEntries(
      [2, 3, 4, 5, 6, 7, 8, 9].map((row) => [`partV${row}`, { field: `PartVTable[0].Item${row}[0].f2_${16 + (row - 1) * 2}[0]`, label: `${row}. Amount` }]),
    ),
  },
  SE: { name: { field: "f1_1[0]", label: "Name of person with self-employment income" } },
  F8995: {
    ...names("f1_01[0]"),
    qbi1: { field: "Table[0].Row1i[0].f1_05[0]", label: "Row: i. Column: (c) Qualified business income" },
    qbi2: { field: "Table[0].Row1ii[0].f1_08[0]", label: "Row: i i. Column: (c) Qualified business income" },
  },
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
  // Form 8863: the decimals of lines 6 and 17 in two boxes each, the box of line 7, and page 2 (Part III) for one student,
  // in two sets of places: as a row of the form (you or your spouse) and as the one column of its table of dependants.
  F8863: {
    ...names("f1_1[0]"),
    names2: { field: "f2_1[0]", label: "Name(s) shown on" },
    "6": { field: "f1_10[0]", label: "6. If line 4 is", count: true },
    "6digits": { field: "f1_11[0]", label: "6. Digits after the decimal", count: true },
    "17": { field: "f1_22[0]", label: "17. If line 15 is", count: true },
    "17digits": { field: "f1_23[0]", label: "17. Digits after the decimal", count: true },
    line7NoRefund: { field: "c1_1[0]", label: "check this box" },
    spouseStudent: { field: "f2-5[0]", label: "20. Student name" },
    ...partIII(""),
    ...partIII("@1"),
  },
  F8959: names("f1_1[0]"),
  F8960: names("f1_1[0]"),
  // California's forms (FTB): the fields are named by FTB, their labels are their tooltips. Form 540's lines 7 to 10
  // are a count and an amount whose labels say "line 7 box"; its filing status is one radio group, in the order of its
  // boxes: 1 Single, 2 Married/RDP filing jointly, 4 Head of household, 3 Married/RDP filing separately, 5 Qualifying
  // surviving spouse/RDP.
  F540: {
    firstName: { field: "540_form_1003", label: "Your first name" },
    lastName: { field: "540_form_1005", label: "Last name" },
    spouseFirstName: { field: "540_form_1008", label: "spouse’s or Registered Domestic Partner's" },
    spouseLastName: { field: "540_form_1010", label: "Last name" },
    ...Object.fromEntries([2, 3, 4, 5, 6].map((page, index) => [`names${page}`, { field: `540_form_2001#${index + 1}`, label: "Your name" }])),
    single: { field: "540_form_1036 RB#1", label: "Filing status" },
    joint: { field: "540_form_1036 RB#2", label: "Filing status" },
    hoh: { field: "540_form_1036 RB#3", label: "Filing status" },
    separate: { field: "540_form_1036 RB#4", label: "Filing status" },
    qss: { field: "540_form_1036 RB#5", label: "Filing status" },
    claimable: { field: "540_form_1040 CB", label: "Line 6. If someone can claim you" },
    "7box": { field: "540_form_1041", label: "For line 7, line 8, line 9, and line 10", count: true },
    "8box": { field: "540_form_1043", label: "Line 8. Blind", count: true },
    "9box": { field: "540_form_1045", label: "Line 9. Senior", count: true },
    "10box": { field: "540_form_2015", label: "Total dependent exemptions", count: true },
    "7": { field: "540_form_1042", label: "line 7 box by $153" },
    "8": { field: "540_form_1044", label: "line 8 box by $153" },
    "9": { field: "540_form_1046", label: "line 9 box by $153" },
    "10": { field: "540_form_2016", label: "by $475" },
    ...columns("firstName", "first name", ["540_form_2003", "540_form_2007", "540_form_2011"]),
    ...columns("lastName", "Last name", ["540_form_2004", "540_form_2008", "540_form_2012"]),
    ...columns("relationship", "relationship to you", ["540_form_2006", "540_form_2010", "540_form_2014"]),
    taxTable: { field: "540_form_2026 CB", label: "tax is from tax table" },
    rateSchedule: { field: "540_form_2027 CB", label: "Tax Rate Schedule" },
    noUseTax: { field: "540_form_3020 RB#1", label: "Line 91. If line 91 is zero" },
    coverage: { field: "540_form_3021 CB", label: "full-year health care coverage" },
  },
  SCA540: {
    names: { field: "540ca_form - 1000", label: "Name or names as shown" },
    notItemizedFederal: { field: "540ca_form - 5000 CB", label: "did NOT itemize" },
  },
  SP540: {
    names: { field: "540P-1001", label: "Name or names as shown" },
    // Line 13's total; its item a has a box of its own, which also says line 13.
    "13": { field: "540P-1027", label: "Add amounts on line a" },
  },
  F3506: {
    names: { field: "3506 - 1000", label: "Name or names as shown" },
  },
  F3514: {
    names: { field: "3514_Form_1000", label: "Name or Names as shown" },
    // Line 20's label names the worksheet's line too.
    "20": { field: "3514_Form_2028", label: "Line 20" },
    ...columns("firstName", "First name", ["3514_Form_1008", "3514_Form_1016", "3514_Form_1024"]),
    ...columns("lastName", "Last Name", ["3514_Form_1009", "3514_Form_1017", "3514_Form_1025"]),
  },
  // New York's forms (tax.ny.gov): a field's name is its label. Form IT-201's filing status is one box with five
  // choices, in the order of their circled numbers (1 Single to 5 Qualifying surviving spouse); each Yes/No question is
  // a box with two choices, Yes first.
  IT201: {
    firstName: { field: "TP_first_name", label: "TP_first_name" },
    lastName: { field: "TP_last_name", label: "TP_last_name" },
    spouseFirstName: { field: "Spouse_first_name", label: "Spouse_first_name" },
    spouseLastName: { field: "Spouse_last_name", label: "Spouse_last_name" },
    names3: { field: "Name_as_page1", label: "Name_as_page1" },
    single: { field: "Filing_status#1", label: "Filing_status" },
    joint: { field: "Filing_status#2", label: "Filing_status" },
    separate: { field: "Filing_status#3", label: "Filing_status" },
    hoh: { field: "Filing_status#4", label: "Filing_status" },
    qss: { field: "Filing_status#5", label: "Filing_status" },
    itemizedYes: { field: "Itemized#1", label: "Itemized" },
    itemizedNo: { field: "Itemized#2", label: "Itemized" },
    claimableYes: { field: "Dependent#1", label: "Dependent" },
    claimableNo: { field: "Dependent#2", label: "Dependent" },
    yonkersYes: { field: "yonkers_freeze_credit#1", label: "yonkers_freeze_credit" },
    yonkersNo: { field: "yonkers_freeze_credit#2", label: "yonkers_freeze_credit" },
    yonkersMonths: { field: "D1_Yonkers", label: "D1_Yonkers", count: true },
    yonkersSpouseMonths: { field: "D3_Yonkers", label: "D3_Yonkers", count: true },
    nycYes: { field: "E1#1", label: "E1" },
    nycNo: { field: "E1#2", label: "E1" },
    nycMonths: { field: "F1_NYC", label: "F1_NYC", count: true },
    nycSpouseMonths: { field: "F2_NYC", label: "F2_NYC", count: true },
    ...columns("firstName", "H_first", [1, 2, 3, 4, 5, 6, 7].map((row) => `H_first${row}`)),
    ...columns("lastName", "H_last", [1, 2, 3, 4, 5, 6, 7].map((row) => `H_last${row}`)),
    ...columns("relationship", "H_relationship", [1, 2, 3, 4, 5, 6, 7].map((row) => `H_relationship${row}`)),
    moreDependants: { field: "H_additional_dependents", label: "H_additional_dependents" },
    standard: { field: "34Deduction#1", label: "34Deduction" },
    itemized: { field: "34Deduction#2", label: "34Deduction" },
  },
  // Form IT-2: two W-2 records, the second's fields named with "2_" before them.
  IT2: Object.fromEntries(
    ["", "2_"].flatMap((prefix, index) =>
      [
        ["employer", "Box_c1"],
        ["1", "Box_1"],
        ["8", "Box_8"],
        ["10", "Box_10"],
        ["11", "Box_11"],
        ["16a", "Box_16a"],
        ["17a", "Box_17a"],
        ["15b", "Box_15b"],
        ["16b", "Box_16b"],
        ["17b", "Box_17b"],
        ["18a", "Box_18a"],
        ["19a", "Box_19a"],
        ["20a", "Box_20a"],
      ].map(([key, field]) => [`${key}@${index + 1}`, { field: `${prefix}${field}`, label: `${prefix}${field}` }]),
    ),
  ),
  // Form IT-1099-R: three records, the second's fields named with "2" after them and the third's (on page 2) with "3".
  IT1099R: {
    names: { field: "Recipent's Name", label: "Recipent's Name" },
    ...Object.fromEntries(
      ["", "2", "3"].flatMap((suffix, index) =>
        [
          ["payer", "Payer's Name & Addr-1"],
          ["1", "Box 1 Dollar"],
          ["2a", "Box 2a Dollar"],
          ["code", "Dist-Code"],
          ["12a", "Box 12a Dollar"],
          ["14", "Box 14 Dollar"],
          ["15a", "Box 15a Dollar"],
          ["locality", "Locality Name A"],
          ["17a", "Box 17a Dollar"],
        ].map(([key, field]) => [`${key}@${index + 1}`, { field: `${field}${suffix}`, label: `${field}${suffix}` }]),
      ),
    ),
  },
  IT196: {
    names: { field: "Name", label: "Name" },
    incomeTaxes: { field: "Line5ab#1", label: "Line5ab" },
    overLimitYes: { field: "Over_line19#1", label: "Over_line19" },
    overLimitNo: { field: "Over_line19#2", label: "Over_line19" },
  },
  // Form IT-213's fields are named by zone, with tooltips: lines 1 to 9 down the right, and the table of children
  // (first name, last name) below.
  IT213: {
    names: { field: "Page 1 Zone 6", label: "Name(s) as shown on return" },
    ...Object.fromEntries(
      [
        ["1", 12, "1 Number of qualifying children"],
        ["2", 15, "2 Multiply line 1"],
        ["3", 19, "3 Number of qualifying children"],
        ["4", 22, "4 Multiply line 3"],
        ["5", 26, "5 Add lines 2 and 4"],
        ["6", 30, "6 Enter your federal adjusted gross income"],
        ["7", 39, "7 Is the amount on line 6"],
        ["8", 43, "8 Multiply line 7"],
        ["9", 47, "9 Subtract line 8"],
      ].map(([line, zone, label]) => [line, { field: `Page 1 Zone ${zone}`, label: String(label), count: true as const }]),
    ),
    ...columns("firstName", "First Name, Row", [51, 52, 53, 54, 55, 56].map((zone) => `Page 1 Zone ${zone}`)),
    ...columns("lastName", "Last name", [63, 64, 65, 66, 67, 68].map((zone) => `Page 1 Zone ${zone}`)),
  },
  IT215: {
    names: { field: "Your last name", label: "Your last name" },
    // Lines 1 to 5's Yes/No boxes are named Line 1, 1a, 2, 3 and 5: each is the line below the one its name says.
    claimedYes: { field: "Line 1#1", label: "Line 1" },
    investmentNo: { field: "Line 1a#2", label: "Line 1a" },
    unmarriedNo: { field: "Line 2#2", label: "Line 2" },
    childrenYes: { field: "Line 3#1", label: "Line 3" },
    childrenNo: { field: "Line 3#2", label: "Line 3" },
    irsFiguresNo: { field: "Line 5#2", label: "Line 5" },
    ...columns("firstName", "ln34fn", [1, 2, 3].map((row) => `ln34fn${row}`)),
    ...columns("lastName", "ln34ln", [1, 2, 3].map((row) => `ln34ln${row}`)),
    ...columns("relationship", "ln34real", [1, 2, 3].map((row) => `ln34real${row}`)),
    ...Object.fromEntries([1, 2, 3].map((row) => [`months@${row}`, { field: `month${row}`, label: "month", count: true as const }])),
  },
  IT216: {
    names: { field: "Your last name", label: "Your last name" },
    "3": { field: "3 total qualifying persons", label: "3 total qualifying persons", count: true },
    "13": { field: "13 first number16", label: "13 first number16" },
    "13agi": { field: "13 IT201 filers dollars16", label: "13 IT201 filers dollars16" },
    ...columns("firstName", "3 first name", [1, 2, 3].map((row) => `3 first name ${row}16`)),
    ...columns("lastName", "3 last name", [1, 2, 3].map((row) => `3 last name ${row}16`)),
    ...columns("expenses", "3 qualified expenses", [1, 2, 3].map((row) => `3 qualified expenses ${row}16`)),
  },
  IT270: {
    names: { field: "NameReturn", label: "NameReturn" },
  },
  IT272: {
    names: { field: "name as shown on return", label: "name as shown on return" },
    spouseNames: { field: "spouses as shown on return", label: "spouses as shown on return" },
    notClaimed: { field: "Line 1#2", label: "Line 1" },
    resident: { field: "Line 2#1", label: "Line 2" },
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
    : publishedOn(form, "ftb.ca.gov")
      ? measureIrsForm(await readFtbFields(new Uint8Array(bytes)), IRS_PLACES[form], { lineOf: ftbLineOf, pagePrefix: true, skipAmbiguous: true })
      : publishedOn(form, "tax.ny.gov")
        ? measureIrsForm(await readNyFields(new Uint8Array(bytes)), IRS_PLACES[form], { lineOf: nyLineOf })
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
