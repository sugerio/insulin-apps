import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { usd } from "./fixtures/builder.ts";
import { exercise, grant, issueStock, miniOrg, terminate } from "./fixtures/mini.ts";

const D = "2026-06-30";

describe("Form 3921 data", () => {
  it("lists one record per ISO portion within the ISO deadline, flags non-US holders and never lists NSO portions", () => {
    const m = miniOrg();
    m.b.reference.stakeholders.find((s) => s.id === m.carol)!.taxStatus = "non_us";
    const iso = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, price: "0.3" });
    const abroad = grant(m, "OPT-2", m.carol, "100", "2025-01-01", { vesting: null, price: "1" });
    const nso = grant(m, "OPT-3", m.bob, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    exercise(m, "CS-1", iso, m.alice, "10", "2026-02-01", { portion: "ISO" });
    exercise(m, "CS-2", abroad, m.carol, "10", "2026-03-01", { portion: "ISO" });
    exercise(m, "CS-3", nso, m.bob, "10", "2026-03-01", { portion: "NSO" });
    exercise(m, "CS-4", iso, m.alice, "10", "2025-12-31", { portion: "ISO" });
    const state = m.b.replay(D);
    const records = e.form3921Records(state, 2026);
    expect(records.map((r) => [r.optionSecurityId, r.exerciseDate, r.exercisePricePerShare?.toString(), r.fmvPerShare?.toString(), r.shares.toString(), r.nonUsHolder])).toEqual([
      [iso, "2026-02-01", "0.3", "2", "10", false],
      [abroad, "2026-03-01", "1", "2", "10", true],
    ]);
    expect(e.form3921Records(state, 2025)).toHaveLength(1);
  });

  it("leaves out ISO shares exercised after the ISO deadline and prints non-terminating prices to 12 digits", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    terminate(m, "alice", m.alice, "2026-01-01");
    m.b.command("extend", (c) => {
      c.tx("X_SECURITY_MODIFICATION", "2026-01-02", { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: option, new_contractual_deadline: "2026-12-31" });
    });
    exercise(m, "CS-1", option, m.alice, "10", "2026-05-01", { portion: "ISO", source: "import" });
    let state = m.b.replay(D);
    expect(state.violations.map((v) => [v.code, v.severity])).toEqual([["ISO_PORTION_AFTER_ISO_DEADLINE", "warning"]]);
    expect(e.form3921Records(state, 2026)).toEqual([]);
    const n = miniOrg();
    const split = grant(n, "OPT-1", n.alice, "300", "2025-01-01", { vesting: null, price: "1" });
    n.b.command("split", (c) => {
      c.tx("TX_STOCK_CLASS_SPLIT", "2025-06-01", { stock_class_id: n.common, split_ratio: { numerator: "3", denominator: "1" } });
    });
    exercise(n, "CS-1", split, n.alice, "30", "2026-01-15", { portion: "ISO" });
    state = n.b.replay(D);
    const [record] = e.form3921Records(state, 2026);
    expect(record?.exercisePricePerShare?.toString()).toBe("0.333333333333");
  });
});

describe("Rule 701 data", () => {
  it("counts options at grant, excluding non-US grants, transfers and retracted grants", () => {
    const m = miniOrg({ pool: "1000000" });
    grant(m, "OPT-1", m.alice, "1000", "2025-07-01", { price: "0.5" });
    grant(m, "OPT-2", m.alice, "1000", "2025-07-01", { price: "0.5", exemption: { federal: "NON_US", country: "CA" } });
    grant(m, "OPT-3", m.alice, "1000", "2025-07-01", { price: "0.5", exemption: { federal: "REG_S" } });
    grant(m, "OPT-4", m.alice, "1000", "2025-06-30", { price: "0.5" }); // a day before the window
    const retracted = grant(m, "OPT-5", m.alice, "1000", "2025-07-01", { price: "0.5" });
    m.b.command("retract", (c) => {
      c.tx("TX_EQUITY_COMPENSATION_RETRACTION", "2025-07-02", { security_id: retracted, reason_text: "Never granted" });
    });
    grant(m, "RSU-1", m.alice, "100", "2025-08-01", { type: "RSU", fmv: "2" });
    issueStock(m, "RSA-1", m.alice, "50", "2025-09-01", { planId: m.plan, origin: "RSA", price: "0.25" });
    issueStock(m, "CS-1", m.bob, "50", "2025-09-01");
    const state = m.b.replay(D);
    const window = e.rule701Window(state, D);
    expect(window.start).toBe("2025-07-01");
    expect(window.sales.map((s) => [s.quantity.toString(), s.pricePerShare.toString(), s.value.toString()])).toEqual([
      ["1000", "0.5", "500"],
      ["100", "2", "200"],
      ["50", "0.25", "12.5"],
    ]);
    expect([window.totalShares.toString(), window.totalValue.toString()]).toEqual(["1150", "712.5"]);
  });

  it("applies the greatest-of test with zero-safe limits", () => {
    const window = { start: "2025-07-01", end: D, sales: [], totalValue: e.Dec.from(12_000_000), totalShares: e.Dec.from(10) };
    const result = e.rule701Test(window, { totalAssets: e.Dec.ZERO, classOutstanding: e.Dec.ZERO });
    expect(result).toMatchObject({ ok: false, governing: null, enhancedDisclosure: true });
    expect(result.limits[1]!.used.toString()).toBe("1000000");
    const nothing = e.rule701Test({ ...window, totalValue: e.Dec.ZERO, totalShares: e.Dec.ZERO }, { totalAssets: e.Dec.ZERO, classOutstanding: e.Dec.ZERO });
    expect(nothing).toMatchObject({ ok: true, governing: "TOTAL_ASSETS_15" });
    expect(nothing.limits[0]!.used.toString()).toBe("0");
    const fixed = e.rule701Test({ ...window, totalValue: e.Dec.from(999_999), totalShares: e.Dec.from(10_000) }, { totalAssets: e.Dec.from(1), classOutstanding: e.Dec.from(1) });
    expect(fixed.governing).toBe("FIXED_1M");
    const byClass = e.rule701Test({ ...window, totalValue: e.Dec.from(2_000_000), totalShares: e.Dec.from(100) }, { totalAssets: e.Dec.from(1), classOutstanding: e.Dec.from(1000) });
    expect(byClass.governing).toBe("CLASS_OUTSTANDING_15");
  });

  it("counts a class's outstanding shares at the balance-sheet date", () => {
    const m = miniOrg();
    issueStock(m, "CS-1", m.bob, "100", "2025-01-01");
    const lot = issueStock(m, "CS-2", m.bob, "100", "2025-01-01");
    m.b.command("retract", (c) => {
      c.tx("TX_STOCK_RETRACTION", "2025-02-01", { security_id: lot, reason_text: "x" });
    });
    issueStock(m, "PS-1", m.bob, "7", "2025-01-01", { classId: m.preferred });
    expect(e.classOutstanding(m.b.replay(D), m.common).toString()).toBe("100");
    expect(e.classOutstanding(m.b.replay("2025-01-15"), m.common).toString()).toBe("200");
    expect(usd("1").currency).toBe("USD");
  });
});
