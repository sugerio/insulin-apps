// Measures where things go on a CRA print form, from what the PDF draws: its text (row numbers, line codes, labels) and
// its lines and white boxes. scripts/form-layout.ts reads the PDF and writes the result to form-layout.yaml; this module
// only measures, so the tests can give it pages of their own.
//
// An amount box of a CRA form is a white box with a short vertical line in it: the line between dollars and cents.
// A row's number is printed just right of its box, and a box with only a line code (no row number) has the code just
// left of it. So a row's place is the page, the x of that line, and the row number's (or code's) baseline. Taking the
// line from the drawing, not from a fixed distance to the number, works whether the numbers are set at x 576, 573 or
// 570, left-aligned or centred, and for the forms whose boxes are only an underline with a tick (T2125).
//
// A box with no cents line is listed in `plain`, and its x is the box's right end: a narrow box after a code holds a
// whole number (a count of months), and a plain underline (T776) holds an amount written with its decimal point. A row
// with more boxes on its line (a "you / your spouse" table, an amount carried in from another line, the columns of an
// expense table) lists every box's x, left to right, in `columns`; a bracket table's row lists its preprinted columns.
// Rows whose box already holds a printed amount are listed in `printed`, so nothing is written over them.
//
// Places that aren't amount rows (Step 1 of the T1) are found by the label printed at them: a text box is the white
// box under its label, a date's boxes are the white box under its label cut into cells by its ticks, and a tick box is
// the small square on its label's line.

export interface TextItem {
  page: number;
  x: number;
  /** The baseline. */
  y: number;
  width: number;
  text: string;
}

/** A path the page draws, by its bounding box: a stroked line or a filled box. */
export interface Shape {
  page: number;
  paint: "stroke" | "fill";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type PlaceKind = "text" | "comb" | "tick" | "amount";
/** A place found by its label: the first item on the page that starts with `label` (below the item starting with `below`). */
export interface PlaceSpec {
  kind: PlaceKind;
  page: number;
  label: string;
  below?: string;
}

export type Point = [page: number, x: number, y: number];
export interface Measured {
  rows: Record<string, Point>;
  columns?: Record<string, number[]>;
  printed?: string[];
  plain?: string[];
  /** Text: page, where the text starts, its baseline, and the room it has. */
  text?: Record<string, [page: number, x: number, y: number, width: number]>;
  /** A date in boxes: page, the first cell's left edge, the baseline, and the cell width. */
  combs?: Record<string, [page: number, x: number, y: number, cell: number]>;
  /** The centre of a tick box. */
  ticks?: Record<string, Point>;
}

/** Helvetica widths, per 1000 em, of what a preprinted amount holds. */
const WIDTH: Record<string, number> = { ",": 278, ".": 278 };
const widthOf = (char: string) => WIDTH[char] ?? 556;
/**
 * How far left of a row number its cents line can be: 24 points on most forms, 13 on the T2125. Nearer than 10 is the
 * box's own right edge (a total's box is outlined).
 */
const ROW_REACH = [10, 40];
/**
 * How far right of the end of a line code the cents line of its box can be: 65 points for a standard box. Nearer than
 * 20 is the edge of the code's own black box.
 */
const CODE_REACH = [20, 100];
/** A label's baseline may sit this far outside the box's height (an underlined box's number is set above the line). */
const BAND = 2.5;

interface CentsLine {
  page: number;
  x: number;
  y0: number;
  y1: number;
}

export function measureForm(items: TextItem[], shapes: Shape[], places: Record<string, PlaceSpec> = {}): Measured {
  const ticks: CentsLine[] = shapes
    .filter((shape) => shape.paint === "stroke" && shape.x1 - shape.x0 < 0.5 && shape.y1 - shape.y0 >= 4 && shape.y1 - shape.y0 <= 120)
    .map((shape) => ({ page: shape.page, x: round((shape.x0 + shape.x1) / 2), y0: shape.y0, y1: shape.y1 }));
  // A box for digits (a SIN, a date) has a tick between every two cells: a run of three or more ticks less than 20
  // points apart. A cents line has at most the box's right edge that near.
  const sameRun = (a: CentsLine, b: CentsLine) => a !== b && a.page === b.page && Math.abs(a.x - b.x) < 20 && Math.abs(a.y0 - b.y0) < 1;
  // A cents line is inside its box: the box (filled white, or outlined), or the underline at its foot, goes on past it on
  // both sides. A box's own edges, and the edges of a line code's black box, aren't. (A box is at most 120 points high
  // and 200 wide; a part's frame and the page's grey background aren't boxes.)
  const inBox = (line: CentsLine) =>
    shapes.some(
      (shape) =>
        shape.page === line.page &&
        shape.x0 < line.x - 5 &&
        shape.x1 > line.x + 5 &&
        (shape.y1 - shape.y0 < 0.5
          ? shape.paint === "stroke" && Math.abs(shape.y0 - line.y0) < 1
          : shape.y1 - shape.y0 <= 120 && shape.x1 - shape.x0 <= 200 && shape.y0 <= line.y0 + 1 && shape.y1 >= line.y1 - 1),
    );
  const lines = ticks.filter((line) => {
    if (!inBox(line)) return false;
    const near = ticks.filter((other) => sameRun(line, other));
    return near.length === 0 || (near.length === 1 && !ticks.some((other) => other !== line && sameRun(near[0]!, other)));
  });
  const fills = shapes.filter((shape) => shape.paint === "fill");
  // A plain underline to write on, with no cents line: an amount sits just above it.
  const underlines = shapes.filter(
    (shape) =>
      shape.paint === "stroke" &&
      shape.y1 - shape.y0 < 0.5 &&
      shape.x1 - shape.x0 >= 30 &&
      shape.x1 - shape.x0 <= 200 &&
      !ticks.some((tick) => tick.page === shape.page && tick.x > shape.x0 && tick.x < shape.x1 && Math.abs(tick.y0 - shape.y0) < 1),
  );
  const onUnderline = (line: Shape): number => round(line.y0 + 2.3);
  /** How far a baseline is from a line's height: 0 when within it. */
  const off = (line: CentsLine, y: number) => Math.max(0, line.y0 - y, y - line.y1);
  /** The cents line on this baseline whose x is in the range, the one nearest the label. */
  const lineAt = (page: number, y: number, from: number, to: number, prefer: "left" | "right") =>
    lines
      .filter((line) => line.page === page && line.x >= from && line.x <= to && off(line, y) <= BAND)
      .sort((a, b) => off(a, y) - off(b, y) || (prefer === "right" ? b.x - a.x : a.x - b.x))[0];

  const rows: Record<string, Point> = {};
  const plain: string[] = [];
  /** A code's underlines, left to right: the first is its box, the others the table's other columns. */
  const codeColumns: Record<string, number[]> = {};
  const rowLines = new Map<string, CentsLine>();
  const seen = new Set<string>();
  for (const item of [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)) {
    // Row numbers ("1", "125", the T2125's "3A", a lettered amount "A") are right of their box; a number nearby with no
    // box is something else (a question's number in Step 1, a tick box's option).
    if (!/^(\d{1,3}[A-Z]?|[A-Z])$/.test(item.text) || item.x < 300) continue;
    const line = lineAt(item.page, item.y, item.x - ROW_REACH[1]!, item.x - ROW_REACH[0]!, "right");
    // Or an underline ending just left of the number, which is set a little above it.
    const under = line ? undefined : underlines.find((each) => each.page === item.page && each.x1 >= item.x - 12 && each.x1 <= item.x && each.y0 <= item.y + 1 && each.y0 >= item.y - 6);
    if (!line && !under) continue;
    // A number printed again (a chart below the form's lines, a second part restarting at 1) is keyed by its page, and
    // by its order on that page when the page has it twice: p7:10, then p7:10.2.
    let key = seen.has(item.text) ? `p${item.page}:${item.text}` : item.text;
    for (let count = 2; key in rows; count += 1) key = `p${item.page}:${item.text}.${count}`;
    seen.add(item.text);
    if (line) {
      // The amount sits on the row number's baseline; a few numbers are set on or below their box's foot, and then the
      // amount sits just above it instead, as in every other box.
      rows[key] = [item.page, line.x, round(item.y < line.y0 + 0.5 ? line.y0 + 2.3 : item.y)];
      rowLines.set(key, line);
    } else {
      rows[key] = [item.page, round(under!.x1), onUnderline(under!)];
      plain.push(key);
    }
  }

  // A box with a line code at its left and no row number of its own (inner columns, the gross amount left of a net
  // one, the refund and balance owing): keyed by the code. A numbered row's own code is left of that row's box.
  const numbered = [...rowLines.values()];
  for (const item of items) {
    if (!/^\d{4,5}$/.test(item.text) || (item.text.length === 5 && Math.abs(item.width - 22.8) > 0.6) || item.text in rows) continue;
    const end = item.x + item.width;
    const line = lineAt(item.page, item.y, end + CODE_REACH[0]!, end + CODE_REACH[1]!, "left");
    if (line) {
      if (!numbered.includes(line)) rows[item.text] = [item.page, line.x, round(item.y)];
      continue;
    }
    // No cents line: a narrow box for a whole number, right after the code's own black box.
    const box = fills.find((fill) => fill.page === item.page && fill.x0 >= end - 1 && fill.x0 <= end + 8 && fill.x1 - fill.x0 >= 10 && item.y >= fill.y0 - BAND && item.y <= fill.y1);
    if (box) {
      rows[item.text] = [item.page, round(box.x1), round(item.y)];
      plain.push(item.text);
      continue;
    }
    // Or an underline starting just right of the code, and the underlines right of it on the same line.
    const under = underlines.find((each) => each.page === item.page && each.x0 >= end && each.x0 <= end + 15 && Math.abs(each.y0 - (item.y - 2.5)) <= 4);
    if (under) {
      rows[item.text] = [item.page, round(under.x1), onUnderline(under)];
      plain.push(item.text);
      const beside = underlines.filter((each) => each.page === item.page && each.x0 > under.x1 && Math.abs(each.y0 - under.y0) < 0.5).map((each) => round(each.x1));
      if (beside.length > 0) codeColumns[item.text] = [round(under.x1), ...beside.sort((a, b) => a - b)];
    }
  }

  const columns: Record<string, number[]> = { ...codeColumns };
  for (const [key, [page, x, y]] of Object.entries(rows)) {
    if (key in columns) continue;
    // A bracket table: a row with preprinted amounts ("57,375.00") in two or more columns; the columns are where the
    // printed amounts' decimal points are.
    const amounts = items.filter((item) => item.page === page && Math.abs(item.y - y) < 3 && /^[\d,]+\.\d\d$/.test(item.text)).sort((a, b) => a.x - b.x);
    if (amounts.length >= 2) {
      columns[key] = amounts.map((item) => {
        const chars = [...item.text];
        const total = chars.reduce((sum, char) => sum + widthOf(char), 0);
        const dot = chars.indexOf(".");
        const before = chars.slice(0, dot).reduce((sum, char) => sum + widthOf(char), 0) + widthOf(".") / 2;
        return round(item.x + (item.width * before) / total);
      });
      continue;
    }
    // Other boxes left of the row's box, standing on the same line: a second column, an amount carried in ("amount from
    // line 76 [ ] ÷ 14.5%"), or a plain box for a count ("[ ] × $8,000"): a white box or a short underline with no
    // cents line and nothing printed in it.
    const own = rowLines.get(key);
    if (!own) continue;
    const empty = (x0: number, x1: number) =>
      !lines.some((line) => line.page === page && line.x > x0 && line.x < x1 && off(line, y) <= BAND) &&
      !items.some((item) => item.page === page && Math.abs(item.y - y) < 4 && item.x + item.width > x0 + 1 && item.x < x1 - 1);
    const besideCents = lines.filter((line) => line.page === page && line.x < x - 30 && Math.abs(line.y0 - own.y0) < 3).map((line) => line.x);
    const besidePlain = [
      ...fills.filter((fill) => fill.page === page && fill.y1 - fill.y0 <= 30 && fill.x1 - fill.x0 >= 15 && fill.x1 - fill.x0 <= 140 && Math.abs(fill.y0 - own.y0) < 3),
      ...underlines.filter((line) => line.page === page && Math.abs(line.y0 - own.y0) < 3),
    ]
      .filter((box) => box.x1 < x - 30 && empty(box.x0, box.x1))
      // A box touching one with a cents line is that box's sign area.
      .filter((box) => !fills.some((other) => other.page === page && (Math.abs(other.x0 - box.x1) < 1 || Math.abs(other.x1 - box.x0) < 1) && Math.abs(other.y0 - box.y0) < 1 && !empty(other.x0, other.x1)))
      .map((box) => round(box.x1))
      // A white box drawn with its own underline is one box.
      .filter((each, index, all) => !all.some((other, at) => at < index && Math.abs(other - each) < 3));
    if (besideCents.length + besidePlain.length === 0) continue;
    const all = [...new Set([...besideCents, ...besidePlain, x])].sort((a, b) => a - b);
    columns[key] = all;
    all.forEach((each, index) => {
      if (besidePlain.includes(each) && !besideCents.includes(each)) plain.push(`${key}@${index + 1}`);
    });
  }

  // A box that already holds a printed amount (a base amount, "294.00"): nothing is written there.
  // A plain box ends at its x; a box with a cents line goes on 18 points past it.
  const printed = Object.entries(rows)
    .filter(([key, [page, x, y]]) => {
      const end = plain.includes(key) ? x : x + 18;
      return items.some((item) => item.page === page && Math.abs(item.y - y) < 4 && item.x + item.width > end - 86 && item.x < end && /^\$?[\d,]*\d(\.\d+)?%?$/.test(item.text) && !/^\d{4,5}$/.test(item.text));
    })
    .map(([key]) => key);

  const text: NonNullable<Measured["text"]> = {};
  const combs: NonNullable<Measured["combs"]> = {};
  const tickBoxes: NonNullable<Measured["ticks"]> = {};
  for (const [key, spec] of Object.entries(places)) {
    const label = labelOf(items, spec, key);
    const fail = (what: string): never => {
      throw new Error(`${key}: no ${what} near "${spec.label}" on page ${spec.page}`);
    };
    if (spec.kind === "text" || spec.kind === "comb") {
      // The white box under the label, overlapping it.
      const reach = spec.kind === "text" ? 25 : 30;
      const box = fills
        .filter((fill) => {
          const height = fill.y1 - fill.y0;
          return fill.page === spec.page && height >= 8 && height <= 16 && fill.x1 - fill.x0 >= 30 && fill.y1 <= label.y + 1 && fill.y1 >= label.y - reach;
        })
        .filter((fill) => (spec.kind === "text" ? fill.x0 <= label.x + 3 && fill.x1 >= label.x + 10 : fill.x0 <= label.x + label.width / 2 && fill.x1 >= label.x + label.width / 2))
        .sort((a, b) => b.y1 - a.y1)[0];
      if (!box) fail("box");
      if (spec.kind === "text") {
        text[key] = [spec.page, round(box!.x0 + 2), round(box!.y0 + 2.5), round(box!.x1 - box!.x0 - 4)];
      } else {
        // The cells' dividers are ticks inside the box; the first cell starts one cell left of the first tick.
        const ticksIn = shapes
          .filter((shape) => shape.page === spec.page && shape.paint === "stroke" && shape.x1 - shape.x0 < 0.5 && shape.x0 > box!.x0 + 1 && shape.x0 < box!.x1 - 1 && shape.y0 < box!.y1 && shape.y1 > box!.y0 - 1)
          .map((shape) => shape.x0)
          .sort((a, b) => a - b);
        if (ticksIn.length < 2) fail("date cells");
        const cell = Math.min(...ticksIn.slice(1).map((x, index) => x - ticksIn[index]!));
        combs[key] = [spec.page, round(ticksIn[0]! - cell), round(box!.y0 + 2.3), round(cell)];
      }
    } else if (spec.kind === "tick") {
      // The small square on the label's line, the nearest one to it.
      const square = fills
        .filter((fill) => {
          const size = fill.x1 - fill.x0;
          return fill.page === spec.page && size >= 7 && size <= 13 && Math.abs(fill.y1 - fill.y0 - size) < 1 && Math.abs((fill.y0 + fill.y1) / 2 - (label.y + 3)) <= 6;
        })
        .sort((a, b) => gap(a, label) - gap(b, label))[0];
      if (!square) fail("tick box");
      tickBoxes[key] = [spec.page, round((square!.x0 + square!.x1) / 2), round((square!.y0 + square!.y1) / 2)];
    } else {
      // An amount box right of a label with no row number: its cents line, the baseline at the box's foot.
      const line = lines.filter((each) => each.page === spec.page && each.x > label.x + label.width && off(each, label.y) <= 3).sort((a, b) => b.x - a.x)[0];
      if (!line) fail("amount box");
      rows[key] = [spec.page, line!.x, round(line!.y0 + 2.3)];
    }
  }

  return {
    rows,
    ...(Object.keys(columns).length > 0 ? { columns } : {}),
    ...(printed.length > 0 ? { printed } : {}),
    ...(plain.length > 0 ? { plain } : {}),
    ...(Object.keys(text).length > 0 ? { text } : {}),
    ...(Object.keys(combs).length > 0 ? { combs } : {}),
    ...(Object.keys(tickBoxes).length > 0 ? { ticks: tickBoxes } : {}),
  };
}

function labelOf(items: TextItem[], spec: PlaceSpec, key: string): TextItem {
  const onPage = items.filter((item) => item.page === spec.page).sort((a, b) => b.y - a.y || a.x - b.x);
  const top = spec.below === undefined ? Infinity : onPage.find((item) => item.text.startsWith(spec.below!))?.y;
  if (top === undefined) throw new Error(`${key}: no "${spec.below}" on page ${spec.page}`);
  const matches = onPage.filter((item) => item.y < top && item.text.startsWith(spec.label));
  if (matches.length === 0) throw new Error(`${key}: no "${spec.label}" on page ${spec.page}`);
  if (spec.below === undefined && matches.length > 1) throw new Error(`${key}: "${spec.label}" is on page ${spec.page} ${matches.length} times; say below what`);
  return matches[0]!;
}

/** The horizontal distance between a box and a label. */
function gap(box: Shape, label: TextItem): number {
  return Math.max(0, box.x0 - (label.x + label.width), label.x - box.x1);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
