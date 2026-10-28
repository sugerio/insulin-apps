import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { usd, uuid } from "./fixtures/builder.ts";
import { codes, exercise, grant, issueStock, miniOrg, terminate } from "./fixtures/mini.ts";

const D = "2026-06-30";

function leave(m: ReturnType<typeof miniOrg>, holder: string, start: string, end: string | null, returnGuaranteed: boolean): void {
  m.b.command(`leave:${holder}:${start}`, (c) => {
    c.tx("X_STAKEHOLDER_LEAVE", start, { stakeholder_id: holder, start_date: start, end_date: end, return_guaranteed: returnGuaranteed });
  }, { source: "app" });
}

describe("termination windows", () => {
  it("maps API windows to OCF windows", () => {
    expect(e.terminationWindowFromApi({ period: "2", unit: "QUARTERS", reason: "RETIREMENT" })).toEqual({ reason: "VOLUNTARY_RETIREMENT", period: 6, period_type: "MONTHS" });
    expect(e.terminationWindowFromApi({ period: "0", unit: "DAYS", reason: "WITH_CAUSE" })).toEqual({ reason: "INVOLUNTARY_WITH_CAUSE", period: 0, period_type: "DAYS" });
    expect(e.terminationWindowFromApi({ period: "1", unit: "YEARS", reason: "DEATH" }).reason).toBe("INVOLUNTARY_DEATH");
    expect(() => e.terminationWindowFromApi({ period: "1.5", unit: "MONTHS", reason: "VOLUNTARY" })).toThrow(RangeError);
    expect(e.WINDOW_REASON_FOR_TERMINATION.disability).toBe("INVOLUNTARY_DISABILITY");
    expect(e.windowEnd("2026-08-31", { period: 6, period_type: "MONTHS" })).toBe("2027-02-28");
  });

  it("uses the grant's window, else the plan default at grant, capped at expiration", () => {
    const m = miniOrg();
    const own = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, windows: [{ reason: "VOLUNTARY_OTHER", period: 30, period_type: "DAYS" }] });
    const inherited = grant(m, "OPT-2", m.alice, "100", "2025-01-01", { vesting: null, windows: [] });
    const short = grant(m, "OPT-3", m.alice, "100", "2025-01-01", { vesting: null, expiration: "2025-04-15" });
    const planless = grant(m, "OPT-4", m.alice, "100", "2025-01-01", { vesting: null, windows: [], planId: null });
    const state = m.b.replay(D);
    const at = (id: string) => e.computeContractualDeadline(state, state.securities.get(id)!, "2025-03-01", "voluntary");
    expect(at(own)).toBe("2025-03-31");
    expect(at(inherited)).toBe("2025-06-01");
    expect(at(short)).toBe("2025-04-15");
    expect(at(planless)).toBeNull();
    expect(e.windowFor(state, state.securities.get(own)!, "death")?.period).toBe(12); // falls back to the plan's
    expect(e.planTermsOn(state, null, D)).toBeNull();
    expect(e.planTermsOn(state, uuid("ghost"), D)).toBeNull();
    expect(e.planTermsOn(state, m.plan, "2023-01-01")).toBeNull();
  });

  it("describes where a deadline comes from", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const onePeriod = grant(m, "OPT-2", m.alice, "100", "2025-01-01", { vesting: null, windows: [{ reason: "INVOLUNTARY_WITH_CAUSE", period: 1, period_type: "DAYS" }] });
    terminate(m, "alice", m.alice, "2025-03-01", { type: "with_cause" });
    const state = m.b.replay(D);
    expect(e.contractualDeadline(state.securities.get(option)!)).toMatchObject({ date: "2025-03-01", source: "termination", reason: "0 days after with cause termination" });
    expect(e.contractualDeadline(state.securities.get(onePeriod)!)?.reason).toBe("1 day after with cause termination");
    const synthetic = { ...state.securities.get(option)!, computedDeadline: { ...state.securities.get(option)!.computedDeadline!, window: null } };
    expect(e.contractualDeadline(synthetic)?.reason).toBe("no exercise window recorded for with cause termination");
    expect(e.contractualDeadline({ ...synthetic, termination: null, extendedDeadline: null })).toBeNull();
  });
});

describe("the ISO deadline", () => {
  it("is 3 months after termination, 12 with the disability attestation, none after death", () => {
    const m = miniOrg();
    const iso = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const nso = grant(m, "OPT-2", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    const active = grant(m, "OPT-3", m.carol, "100", "2025-01-01", { vesting: null });
    let state = m.b.replay(D);
    expect(e.isoDeadline(state, state.securities.get(active)!)).toBeNull();
    expect(e.isoDeadline(state, state.securities.get(nso)!)).toBeNull();
    const cases: [e.TerminationType, boolean | undefined, string | null, string][] = [
      ["voluntary", undefined, "2025-06-01", "termination"],
      ["disability", true, "2026-03-01", "disability"],
      ["disability", false, "2025-06-01", "termination"],
      ["death", undefined, null, "death"],
    ];
    for (const [type, attestation, date, kind] of cases) {
      const t = miniOrg();
      const option = grant(t, "OPT-1", t.alice, "100", "2025-01-01", { vesting: null });
      terminate(t, "alice", t.alice, "2025-03-01", { type, attestation });
      state = t.b.replay(D);
      expect(e.isoDeadline(state, state.securities.get(option)!), `${type} ${attestation}`).toMatchObject({ date, kind, employmentEnd: "2025-03-01" });
    }
    terminate(m, "alice", m.alice, "2025-03-01");
    state = m.b.replay(D);
    expect(e.isoDeadline(state, state.securities.get(iso)!)?.reason).toBe("3 months after termination");
  });

  it("never runs past the contractual deadline or the expiration", () => {
    const m = miniOrg();
    const cause = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    terminate(m, "alice", m.alice, "2025-03-01", { type: "with_cause" });
    const expiring = grant(m, "OPT-2", m.carol, "100", "2025-01-01", { vesting: null, expiration: "2025-04-01", windows: [{ reason: "VOLUNTARY_OTHER", period: 12, period_type: "MONTHS" }] });
    terminate(m, "carol", m.carol, "2025-03-01");
    const state = m.b.replay(D);
    expect(e.isoDeadline(state, state.securities.get(cause)!)).toMatchObject({ date: "2025-03-01", reason: "3 months after termination, capped at the contractual deadline" });
    expect(e.isoDeadline(state, state.securities.get(expiring)!)).toMatchObject({ date: "2025-04-01" });
  });

  it("is fixed when employment ends and extending a shorter window never moves it", () => {
    const m = miniOrg();
    // A 30-day post-termination window: the ISO deadline is capped at it, well before the statutory 3 months.
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, windows: [{ reason: "VOLUNTARY_OTHER", period: 30, period_type: "DAYS" }] });
    terminate(m, "alice", m.alice, "2025-03-01");
    let state = m.b.replay(D);
    expect(e.isoDeadline(state, state.securities.get(option)!)).toMatchObject({ date: "2025-03-31", reason: "3 months after termination, capped at the contractual deadline" });
    // A separation agreement then extends the window to year end.
    m.b.command("extend", (c) => {
      c.tx("X_SECURITY_MODIFICATION", "2025-03-15", { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: option, new_contractual_deadline: "2025-12-31" });
    }, { source: "app" });
    exercise(m, "CS-1", option, m.alice, "10", "2025-05-01", { portion: "ISO" });
    state = m.b.replay(D);
    const s = state.securities.get(option)!;
    expect(e.contractualDeadline(s)?.date).toBe("2025-12-31");
    expect(e.isoDeadline(state, s)?.date).toBe("2025-03-31"); // not 2025-06-01: the extension doesn't lengthen it
    // The exercise is inside the extended window, but its ISO shares are after the ISO deadline: NSO, no Form 3921.
    expect(codes(state)).toEqual(["ISO_PORTION_AFTER_ISO_DEADLINE"]);
    expect(e.form3921Records(state, 2025)).toEqual([]);
  });

  it("ends employment the day after the third month of a long leave without a guaranteed return", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    leave(m, m.alice, "2025-02-10", null, false);
    let state = m.b.replay(D);
    expect(e.isoDeadline(state, state.securities.get(option)!)).toMatchObject({ date: "2025-08-11", kind: "leave", employmentEnd: "2025-05-11" });
    terminate(m, "alice", m.alice, "2025-12-01");
    state = m.b.replay(D);
    expect(e.isoDeadline(state, state.securities.get(option)!)?.kind).toBe("leave"); // the leave ended employment first
    const t = miniOrg();
    const other = grant(t, "OPT-1", t.alice, "100", "2025-01-01", { vesting: null });
    leave(t, t.alice, "2025-02-10", "2025-04-01", false); // back within 3 months
    leave(t, t.alice, "2025-06-01", null, true); // a guaranteed return
    state = t.b.replay(D);
    expect(e.isoDeadline(state, state.securities.get(other)!)).toBeNull();
    expect(e.leaveEmploymentEnd(undefined)).toBeNull();
    leave(t, t.alice, "2025-09-01", "2026-03-01", false);
    leave(t, t.alice, "2025-08-01", null, false);
    state = t.b.replay(D);
    expect(e.leaveEmploymentEnd(state.stakeholders.get(t.alice))).toBe("2025-11-02");
  });

  it("keeps the later record of a leave with the same start date, so its end, once known, closes it", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    leave(m, m.alice, "2025-02-10", null, false);
    let state = m.b.replay(D);
    expect(e.isoDeadline(state, state.securities.get(option)!)?.kind).toBe("leave");
    // Back on 2025-04-01, within three months: recorded again with its end, the leave no longer ends employment.
    m.b.command("leave:alice:2025-02-10:end", (c) => {
      c.tx("X_STAKEHOLDER_LEAVE", "2025-02-10", { stakeholder_id: m.alice, start_date: "2025-02-10", end_date: "2025-04-01", return_guaranteed: false });
    }, { source: "app" });
    state = m.b.replay(D);
    expect(state.stakeholders.get(m.alice)!.leaves).toEqual([expect.objectContaining({ startDate: "2025-02-10", endDate: "2025-04-01", returnGuaranteed: false })]);
    expect(e.isoDeadline(state, state.securities.get(option)!)).toBeNull();
  });
});

describe("exercisability and expiry", () => {
  it("is vested outstanding unless a gate closes it", () => {
    const m = miniOrg();
    const vesting = grant(m, "OPT-1", m.alice, "4800", "2025-01-01");
    const pending = grant(m, "OPT-2", m.alice, "100", "2025-01-01", { vesting: null, execution: "pending_both" });
    const expired = grant(m, "OPT-3", m.alice, "100", "2025-01-01", { vesting: null, expiration: "2026-01-01" });
    const early = grant(m, "OPT-4", m.alice, "4800", "2026-01-01", { early: true });
    const done = grant(m, "OPT-5", m.carol, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    exercise(m, "CS-1", done, m.carol, "100", "2025-02-01", { portion: "NSO" });
    const rsu = grant(m, "RSU-1", m.alice, "100", "2025-01-01", { type: "RSU", vesting: null });
    const stock = issueStock(m, "CS-2", m.bob, "1", "2025-01-01");
    const fired = grant(m, "OPT-6", m.bob, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    m.b.command("bob-out", (c) => {
      c.tx("X_STAKEHOLDER_TERMINATION", "2025-03-01", { stakeholder_id: m.bob, termination_date: "2025-03-01", termination_type: "voluntary", vesting_stop_date: "2025-03-01", relationship_before: "investor", relationship_after: "investor" });
    });
    const state = m.b.replay(D);
    const of = (id: string, date?: string) => e.exercisability(state, state.securities.get(id)!, date);
    expect(of(vesting)).toMatchObject({ exercisable: e.Dec.from(1700), blockedBy: null });
    expect(of(vesting, "2025-06-01").blockedBy).toBe("nothing_vested");
    expect(of(pending).blockedBy).toBe("execution_pending");
    expect(of(expired).blockedBy).toBe("past_expiration");
    expect(of(done).blockedBy).toBe("not_outstanding");
    expect(of(rsu).blockedBy).toBe("not_exercisable_type");
    expect(of(stock).blockedBy).toBe("not_exercisable_type");
    expect(of(fired).blockedBy).toBe("past_contractual_deadline");
    expect(of(early)).toMatchObject({ exercisable: e.Dec.ZERO, exercisableIncludingUnvested: e.Dec.from(4800), blockedBy: null });
    expect(e.lastExerciseDate(state.securities.get(fired)!)).toBe("2025-06-01");
    expect(e.lastExerciseDate(state.securities.get(expired)!)).toBe("2026-01-01");
    expect(e.lastExerciseDate({ ...state.securities.get(fired)!, expirationDate: null })).toBe("2025-06-01");
    expect(e.lastExerciseDate({ ...state.securities.get(stock)! })).toBeNull();
  });

  it("lists what the daily job expires, effective the day after the last exercise day", () => {
    const m = miniOrg();
    const fired = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const old = grant(m, "OPT-2", m.carol, "100", "2025-01-01", { vesting: null, expiration: "2026-01-01" });
    let warrant = "";
    m.b.command("warrant", (c) => {
      warrant = c.security("WAR-1", { family: "WARRANT", subtype: "WARRANT", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_WARRANT_ISSUANCE", "2025-01-01", { security_id: warrant, custom_id: "WAR-1", stakeholder_id: m.bob, quantity: "5", purchase_price: usd("0"), warrant_expiration_date: "2025-12-31" });
    });
    const termination = terminate(m, "alice", m.alice, "2025-03-01");
    const state = m.b.replay(D);
    const candidates = e.expiryCandidates(state);
    expect(candidates.map((c) => [c.securityId, c.reason, c.lastExerciseDate, c.effectiveDate, c.quantity.toString(), c.dependsOnCommandId])).toEqual(
      [
        [fired, "contractual_deadline", "2025-06-01", "2025-06-02", "100", termination],
        [old, "expiration", "2026-01-01", "2026-01-02", "100", null],
        [warrant, "expiration", "2025-12-31", "2026-01-01", "5", null],
      ].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
    expect(e.expiryCandidates(state, "2025-06-01")).toEqual([]);
  });

  it("knows the last day to repurchase a leaver's unvested shares", () => {
    const m = miniOrg();
    const restricted = issueStock(m, "CS-1", m.alice, "100", "2025-01-01", { planId: m.plan, origin: "RSA", vestingMonths: { start: "2025-01-01", months: 10, cliff: 0 } });
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01");
    let state = m.b.replay(D);
    expect(e.repurchaseDeadline(state, state.securities.get(restricted)!)).toBeNull(); // no termination yet
    expect(e.repurchaseDeadline(state, state.securities.get(option)!)).toBeNull();
    terminate(m, "alice", m.alice, "2025-03-01");
    state = m.b.replay(D);
    expect(e.repurchaseDeadline(state, state.securities.get(restricted)!)).toBe("2025-05-30"); // the plan's 90 days
    m.b.command("deadline", (c) => {
      c.tx("X_SECURITY_MODIFICATION", "2025-03-02", { kind: "REPURCHASE_DEADLINE", security_id: restricted, last_repurchase_date: "2025-04-01" });
    });
    state = m.b.replay(D);
    expect(e.repurchaseDeadline(state, state.securities.get(restricted)!)).toBe("2025-04-01");
    const n = miniOrg({ planTerms: false });
    const lot = issueStock(n, "CS-1", n.alice, "100", "2025-01-01", { vestingMonths: { start: "2025-01-01", months: 10, cliff: 0 } });
    terminate(n, "alice", n.alice, "2025-03-01");
    state = n.b.replay(D);
    expect(e.repurchaseDeadline(state, state.securities.get(lot)!)).toBeNull();
  });
});

describe("the termination preview", () => {
  it("shows vested, cancelled, deadlines and pool returns per lot", () => {
    const m = miniOrg({ rules: { cancelled_unvested_awards: "RETIRE" } });
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01", { vesting: { months: 48, cliff: 0 } });
    const later = grant(m, "OPT-2", m.alice, "100", "2026-07-01");
    const restricted = issueStock(m, "CS-1", m.alice, "100", "2025-01-01", { vestingMonths: { start: "2025-01-01", months: 10, cliff: 0 } });
    issueStock(m, "CS-2", m.alice, "100", "2025-01-01"); // no vesting: not affected
    const planless = grant(m, "OPT-3", m.alice, "100", "2025-01-01", { planId: null, windows: [] });
    const state = m.b.replay("2026-07-31"); // as of the termination date, when OPT-2 exists
    const effects = e.terminationPreview(state, m.alice, {
      terminationDate: "2026-07-31",
      terminationType: "voluntary",
      vestingStopDate: "2026-06-30",
      accelerations: { [option]: e.Dec.from(100000) },
    });
    const byId = new Map(effects.map((x) => [x.securityId, x]));
    expect(byId.get(option)).toMatchObject({
      vestedAtStop: e.Dec.from(1700),
      acceleration: e.Dec.from(3100),
      keep: e.Dec.from(4800),
      cancel: e.Dec.ZERO,
      contractualDeadline: "2026-10-31",
      isoDeadline: "2026-10-31",
      poolReturn: e.Dec.ZERO,
    });
    expect(byId.get(later)?.blockedBy).toBe("stop_before_issue");
    expect(byId.get(restricted)).toMatchObject({ family: "STOCK", unvestedShares: e.Dec.ZERO, vestedAtStop: e.Dec.from(100) });
    // 35 vested by the stop; no window anywhere, so no contractual deadline, but the statutory ISO rule still applies.
    expect(byId.get(planless)).toMatchObject({ cancel: e.Dec.from(65), contractualDeadline: null, isoDeadline: "2026-10-31", poolReturn: e.Dec.ZERO });
    expect(effects).toHaveLength(4);
  });

  it("applies the death, disability and leave rules to the ISO deadline", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    leave(m, m.alice, "2025-02-10", null, false);
    const state = m.b.replay(D);
    const preview = (type: e.TerminationType, attestation?: boolean) =>
      e.terminationPreview(state, m.alice, { terminationDate: "2026-06-30", terminationType: type, vestingStopDate: "2026-06-30", disabilityAttestation: attestation })[0]!;
    expect(preview("death").isoDeadline).toBeNull();
    expect(preview("death").contractualDeadline).toBe("2027-06-30");
    expect(preview("voluntary").isoDeadline).toBe("2025-08-11"); // the leave ended employment for the ISO test
    const n = miniOrg();
    grant(n, "OPT-1", n.alice, "100", "2025-01-01", { vesting: null });
    const fresh = n.b.replay(D);
    expect(e.terminationPreview(fresh, n.alice, { terminationDate: "2026-06-30", terminationType: "disability", vestingStopDate: "2026-06-30", disabilityAttestation: true })[0]!.isoDeadline).toBe("2027-06-30");
    expect(e.terminationPreview(fresh, n.alice, { terminationDate: "2026-06-30", terminationType: "disability", vestingStopDate: "2026-06-30" })[0]!.isoDeadline).toBe("2026-09-30");
    expect(state.securities.get(option)!.termination).toBeNull(); // a preview writes nothing
  });
});
