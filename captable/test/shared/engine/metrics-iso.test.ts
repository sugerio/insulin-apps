import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { usd, uuid } from "./fixtures/builder.ts";
import { codes, exercise, grant, issueStock, miniOrg, terminate } from "./fixtures/mini.ts";

// Room for full replays and property runs on a loaded CI machine (vitest's default is 5 s per test).
const SLOW = { timeout: 30_000 };

const D = "2026-06-30";

describe("cap table metrics", SLOW, () => {
  it("counts stock as converted, awards and warrants as exercised, plus the pools; SAFEs are left out", () => {
    const m = miniOrg();
    issueStock(m, "CS-1", m.bob, "1000", "2025-01-01");
    issueStock(m, "PS-1", m.bob, "101", "2025-01-01", { classId: m.preferred });
    grant(m, "OPT-1", m.alice, "100", "2025-01-01");
    m.b.command("ratio-and-safe", (c) => {
      c.tx("TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", "2025-02-01", {
        stock_class_id: m.preferred,
        new_ratio_conversion_mechanism: { type: "RATIO_CONVERSION", ratio: { numerator: "3", denominator: "2" } },
      });
      const safe = c.security("SAFE-1", { family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: m.carol, stockClassId: null, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_CONVERTIBLE_ISSUANCE", "2025-02-01", { security_id: safe, custom_id: "SAFE-1", stakeholder_id: m.carol, investment_amount: usd("5000"), convertible_type: "SAFE" });
      const warrant = c.security("WAR-1", { family: "WARRANT", subtype: "WARRANT", stakeholderId: m.carol, stockClassId: m.preferred, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_WARRANT_ISSUANCE", "2025-02-01", { security_id: warrant, custom_id: "WAR-1", stakeholder_id: m.carol, quantity: "10", purchase_price: usd("0") });
    });
    const state = m.b.replay(D);
    const metrics = e.computeMetrics(state);
    expect(metrics.issuedAndOutstanding.toString()).toBe("1101"); // legal shares
    // 1000 + floor(101 × 3/2) + 100 options + 15 warrant shares + 99,900 pool
    expect(metrics.fullyDiluted.toString()).toBe(String(1000 + 151 + 100 + 15 + 99900));
    expect(metrics.capitalContribution.toString()).toBe(String(1000 + 101 + 5000));
    expect(metrics.stakeholdersWithSecurities).toBe(3);
    expect(metrics.holders.find((h) => h.stakeholderId === m.carol)!.convertiblesOutstanding.toString()).toBe("5000");
    expect(e.checkCapTableIdentity(metrics)).toEqual([]);
    const preferred = metrics.classes.find((c) => c.stockClassId === m.preferred)!;
    expect([preferred.issuedAndOutstanding, preferred.fullyDiluted, preferred.reserved, preferred.available, preferred.availableToIssue].map(String)).toEqual([
      "101",
      "111",
      "10",
      "499899",
      "499889",
    ]);
    const common = metrics.classes.find((c) => c.stockClassId === m.common)!;
    // Reserved for common: 100 options + the 99,900 pool + 151 for converting the preferred.
    expect(common.reserved.toString()).toBe(String(100 + 99900 + 151));
    expect(common.availableToIssue?.toString()).toBe(String(1000000 - 1000 - 100 - 99900 - 151));
  });

  it("leaves classes excluded from FD out, and reports classes without authorized shares", () => {
    const m = miniOrg();
    issueStock(m, "PS-1", m.bob, "100", "2025-01-01", { classId: m.preferred });
    m.b.command("exclude", (c) => {
      c.tx("X_STOCK_CLASS_TERMS", "2025-01-01", {
        stock_class_id: m.preferred,
        votes_per_share: "0",
        exclude_from_fully_diluted: true,
        seniority: null,
        liquidation_preference_multiple: null,
        participation: null,
        participation_cap_multiple: null,
        dividend_terms: null,
        anti_dilution: null,
        not_recorded_in_pulley: [],
      });
    });
    m.b.reference.stockClasses.push({ id: uuid("class:loose"), name: "Unauthorized", classType: "COMMON" });
    const metrics = e.computeMetrics(m.b.replay(D));
    expect(metrics.fullyDiluted.toString()).toBe("100000"); // the pool only
    const preferred = metrics.classes.find((c) => c.stockClassId === m.preferred)!;
    expect([preferred.excludedFromFullyDiluted, preferred.fullyDiluted.toString()]).toEqual([true, "0"]);
    const loose = metrics.classes.find((c) => c.stockClassId === uuid("class:loose"))!;
    expect([loose.authorized, loose.available, loose.availableToIssue]).toEqual([null, null, null]);
    expect(metrics.holders[0]!.issuedAndOutstandingPct.toString()).toBe("1");
  });

  it("zeroes a terminated plan's availability and pours it over into its successor", () => {
    const m = miniOrg({ pool: "1000" });
    const successor = m.b.plan("mini:P2", m.common, "Successor plan");
    grant(m, "OPT-1", m.alice, "400", "2025-01-01");
    m.b.command("terms", (c) => {
      const rules = { cancelled_unvested_awards: "RETURN", expired_vested_options: "RETURN", repurchased_unvested_shares: "RETURN", repurchased_vested_shares: "RETURN", shares_withheld_for_tax: "RETURN" } as const;
      c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2025-06-01", { stock_plan_id: successor, shares_reserved: "500" });
      c.tx("X_STOCK_PLAN_TERMS", "2025-06-01", { stock_plan_id: successor, return_rules: rules, default_termination_windows: [], default_repurchase_window: null, status: "active", pour_over_plan_id: null });
      c.tx("X_STOCK_PLAN_TERMS", "2025-06-01", { stock_plan_id: m.plan, return_rules: rules, default_termination_windows: [], default_repurchase_window: null, status: "terminated", pour_over_plan_id: successor });
    });
    const metrics = e.computeMetrics(m.b.replay(D));
    const [old, next] = [metrics.plans.find((p) => p.stockPlanId === m.plan)!, metrics.plans.find((p) => p.stockPlanId === successor)!];
    expect([old.status, old.available.toString(), old.availableToGrant.toString()]).toEqual(["terminated", "600", "0"]);
    expect(next.availableToGrant.toString()).toBe("1100");
    expect(metrics.planAvailable.toString()).toBe("1100");
    expect(e.checkCapTableIdentity(metrics)).toEqual([]);
  });

  it("reports per-security numbers, relationships as of the date, and execution-pending awards", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01", { execution: "pending_holder" });
    const restricted = issueStock(m, "CS-1", m.carol, "100", "2025-01-01", { vestingMonths: { start: "2025-01-01", months: 10, cliff: 0 } });
    const planShares = issueStock(m, "CS-2", m.carol, "100", "2025-01-01", { planId: m.plan, origin: "RSA", vestingMonths: { start: "2025-01-01", months: 10, cliff: 0 } });
    terminate(m, "carol", m.carol, "2025-03-01");
    m.b.command("bob-later", (c) => {
      c.tx("X_STAKEHOLDER_TERMINATION", "2026-12-01", { stakeholder_id: m.bob, termination_date: "2026-12-01", termination_type: "voluntary", vesting_stop_date: "2026-12-01", relationship_before: "officer", relationship_after: "advisor" });
    });
    const state = m.b.replay(D);
    const metrics = e.computeMetrics(state);
    expect([metrics.executionPendingCount, metrics.executionPendingAwards.toString()]).toEqual([1, "4800"]);
    const alice = metrics.holders.find((h) => h.stakeholderId === m.alice)!;
    expect([alice.executionPending.toString(), alice.vestedOptions.toString(), alice.unvestedOptions.toString()]).toEqual(["4800", "1700", "3100"]);
    expect(e.relationshipAsOf(state, m.carol)).toBe("ex_employee");
    expect(e.relationshipAsOf(state, m.bob)).toBe("officer");
    expect(e.relationshipAsOf(state, uuid("ghost"))).toBe("other");
    expect(e.relationshipAsOf(m.b.replay("2026-12-31"), m.bob)).toBe("advisor");
    // No window recorded anywhere: the right stays open until the deadline is entered (a migration exception).
    const numbers = e.securityNumbers(state, state.securities.get(restricted)!);
    expect([numbers.vested.toString(), numbers.unvested.toString(), numbers.repurchaseable.toString(), numbers.fullyDilutedPct.toString()]).toEqual(["20", "80", "80", "0"]);
    // Plan shares follow the plan's 90-day window: repurchaseable inside it, lapsed after.
    const inWindow = m.b.replay("2025-04-01");
    expect(e.securityNumbers(inWindow, inWindow.securities.get(planShares)!).repurchaseable.toString()).toBe("80");
    expect(e.securityNumbers(state, state.securities.get(planShares)!).repurchaseable.toString()).toBe("0");
    expect(e.securityNumbers(state, state.securities.get(option)!).exercisable.toString()).toBe("0");
    expect(e.deliveredClassId(state, { ...state.securities.get(option)!, identity: { ...state.securities.get(option)!.identity, stockClassId: null } })).toBe(m.common);
    expect(e.deliveredClassId(state, { ...state.securities.get(option)!, identity: { ...state.securities.get(option)!.identity, stockClassId: null, stockPlanId: null } })).toBeNull();
  });
});

describe("ISO $100K lots", SLOW, () => {
  it("orders same-day grants by display id, naturally", () => {
    const m = miniOrg({ pool: "1000000" });
    grant(m, "OPT-10", m.alice, "60000", "2025-01-01", { vesting: null });
    grant(m, "OPT-9", m.alice, "60000", "2025-01-01", { vesting: null });
    const state = m.b.replay(D);
    const split = e.isoSplit(state, m.alice);
    expect(split.map((g) => g.displayId)).toEqual(["OPT-9", "OPT-10"]); // natural order, not "OPT-10" < "OPT-9"
    expect(split.map((g) => [g.iso.toString(), g.nso.toString(), g.review])).toEqual([
      ["60000", "0", null],
      ["40000", "20000", null],
    ]);
    expect(e.isoYearValue(state, m.alice, 2025).toString()).toBe("120000");
  });

  it("merges attested outside ISO grants into grant-date and id order", () => {
    const m = miniOrg({ pool: "1000000" });
    const nine = grant(m, "OPT-9", m.alice, "60000", "2025-01-01", { vesting: null });
    grant(m, "OPT-10", m.alice, "60000", "2025-01-01", { vesting: null });
    const state = m.b.replay(D);
    const outside = (id: string, grantDate: string, fmv: string, shares: string) => ({ id, grantDate, fmv: e.Rational.from(fmv), firstExercisable: new Map([[2025, e.Dec.from(shares)]]) });
    const isos = (grants: e.OutsideIsoGrant[]) => e.isoSplit(state, m.alice, grants).map((g) => g.iso.toString());
    // The earlier outside grant uses $90,000 of the optionee's 2025 room first.
    expect(isos([outside("PARENT-1", "2024-06-01", "3", "30000")])).toEqual(["10000", "0"]);
    // The later outside grant comes last and does not change the app-recorded grants.
    expect(isos([outside("PARENT-1", "2025-03-01", "3", "30000")])).toEqual(["60000", "40000"]);
    // The same day: ordered by id ("PARENT-1" before "OPT-9" would be wrong; "EXT-1" sorts first).
    expect(isos([outside("EXT-1", "2025-01-01", "1", "10000")])).toEqual(["60000", "30000"]);
    expect(isos([outside("ZED-1", "2025-01-01", "1", "10000")])).toEqual(["60000", "40000"]);
    // Entered on the stakeholder, replay uses them: an exercise of ISO lots the outside grant took is refused.
    const n = miniOrg({ pool: "1000000" });
    n.b.reference.stakeholders.find((s) => s.id === n.alice)!.outsideIsoGrants = [
      { id: "PARENT-1", grantDate: "2024-06-01", fmvPerShare: "3", firstExercisable: [{ year: 2025, shares: "30000" }] },
    ];
    const opt = grant(n, "OPT-9", n.alice, "60000", "2025-01-01", { vesting: null });
    exercise(n, "CS-1", opt, n.alice, "20000", "2025-02-01", { portion: "ISO" });
    const replayed = n.b.replay(D);
    expect(e.isoSplit(replayed, n.alice)[0]!.iso.toString()).toBe("10000");
    expect(codes(replayed)).toEqual(["ISO_LOTS_EXCEEDED"]);
    // An invalid outside grant is refused, not guessed at.
    n.b.reference.stakeholders.find((s) => s.id === n.alice)!.outsideIsoGrants = [{ id: "BAD", grantDate: "2024-06-01", fmvPerShare: "0", firstExercisable: [] }];
    expect(codes(n.b.replay(D))).toContain("OUTSIDE_ISO_GRANT_INVALID");
    expect(state.securities.get(nine)!.issued).toBe(true);
  });

  it("needs each outside grant id to be unique and no security's display id: a repeat is refused and counted once", () => {
    const parent = (id: string, shares = "30000") => ({ id, grantDate: "2024-06-01", fmvPerShare: "3", firstExercisable: [{ year: 2025, shares }] });
    const m = miniOrg({ pool: "1000000" });
    const opt = grant(m, "OPT-9", m.alice, "60000", "2025-01-01", { vesting: null });
    const holder = m.b.reference.stakeholders.find((s) => s.id === m.alice)!;
    // Entered twice: the second is refused, so the $90,000 is used once (10,000 ISO shares left, not 0).
    holder.outsideIsoGrants = [parent("PARENT-1"), parent("PARENT-1")];
    let state = m.b.replay(D);
    expect(codes(state)).toEqual(["OUTSIDE_ISO_GRANT_INVALID"]);
    expect(state.violations[0]!.message).toContain("entered twice");
    expect(e.isoSplit(state, m.alice)[0]!.iso.toString()).toBe("10000");
    // An id that is also a display id would make the same-day order ambiguous: refused.
    holder.outsideIsoGrants = [{ ...parent("OPT-9"), grantDate: "2025-01-01" }];
    state = m.b.replay(D);
    expect(codes(state)).toEqual(["OUTSIDE_ISO_GRANT_INVALID"]);
    expect(state.violations[0]!.message).toContain("display id");
    expect(e.isoSplit(state, m.alice)[0]!.iso.toString()).toBe("60000");
    // Given directly (a preview), the same mistakes throw instead of computing a wrong split.
    const outside = (id: string) => ({ id, grantDate: "2024-06-01", fmv: e.Rational.from("3"), firstExercisable: new Map([[2025, e.Dec.from(30000)]]) });
    expect(() => e.isoSplit(state, m.alice, [outside("PARENT-1"), outside("PARENT-1")])).toThrow(/given twice/);
    expect(() => e.isoSplit(state, m.alice, [outside("OPT-9")])).toThrow(/display id/);
    expect(state.securities.get(opt)!.issued).toBe(true);
  });

  it("never substitutes for a missing or zero FMV at grant: those lots, and later grants' lots in the same years, go to review", () => {
    const m = miniOrg({ pool: "1000000" });
    const zero = grant(m, "OPT-1", m.alice, "500000", "2025-01-01", { vesting: null, price: "0.0001", fmv: "0", source: "app" });
    const later = grant(m, "OPT-2", m.alice, "10000", "2025-02-01", { vesting: null });
    grant(m, "OPT-3", m.alice, "10000", "2026-01-01", { vesting: null });
    const missing = grant(m, "OPT-4", m.carol, "100", "2025-01-01", { vesting: null, fmv: null }); // the strike ($1) is no substitute
    exercise(m, "CS-1", later, m.alice, "100", "2025-03-01", { portion: "ISO", source: "import" });
    const state = m.b.replay(D);
    expect(state.violations.map((v) => [v.code, v.severity, v.securityId])).toEqual([
      ["ISO_FMV_REQUIRED", "error", zero],
      ["ISO_FMV_REQUIRED", "warning", missing],
      ["ISO_LOTS_UNVERIFIED", "warning", later],
    ]);
    expect(e.isoSplit(state, m.alice).map((g) => [g.displayId, g.review, g.iso.toString(), g.nso.toString(), g.unclassified.toString()])).toEqual([
      ["OPT-1", "FMV_REQUIRED", "0", "0", "500000"],
      ["OPT-2", "PRIOR_GRANT_UNCLASSIFIED", "0", "0", "10000"],
      ["OPT-3", null, "10000", "0", "0"], // 2026: its room doesn't depend on the 2025 grants
    ]);
    expect(e.isoSplit(state, m.carol)[0]).toMatchObject({ review: "FMV_REQUIRED", fmv: null, unclassified: e.Dec.from(100) });
    expect(e.isoSplit(state, m.carol)[0]!.years[0]!.value).toBeNull();
    expect(e.isoLotsAvailable(state, state.securities.get(later)!, D)).toMatchObject({ iso: e.Dec.ZERO, review: true });
    expect(e.isoYearValue(state, m.carol, 2025).toString()).toBe("0");
  });

  it("counts accelerations in their year up to the uncancelled quantity", () => {
    const m = miniOrg({ pool: "1000000" });
    const other = grant(m, "OPT-2", m.carol, "4800", "2025-01-01");
    m.b.command("accelerate", (c) => {
      c.tx("TX_VESTING_ACCELERATION", "2025-06-01", { security_id: other, quantity: "1000", reason_text: "Board approval" });
    });
    terminate(m, "carol", m.carol, "2025-06-01", { cancels: [[other, "3800"]] });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect([...e.firstExercisableByYear(state, state.securities.get(other)!)]).toEqual([[2025, e.Dec.from(1000)]]);
    expect(e.firstExercisableByYear(state, { ...state.securities.get(other)!, issued: false }).size).toBe(0);
  });

  it("moves year lots with a vesting pause", () => {
    const m = miniOrg({ pool: "1000000" });
    // 4,800 over 48 months with a 12-month cliff from 2025-01-01; a 61-day pause before the cliff moves every later
    // event by 61 days (the cliff to 2026-03-03), so two monthly tranches of each year move into the next.
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01", { price: "50" });
    m.b.command("pause", (c) => {
      c.tx("X_VESTING_PAUSE", "2025-12-01", { security_id: option, reason: "Leave" });
      c.tx("X_VESTING_RESUME", "2026-01-31", { security_id: option });
    });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    const s = state.securities.get(option)!;
    expect([...e.firstExercisableByYear(state, s)].map(([year, shares]) => [year, shares.toString()])).toEqual([
      [2026, "2100"],
      [2027, "1200"],
      [2028, "1200"],
      [2029, "300"],
    ]);
    // 2026: 2,100 × $50 is over $100K, so 2,000 ISO and 100 NSO, the NSO lots vesting last.
    expect(e.isoLotsAvailable(state, s, "2026-06-30")).toEqual({ iso: e.Dec.from(1500), nso: e.Dec.ZERO, total: e.Dec.from(1500), review: false });
    expect(e.isoLotsAvailable(state, s, "2026-12-31")).toEqual({ iso: e.Dec.from(2000), nso: e.Dec.from(100), total: e.Dec.from(2100), review: false });
  });

  it("offers ISO lots first, less what earlier exercises consumed", () => {
    const m = miniOrg({ pool: "1000000" });
    const big = grant(m, "OPT-1", m.alice, "150000", "2025-01-01", { vesting: null });
    exercise(m, "CS-1", big, m.alice, "90000", "2025-02-01", { portion: "ISO" });
    const nso = grant(m, "OPT-2", m.carol, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    const early = grant(m, "OPT-3", m.carol, "48", "2025-01-01", { early: true });
    const state = m.b.replay(D);
    const at = (id: string) => e.isoLotsAvailable(state, state.securities.get(id)!, D);
    expect(at(big)).toEqual({ iso: e.Dec.from(10000), nso: e.Dec.from(50000), total: e.Dec.from(60000), review: false });
    expect(at(nso)).toEqual({ iso: e.Dec.ZERO, nso: e.Dec.from(100), total: e.Dec.from(100), review: false });
    expect(at(early)).toEqual({ iso: e.Dec.from(48), nso: e.Dec.ZERO, total: e.Dec.from(48), review: false });
    const unissued = { ...state.securities.get(big)!, identity: { ...state.securities.get(big)!.identity, id: uuid("not-a-grant") } };
    expect(e.isoLotsAvailable(state, unissued, D)).toMatchObject({ iso: e.Dec.ZERO });
  });
});
