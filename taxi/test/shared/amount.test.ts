import { describe, expect, it } from "vitest";
import { normalizeAmount } from "../../src/app/shared/amount.ts";

describe("an amount as typed or printed", () => {
  it("takes out $, spaces and thousands separators", () => {
    expect(normalizeAmount("$60,000.00")).toBe("60000.00");
    expect(normalizeAmount(" 1 234 ")).toBe("1234");
    expect(normalizeAmount("60,000")).toBe("60000");
  });

  it("reads a French decimal comma as the decimal mark", () => {
    // An RL slip prints 45 000,00: taking the comma out as a separator once saved $4,500,000.
    expect(normalizeAmount("45 000,00")).toBe("45000.00");
    expect(normalizeAmount("45 000,5")).toBe("45000.5");
    expect(normalizeAmount("1234,56")).toBe("1234.56");
  });

  it("leaves a mix of both marks for the checks to refuse, rather than guessing", () => {
    expect(normalizeAmount("1.234,56")).toBe("1.23456");
  });
});
