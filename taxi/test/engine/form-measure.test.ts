import { describe, expect, it } from "vitest";
import { measureForm, measureRqForm, type Shape, type TextItem } from "../../scripts/form-measure.ts";

// The layout script's measuring (scripts/form-measure.ts), on small made-up pages drawn the way the CRA's print forms
// draw their boxes. The real forms are measured by npm run form-layout; these pin each kind of box it has to find.

const text = (x: number, y: number, value: string, width = 5.6 * value.length, page = 1): TextItem => ({ page, x, y, width, text: value });
const fill = (x0: number, y0: number, x1: number, y1: number, page = 1): Shape => ({ page, paint: "fill", x0, y0, x1, y1 });
const stroke = (x0: number, y0: number, x1: number, y1: number, page = 1): Shape => ({ page, paint: "stroke", x0, y0, x1, y1 });
/** An amount box as most CRA forms draw it: a white box with its cents line, 18 points from its right end. */
const box = (right: number, bottom: number, height = 12, page = 1): Shape[] => [
  fill(right - 81, bottom, right, bottom + height, page),
  stroke(right - 18, bottom, right - 18, bottom + height, page),
];

describe("measuring a form's boxes", () => {
  it("finds a row's cents line from the drawing, wherever its number is set", () => {
    const measured = measureForm(
      [text(576, 668.3, "1"), text(573, 640.3, "10", 11.1), text(570, 610.3, "11", 11.1)],
      [...box(570, 666), ...box(570, 638), ...box(564, 608)],
    );
    // Left-aligned at 576, centred at 573, and a form whose boxes end at 564.
    expect(measured.rows).toEqual({ "1": [1, 552, 668.3], "10": [1, 552, 640.3], "11": [1, 546, 610.3] });
  });

  it("takes an outlined total's cents line, not the outline's edge, and a T2125 underline's tick", () => {
    const measured = measureForm(
      [text(576, 500.3, "42", 11.1), text(580.1, 639.8, "3A", 9.8)],
      [stroke(489, 498, 570, 522), stroke(552, 498, 552, 522), stroke(570, 498, 570, 522), stroke(507, 636, 579, 636), stroke(567, 636, 567, 642)],
    );
    expect(measured.rows).toEqual({ "42": [1, 552, 500.3], "3A": [1, 567, 639.8] });
  });

  it("ignores a number beside a box of digits (a SIN's cells), which has no cents line", () => {
    const cells = [330, 345, 360, 375, 390, 405, 420, 435].map((x) => stroke(x, 580, x, 592));
    expect(measureForm([text(462, 582, "2")], [fill(315, 580, 450, 591), ...cells]).rows).toEqual({});
  });

  it("keys a box by the line code left of it, unless the code is a numbered row's own", () => {
    const measured = measureForm(
      [text(356.1, 641.3, "10120", 22.8), text(464.1, 668.3, "10100", 22.8), text(576, 668.3, "1")],
      [fill(354, 639, 381, 651), stroke(354, 639, 354, 651), stroke(381, 639, 381, 651), ...box(462, 639), fill(462, 666, 489, 678), ...box(570, 666)],
    );
    expect(measured.rows).toEqual({ "1": [1, 552, 668.3], "10120": [1, 444, 641.3] });
  });

  it("lists boxes with no cents line as plain: a narrow box for a count, and an underline", () => {
    const measured = measureForm(
      [text(356.1, 221.3, "58229", 22.8), text(422.4, 222.2, "$100", 22.2), text(289.6, 716.8, "8521", 17.8)],
      [fill(354, 219, 381, 231), fill(381, 219, 405, 231), stroke(312, 714.3, 385, 714.3), stroke(410, 714.3, 480, 714.3)],
    );
    expect(measured.rows).toEqual({ "58229": [1, 405, 221.3], "8521": [1, 385, 716.6] });
    expect(measured.plain).toEqual(["58229", "8521"]);
    // The table's other columns on the code's line.
    expect(measured.columns).toEqual({ "8521": [385, 480] });
    expect(measured.printed).toBeUndefined();
  });

  it("lists the other boxes on a row's line: a second column, and a plain box for a count", () => {
    const measured = measureForm(
      [text(576, 482.3, "1"), text(576, 320.3, "2"), text(401.5, 320.7, "×", 7), text(415.2, 321.7, "$8,000", 30.6)],
      [...box(462, 480, 24), ...box(570, 480, 24), stroke(360, 318, 393, 318), stroke(399, 318, 450, 318), ...box(570, 318, 24)],
    );
    expect(measured.columns).toEqual({ "1": [444, 552], "2": [393, 552] });
    // The underline under the printed "× $8,000" isn't a box.
    expect(measured.plain).toEqual(["2@1"]);
  });

  it("marks a box that holds a printed amount, and keys a number printed again by its page, then its order there", () => {
    const measured = measureForm(
      [text(576, 700.3, "1"), text(510, 700.3, "294.00", 30), text(576, 200.3, "1", 5.6, 2), text(576, 400.3, "1", 5.6, 2)],
      [...box(570, 698), ...box(570, 398, 12, 2), ...box(570, 198, 12, 2)],
    );
    expect(measured.rows).toEqual({ "1": [1, 552, 700.3], "p2:1": [2, 552, 400.3], "p2:1.2": [2, 552, 200.3] });
    expect(measured.printed).toEqual(["1"]);
  });

  it("finds Step 1's places by their labels", () => {
    const measured = measureForm(
      [
        text(30, 603.7, "First name", 47.2),
        text(356.5, 557.4, "Date of birth", 54.5),
        text(492, 598.3, "Married", 33.9),
        text(30, 166.1, "Net income from line 23600 of their return", 200),
        text(516, 339.6, "Yes", 17.2),
        text(516, 239.6, "Yes", 17.2),
        text(30, 380, "Foreign property", 80),
      ],
      [
        fill(30, 588.7, 162, 600),
        fill(333.7, 529.4, 428.2, 541.6),
        ...[345, 357, 369, 381, 393, 405, 417].map((x) => stroke(x, 528.7, x, 534.7)),
        fill(474, 595.9, 484, 605.9),
        fill(503, 337.5, 513, 347.5),
        fill(503, 237.5, 513, 247.5),
        ...box(570, 151.4, 24),
      ],
      {
        firstName: { kind: "text", page: 1, label: "First name" },
        birthDate: { kind: "comb", page: 1, label: "Date of birth" },
        married: { kind: "tick", page: 1, label: "Married" },
        spouseNetIncome: { kind: "amount", page: 1, label: "Net income from line 23600" },
        foreignPropertyYes: { kind: "tick", page: 1, label: "Yes", below: "Foreign property" },
      },
    );
    expect(measured.text).toEqual({ firstName: [1, 32, 591.2, 128] });
    expect(measured.combs).toEqual({ birthDate: [1, 333, 531.7, 12] });
    expect(measured.ticks).toEqual({ married: [1, 479, 600.9], foreignPropertyYes: [1, 508, 342.5] });
    expect(measured.rows.spouseNetIncome).toEqual([1, 552, 153.7]);
  });

  it("refuses a label that isn't on the page, or is there twice with nothing to tell them apart", () => {
    expect(() => measureForm([], [], { x: { kind: "text", page: 1, label: "First name" } })).toThrow(/no "First name"/);
    expect(() => measureForm([text(516, 339.6, "Yes"), text(516, 239.6, "Yes")], [], { x: { kind: "tick", page: 1, label: "Yes" } })).toThrow(/2 times/);
  });
});

// Revenu Québec's forms, drawn as the TP-1 and its schedules draw them: a line number 7.5 points high in a 15-point frame
// just left of its box, the box 3 points after the frame, its cents line (a full-height line) 18 points before its end,
// and its bottom line 3 points below the number's baseline.
const number = (x: number, y: number, value: string, page = 1, height = 7.5): TextItem => ({ page, x, y, width: 3.7 * value.length, text: value, height });
/** A numbered amount box: the number's frame, then the box from `left` to `right`. */
const rqBox = (frame: number, left: number, right: number, y: number, page = 1): Shape[] => [
  stroke(frame, y - 3, frame, y + 9, page),
  stroke(frame + 15, y - 3, frame + 15, y + 9, page),
  ...rqAmount(left, right, y, page),
];
/** An amount box with no number of its own (a second column). */
const rqAmount = (left: number, right: number, y: number, page = 1): Shape[] => [
  fill(left, y - 3, right, y + 9, page),
  stroke(left, y - 3, left, y + 9, page),
  stroke(right - 18, y - 3, right - 18, y + 9, page),
  stroke(left, y - 3, right - 18, y - 3, page),
  stroke(right - 18, y - 3, right, y - 3, page),
];

describe("measuring Revenu Québec's boxes", () => {
  it("finds a row's cents line right of its number, in whatever column its box is", () => {
    const measured = measureRqForm(
      [number(473, 441.5, "101"), number(359, 706.7, "201"), number(32, 281.1, "166"), number(165.9, 281.1, "167")],
      [...rqBox(471, 489, 573, 441.5), ...rqBox(357, 375, 459, 706.7), ...rqBox(30.3, 47.6, 131.6, 281.1), ...rqBox(164.2, 181.5, 265.5, 281.1)],
    );
    expect(measured.rows).toEqual({ "101": [1, 555, 441.5], "166": [1, 113.6, 281.1], "167": [1, 247.5, 281.1], "201": [1, 441, 706.7] });
  });

  it("reads a decimal line from its number and the smaller digit after it, or from one item", () => {
    const measured = measureRqForm(
      [number(471.3, 613.5, "377", 1, 7), number(482.3, 613.5, "1", 1, 7), number(473, 286.1, "40.6")],
      [...rqBox(471, 489, 573, 613.5), ...rqBox(471, 489, 573, 286.1)],
    );
    expect(measured.rows).toEqual({ "377.1": [1, 555, 613.5], "40.6": [1, 555, 286.1] });
  });

  it("takes the boxes after a row's own as its columns, and keys a number printed again by its page, then its order", () => {
    const measured = measureRqForm(
      [
        // A work chart's row: your column, then your spouse's.
        number(390, 247.5, "1"),
        // Schedule P: line 64 in column 1 and column 2, then again in section 2.
        number(359, 616.6, "64", 2),
        number(473, 616.6, "64", 2),
        number(359, 339.5, "64", 2),
        // Line 199 at the foot of page 2, carried to the top of page 3.
        number(473, 109.3, "199", 2),
        number(473, 718.8, "199", 3),
      ],
      [
        ...rqBox(384, 402, 486, 247.5),
        ...rqAmount(489, 573, 247.5),
        ...rqBox(357, 375, 459, 616.6, 2),
        ...rqBox(471, 489, 573, 616.6, 2),
        ...rqBox(357, 375, 459, 339.5, 2),
        ...rqBox(471, 489, 573, 109.3, 2),
        ...rqBox(471, 489, 573, 718.8, 3),
      ],
    );
    expect(measured.rows).toEqual({ "1": [1, 468, 247.5], "64": [2, 441, 616.6], "p2:64": [2, 441, 339.5], "199": [2, 555, 109.3], "p3:199": [3, 555, 718.8] });
    expect(measured.columns).toEqual({ "1": [468, 555], "64": [441, 555] });
  });

  it("skips a numbered check box and a box of digit cells, lists a code's box as plain, and marks a printed amount", () => {
    const sin = [59.4, 71.7, 83.3, 95.3, 107.3, 119.3, 131.3, 143.3].map((x) => stroke(x, 433.1, x, 437.1));
    const measured = measureRqForm(
      [number(431.9, 290, "403"), number(31, 435.9, "21.1"), number(419.9, 573.4, "449"), number(473, 561.2, "16"), text(526, 561.2, "42,090", 24), text(558, 561.2, "00", 9)],
      [
        // Check box 403: a square right of the frame.
        fill(430.2, 287.1, 444.7, 298.6),
        fill(447.3, 287.1, 458.8, 298.6),
        // A SIN's cells.
        stroke(30.2, 433, 44.7, 444.5),
        stroke(47.9, 433.1, 47.9, 444.6),
        stroke(155.4, 433.1, 155.4, 444.6),
        ...sin,
        // Box 449: two digit cells.
        fill(418.2, 570.5, 432.7, 582),
        fill(435, 570.3, 459, 582.3),
        stroke(447, 570.5, 447, 574.5),
        stroke(458.8, 570.5, 458.8, 582),
        ...rqBox(471, 489, 573, 561.2),
      ],
    );
    expect(measured.rows).toEqual({ "16": [1, 555, 561.2], "449": [1, 458.8, 573.4] });
    expect(measured.plain).toEqual(["449"]);
    expect(measured.printed).toEqual(["16"]);
  });

  it("finds Step 1's boxes by their line numbers, and an answer's tick box by its label", () => {
    const cells = [198.3, 210.3, 222.3, 234.3, 246.3, 258.3, 270.3].map((x) => stroke(x, 546.6, x, 550.6));
    const measured = measureRqForm(
      [number(35.9, 574.9, "1"), number(315.9, 574.9, "2"), number(173.9, 549.3, "6"), number(547.5, 661.8, "50"), text(30, 409.9, "Situation", 37), text(511.2, 397.9, "Yes", 12)],
      [
        stroke(30.3, 571.7, 30.3, 583.7),
        stroke(45.3, 571.7, 45.3, 583.7),
        fill(48.3, 571.7, 572.8, 583.7),
        stroke(298.3, 571.7, 298.3, 583.5),
        stroke(310.3, 571.7, 310.3, 583.7),
        stroke(325.3, 571.7, 325.3, 583.7),
        stroke(328.3, 571.7, 328.3, 583.5),
        stroke(572.8, 571.7, 572.8, 583.5),
        stroke(168.3, 546.1, 168.3, 558.1),
        stroke(183.3, 546.1, 183.3, 558.1),
        stroke(186.3, 546.1, 186.3, 557.8),
        stroke(282.3, 546.1, 282.3, 557.8),
        ...cells,
        stroke(543.7, 658.6, 558.7, 670.6),
        fill(561.3, 659.1, 572.8, 670.6),
        fill(495.4, 397.6, 506.9, 409.1),
      ],
      {
        lastName: { kind: "text", page: 1, line: "1" },
        firstName: { kind: "text", page: 1, line: "2" },
        birthDate: { kind: "comb", page: 1, line: "6" },
        spouseSelfEmployed: { kind: "tick", page: 1, line: "50" },
        spouseYes: { kind: "tick", page: 1, label: "Yes", below: "Situation" },
      },
    );
    expect(measured.text).toEqual({ lastName: [1, 50.3, 574.9, 246], firstName: [1, 330.3, 574.9, 240.5] });
    expect(measured.combs).toEqual({ birthDate: [1, 186.3, 549.3, 12] });
    expect(measured.ticks).toEqual({ spouseSelfEmployed: [1, 567.1, 664.9], spouseYes: [1, 501.2, 403.4] });
    // Step 1's numbers have no amount box.
    expect(measured.rows).toEqual({});
    expect(() => measureRqForm([], [], { x: { kind: "text", page: 1, line: "1" } })).toThrow(/no line 1 on page 1/);
  });
});
