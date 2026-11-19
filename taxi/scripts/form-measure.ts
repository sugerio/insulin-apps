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
//
// Revenu Québec draws its forms (the TP-1 and its schedules) another way, so they have their own measuring,
// measureRqForm, below.

export interface TextItem {
  page: number;
  x: number;
  /** The baseline. */
  y: number;
  width: number;
  text: string;
  /** The font's height; Revenu Québec's line numbers are told from other numbers by it. */
  height?: number;
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
export interface LabelPlace {
  kind: PlaceKind;
  page: number;
  label: string;
  below?: string;
}
/** On a Revenu Québec form, a place found by the line number printed in the frame at its left. */
export interface LinePlace {
  kind: "text" | "comb" | "tick";
  page: number;
  line: string;
}
export type PlaceSpec = LabelPlace | LinePlace;

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
    if (!("label" in spec)) throw new Error(`${key}: a CRA form's places are found by their labels`);
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
      tickBoxes[key] = tickBy(fills, spec, label) ?? fail("tick box");
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

// Revenu Québec draws its forms (the TP-1 and its schedules, on pages of 603 by 774 points) differently: each line's
// number is printed in a small frame just left of its box, in columns that differ from form to form, and several boxes
// can share a line (the TP-1's lines 96 to 98.2, a work chart's "you" and "your spouse" columns). A box's dollars and
// cents are split by a vertical line, often a dotted one drawn over a solid one, 18 points before the box's right end.
// So a row is found from its number: its cents line is a vertical line right of the number's frame, through the
// number's baseline, with the box's bottom line (3 points below the baseline) running on 16.5 to 20.5 points past it.
// Nothing is assumed about how far the box is from the number, so every column of every schedule is found the same
// way; and a long line down a column of boxes isn't taken for another row's, as the bottom line has to be on this
// row. A decimal line is printed as its number and a smaller digit ("377" "1": line 377.1), or as one item ("40.6").
//
// Other boxes on a row's line, before the next number, are its columns (a work chart's spouse column, Schedule F's
// "more than $63,060"); a number printed again on its own line is the same line in another column. A number printed
// again elsewhere is keyed by its page (p3:199), then by its order on that page (p2:64#2): "." already marks a decimal
// line. A numbered box with no cents line (a code, a count of months) is plain, its x the box's right end; a frame with
// a check box or a box of digit cells beside it is no row. Step 1's boxes are found by their line numbers too.

/** Revenu Québec's line numbers are 7 to 7.5 points high; the text around them is 8.5 or more, a date's printed digits 9. */
const RQ_NUMBER_HEIGHT = [6.5, 8];
/**
 * How far right of its cents line a box ends: 18 points, give or take the drawing's rounding. A number's frame is 14.5
 * to 15.5 points wide, so its left edge isn't taken for a cents line.
 */
const RQ_CENTS = [16.5, 20.5];
/** A code's box (box 449 of the TP-1) has a cell for each digit: at most 40 points wide, where a SIN's or a date's is wider. */
const RQ_CODE_WIDTH = 40;

interface RqNumber {
  page: number;
  x: number;
  /** Where the number (and a decimal line's digit) ends. */
  end: number;
  y: number;
  line: string;
  items: TextItem[];
}

export function measureRqForm(items: TextItem[], shapes: Shape[], places: Record<string, PlaceSpec> = {}): Measured {
  const numbers = rqNumbers(items);
  const numberItems = new Set(numbers.flatMap((number) => number.items));
  const verticals = shapes.filter((shape) => shape.paint === "stroke" && shape.x1 - shape.x0 < 0.5 && shape.y1 - shape.y0 >= 2.5);
  const fills = shapes.filter((shape) => shape.paint === "fill");
  /**
   * A vertical line through a box on this baseline (a box runs from about 3 points below it to 9 above), at least 8
   * points of it: the strokes of the small letters printed under a date's boxes are shorter.
   */
  const crosses = (line: Shape, y: number) => line.y0 <= y + 1 && line.y1 >= y + 4 && line.y1 - line.y0 >= 8;
  /** A line the box's full height: its edge, not one of the short ticks between a date's digits. */
  const spans = (line: Shape, y: number) => line.y0 <= y + 0.5 && line.y1 >= y + 7;
  /** A tick between digit cells: rising from the box's foot, short of its top. */
  const tick = (line: Shape, y: number) => line.y0 <= y + 1 && line.y1 >= y && !spans(line, y);
  /** The bottom line of a box on this baseline, from the cents line (or before it) to the box's right end. */
  const centsPartAt = (page: number, x: number, y: number) =>
    shapes.some(
      (shape) =>
        shape.page === page &&
        shape.paint === "stroke" &&
        shape.y1 - shape.y0 < 0.5 &&
        shape.y0 >= y - 4.5 &&
        shape.y0 <= y - 1 &&
        shape.x0 <= x + 1 &&
        shape.x1 >= x + RQ_CENTS[0]! &&
        shape.x1 <= x + RQ_CENTS[1]!,
    );
  /** The right edge of the frame around a number: a vertical line, or a framed box, just past it. */
  const frameOf = (number: RqNumber): number | undefined => {
    const edges = shapes
      .filter((shape) => shape.page === number.page && shape.x1 >= number.end - 0.5 && shape.x1 <= number.end + 8 && shape.y0 <= number.y + 1 && shape.y1 >= number.y + 4)
      .filter((shape) => (shape.x1 - shape.x0 < 0.5 ? shape.paint === "stroke" : shape.x0 <= number.x + 1 && shape.x1 - shape.x0 <= 25))
      .map((shape) => shape.x1);
    return edges.length > 0 ? Math.min(...edges) : undefined;
  };
  /** The next number on the line: a box ends before its frame, which starts up to 6 points left of the number. */
  const limitOf = (number: RqNumber) =>
    Math.min(...numbers.filter((other) => other.page === number.page && other.x > number.x && Math.abs(other.y - number.y) < 4).map((other) => other.x - 8), Infinity);
  /** A check box: a small square just right of the frame. */
  const checkBoxBeside = (number: RqNumber, frame: number) =>
    fills.find((fill) => {
      const size = fill.x1 - fill.x0;
      return fill.page === number.page && size >= 7 && size <= 13 && Math.abs(fill.y1 - fill.y0 - size) < 1 && fill.x0 >= frame - 1 && fill.x0 <= frame + 12 && Math.abs((fill.y0 + fill.y1) / 2 - (number.y + 3)) <= 6;
    });

  const rows: Record<string, Point> = {};
  const lineOf = new Map<string, string>();
  const columns: Record<string, number[]> = {};
  const plain: string[] = [];
  const widths = new Map<string, number>();
  const seen = new Set<string>();
  for (const number of numbers) {
    const framed = frameOf(number);
    const frame = framed ?? number.end;
    // A numbered check box ("check box 403") holds no amount.
    if (checkBoxBeside(number, frame)) continue;
    const limit = limitOf(number);
    const cents = [
      ...new Set(
        verticals
          .filter((line) => line.page === number.page && line.x0 > frame + 6 && line.x0 < limit && crosses(line, number.y) && centsPartAt(number.page, line.x0, number.y))
          .map((line) => round(line.x0)),
      ),
    ]
      .sort((a, b) => a - b)
      .filter((x, index, all) => index === 0 || x - all[index - 1]! > 1);
    let boxes = cents;
    let isPlain = false;
    if (cents.length === 0) {
      // No cents line: a plain box from the frame to its right end, if it is one (a framed number, and digit cells only
      // in a code's narrow box). It ends at its right edge, or where its white fill or its bottom line ends; a rate's
      // box ends at its printed "%".
      if (framed === undefined) continue;
      const edge = Math.min(...verticals.filter((line) => line.page === number.page && line.x0 > frame + 6 && line.x0 < limit && spans(line, number.y)).map((line) => line.x0));
      let right = Math.min(
        edge,
        ...fills.filter((fill) => fill.page === number.page && fill.x0 >= frame - 0.5 && fill.x0 <= frame + 6 && fill.x1 < limit && fill.y0 <= number.y + 1 && fill.y1 >= number.y + 4 && fill.x1 - fill.x0 <= 200).map((fill) => fill.x1),
        ...shapes
          .filter((line) => line.page === number.page && line.paint === "stroke" && line.y1 - line.y0 < 0.5 && line.y0 >= number.y - 4.5 && line.y0 <= number.y - 1 && line.x0 >= frame - 0.5 && line.x0 <= frame + 6 && line.x1 < limit)
          .map((line) => line.x1),
      );
      const end = Number.isFinite(edge) ? edge : right;
      const cells = verticals.filter((line) => line.page === number.page && line.x0 > frame + 6 && line.x0 < end - 1 && tick(line, number.y));
      if (cells.length > 0 && end - frame > RQ_CODE_WIDTH) continue;
      const percent = items.find((item) => item.page === number.page && item.text === "%" && Math.abs(item.y - number.y) < 3 && item.x > frame + 6 && item.x < right);
      if (percent) right = percent.x;
      if (!Number.isFinite(right) || right - frame < 14 || right - frame > 200) continue;
      boxes = [round(right)];
      isPlain = true;
    }
    // The same number again on its line: another column of that line.
    const same = Object.keys(rows).find((key) => lineOf.get(key) === number.line && rows[key]![0] === number.page && Math.abs(rows[key]![2] - number.y) < 1);
    if (same) {
      const all = [...(columns[same] ?? [rows[same]![1]]), ...boxes];
      columns[same] = all;
      if (isPlain) plain.push(`${same}@${all.length}`);
      continue;
    }
    let key = seen.has(number.line) ? `p${number.page}:${number.line}` : number.line;
    for (let count = 2; key in rows; count += 1) key = `p${number.page}:${number.line}#${count}`;
    seen.add(number.line);
    lineOf.set(key, number.line);
    rows[key] = [number.page, boxes[0]!, round(number.y)];
    widths.set(key, boxes[0]! - frame);
    if (boxes.length > 1) columns[key] = boxes;
    if (isPlain) plain.push(key);
  }

  // A box that already holds a printed amount ("42,090 00"): nothing is written there.
  const printed = Object.entries(rows)
    .filter(([key, [page, x, y]]) => {
      const [from, to] = plain.includes(key) ? [x - widths.get(key)!, x] : [x - 60, x + 18];
      return items.some((item) => !numberItems.has(item) && item.page === page && Math.abs(item.y - y) < 4 && item.x + item.width > from + 1 && item.x < to - 1 && /^\$?[\d,]*\d(\.\d+)?%?$/.test(item.text));
    })
    .map(([key]) => key);

  const text: NonNullable<Measured["text"]> = {};
  const combs: NonNullable<Measured["combs"]> = {};
  const tickBoxes: NonNullable<Measured["ticks"]> = {};
  for (const [key, spec] of Object.entries(places)) {
    if ("label" in spec) {
      // An answer's tick box ("Yes", "No"), by the option's label.
      if (spec.kind !== "tick") throw new Error(`${key}: a Revenu Québec form's boxes are found by their line numbers`);
      tickBoxes[key] = tickBy(fills, spec, labelOf(items, spec, key)) ?? fail(key, `no tick box near "${spec.label}" on page ${spec.page}`);
      continue;
    }
    const number = numbers.find((each) => each.page === spec.page && each.line === spec.line) ?? fail(key, `no line ${spec.line} on page ${spec.page}`);
    const frame = frameOf(number) ?? fail(key, `line ${spec.line} has no frame`);
    if (spec.kind === "tick") {
      const square = checkBoxBeside(number, frame) ?? fail(key, `no check box beside line ${spec.line}`);
      tickBoxes[key] = [spec.page, round((square.x0 + square.x1) / 2), round((square.y0 + square.y1) / 2)];
      continue;
    }
    // A box starts 3 points right of its number's frame and ends at the next line its full height.
    const left = frame + 3;
    const right = Math.min(...verticals.filter((line) => line.page === spec.page && line.x0 > frame + 6 && spans(line, number.y)).map((line) => line.x0));
    if (!Number.isFinite(right)) fail(key, `no box beside line ${spec.line}`);
    if (spec.kind === "text") {
      text[key] = [spec.page, round(left + 2), round(number.y), round(right - left - 4)];
    } else {
      // Each tick is drawn twice (solid, then dotted over it).
      const cells = [
        ...new Set(
          verticals.filter((line) => line.page === spec.page && line.x0 > left + 1 && line.x0 < right - 1 && tick(line, number.y)).map((line) => round(line.x0)),
        ),
      ].sort((a, b) => a - b);
      if (cells.length < 2) fail(key, `no date cells beside line ${spec.line}`);
      const cell = Math.min(...cells.slice(1).map((x, index) => x - cells[index]!));
      combs[key] = [spec.page, round(cells[0]! - cell), round(number.y), round(cell)];
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

/** Revenu Québec's line numbers, top to bottom: a number with its decimal digit is one line ("377" "1" is 377.1). */
function rqNumbers(items: TextItem[]): RqNumber[] {
  const candidates = items.filter(
    (item) => item.height !== undefined && item.height >= RQ_NUMBER_HEIGHT[0]! && item.height <= RQ_NUMBER_HEIGHT[1]! && /^\d{1,3}(\.\d)?$/.test(item.text),
  );
  const digitOf = (item: TextItem) =>
    /^\d{1,3}$/.test(item.text)
      ? candidates.find(
          (other) =>
            other !== item &&
            other.page === item.page &&
            /^\d$/.test(other.text) &&
            Math.abs(other.y - item.y) < 0.6 &&
            other.x >= item.x + item.width - 0.5 &&
            other.x <= item.x + item.width + 3,
        )
      : undefined;
  const digits = new Map(candidates.flatMap((item) => (digitOf(item) ? [[item, digitOf(item)!] as const] : [])));
  const taken = new Set(digits.values());
  return candidates
    .filter((item) => !taken.has(item))
    .map((item) => {
      const digit = digits.get(item);
      return {
        page: item.page,
        x: item.x,
        end: digit ? digit.x + digit.width : item.x + item.width,
        y: item.y,
        line: digit ? `${item.text}.${digit.text}` : item.text,
        items: digit ? [item, digit] : [item],
      };
    })
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
}

function fail(key: string, message: string): never {
  throw new Error(`${key}: ${message}`);
}

/** The small square on a label's line, the nearest one to it: its centre. */
function tickBy(fills: Shape[], spec: LabelPlace, label: TextItem): Point | undefined {
  const square = fills
    .filter((fill) => {
      const size = fill.x1 - fill.x0;
      return fill.page === spec.page && size >= 7 && size <= 13 && Math.abs(fill.y1 - fill.y0 - size) < 1 && Math.abs((fill.y0 + fill.y1) / 2 - (label.y + 3)) <= 6;
    })
    .sort((a, b) => gap(a, label) - gap(b, label))[0];
  return square && [spec.page, round((square.x0 + square.x1) / 2), round((square.y0 + square.y1) / 2)];
}

function labelOf(items: TextItem[], spec: LabelPlace, key: string): TextItem {
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
