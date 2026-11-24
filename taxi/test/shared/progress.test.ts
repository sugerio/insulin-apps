import { describe, expect, it } from "vitest";
import { possibleDuplicates } from "../../src/app/shared/progress.ts";
import { rulesFor } from "../../src/app/shared/rules/index.ts";

const slip = (id: string, type: string, issuer: string, boxes: Record<string, string>, personId = "alex") => ({ id, personId, type, issuer, boxes });

describe("possible duplicates", () => {
  it("flags one person's slips of one type and issuer with no box holding different amounts, receipts aside", () => {
    const flagged = possibleDuplicates(rulesFor("ca", 2025)!, [
      slip("a", "T4", "Maple Corp", { 14: "60000" }),
      // The same issuer, whatever its case and spaces, and box 14's amount written another way.
      slip("b", "T4", " maple corp", { 14: "60000.00", 22: "9000" }),
      // Box 14 differs from both above.
      slip("c", "T4", "Maple Corp", { 14: "61000" }),
      slip("d", "T4", "Maple Corp", { 22: "9000" }, "sam"),
      slip("e", "T4", "Harbour Cafe", { 14: "60000" }),
      // Two receipts can hold the same amount from the same place.
      slip("f", "MEDICAL", "Lakeview Pharmacy", { 1: "25" }),
      slip("g", "MEDICAL", "Lakeview Pharmacy", { 1: "25" }),
      // One with no amount read shares no box with any other: it may be any of them.
      slip("h", "T5", "Lakeview Credit Union", {}),
      slip("i", "T5", "Lakeview Credit Union", { 13: "1200" }),
    ]);
    expect(Object.fromEntries([...flagged].map(([id, other]) => [id, other.id]))).toEqual({ b: "a", i: "h" });
  });
});
