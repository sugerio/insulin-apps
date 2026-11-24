import { PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRadioGroup, PDFRawStream, PDFString, PDFHexString, PDFTextField, decodePDFRawStream } from "pdf-lib";
import type { Measured, Point } from "./form-measure.ts";

// How the layout script places things on an IRS form. The IRS publishes its forms as fill-in PDFs: each box is a form
// field with its own rectangle, and the form's XFA part gives each field a spoken label that starts with its line
// number ("1a. Total amount from Form(s) W-2, box 1"). So nothing is measured from the drawing: a right-aligned field is
// an amount row named by the line number in its label, and the other places (names, ticks, a dependant's column) are
// named in the layout script by their field, with a piece of their label to check that the field is still the one meant.
//
// California's Franchise Tax Board publishes fill-in PDFs too, without an XFA part: each field's tooltip is its label
// ("Line 13. Enter federal adjusted gross income…", "Line 2b. Column B. Subtractions."), and a field set to the right
// holds an amount. readFtbFields reads them the same way, and ftbLineOf finds the line (and column) a label names.
//
// New York's Department of Taxation and Finance publishes fill-in PDFs mostly without tooltips: a field's name is then
// its label ("Line33" on Form IT-201, "6 dollars15" on IT-215, "line 3 dollars27" on IT-272). readNyFields reads them,
// and nyLineOf finds the line in the name.

/** A field's box on the form, with its label. */
export interface IrsField {
  /** The field's name inside its page, as the PDF names it: `f1_47[0]`, `Table_Dependents[0].Row1[0].f1_31[0]`. */
  name: string;
  kind: "text" | "tick";
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A text field whose text is set to the right of its box: an amount. */
  right: boolean;
  /** A box of one character per cell (a social security number): never filled by the app. */
  comb: boolean;
  label: string;
}

/**
 * A place named in the layout script: the field, and a piece of its label. A text field can hold a whole number
 * (`count`, ending at the box's right end), and a field with `cells` is the first of a row of one-character boxes (a
 * year of birth), written one character per box.
 */
export interface IrsPlace {
  field: string;
  label: string;
  count?: true;
  cells?: string[];
}

/** Each field of an IRS fill-in PDF, with its label from the form's XFA part. */
export async function readIrsFields(bytes: Uint8Array): Promise<IrsField[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const acroForm = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  const xfa = acroForm?.lookupMaybe(PDFName.of("XFA"), PDFArray);
  if (!xfa) throw new Error("The PDF has no XFA part: it isn't an IRS fill-in form");
  let template: string | undefined;
  for (let index = 0; index + 1 < xfa.size(); index += 2) {
    const key = xfa.lookup(index);
    const name = key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : "";
    const stream = xfa.lookup(index + 1);
    if (name === "template" && stream instanceof PDFRawStream) template = new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }
  if (!template) throw new Error("The PDF's XFA part has no template");
  const labels = xfaLabels(template);
  const pages = doc.getPages();
  // Read the fields before pdf-lib's form, which drops the XFA part, is asked for.
  const fields: IrsField[] = [];
  for (const field of doc.getForm().getFields()) {
    if (!(field instanceof PDFTextField) && !(field instanceof PDFCheckBox)) continue;
    // topmostSubform[0].Page1[0].f1_47[0] → f1_47[0], on page 1.
    const path = field.getName().split(".").slice(2).join(".");
    const label = labels.get(path);
    if (label === undefined) throw new Error(`The XFA part has no field ${path}`);
    const widgets = field.acroField.getWidgets();
    if (widgets.length !== 1) throw new Error(`${path} has ${widgets.length} boxes`);
    const widget = widgets[0]!;
    const page = pages.findIndex((each) => each.ref === widget.P()) + 1;
    const rect = widget.getRectangle();
    const text = field instanceof PDFTextField;
    fields.push({
      name: path,
      kind: text ? "text" : "tick",
      page,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      right: label.right,
      comb: text && field.isCombed(),
      label: label.text,
    });
  }
  return fields;
}

/**
 * Each field of an FTB fill-in PDF, with its label from the field's tooltip (`/TU`). A field with more than one box (a
 * radio group's choices, a name repeated on each page) is one field per box, named `<field>#<n>` in the order of its
 * boxes.
 */
export async function readFtbFields(bytes: Uint8Array): Promise<IrsField[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const fields: IrsField[] = [];
  for (const field of doc.getForm().getFields()) {
    if (!(field instanceof PDFTextField) && !(field instanceof PDFCheckBox) && !(field instanceof PDFRadioGroup)) continue;
    const tooltip = field.acroField.dict.lookup(PDFName.of("TU"));
    const label = tooltip instanceof PDFString || tooltip instanceof PDFHexString ? tooltip.decodeText().replace(/\s+/g, " ").trim() : "";
    const widgets = field.acroField.getWidgets();
    const text = field instanceof PDFTextField;
    const quadding = (dict: PDFDict) => {
      const q = dict.lookup(PDFName.of("Q"));
      return q instanceof PDFNumber ? q.asNumber() : null;
    };
    const fieldQ = quadding(field.acroField.dict);
    widgets.forEach((widget, index) => {
      const rect = widget.getRectangle();
      fields.push({
        name: widgets.length === 1 ? field.getName() : `${field.getName()}#${index + 1}`,
        kind: text ? "text" : "tick",
        page: pages.findIndex((each) => each.ref === widget.P()) + 1,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: (quadding(widget.dict) ?? fieldQ) === 2,
        comb: text && field.isCombed(),
        label,
      });
    });
  }
  return fields;
}

/**
 * The line an FTB label names, with its column when it has one: the last "Line …" of the label ("Line 6. Social
 * security benefits. Line 6b. Column A." is 6bA; "Line 1 h." is 1h; "Line 13 ." is 13). Lower-case "line" is a
 * reference to another line, never the field's own.
 */
export function ftbLineOf(label: string): string | null {
  const lines = [...label.matchAll(/\bLine (\d{1,3})(?: ?([a-z]\d?)\b)?/g)];
  const last = lines.at(-1);
  if (!last) return null;
  const column = /\bColumn ([A-D])\b/.exec(label)?.[1] ?? "";
  return `${last[1]}${last[2] ?? ""}${column}`;
}

/**
 * Each field of a New York fill-in PDF, its tooltip or else its name as its label (a field with more than one box is one per box, named
 * `<field>#<n>`, as readFtbFields names them). A box whose rectangle is drawn upside down (a negative height) is turned
 * the right way up.
 */
export async function readNyFields(bytes: Uint8Array): Promise<IrsField[]> {
  return (await readFtbFields(bytes)).map((field) => ({
    ...field,
    label: field.label || field.name.replace(/#\d+$/, ""),
    ...(field.height < 0 ? { y: field.y + field.height, height: -field.height } : {}),
  }));
}

/**
 * The line a New York field's name names: "Line33" and "line16a" (IT-201, IT-196, IT-270), "6 dollars15" and "28a
 * dollars" (IT-215), "5 dollars16" (IT-216), "line 3 dollars27" (IT-272), and IT-215's "Worksheet B 2 dollars15" as B2.
 * Any other name (a tick, a name, an SSN) isn't a line.
 */
export function nyLineOf(label: string): string | null {
  const name = label.trim();
  const worksheet = /^Worksheet ([A-Z]) (\d+) dollars\d*$/.exec(name);
  if (worksheet) return `${worksheet[1]}${worksheet[2]}`;
  const match = /^line ?(\d{1,2}[a-e]?)$/i.exec(name) ?? /^(?:line )?(\d{1,2}[a-z]?) dollars\d*$/i.exec(name);
  return match ? match[1]! : null;
}

/**
 * Each field's label in an XFA template, by its path below the page (`Table_Dependents[0].Row1[0].f1_31[0]`), and
 * whether its text is set right. A name's index counts the earlier nodes of the same name under the same parent, as
 * the PDF's field names do.
 */
export function xfaLabels(template: string): Map<string, { text: string; right: boolean }> {
  const labels = new Map<string, { text: string; right: boolean }>();
  // The open nodes: a named subform or exclusion group is part of a field's path, a page's subform (the second level)
  // starts it, and each counts its children's names.
  const stack: { name: string | null; seen: Map<string, number> }[] = [];
  const tag = /<(\/?)(subform|exclGroup|field|area)\b([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(template))) {
    const [, closing, element, attributes, selfClosing] = match;
    if (closing) {
      if (element !== "field") stack.pop();
      continue;
    }
    const name = /\bname="([^"]*)"/.exec(attributes!)?.[1] ?? null;
    const parent = stack.at(-1);
    let named: string | null = null;
    if (name !== null && parent) {
      const index = parent.seen.get(name) ?? 0;
      parent.seen.set(name, index + 1);
      named = `${name}[${index}]`;
    }
    if (element === "field") {
      const end = template.indexOf("</field", tag.lastIndex);
      const body = selfClosing || end < 0 ? "" : template.slice(tag.lastIndex, end);
      if (!selfClosing && end >= 0) tag.lastIndex = end;
      // Below the page: the path skips the form's root subform and the page's.
      const path = [...stack.slice(2).map((each) => each.name), named].filter((each): each is string => each !== null).join(".");
      const speak = /<speak\b[^>]*>([\s\S]*?)<\/speak/.exec(body)?.[1] ?? /<toolTip\b[^>]*>([\s\S]*?)<\/toolTip/.exec(body)?.[1] ?? "";
      const right = /<para\b[^>]*hAlign="right"/.test(body);
      if (named) labels.set(path, { text: decodeEntities(speak.replace(/\s+/g, " ").trim()), right });
      continue;
    }
    if (element === "area") {
      // An area groups fields without adding to their names.
      if (!selfClosing) stack.push({ name: null, seen: parent?.seen ?? new Map() });
      continue;
    }
    if (!selfClosing) stack.push({ name: named, seen: new Map() });
  }
  return labels;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The line number a label starts its line with: "1a" in "Income. Attach Form(s) W-2 here. … 1a. Total amount…", "11b"
 * in "Page 2. Tax and Credits. 11b. Amount from line 11a". A page number isn't one. A line whose first part is
 * lettered in its label is that part: "25a" in "25. Federal income tax withheld from: a. Form(s) W-2".
 */
export function lineOf(label: string): string | null {
  const match = /(?:^|\.\s|(?<!Row):\s)(\d{1,2}[a-z]?)\.\s(.*)$/.exec(label.replace(/^Page \d+\.\s*/, ""));
  if (!match) return null;
  const [, line, rest] = match as unknown as [string, string, string];
  return /^\d+$/.test(line) && /^[^.]*:\sa\.\s/.test(rest) ? `${line}a` : line;
}

// Where a value is written in a field's box, in points: an amount ends 0.5 before the box's right end (the drawing adds
// its own 2.5), text starts 2 in, and both sit on a baseline at the middle of the box less half a 9-point capital.
const BASELINE = (field: IrsField) => Math.round((field.y + (field.height - 6.5) / 2) * 10) / 10;
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * An IRS form's layout: each amount row by its line number (`rows`, all `plain`: the IRS's boxes have no cents line),
 * and each named place (`places`) by its field. Two amount fields with the same line number are refused unless one is named; a named field whose label doesn't
 * hold the piece given is refused.
 */
export function measureIrsForm(
  fields: IrsField[],
  places: Record<string, IrsPlace> = {},
  options: { lineOf?: (label: string) => string | null; pagePrefix?: boolean; skipAmbiguous?: boolean } = {},
): Measured {
  const lineFor = options.lineOf ?? lineOf;
  const byName = new Map(fields.map((field) => [field.name, field]));
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const named = new Set<string>();
  const counts = new Set<string>();
  const rows: Record<string, Point> = {};
  const text: Record<string, [number, number, number, number]> = {};
  const combs: Record<string, [number, number, number, number]> = {};
  const ticks: Record<string, Point> = {};
  const fieldOf = (key: string, name: string) => byName.get(name) ?? fail(`${key}: the form has no field ${name}`);
  for (const [key, place] of Object.entries(places)) {
    const field = fieldOf(key, place.field);
    if (!field.label.toLowerCase().includes(place.label.toLowerCase())) fail(`${key}: ${place.field} is "${field.label}", not "${place.label}"`);
    named.add(place.field);
    if (place.cells) {
      // One character per box: the cells are the boxes' spacing, centred on each box.
      const boxes = [field, ...place.cells.map((name) => fieldOf(key, name))];
      for (const box of boxes) named.add(box.name);
      const cell = (boxes.at(-1)!.x - field.x) / (boxes.length - 1);
      combs[key] = [field.page, round(field.x + field.width / 2 - cell / 2), BASELINE(field), round(cell)];
    } else if (field.kind === "tick") {
      ticks[key] = [field.page, round(field.x + field.width / 2), round(field.y + field.height / 2)];
    } else if (field.right || place.count) {
      rows[key] = [field.page, round(field.x + field.width - 0.5), BASELINE(field)];
      if (place.count) counts.add(key);
    } else {
      text[key] = [field.page, round(field.x + 2), BASELINE(field), round(field.width - 4)];
    }
  }
  const numbered = new Map<string, IrsField[]>();
  for (const field of fields) {
    if (named.has(field.name) || field.kind !== "text" || !field.right || field.comb) continue;
    const line = lineFor(field.label);
    if (line !== null) numbered.set(line, [...(numbered.get(line) ?? []), field]);
  }
  for (const [line, found] of [...numbered]) {
    if (line in rows) continue;
    // An FTB form numbers each part from 1 (Schedule P's Part III, Schedule CA's Part II): the same line on a later
    // page is that page's, `p<page>:<line>`.
    if (options.pagePrefix && found.length > 1 && new Set(found.map((each) => each.page)).size === found.length) {
      const [first, ...later] = [...found].sort((a, b) => a.page - b.page);
      numbered.set(line, [first!]);
      for (const field of later) numbered.set(`p${field.page}:${line}`, [field]);
    }
  }
  for (const [line, found] of numbered) {
    if (line in rows) continue;
    if (found.length > 1) {
      // An FTB form's table repeats a line for each provider or child: such a line isn't a row unless a place names it.
      if (options.skipAmbiguous) continue;
      fail(`Line ${line} has ${found.length} amount fields (${found.map((each) => each.name).join(", ")}): name the one meant`);
    }
    const field = found[0]!;
    rows[line] = [field.page, round(field.x + field.width - 0.5), BASELINE(field)];
  }
  const sorted = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));
  return {
    rows: sorted(rows),
    plain: Object.keys(sorted(rows)).filter((key) => !counts.has(key)),
    ...(Object.keys(text).length > 0 ? { text: sorted(text) } : {}),
    ...(Object.keys(combs).length > 0 ? { combs: sorted(combs) } : {}),
    ...(Object.keys(ticks).length > 0 ? { ticks: sorted(ticks) } : {}),
  };
}
