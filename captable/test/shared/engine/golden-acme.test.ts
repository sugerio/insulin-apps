import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import {
  buildAcme,
  p10CancelThenReverse,
  p4MarkExecuted,
  p5GrantNewHire,
  p6TerminateEmployee,
  p8ExerciseFormerEmployee,
  p9ExerciseAdvisor,
  runRecommendedR1,
  VALUATIONS,
  type Acme,
} from "./fixtures/acme.ts";
import { uuid } from "./fixtures/builder.ts";

// Room for full replays and property runs on a loaded CI machine (vitest's default is 5 s per test).
const SLOW = { timeout: 30_000 };

/**
 * Golden tests: the engine reproduces the synthetic numbers of the approved demo exactly (demo-script §3.3, §3.9,
 * §3.12, §3.20, §4 and the cumulative ledger of §5). The dataset is fictional ("Acme Robotics, Inc.").
 */

const TODAY = "2026-10-21";

function metricsAt(acme: Acme, asOf = TODAY): { state: e.LedgerState; m: e.CapTableMetrics } {
  const state = acme.b.replay(asOf, { today: TODAY });
  return { state, m: e.computeMetrics(state) };
}

function holderFd(m: e.CapTableMetrics, label: string): string {
  return (m.holders.find((h) => h.stakeholderId === uuid(label))?.fullyDiluted ?? e.Dec.ZERO).toString();
}

function security(m: e.CapTableMetrics, label: string): e.SecurityNumbers {
  const row = m.securities.find((s) => s.securityId === uuid(label));
  if (!row) throw new Error(`No security ${label}`);
  return row;
}

function plan(m: e.CapTableMetrics): e.PlanMetrics {
  return m.plans[0]!;
}

function classIo(m: e.CapTableMetrics, label: string): string {
  return m.classes.find((c) => c.stockClassId === uuid(`class:${label}`))!.issuedAndOutstanding.toString();
}

describe("Acme Robotics at demo start (2026-10-21)", SLOW, () => {
  const acme = buildAcme();
  const { state, m } = metricsAt(acme);

  it("replays the migrated ledger without a single violation", () => {
    expect(state.violations).toEqual([]);
    expect(e.checkInvariants(state)).toEqual([]);
    expect(e.verifyChain(acme.b.orgId, acme.b.rows)).toMatchObject({ ok: true, headSeq: acme.b.headSeq });
  });

  it("matches the dashboard and the consistency ledger (§3.20)", () => {
    expect(m.fullyDiluted.toString()).toBe("24312120");
    expect(m.issuedAndOutstanding.toString()).toBe("19945120");
    expect(m.optionsOutstanding.toString()).toBe("3796250");
    expect(m.warrantsOutstanding.toString()).toBe("110000");
    expect(m.planAvailable.toString()).toBe("460750");
    expect(m.capitalContribution.toString()).toBe("16147718.6");
    expect(e.formatMoney(m.capitalContribution)).toBe("$16,147,718.60");
    expect(m.stakeholdersWithSecurities).toBe(38);
    expect(m.executionPendingCount).toBe(6);
    expect(m.executionPendingAwards.toString()).toBe("130000");
    expect(classIo(m, "CS")).toBe("9743000");
    expect(classIo(m, "PS")).toBe("5138019");
    expect(classIo(m, "PA1")).toBe("4038461");
    expect(classIo(m, "PA2")).toBe("1025640");
    // FD = common 9,743,000 + preferred 10,202,120 + options 3,796,250 + pool 460,750 + warrants 110,000.
    expect(m.issuedAndOutstanding.add(m.optionsOutstanding).add(m.planAvailable).add(m.warrantsOutstanding).toString()).toBe("24312120");
  });

  it("matches the plan card (§3.5)", () => {
    const p = plan(m);
    expect(p.poolSize.toString()).toBe("4500000");
    expect(p.grantedGross.toString()).toBe("4451000");
    expect(p.returned.toString()).toBe("411750");
    expect(p.awardsOutstanding.toString()).toBe("3796250");
    expect(p.sharesOutstanding.toString()).toBe("243000");
    expect(p.equityOutstanding.toString()).toBe("4039250");
    expect(p.equityRetired.toString()).toBe("0");
    expect(p.availableToGrant.toString()).toBe("460750");
    expect(e.formatPercent(e.Rational.fromDec(p.equityOutstanding).div(e.Rational.fromDec(p.poolSize)))).toBe("89.76%");
    expect(p.rules?.repurchasedVestedShares).toBe("RETIRE");
  });

  it("matches every stakeholder's fully diluted shares and percentage (§3.3)", () => {
    const expected: [string, string, string][] = [
      ["S01", "4300000", "17.69"], ["S02", "3750000", "15.42"], ["S03", "2150000", "8.84"], ["S04", "520000", "2.14"],
      ["S05", "260000", "1.07"], ["S06", "170000", "0.70"], ["S07", "160000", "0.66"], ["S08", "120000", "0.49"],
      ["S09", "280000", "1.15"], ["S10", "105000", "0.43"], ["S11", "95000", "0.39"], ["S12", "210000", "0.86"],
      ["S13", "400000", "1.65"], ["S14", "140000", "0.58"], ["S15", "60000", "0.25"], ["S16", "100000", "0.41"],
      ["S17", "105000", "0.43"], ["S18", "80000", "0.33"], ["S19", "90000", "0.37"], ["S20", "60000", "0.25"],
      ["S21", "60000", "0.25"], ["S22", "0", "0.00"], ["S23", "42000", "0.17"], ["S24", "72000", "0.30"],
      ["S25", "0", "0.00"], ["S26", "19000", "0.08"], ["S27", "21250", "0.09"], ["S28", "60000", "0.25"],
      ["S29", "80000", "0.33"], ["S30", "30000", "0.12"], ["S31", "3858173", "15.87"], ["S32", "3076923", "12.66"],
      ["S33", "1131230", "4.65"], ["S34", "755708", "3.11"], ["S35", "545673", "2.24"], ["S36", "104166", "0.43"],
      ["S37", "91145", "0.37"], ["S38", "176282", "0.73"], ["S39", "512820", "2.11"], ["S40", "60000", "0.25"],
    ];
    for (const [label, fd, pct] of expected) {
      expect(holderFd(m, label), label).toBe(fd);
      const row = m.holders.find((h) => h.stakeholderId === uuid(label));
      expect(e.formatPercent(row?.fullyDilutedPct ?? 0).replace("%", ""), label).toBe(pct);
    }
    expect(m.availablePool.fullyDiluted.toString()).toBe("460750");
    expect(e.formatPercent(m.availablePool.fullyDilutedPct)).toBe("1.90%");
    expect(m.holders[0]!.stakeholderId).toBe(uuid("S01")); // sorted by FD, descending
  });

  it("matches ownership by relationship (§3.20 donut)", () => {
    const byRelationship = new Map<string, e.Dec>();
    for (const h of m.holders) byRelationship.set(h.relationship, (byRelationship.get(h.relationship) ?? e.Dec.ZERO).add(h.fullyDiluted));
    expect(byRelationship.get("founder")?.toString()).toBe("10200000");
    expect(byRelationship.get("investor")?.toString()).toBe("10252120");
    expect(byRelationship.get("employee")?.toString()).toBe("2895000");
    expect(byRelationship.get("ex_employee")?.toString()).toBe("274250");
    expect(byRelationship.get("advisor")?.toString()).toBe("170000");
    expect(byRelationship.get("other")?.toString()).toBe("60000");
  });

  it("matches every option grant: exercised, cancelled, outstanding, vested, vested and unexercised (§3.9)", () => {
    const table: [string, number, number, number, number, number][] = [
      ["OPT-1", 50000, 0, 250000, 268750, 218750], ["OPT-2", 0, 0, 150000, 131250, 131250], ["OPT-3", 60000, 60000, 0, 72500, 0],
      ["OPT-4", 0, 0, 40000, 40000, 40000], ["OPT-5", 0, 80000, 0, 0, 0], ["OPT-6", 0, 0, 100000, 79166, 79166],
      ["OPT-7", 0, 0, 100000, 79166, 79166], ["OPT-8", 0, 90000, 0, 26250, 0], ["OPT-9", 0, 0, 50000, 50000, 50000],
      ["OPT-10", 0, 0, 80000, 56666, 56666], ["OPT-11", 0, 0, 200000, 141666, 141666], ["OPT-12", 0, 0, 60000, 42500, 42500],
      ["OPT-13", 0, 0, 60000, 38750, 38750], ["OPT-14", 0, 0, 120000, 77500, 77500], ["OPT-15", 42000, 54000, 0, 42000, 0],
      ["OPT-16", 0, 0, 100000, 64583, 64583], ["OPT-17", 72000, 0, 0, 37500, 0], ["OPT-18", 0, 0, 90000, 48750, 48750],
      ["OPT-19", 0, 0, 40000, 21666, 21666], ["OPT-20", 0, 60000, 60000, 60000, 60000], ["OPT-21", 0, 0, 70000, 32083, 32083],
      ["OPT-22", 0, 0, 60000, 27500, 27500], ["OPT-23", 19000, 29000, 0, 19000, 0], ["OPT-24", 0, 0, 80000, 30000, 30000],
      ["OPT-25", 0, 0, 60000, 22500, 22500], ["OPT-26", 0, 38750, 21250, 21250, 21250], ["OPT-27", 0, 0, 30000, 30000, 30000],
      ["OPT-28", 0, 0, 40000, 15000, 15000], ["OPT-29", 0, 0, 70000, 21875, 21875], ["OPT-30", 0, 0, 30000, 9375, 9375],
      ["OPT-31", 0, 0, 50000, 5000, 5000], ["OPT-32", 0, 0, 20000, 6250, 6250], ["OPT-33", 0, 0, 400000, 0, 0],
      ["OPT-34", 0, 0, 300000, 68750, 68750], ["OPT-35", 0, 0, 250000, 57291, 57291], ["OPT-36", 0, 0, 80000, 0, 0],
      ["OPT-37", 0, 0, 120000, 0, 0], ["OPT-38", 0, 0, 150000, 34375, 34375],
    ];
    const granted: Record<string, number> = { "OPT-39": 50000, "OPT-40": 40000, "OPT-41": 30000, "OPT-42": 25000, "OPT-43": 35000, "OPT-44": 20000, "OPT-45": 30000, "OPT-46": 25000, "OPT-47": 30000, "OPT-48": 20000, "OPT-49": 20000, "OPT-50": 40000, "OPT-51": 30000, "OPT-52": 15000, "OPT-53": 20000, "OPT-54": 15000, "OPT-55": 10000, "OPT-56": 10000 };
    for (const [label, quantity] of Object.entries(granted)) table.push([label, 0, 0, quantity, 0, 0]);
    let vestedUnexercised = e.Dec.ZERO;
    let unvested = e.Dec.ZERO;
    for (const [label, exercised, cancelled, outstanding, vested, vestedOutstanding] of table) {
      const s = security(m, label);
      expect([s.exercised, s.cancelled, s.outstanding, s.vested, s.vestedOutstanding].map(String), label).toEqual(
        [exercised, cancelled, outstanding, vested, vestedOutstanding].map(String),
      );
      vestedUnexercised = vestedUnexercised.add(s.vestedOutstanding);
      unvested = unvested.add(s.unvested);
    }
    expect(table).toHaveLength(56);
    expect(vestedUnexercised.toString()).toBe("1531662");
    expect(unvested.toString()).toBe("2264588");
  });

  it("flags the six execution-pending grants: counted in FD, not exercisable", () => {
    const pending = m.securities.filter((s) => s.executionStatus.startsWith("pending")).map((s) => s.displayId).sort();
    expect(pending).toEqual(["OPT-49", "OPT-50", "OPT-51", "OPT-53", "OPT-55", "OPT-56"]);
    expect(security(m, "OPT-50").fullyDiluted.toString()).toBe("40000");
    expect(security(m, "OPT-50").exercisable.toString()).toBe("0");
    expect(security(m, "OPT-49").executionStatus).toBe("pending_both");
  });

  it("matches the statuses of closed lots", () => {
    expect(security(m, "OPT-5").status).toBe("CANCELLED");
    expect(security(m, "OPT-8").status).toBe("EXPIRED");
    expect(security(m, "OPT-3").status).toBe("EXPIRED");
    expect(security(m, "OPT-17").status).toBe("EXERCISED");
    expect(security(m, "SAFE-1").status).toBe("CONVERTED");
    expect(security(m, "CS-4").status).toBe("OUTSTANDING");
    expect(security(m, "OPT-5").forfeited.toString()).toBe("80000");
  });

  it("matches the exit windows and ISO deadlines (§3.12)", () => {
    const rows: [string, string | null, string | null][] = [
      ["OPT-8", "2025-01-31", "2025-01-31"],
      ["OPT-3", "2025-09-30", "2025-09-30"],
      ["OPT-20", "2027-02-28", "2026-11-30"],
      ["OPT-26", "2027-01-01", null],
    ];
    for (const [label, contractual, iso] of rows) {
      const sec = state.securities.get(uuid(label))!;
      expect(e.contractualDeadline(sec)?.date ?? null, label).toBe(contractual);
      expect(e.isoDeadline(state, sec)?.date ?? null, label).toBe(iso);
    }
    const nadia = state.securities.get(uuid("OPT-20"))!;
    expect(e.contractualDeadline(nadia)?.source).toBe("extension");
    expect(e.isoDeadline(state, nadia)?.reason).toBe("3 months after termination");
    expect(security(m, "OPT-20").exercisable.toString()).toBe("60000");
    expect(security(m, "OPT-26").exercisable.toString()).toBe("21250");
    // CS-4: 37,500 vested and 34,500 unvested shares, repurchasable until 2026-12-14.
    const cs4 = state.securities.get(uuid("CS-4"))!;
    expect(e.positionAt(state, cs4, TODAY)).toMatchObject({ vested: e.Dec.from(37500), unvestedOutstanding: e.Dec.from(34500) });
    expect(e.repurchaseDeadline(state, cs4)).toBe("2026-12-14");
    expect(security(m, "CS-4").repurchaseable.toString()).toBe("34500");
  });

  it("previews the scheduled termination of S14 on 2026-12-04 (§3.12, P7)", () => {
    const effects = e.terminationPreview(state, uuid("S14"), { terminationDate: "2026-12-04", terminationType: "voluntary", vestingStopDate: "2026-12-04" });
    const byId = new Map(effects.map((x) => [x.securityId, x]));
    expect(byId.get(uuid("OPT-18"))).toMatchObject({ vestedAtStop: e.Dec.from(50625), cancel: e.Dec.from(39375), contractualDeadline: "2027-03-04", isoDeadline: "2027-03-04" });
    expect(byId.get(uuid("OPT-43"))?.cancel.toString()).toBe("35000");
    expect(byId.get(uuid("OPT-54"))?.cancel.toString()).toBe("15000");
    expect(e.Dec.sum(effects.map((x) => x.poolReturn)).toString()).toBe("89375");
  });

  it("matches the ISO $100K split (§3.9)", () => {
    const rachel = e.isoSplit(state, uuid("S13"));
    expect(rachel).toHaveLength(1);
    const opt33 = rachel[0]!;
    expect([opt33.iso.toString(), opt33.nso.toString()]).toEqual(["396930", "3070"]);
    expect(opt33.years[0]).toMatchObject({ year: 2026, shares: e.Dec.from(108333), iso: e.Dec.from(105263), nso: e.Dec.from(3070) });
    expect(opt33.years[0]!.value!.roundTo(2, "HALF_EVEN").toString()).toBe("102916.35");
    const value = (label: string, year: number) => e.isoYearValue(state, uuid(label), year).roundTo(2, "HALF_EVEN").toString();
    expect(value("S04", 2026)).toBe("42875");
    expect(value("S05", 2026)).toBe("55900");
    expect(value("S07", 2026)).toBe("40500");
    expect(value("S08", 2026)).toBe("32100");
    // Only OPT-33 splits.
    for (const holder of ["S04", "S05", "S06", "S07", "S08", "S09", "S11", "S12"]) {
      for (const grant of e.isoSplit(state, uuid(holder))) expect(grant.nso.toString(), `${holder} ${grant.displayId}`).toBe("0");
    }
  });

  it("shows S04's portfolio: options, vested and the next vests (§3.20)", () => {
    const daniel = m.holders.find((h) => h.stakeholderId === uuid("S04"))!;
    expect(daniel.planAwards[acme.plan]?.toString()).toBe("470000");
    expect(daniel.vestedOptions.toString()).toBe("283333");
    expect(daniel.unvestedOptions.toString()).toBe("186667");
    expect(daniel.byClass[acme.cls.CS]?.toString()).toBe("50000");
    const upcoming = ["OPT-1", "OPT-16", "OPT-37"]
      .flatMap((label) => e.securityUpcomingVests(state, state.securities.get(uuid(label))!).map((v) => [v.date, v.quantity.toString()]))
      .sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
      .slice(0, 6);
    expect(upcoming).toEqual([
      ["2026-11-01", "6250"],
      ["2026-11-15", "2083"],
      ["2026-11-20", "30000"],
      ["2026-12-01", "6250"],
      ["2026-12-15", "2084"],
      ["2026-12-20", "2500"],
    ]);
  });

  it("matches the 409A statuses", () => {
    const v5 = VALUATIONS[4]!;
    expect(e.valuationStatus(v5, VALUATIONS, TODAY)).toBe("expiring_soon");
    expect(e.daysBetween(TODAY, v5.expirationDate!)).toBe(15);
    for (const v of VALUATIONS.slice(0, 4)) expect(e.valuationStatus(v, VALUATIONS, TODAY)).toBe("superseded");
    const fmv = e.fmvOn(VALUATIONS, TODAY, acme.cls.CS, []);
    expect(fmv.valid && fmv.pricePerShare.toString()).toBe("0.95");
  });

  it("matches the cap table as of 2025-12-31 (P2)", () => {
    const { m: then } = metricsAt(acme, "2025-12-31");
    expect(classIo(then, "CS")).toBe("9632000");
    expect(then.optionsOutstanding.toString()).toBe("3570000");
    expect(then.planAvailable.toString()).toBe("798000");
    expect(then.fullyDiluted.toString()).toBe("24312120");
  });

  it("matches the Rule 701 tracker and the Form 3921 population (X5, X4)", () => {
    const window = e.rule701Window(state, TODAY);
    expect(window.start).toBe("2025-10-22");
    expect(window.totalShares.toString()).toBe("1715000");
    expect(window.totalValue.toString()).toBe("1629250");
    const common = e.classOutstanding(acme.b.replay("2026-06-30"), acme.cls.CS);
    expect(common.toString()).toBe("9724000");
    const verdict = e.rule701Test(window, { totalAssets: e.Dec.from(14000000), classOutstanding: common });
    expect(verdict).toMatchObject({ ok: true, governing: "TOTAL_ASSETS_15", enhancedDisclosure: false });
    expect(verdict.limits.map((l) => [l.kind, l.limit.toString(), l.ok])).toEqual([
      ["FIXED_1M", "1000000", false],
      ["TOTAL_ASSETS_15", "2100000", true],
      ["CLASS_OUTSTANDING_15", "1458600", false],
    ]);
    expect(e.formatPercent(verdict.limits[1]!.used, 1)).toBe("77.6%");
    expect(e.formatPercent(e.Rational.fromDec(window.totalShares).div(e.Rational.fromDec(common)))).toBe("17.64%");

    const forms = e.form3921Records(state, 2026);
    expect(forms.map((f) => [f.grantDate, f.exerciseDate, f.exercisePricePerShare?.toString(), f.fmvPerShare?.toString(), f.shares.toString()])).toEqual([
      ["2024-03-15", "2026-02-10", "0.18", "0.95", "42000"],
      ["2023-04-14", "2026-03-20", "0.1", "0.95", "50000"],
    ]);
    expect(forms.every((f) => !f.nonUsHolder)).toBe(true);
    expect(e.form3921Records(state, 2025).map((f) => f.shares.toString())).toEqual(["60000"]);
  });

  it("hashes the replay deterministically (I20)", () => {
    expect(e.replayHash(state)).toBe(e.replayHash(acme.b.replay(TODAY, { today: TODAY })));
    expect(e.replayHash(state)).toMatch(/^[0-9a-f]{64}$/);
    expect(e.replayHash(state)).not.toBe(e.replayHash(acme.b.replay("2025-12-31")));
  });
});

describe("the complete synthetic company lifecycle", SLOW, () => {
  it("moves the numbers step by step exactly as the cumulative ledger says", () => {
    const acme = buildAcme();
    const row = () => {
      const { state, m } = metricsAt(acme);
      expect(state.violations.filter((v) => v.severity === "error"), "no errors").toEqual([]);
      return [
        m.fullyDiluted.toString(),
        m.optionsOutstanding.toString(),
        m.planAvailable.toString(),
        classIo(m, "CS"),
        m.issuedAndOutstanding.toString(),
        m.capitalContribution.toString(),
        String(m.stakeholdersWithSecurities),
        String(m.executionPendingCount),
      ];
    };
    expect(row()).toEqual(["24312120", "3796250", "460750", "9743000", "19945120", "16147718.6", "38", "6"]);
    p4MarkExecuted(acme);
    expect(row()).toEqual(["24312120", "3796250", "460750", "9743000", "19945120", "16147718.6", "38", "5"]);
    p5GrantNewHire(acme);
    expect(row()).toEqual(["24312120", "3836250", "420750", "9743000", "19945120", "16147718.6", "39", "5"]);
    p6TerminateEmployee(acme);
    expect(row()).toEqual(["24312120", "3783125", "473875", "9743000", "19945120", "16147718.6", "39", "5"]);
    p8ExerciseFormerEmployee(acme);
    expect(row()).toEqual(["24312120", "3753125", "473875", "9773000", "19975120", "16157018.6", "39", "5"]);
    p9ExerciseAdvisor(acme);
    expect(row()).toEqual(["24312120", "3743125", "473875", "9783000", "19985120", "16158018.6", "39", "5"]);
    const before = e.replayHash(acme.b.replay(TODAY, { today: TODAY }));
    const { cancel } = p10CancelThenReverse(acme);
    expect(row()).toEqual(["24312120", "3743125", "473875", "9783000", "19985120", "16158018.6", "39", "5"]);
    // Cancel + reverse = no change, except the ledger seq.
    const after = e.stateSummary(acme.b.replay(TODAY, { today: TODAY }));
    const reference = e.stateSummary(acme.b.replay(TODAY, { today: TODAY, asKnownAt: acme.b.reference.commands.find((c) => c.id === cancel)!.firstSeq - 1 }));
    expect({ ...after, ledgerSeq: 0, asKnownAt: 0 }).toEqual({ ...reference, ledgerSeq: 0, asKnownAt: 0 });
    expect(before).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives each step its expected details (P5, P6, P8, P9)", () => {
    const acme = buildAcme();
    runRecommendedR1(acme);
    const { state, m } = metricsAt(acme);
    // P5: the new hire's grant, generated from the VS-1 template: cliff 10,000 on 2027-10-19, then 833/834 a month.
    const opt57 = state.securities.get(uuid("OPT-57"))!;
    const tranches = e.securityVestingTimeline(state, opt57);
    expect(tranches[0]).toMatchObject({ date: "2027-10-19", kind: "CLIFF" });
    expect(tranches[0]!.quantity.toString()).toBe("10000");
    expect(tranches.slice(1, 3).map((t) => t.quantity.toString())).toEqual(["833", "833"]);
    expect(tranches.slice(1, 4).map((t) => t.quantity.toString())).toContain("834");
    expect(tranches).toHaveLength(37);
    expect(e.Dec.sum(tranches.map((t) => t.quantity)).toString()).toBe("40000");
    expect(e.isoYearValue(state, uuid("S41"), 2027).roundTo(2, "HALF_EVEN").toString()).toBe("11082.7");
    const employees = m.holders.filter((h) => h.relationship === "employee").reduce((sum, h) => sum.add(h.fullyDiluted), e.Dec.ZERO);
    // P5 adds 40,000 to employees; P6 moves S10 (105,000 − 53,125 cancelled = 51,875) to former employees.
    expect(employees.toString()).toBe(e.Dec.from(2935000).sub(105000).toString());
    // P6: S10 terminated, FD 51,875, deadlines 2027-01-21.
    expect(holderFd(m, "S10")).toBe("51875");
    expect(m.holders.find((h) => h.stakeholderId === uuid("S10"))!.relationship).toBe("ex_employee");
    for (const label of ["OPT-12", "OPT-30"]) {
      const sec = state.securities.get(uuid(label))!;
      expect(e.contractualDeadline(sec)?.date).toBe("2027-01-21");
      expect(e.isoDeadline(state, sec)?.date).toBe("2027-01-21");
    }
    expect(security(m, "OPT-52").status).toBe("CANCELLED");
    // P8: CS-9 30,000; OPT-20 30,000 left; S21 FD 60,000; the 2026 Form 3921 population gains the ISO exercise.
    expect(security(m, "CS-9").outstanding.toString()).toBe("30000");
    expect(security(m, "OPT-20").outstanding.toString()).toBe("30000");
    expect(holderFd(m, "S21")).toBe("60000");
    expect(e.form3921Records(state, 2026).map((f) => [f.grantDate, f.exerciseDate, f.exercisePricePerShare?.toString(), f.shares.toString()])).toContainEqual([
      "2024-08-15",
      "2026-10-20",
      "0.31",
      "30000",
    ]);
    // P9: an NSO exercise is never on Form 3921.
    expect(security(m, "OPT-9").outstanding.toString()).toBe("40000");
    expect(e.form3921Records(state, 2026)).toHaveLength(3);
    // P10: OPT-56 is outstanding and execution pending again.
    expect(security(m, "OPT-56")).toMatchObject({ status: "OUTSTANDING", executionStatus: "pending_company" });
    expect(security(m, "OPT-50").executionStatus).toBe("executed");
    expect(e.verifyCommandSeals(acme.b.reference.commands, acme.b.transactions)).toEqual([]);
    expect(e.verifyChain(acme.b.orgId, acme.b.rows).ok).toBe(true);
    expect(e.formatMoney(m.capitalContribution)).toBe("$16,158,018.60");
  });

  it("repurchases S24's unvested shares under the plan rules (X3)", () => {
    const acme = buildAcme();
    const before = metricsAt(acme).m;
    acme.b.command(
      "repurchase:CS-4",
      (c) => {
        c.tx("TX_STOCK_REPURCHASE", TODAY, {
          security_id: acme.id("CS-4"),
          quantity: "34500",
          price: { amount: "0.31", currency: "USD" },
          x_kind: "UNVESTED",
          x_consideration: { amount: "10695", currency: "USD" },
        });
      },
      { source: "app" },
    );
    const { state, m } = metricsAt(acme);
    expect(state.violations).toEqual([]);
    expect(classIo(m, "CS")).toBe(e.Dec.from(classIo(before, "CS")).sub(34500).toString());
    expect(plan(m).availableToGrant.sub(plan(before).availableToGrant).toString()).toBe("34500");
    expect(m.fullyDiluted.toString()).toBe("24312120");
    expect(m.capitalContribution.toString()).toBe("16147718.6"); // gross: the repurchase never nets against it
    expect(security(m, "CS-4")).toMatchObject({ outstanding: e.Dec.from(37500), repurchaseable: e.Dec.ZERO });
  });

  it("refuses a material event's FMV and takes the new 409A (P11)", () => {
    const material: e.ValuationRecord = { ...VALUATIONS[4]!, events: [{ id: uuid("me:1"), kind: "MATERIAL_EVENT", eventDate: "2026-10-19", reversesEventId: null }] };
    const v6: e.ValuationRecord = { id: uuid("V6"), valuationType: "409A", reportVersion: "FINAL", effectiveDate: TODAY, expirationDate: "2027-10-21", prices: [{ stockClassId: uuid("class:CS"), pricePerShare: "1.12" }], events: [] };
    const before = [...VALUATIONS.slice(0, 4), material];
    expect(e.valuationStatus(material, before, "2026-10-20")).toBe("review_required");
    expect(e.fmvOn(before, "2026-10-20", uuid("class:CS"), [])).toMatchObject({ valid: false, reason: "review_required" });
    const after = [...before, v6];
    expect(e.valuationStatus(material, after, TODAY)).toBe("superseded");
    expect(e.valuationStatus(v6, after, TODAY)).toBe("presumptively_valid");
    const fmv = e.fmvOn(after, TODAY, uuid("class:CS"), []);
    expect(fmv.valid && fmv.pricePerShare.toString()).toBe("1.12");
    expect(e.fmvOn(after, "2026-10-20", uuid("class:CS"), [])).toMatchObject({ valid: false });
  });
});
