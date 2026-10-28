import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { usd, uuid } from "./fixtures/builder.ts";
import { SAMPLE_PAYLOADS } from "./fixtures/payloads.ts";
import { addStock, cancel, codes, exercise, grant, issueStock, miniOrg, terminate } from "./fixtures/mini.ts";

const D = "2026-06-30";

/** Every type whose payload names the lot it acts on (not an issuance). */
const SECURITY_TYPES = e.TRANSACTION_TYPE_CODES.filter((type) => {
  const payload = SAMPLE_PAYLOADS[type] as { security_id?: unknown };
  return typeof payload.security_id === "string" && !type.endsWith("_ISSUANCE") && type !== "X_MIGRATION_OPENING_BALANCE" && type !== "TX_STOCK_PLAN_RETURN_TO_POOL";
});

describe("every lot-level transaction", () => {
  it("is refused on an unknown lot, and on a closed one", () => {
    const m = miniOrg();
    const ghost = uuid("ghost");
    const closed = grant(m, "OPT-1", m.alice, "10", "2025-01-01", { vesting: null });
    cancel(m, "close", closed, "10", "2025-02-01");
    const closedStock = issueStock(m, "CS-1", m.bob, "10", "2025-01-01");
    m.b.command("close-stock", (c) => {
      c.tx("TX_STOCK_CANCELLATION", "2025-02-01", { security_id: closedStock, quantity: "10", reason_text: "Error" });
    });
    let warrant = "";
    let safe = "";
    m.b.command("closed-others", (c) => {
      warrant = c.security("WAR-1", { family: "WARRANT", subtype: "WARRANT", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_WARRANT_ISSUANCE", "2025-01-01", { security_id: warrant, custom_id: "WAR-1", stakeholder_id: m.bob, quantity: "10", purchase_price: usd("0") });
      c.tx("TX_WARRANT_CANCELLATION", "2025-02-01", { security_id: warrant, quantity: "10", reason_text: "x", x_reason: "OTHER" });
      safe = c.security("SAFE-1", { family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: m.bob, stockClassId: null, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_CONVERTIBLE_ISSUANCE", "2025-01-01", { security_id: safe, custom_id: "SAFE-1", stakeholder_id: m.bob, investment_amount: usd("10"), convertible_type: "SAFE" });
      c.tx("TX_CONVERTIBLE_CANCELLATION", "2025-02-01", { security_id: safe, amount: usd("10"), reason_text: "Repaid" });
    });
    const closedFor = (type: e.TransactionTypeCode) => {
      const family = e.securityFamilyOf(type);
      return family === "STOCK" ? closedStock : family === "WARRANT" ? warrant : family === "CONVERTIBLE" ? safe : closed;
    };
    const base = codes(m.b.replay(D)).length;
    for (const type of SECURITY_TYPES) {
      m.b.command(`ghost:${type}`, (c) => {
        c.tx(type, "2025-06-01", { ...SAMPLE_PAYLOADS[type], security_id: ghost });
      });
      m.b.command(`closed:${type}`, (c) => {
        c.tx(type, "2025-06-01", { ...SAMPLE_PAYLOADS[type], security_id: closedFor(type) });
      });
    }
    const found = codes(m.b.replay(D)).slice(base);
    expect(found.filter((code) => code === "UNKNOWN_SECURITY")).toHaveLength(SECURITY_TYPES.length);
    expect(found.filter((code) => code === "LOT_CLOSED")).toHaveLength(SECURITY_TYPES.length);
    expect(SECURITY_TYPES.length).toBeGreaterThan(30);
  });

  it("refuses issuances on lots of another family, and duplicate issuances in every family", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "10", "2025-01-01", { vesting: null });
    const stock = issueStock(m, "CS-1", m.bob, "10", "2025-01-01");
    m.b.command("wrong-family", (c) => {
      for (const type of ["TX_STOCK_ISSUANCE", "TX_WARRANT_ISSUANCE", "TX_CONVERTIBLE_ISSUANCE"] as const) {
        c.tx(type, "2025-02-01", { ...SAMPLE_PAYLOADS[type], security_id: option, stakeholder_id: m.alice });
      }
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", "2025-02-01", { ...SAMPLE_PAYLOADS.TX_EQUITY_COMPENSATION_ISSUANCE, security_id: stock, stakeholder_id: m.bob, stock_plan_id: m.plan });
    });
    let warrant = "";
    let safe = "";
    m.b.command("issued", (c) => {
      warrant = c.security("WAR-1", { family: "WARRANT", subtype: "WARRANT", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_WARRANT_ISSUANCE", "2025-01-01", { security_id: warrant, custom_id: "WAR-1", stakeholder_id: m.bob, quantity: "10", purchase_price: usd("0") });
      safe = c.security("SAFE-1", { family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: m.bob, stockClassId: null, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_CONVERTIBLE_ISSUANCE", "2025-01-01", { security_id: safe, custom_id: "SAFE-1", stakeholder_id: m.bob, investment_amount: usd("10"), convertible_type: "SAFE" });
    });
    m.b.command("duplicates", (c) => {
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", "2025-03-01", { ...SAMPLE_PAYLOADS.TX_EQUITY_COMPENSATION_ISSUANCE, security_id: option, stakeholder_id: m.alice, stock_plan_id: m.plan, stock_class_id: m.common });
      c.tx("TX_WARRANT_ISSUANCE", "2025-03-01", { security_id: warrant, custom_id: "WAR-1", stakeholder_id: m.bob, quantity: "10", purchase_price: usd("0") });
      c.tx("TX_CONVERTIBLE_ISSUANCE", "2025-03-01", { security_id: safe, custom_id: "SAFE-1", stakeholder_id: m.bob, investment_amount: usd("10"), convertible_type: "SAFE" });
    });
    expect(codes(m.b.replay(D))).toEqual(["FAMILY_MISMATCH", "FAMILY_MISMATCH", "FAMILY_MISMATCH", "FAMILY_MISMATCH", "DUPLICATE_ISSUANCE", "DUPLICATE_ISSUANCE", "DUPLICATE_ISSUANCE"]);
  });

  it("refuses vesting, repricing, pause, execution and leave facts on unknown lots and holders", () => {
    const m = miniOrg();
    const ghost = uuid("ghost");
    m.b.command("ghosts", (c) => {
      for (const type of ["TX_VESTING_START", "TX_VESTING_EVENT", "TX_VESTING_ACCELERATION", "X_EQUITY_COMPENSATION_REPRICING", "X_VESTING_PAUSE", "X_VESTING_RESUME", "X_EXECUTION_STATUS", "X_SECURITY_MODIFICATION"] as const) {
        c.tx(type, D, { ...SAMPLE_PAYLOADS[type], security_id: ghost });
      }
      c.tx("X_STAKEHOLDER_LEAVE", D, { ...SAMPLE_PAYLOADS.X_STAKEHOLDER_LEAVE, stakeholder_id: ghost });
      c.tx("X_MIGRATION_OPENING_BALANCE", D, { ...SAMPLE_PAYLOADS.X_MIGRATION_OPENING_BALANCE, security_id: ghost });
    });
    expect(codes(m.b.replay(D))).toEqual([...Array(8).fill("UNKNOWN_SECURITY"), "UNKNOWN_STAKEHOLDER", "UNKNOWN_SECURITY"]);
  });
});

describe("transfers and retractions of awards, warrants and convertibles", () => {
  it("transfers an option to a trust with a balance lot, keeping plan usage unchanged", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const award = (c: Parameters<Parameters<typeof m.b.command>[1]>[0], label: string, holder: string, quantity: string, origin: "TRANSFER" | "BALANCE") => {
      const lot = c.security(label, { family: "EQUITY_COMPENSATION", subtype: "OPTION_ISO", stakeholderId: holder, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: option });
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", "2025-03-01", {
        security_id: lot,
        custom_id: label,
        stakeholder_id: holder,
        stock_plan_id: m.plan,
        compensation_type: "OPTION_ISO",
        quantity,
        exercise_price: usd("1"),
        expiration_date: "2035-01-01",
        termination_exercise_windows: [],
        x_origin: origin,
        x_source_security_id: option,
      });
      return lot;
    };
    m.b.command("transfer", (c) => {
      const to = award(c, "OPT-1T", m.carol, "60", "TRANSFER");
      const balance = award(c, "OPT-1B", m.alice, "40", "BALANCE");
      c.tx("TX_EQUITY_COMPENSATION_TRANSFER", "2025-03-01", { security_id: option, quantity: "60", resulting_security_ids: [to], balance_security_id: balance, x_reason: "ESTATE" });
    });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.securities.get(option)!.status).toBe("TRANSFERRED");
    const plan = e.computeMetrics(state).plans[0]!;
    expect([plan.awardsOutstanding.toString(), plan.grantedGross.toString()]).toEqual(["100", "100"]);
  });

  it("transfers a warrant in full, and retracts untouched awards, warrants and convertibles", () => {
    const m = miniOrg();
    let warrant = "";
    let safe = "";
    m.b.command("setup", (c) => {
      warrant = c.security("WAR-1", { family: "WARRANT", subtype: "WARRANT", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_WARRANT_ISSUANCE", "2025-01-01", { security_id: warrant, custom_id: "WAR-1", stakeholder_id: m.bob, quantity: "10", purchase_price: usd("5") });
      safe = c.security("SAFE-1", { family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: m.bob, stockClassId: null, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_CONVERTIBLE_ISSUANCE", "2025-01-01", { security_id: safe, custom_id: "SAFE-1", stakeholder_id: m.bob, investment_amount: usd("10"), convertible_type: "SAFE" });
    });
    m.b.command("transfer", (c) => {
      const to = c.security("WAR-2", { family: "WARRANT", subtype: "WARRANT", stakeholderId: m.carol, stockClassId: m.common, stockPlanId: null, parentSecurityId: warrant });
      c.tx("TX_WARRANT_ISSUANCE", "2025-02-01", {
        security_id: to,
        custom_id: "WAR-2",
        stakeholder_id: m.carol,
        quantity: "10",
        purchase_price: usd("5"),
        x_origin: "TRANSFER",
        x_source_security_id: warrant,
        x_capital_contribution: usd("1"),
      });
      c.tx("TX_WARRANT_TRANSFER", "2025-02-01", { security_id: warrant, quantity: "10", resulting_security_ids: [to] });
    });
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    m.b.command("retract", (c) => {
      c.tx("TX_EQUITY_COMPENSATION_RETRACTION", "2025-03-01", { security_id: option, reason_text: "Never granted" });
      c.tx("TX_WARRANT_RETRACTION", "2025-03-01", { security_id: uuid("WAR-2"), reason_text: "Never issued" });
      c.tx("TX_CONVERTIBLE_RETRACTION", "2025-03-01", { security_id: safe, reason_text: "Never issued" });
    });
    m.b.command("accept", (c) => {
      c.tx("TX_EQUITY_COMPENSATION_ACCEPTANCE", "2025-04-01", { security_id: option });
    });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["LOT_CLOSED"]); // accepting a retracted grant
    expect(state.plans.get(m.plan)!.grantedGross.toString()).toBe("0");
    const metrics = e.computeMetrics(state);
    expect(metrics.capitalContribution.toString()).toBe("5"); // WAR-1's purchase price; the retracted lots count for nothing
    expect([state.securities.get(uuid("WAR-2"))!.status, state.securities.get(safe)!.status]).toEqual(["RETRACTED", "RETRACTED"]);
  });

  it("refuses a transfer of more than the lot holds", () => {
    const m = miniOrg();
    const lot = issueStock(m, "CS-1", m.bob, "10", "2025-01-01");
    m.b.command("over", (c) => {
      const to = addStock(m, c, "CS-2", m.carol, "20", "2025-02-01", { origin: "TRANSFER", source: lot });
      c.tx("TX_STOCK_TRANSFER", "2025-02-01", { security_id: lot, quantity: "20", resulting_security_ids: [to] });
    });
    expect(codes(m.b.replay(D))).toEqual(["NEGATIVE_POSITION"]);
  });
});

describe("other replay paths", () => {
  it("issues SARs with a base price and checks a derived lot's parent", () => {
    const m = miniOrg();
    let sar = "";
    m.b.command("sar", (c) => {
      sar = c.security("SAR-1", { family: "EQUITY_COMPENSATION", subtype: "SAR", stakeholderId: m.alice, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", "2025-01-01", {
        security_id: sar,
        custom_id: "SAR-1",
        stakeholder_id: m.alice,
        compensation_type: "SSAR",
        quantity: "10",
        base_price: usd("2"),
        expiration_date: null,
        termination_exercise_windows: [],
      });
    });
    const lot = issueStock(m, "CS-1", m.bob, "10", "2025-01-01");
    m.b.command("orphan-parent", (c) => {
      const to = c.security("CS-2", { family: "STOCK", subtype: "COMMON", stakeholderId: m.carol, stockClassId: m.common, stockPlanId: null, parentSecurityId: uuid("someone-else") });
      c.tx("TX_STOCK_ISSUANCE", "2025-02-01", { security_id: to, custom_id: "CS-2", stakeholder_id: m.carol, stock_class_id: m.common, share_price: usd("1"), quantity: "10", x_origin: "TRANSFER", x_source_security_id: lot });
      c.tx("TX_STOCK_TRANSFER", "2025-02-01", { security_id: lot, quantity: "10", resulting_security_ids: [to] });
    });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["LINEAGE_MISMATCH"]);
    expect(state.securities.get(sar)!.basePrice?.toString()).toBe("2");
    expect(e.violationsOf(state).map((v) => v.code)).toEqual(["LINEAGE_MISMATCH"]);
    expect(e.violationsOf(state, "warning")).toEqual([]);
  });

  it("checks plan availability once per day when a grant and a pool change land together", () => {
    const m = miniOrg({ pool: "100" });
    m.b.command("same-day", (c) => {
      c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2025-01-01", { stock_plan_id: m.plan, shares_reserved: "100" });
    });
    grant(m, "OPT-1", m.alice, "150", "2025-01-01");
    m.b.command("same-day-again", (c) => {
      c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2025-01-01", { stock_plan_id: m.plan, shares_reserved: "120" });
    });
    expect(codes(m.b.replay(D))).toEqual(["EXCEEDS_PLAN_AVAILABLE"]);
  });

  it("skips pool bookkeeping for lots whose plan isn't in the org, and counts awards outside plans", () => {
    const m = miniOrg();
    const stray = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, planId: uuid("plan:ghost") });
    cancel(m, "c", stray, "10", "2025-02-01");
    const planless = grant(m, "OPT-2", m.carol, "50", "2025-01-01", { vesting: null, planId: null });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["UNKNOWN_STOCK_PLAN"]);
    const metrics = e.computeMetrics(state);
    expect(metrics.holders.find((h) => h.stakeholderId === m.carol)!.awardsOutsidePlans.toString()).toBe("50");
    expect(state.securities.get(planless)!.outstanding.toString()).toBe("50");
  });

  it("returns empty vesting views for unissued or exhausted lots", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    exercise(m, "CS-1", option, m.alice, "100", "2025-02-01", { portion: "NSO" });
    m.b.command("unissued", (c) => {
      c.security("OPT-2", { family: "EQUITY_COMPENSATION", subtype: "OPTION_NSO", stakeholderId: m.alice, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: null });
      c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2025-02-01", { stock_plan_id: m.plan, shares_reserved: "100000" });
    });
    const state = m.b.replay(D);
    expect(e.securityVestingTimeline(state, state.securities.get(uuid("OPT-2"))!)).toEqual([]);
    expect(e.securityUpcomingVests(state, state.securities.get(option)!)).toEqual([]);
    expect(e.securityVestingTimeline(state, state.securities.get(option)!)).toHaveLength(1);
  });

  it("orders later terminations and summarizes violations in the replay hash", () => {
    const m = miniOrg();
    m.b.command("later", (c) => {
      for (const [date, before] of [
        ["2027-02-01", "advisor"],
        ["2027-01-01", "officer"],
      ] as const) {
        c.tx("X_STAKEHOLDER_TERMINATION", date, { stakeholder_id: m.bob, termination_date: date, termination_type: "voluntary", vesting_stop_date: date, relationship_before: before, relationship_after: "other" });
      }
    });
    const state = m.b.replay(D);
    expect(e.relationshipAsOf(state, m.bob)).toBe("officer"); // the earliest later termination says what it was before
    const option = grant(m, "OPT-1", m.alice, "10", "2025-01-01", { vesting: null });
    cancel(m, "too-much", option, "20", "2025-02-01");
    const broken = m.b.replay(D);
    expect((e.stateSummary(broken).violations as string[])[0]).toMatch(/^error:NEGATIVE_POSITION:/);
    expect(e.replayHash(broken)).not.toBe(e.replayHash(state));
  });

  it("splits only the class's lots, and leaves other classes alone (I7)", () => {
    const m = miniOrg();
    issueStock(m, "CS-1", m.bob, "10", "2025-01-01");
    issueStock(m, "PS-1", m.bob, "10", "2025-01-01", { classId: m.preferred });
    const before = m.b.replay("2025-05-31");
    m.b.command("split", (c) => {
      c.tx("TX_STOCK_CLASS_SPLIT", "2025-06-01", { stock_class_id: m.common, split_ratio: { numerator: "2", denominator: "1" } });
    });
    const after = m.b.replay("2025-06-01");
    expect(e.checkSplitScaling(before, after, m.common, e.Rational.of(2))).toEqual([]);
    expect(after.securities.get(uuid("PS-1"))!.outstanding.toString()).toBe("10");
  });

  it("covers the remaining deadline, dependency and compliance branches", () => {
    const m = miniOrg();
    // An ISO with no window: the ISO deadline is capped only by the expiration.
    const iso = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, planId: null, windows: [], expiration: "2025-04-01" });
    issueStock(m, "CS-9", m.bob, "1", "2025-01-01");
    const done = grant(m, "OPT-2", m.carol, "10", "2025-01-01", { vesting: null });
    exercise(m, "CS-1", done, m.carol, "10", "2025-01-15", { portion: "NSO" });
    terminate(m, "alice", m.alice, "2025-03-01");
    const state = m.b.replay(D);
    expect(e.isoDeadline(state, state.securities.get(iso)!)).toMatchObject({ date: "2025-04-01", reason: "3 months after termination, capped at the expiration date" });
    expect(e.expiryCandidates(state).map((c) => c.securityId)).toEqual([iso]);
    // A command the state never applied has no edges.
    expect(e.commandDependencies(state, uuid("c:ghost"))).toEqual([]);
    // An ISO grant exercised as NSO has no Form 3921; an RSU without an FMV at grant has no Rule 701 price.
    const iso2 = grant(m, "OPT-3", m.carol, "10", "2026-01-01", { vesting: null });
    exercise(m, "CS-2", iso2, m.carol, "10", "2026-02-01", { portion: "NSO" });
    m.b.command("rsu", (c) => {
      const rsu = c.security("RSU-1", { family: "EQUITY_COMPENSATION", subtype: "RSU", stakeholderId: m.carol, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: null });
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", "2026-01-01", { security_id: rsu, custom_id: "RSU-1", stakeholder_id: m.carol, stock_plan_id: m.plan, compensation_type: "RSU", quantity: "5", expiration_date: null, termination_exercise_windows: [] });
    });
    const later = m.b.replay(D);
    expect(e.form3921Records(later, 2026)).toEqual([]);
    expect(e.rule701Window(later, D).sales.map((s) => s.securityId)).toEqual([iso2]);
  });
});
