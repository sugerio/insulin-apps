import { describe, expect, it } from "vitest";
import { byDisplayId } from "../../src/app/components/DataTable.tsx";
import { compareDisplayIds } from "../../src/app/shared/order.ts";

const IDS = ["PA10-1", "CS-10", "PA2-1", "CS-2", "OPT-1", "PA2-10", "PA2-2", "CS-1"];
const NATURAL = ["CS-1", "CS-2", "CS-10", "OPT-1", "PA2-1", "PA2-2", "PA2-10", "PA10-1"];

describe("compareDisplayIds", () => {
  it("orders display ids naturally, a number inside the prefix included", () => {
    expect([...IDS].sort(compareDisplayIds)).toEqual(NATURAL);
  });

  it("is the order of the tables' ID columns", () => {
    expect([...IDS].sort(byDisplayId((id: string) => id))).toEqual(NATURAL);
  });

  it("compares digits as numbers of any length, and the id breaks a tie", () => {
    expect(["CS-100000000000000000001", "CS-99999999999999999999", "CS-01", "CS-1"].sort(compareDisplayIds)).toEqual(["CS-01", "CS-1", "CS-99999999999999999999", "CS-100000000000000000001"]);
    expect(compareDisplayIds("CS-1", "CS-1")).toBe(0);
  });
});
