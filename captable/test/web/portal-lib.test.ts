import "./setup.ts";
import { describe, expect, it } from "vitest";
import {
  awaitingHolderSignature, discountLabel, exerciseCost, exerciseQuantity, exitWindows, formatComputedMoney, formatRecordedMoney, initials,
  isoDeadlineState, maxWholeOptions, paymentReference, summarize, upcomingVests, vestedUnexercised,
} from "../../src/app/lib/portal.ts";
import { TODAY, uuid } from "./support/acme.ts";
import { DANIEL, DANIEL_OPTION, MARCUS, NADIA_OPTION, portalSecurity } from "./support/portal.ts";

// The portal's derived figures: sums, differences and products of the holder's own numbers, with the engine's exact
// decimals, and money rounded only at the display edge, HALF_EVEN to the cent.

describe("portal figures", () => {
  it("summarizes shares by class, options and converted SAFEs", () => {
    const summary = summarize(MARCUS.securities);
    expect(summary.sharesByClass).toEqual([expect.objectContaining({ className: "Series Seed Preferred", quantity: "91145" })]);
    expect(summary.options).toBeNull();
    expect(summary.safes.map((safe) => safe.displayId)).toEqual(["SAFE-3", "SAFE-5"]);
    const options = summarize(DANIEL.securities).options!;
    expect(options).toMatchObject({ outstanding: "250000", vestedUnexercised: "218750", unvested: "31250", cancelled: "0" });
  });

  it("adds fractional quantities exactly", () => {
    const a = portalSecurity({ id: uuid(6, 501), displayId: "CS-501", numbers: { asOf: TODAY, granted: "0.000000000001", outstanding: "0.000000000001", vested: null, unvested: null, exercised: null, exercisable: null, cancelled: null } });
    const b = portalSecurity({ id: uuid(6, 502), displayId: "CS-502", numbers: { ...a.numbers, outstanding: "999999999999.999999999999" } });
    expect(summarize([a, b]).sharesByClass[0]!.quantity).toBe("1000000000000");
  });

  it("never reports less than nothing vested and unexercised", () => {
    const odd = portalSecurity({ ...DANIEL_OPTION, numbers: { ...DANIEL_OPTION.numbers, outstanding: "10", unvested: "20" } });
    expect(vestedUnexercised(odd)).toBe("0");
  });
});

describe("exit windows", () => {
  it("finds a former holder's open exit window with its deadlines", () => {
    expect(exitWindows([NADIA_OPTION], TODAY)).toEqual([
      { deadline: "2027-02-28", iso: { kind: "upcoming", date: "2026-11-30" }, awaitingSignature: false, quantity: "60000", grants: [NADIA_OPTION] },
    ]);
    expect(exitWindows([NADIA_OPTION], "2027-03-01")).toEqual([]);
    expect(exitWindows([DANIEL_OPTION], TODAY)).toEqual([]);
    const nothingLeft = portalSecurity({ ...NADIA_OPTION, numbers: { ...NADIA_OPTION.numbers, exercisable: "0" } });
    expect(exitWindows([nothingLeft], TODAY)).toEqual([]);
  });

  it("keeps grants with different deadlines apart, so no quantity carries another grant's date", () => {
    const early = portalSecurity({ ...NADIA_OPTION, id: uuid(6, 125), displayId: "OPT-25", optionType: "NSO", contractualDeadline: "2027-01-08", isoDeadline: null, numbers: { ...NADIA_OPTION.numbers, exercisable: "10000" } });
    const sameDates = portalSecurity({ ...NADIA_OPTION, id: uuid(6, 126), displayId: "OPT-26", numbers: { ...NADIA_OPTION.numbers, exercisable: "5000" } });
    const windows = exitWindows([NADIA_OPTION, early, sameDates], TODAY);
    expect(windows.map((window) => [window.deadline, window.iso, window.quantity, window.grants.map((grant) => grant.displayId)])).toEqual([
      ["2027-01-08", { kind: "none" }, "10000", ["OPT-25"]],
      // Only grants sharing both dates are added up.
      ["2027-02-28", { kind: "upcoming", date: "2026-11-30" }, "65000", ["OPT-20", "OPT-26"]],
    ]);
  });

  it("keeps the deadline of a grant awaiting the holder's signature in view, on its own, never as exercisable", () => {
    const blocked = (executionPending: "pending_holder" | "pending_both", id: number, displayId: string) => portalSecurity({
      ...NADIA_OPTION, id: uuid(6, id), displayId, executionPending, numbers: { ...NADIA_OPTION.numbers, exercisable: "0" },
    });
    const holder = blocked("pending_holder", 140, "OPT-40");
    const both = blocked("pending_both", 141, "OPT-41");
    expect(exitWindows([NADIA_OPTION, holder, both], TODAY)).toEqual([
      { deadline: "2027-02-28", iso: { kind: "upcoming", date: "2026-11-30" }, awaitingSignature: false, quantity: "60000", grants: [NADIA_OPTION] },
      { deadline: "2027-02-28", iso: { kind: "upcoming", date: "2026-11-30" }, awaitingSignature: true, quantity: "60000", grants: [holder] },
      { deadline: "2027-02-28", iso: { kind: "upcoming", date: "2026-11-30" }, awaitingSignature: true, quantity: "60000", grants: [both] },
    ]);
    // Awaiting only the company's countersignature: exercisable as any other grant.
    const company = portalSecurity({ ...NADIA_OPTION, executionPending: "pending_company" });
    expect(exitWindows([company], TODAY)).toEqual([expect.objectContaining({ awaitingSignature: false, quantity: "60000", grants: [company] })]);
    expect([holder, both, company, NADIA_OPTION].map(awaitingHolderSignature)).toEqual([true, true, false, false]);
    // Nothing vested left to sign for, or a deadline already passed: no statement.
    expect(exitWindows([{ ...holder, numbers: { ...holder.numbers, outstanding: "0", vested: "0" } }], TODAY)).toEqual([]);
    expect(exitWindows([holder], "2027-03-01")).toEqual([]);
  });

  it("keeps a passed ISO deadline, which makes every later exercise an NSO, until the contractual deadline", () => {
    expect(isoDeadlineState(NADIA_OPTION, "2026-12-15")).toEqual({ kind: "passed", date: "2026-11-30" });
    expect(exitWindows([NADIA_OPTION], "2026-12-15")).toEqual([
      { deadline: "2027-02-28", iso: { kind: "passed", date: "2026-11-30" }, awaitingSignature: false, quantity: "60000", grants: [NADIA_OPTION] },
    ]);
    // An ISO deadline capped at the contractual deadline changes nothing before it.
    expect(isoDeadlineState({ isoDeadline: "2027-02-28", contractualDeadline: "2027-02-28" }, TODAY)).toEqual({ kind: "none" });
    expect(isoDeadlineState({ isoDeadline: null, contractualDeadline: "2027-02-28" }, TODAY)).toEqual({ kind: "none" });
  });
});

describe("upcoming vests and references", () => {
  it("lists upcoming vests in date order, six at most", () => {
    const vests = upcomingVests(DANIEL.securities);
    expect(vests).toHaveLength(5);
    expect(vests.map((vest) => vest.date)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"]);
    expect(vests[0]).toMatchObject({ quantity: "6250", unit: "options" });
    expect(upcomingVests([NADIA_OPTION])).toEqual([]);
  });

  it("fills in the payment reference from the company's format", () => {
    expect(initials("Nadia Pereira-Stone")).toBe("NPS");
    expect(initials("Northgate Ventures Fund II, L.P.")).toBe("NVFIL");
    expect(paymentReference("EX-<grant>-<initials>", "OPT-20", "Nadia Pereira-Stone")).toBe("EX-OPT-20-NPS");
    expect(paymentReference("EX-<grant>-<holder initials>", "OPT-1", "Daniel Achterberg")).toBe("EX-OPT-1-DA");
    // Without a grant the placeholder stays for the holder to fill in; other placeholders are left alone.
    expect(paymentReference("EX-<grant>-<initials>-<date>", null, "Daniel Achterberg")).toBe("EX-<grant>-DA-<date>");
  });
});

describe("money", () => {
  it("multiplies the exercise cost exactly, with the engine's variable-scale decimals", () => {
    expect(exerciseCost("60000", "0.31").toString()).toBe("18600");
    expect(exerciseCost("833", "0.185").toString()).toBe("154.105");
    // Two operands at the 12-digit maximum: the product keeps all 24 digits (a fixed 12-digit scale would lose them).
    expect(exerciseCost("0.000000000001", "0.000000000001").toString()).toBe("0.000000000000000000000001");
    expect(exerciseCost("999999999999.999999999999", "999999999999.999999999999").toString()).toBe("999999999999999999999998.000000000000000000000001");
    expect(exerciseCost("0.5", "0.010000000001").toString()).toBe("0.0050000000005");
  });

  it("takes a number of options to exercise only as whole options, from one up to what is exercisable", () => {
    expect(maxWholeOptions("60000")).toBe("60000");
    expect(maxWholeOptions("833.75")).toBe("833");
    expect(maxWholeOptions(null)).toBe("0");
    expect(exerciseQuantity("1500", "60000")).toEqual({ quantity: "1500" });
    expect(exerciseQuantity(" 60,000 ", "60000")).toEqual({ quantity: "60000" });
    expect(exerciseQuantity("007", "60000")).toEqual({ quantity: "7" });
    expect(exerciseQuantity("833", "833.75")).toEqual({ quantity: "833" });
    expect(exerciseQuantity("834", "833.75")).toEqual({ problem: "too_many" });
    expect(exerciseQuantity("60001", "60000")).toEqual({ problem: "too_many" });
    expect(exerciseQuantity("99999999999999999999999999999", "60000")).toEqual({ problem: "too_many" });
    expect(exerciseQuantity("0", "60000")).toEqual({ problem: "none" });
    for (const input of ["", "12.5", "-3", "1e3", "ten"]) expect(exerciseQuantity(input, "60000"), input).toEqual({ problem: "not_whole" });
  });

  it("shows computed money HALF_EVEN to the cent and says when it rounded", () => {
    expect(formatComputedMoney(exerciseCost("60000", "0.31"))).toEqual({ text: "$18,600.00", rounded: false });
    // Half a cent goes to the even cent: 154.105 → 154.10, 162.435 → 162.44, 0.135 → 0.14, 0.125 → 0.12.
    expect(formatComputedMoney(exerciseCost("833", "0.185"))).toEqual({ text: "$154.10", rounded: true });
    expect(formatComputedMoney(exerciseCost("833", "0.195"))).toEqual({ text: "$162.44", rounded: true });
    expect(formatComputedMoney(exerciseCost("1", "0.135"))).toEqual({ text: "$0.14", rounded: true });
    expect(formatComputedMoney(exerciseCost("1", "0.125"))).toEqual({ text: "$0.12", rounded: true });
    // Just above half a cent at the 13th digit: rounds up. Truncating to 12 digits first would make it a tie, rounded down.
    expect(formatComputedMoney(exerciseCost("0.5", "0.010000000001"))).toEqual({ text: "$0.01", rounded: true });
    expect(formatComputedMoney(exerciseCost("0.000000000001", "0.000000000001"))).toEqual({ text: "$0.00", rounded: true });
  });

  it("shows recorded money and a SAFE's discount exactly", () => {
    expect(formatRecordedMoney("100000")).toBe("$100,000");
    expect(formatRecordedMoney("100000.5")).toBe("$100,000.50");
    expect(formatRecordedMoney("0.000001")).toBe("$0.000001");
    expect(discountLabel("0.2")).toBe("20%");
    expect(discountLabel("0.125")).toBe("12.5%");
  });
});
