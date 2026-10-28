import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { usd, uuid } from "./fixtures/builder.ts";
import { SAMPLE_PAYLOADS } from "./fixtures/payloads.ts";
import { addStock, codes, exercise, grant, issueStock, miniOrg, terminate, type Mini } from "./fixtures/mini.ts";

/**
 * Lineage counts each derived lot once, and every exercise carries its tax portions and the
 * ISO/NSO lots it consumed (§6.8), which Form 3921 reads.
 */

const D = "2026-06-30";
const A = uuid("lot:a");
const B = uuid("lot:b");

/** Types whose payload lists resulting lots, with the extra fields their sample needs. */
const SPLITTING_TYPES = [
  "TX_STOCK_TRANSFER",
  "TX_STOCK_CONVERSION",
  "TX_STOCK_REISSUANCE",
  "TX_EQUITY_COMPENSATION_EXERCISE",
  "TX_EQUITY_COMPENSATION_RELEASE",
  "TX_EQUITY_COMPENSATION_TRANSFER",
  "TX_WARRANT_EXERCISE",
  "TX_WARRANT_TRANSFER",
  "TX_CONVERTIBLE_CONVERSION",
  "TX_CONVERTIBLE_TRANSFER",
] as const;

/** An exercise of an option by its holder, written by hand so a test can state any portion and lots. */
function rawExercise(m: Mini, label: string, option: string, date: string, quantity: string, portions: { portion: "ISO" | "NSO"; quantity: string; reason?: "AFTER_ISO_DEADLINE" | "ISO_LIMIT" | "LOT_CHOICE"; issuedAs?: "ISO" | "NSO" }[], lots: { iso: string; nso: string }, extra: Record<string, unknown> = {}): string {
  return m.b.command(label, (c) => {
    const ids = portions.map((p, i) => c.security(`${label}:${i}`, { family: "STOCK", subtype: "COMMON", stakeholderId: m.alice, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: option }));
    c.tx("TX_EQUITY_COMPENSATION_EXERCISE", date, {
      security_id: option,
      quantity,
      resulting_security_ids: ids,
      x_portions: portions.map((p, i) => ({ portion: p.portion, quantity: p.quantity, security_id: ids[i]!, ...(p.reason ? { reason: p.reason } : {}) })),
      x_lots_consumed: lots,
      x_fmv: { price_per_share: usd("2"), valuation_id: null, source: "MANUAL", source_note: "Board determination" },
      ...extra,
    });
    portions.forEach((p, i) => {
      c.tx("TX_STOCK_ISSUANCE", date, {
        security_id: ids[i]!,
        custom_id: `${label}-${i}`,
        stakeholder_id: m.alice,
        stock_class_id: m.common,
        stock_plan_id: m.plan,
        share_price: usd("1"),
        quantity: p.quantity,
        x_origin: "EXERCISE",
        x_source_security_id: option,
        x_portion: p.issuedAs ?? p.portion,
      });
    });
  }, { source: "app" });
}

describe("each derived lot counts once (I2, I4)", () => {
  it("refuses repeated, overlapping or self-referencing lot ids in every lot-splitting payload", () => {
    for (const type of SPLITTING_TYPES) {
      const sample = SAMPLE_PAYLOADS[type] as Record<string, unknown> & { security_id: string };
      expect(() => e.parsePayload(type, sample), type).not.toThrow();
      expect(() => e.parsePayload(type, { ...sample, resulting_security_ids: [A, A] }), type).toThrow(/listed once/);
      expect(() => e.parsePayload(type, { ...sample, resulting_security_ids: [sample.security_id] }), type).toThrow(/all different lots/);
      if ("balance_security_id" in sample || type.endsWith("_TRANSFER") || type.endsWith("_CONVERSION")) {
        expect(() => e.parsePayload(type, { ...sample, resulting_security_ids: [A], balance_security_id: A }), type).toThrow(/all different lots/);
        expect(() => e.parsePayload(type, { ...sample, resulting_security_ids: [A], balance_security_id: sample.security_id }), type).toThrow(/all different lots/);
      }
    }
  });

  it("refuses a balance lot that is the source itself in every cancellation and repurchase", () => {
    for (const type of ["TX_STOCK_CANCELLATION", "TX_STOCK_REPURCHASE", "TX_EQUITY_COMPENSATION_CANCELLATION", "TX_WARRANT_CANCELLATION", "TX_CONVERTIBLE_CANCELLATION"] as const) {
      const sample = SAMPLE_PAYLOADS[type] as Record<string, unknown> & { security_id: string };
      expect(() => e.parsePayload(type, { ...sample, balance_security_id: B }), type).not.toThrow();
      expect(() => e.parsePayload(type, { ...sample, balance_security_id: sample.security_id }), type).toThrow(/new lot, not the source/);
    }
    // Past the schema, replay still refuses it: the source is no balance lot of itself.
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    m.b.command("cancel", (c) => c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", "2025-02-01", { security_id: option, quantity: "10", reason_text: "Waiver", x_reason: "HOLDER_WAIVER" }), { source: "app" });
    const cancellation = m.b.transactions[m.b.transactions.length - 1]!;
    (cancellation.payload as { balance_security_id?: string }).balance_security_id = option;
    expect(codes(m.b.replay(D))).toEqual(["BALANCE_LOT_MISSING"]);
  });

  it("never lets a 50-share lot listed twice stand for 100 transferred, even past the schema", () => {
    const m = miniOrg();
    const source = issueStock(m, "CS-1", m.alice, "100", "2025-01-01");
    let lot = "";
    m.b.command("transfer", (c) => {
      lot = addStock(m, c, "CS-2", m.bob, "50", "2025-02-01", { origin: "TRANSFER", source });
      c.tx("TX_STOCK_TRANSFER", "2025-02-01", { security_id: source, quantity: "100", resulting_security_ids: [lot] });
    }, { source: "app" });
    expect(codes(m.b.replay(D))).toEqual(["TRANSFER_NOT_CONSERVED"]);
    // A decoded transaction can't carry a repeated id, but replay doesn't trust that: the second listing adds nothing.
    const transfer = m.b.transactions.find((t) => t.type === "TX_STOCK_TRANSFER")!;
    (transfer.payload as { resulting_security_ids: string[] }).resulting_security_ids = [lot, lot];
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["LOT_CLAIMED_TWICE", "TRANSFER_NOT_CONSERVED"]);
    expect(state.violations[1]!.message).toContain("hold 50, expected 100");
  });

  it("refuses a lot two transactions both claim, so it can't satisfy both totals", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    m.b.command("double", (c) => {
      const lot = c.security("CS-9", { family: "STOCK", subtype: "COMMON", stakeholderId: m.alice, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: option });
      for (let i = 0; i < 2; i++) {
        c.tx("TX_EQUITY_COMPENSATION_EXERCISE", "2025-02-01", {
          security_id: option,
          quantity: "50",
          resulting_security_ids: [lot],
          x_portions: [{ portion: "NSO", quantity: "50", security_id: lot }],
          x_lots_consumed: { iso: "0", nso: "50" },
        });
      }
      c.tx("TX_STOCK_ISSUANCE", "2025-02-01", { security_id: lot, custom_id: "CS-9", stakeholder_id: m.alice, stock_class_id: m.common, stock_plan_id: m.plan, share_price: usd("1"), quantity: "50", x_origin: "EXERCISE", x_source_security_id: option, x_portion: "NSO" });
    }, { source: "app" });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["LOT_CLAIMED_TWICE", "RESULTING_QUANTITY_MISMATCH"]);
    expect(state.securities.get(option)!.exercised.toString()).toBe("100"); // 100 options exercised for 50 shares: refused
  });

  it("refuses duplicate exercise portions that would pass the ISO + NSO total, even past the schema", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    rawExercise(m, "dup", option, "2025-02-01", "100", [{ portion: "NSO", quantity: "50" }], { iso: "0", nso: "100" });
    const tx = m.b.transactions.find((t) => t.type === "TX_EQUITY_COMPENSATION_EXERCISE")!;
    const payload = tx.payload as { x_portions: unknown[] };
    payload.x_portions = [payload.x_portions[0], payload.x_portions[0]];
    expect(codes(m.b.replay(D))).toEqual(["RESULTING_QUANTITY_MISMATCH", "PORTION_MISMATCH"]);
  });
});

describe("exercise portions and frozen lots", () => {
  it("are required, one portion per resulting lot, at most one of each kind", () => {
    const sample = SAMPLE_PAYLOADS.TX_EQUITY_COMPENSATION_EXERCISE as Record<string, unknown>;
    const resulting = sample.resulting_security_ids as string[];
    const { x_portions: _portions, ...withoutPortions } = sample;
    const { x_lots_consumed: _lots, ...withoutLots } = sample;
    expect(() => e.parsePayload("TX_EQUITY_COMPENSATION_EXERCISE", withoutPortions)).toThrow(/x_portions/);
    expect(() => e.parsePayload("TX_EQUITY_COMPENSATION_EXERCISE", withoutLots)).toThrow(/x_lots_consumed/);
    expect(() => e.parsePayload("TX_EQUITY_COMPENSATION_EXERCISE", { ...sample, x_portions: [{ portion: "NSO", quantity: "10", security_id: B }] })).toThrow(/exactly one portion/);
    expect(() =>
      e.parsePayload("TX_EQUITY_COMPENSATION_EXERCISE", {
        ...sample,
        resulting_security_ids: [resulting[0]!, B],
        x_portions: [
          { portion: "NSO", quantity: "5", security_id: resulting[0]! },
          { portion: "NSO", quantity: "5", security_id: B },
        ],
      }),
    ).toThrow(/one ISO and one NSO/);
    expect(() => e.parsePayload("TX_EQUITY_COMPENSATION_EXERCISE", { ...sample, x_portions: [{ portion: "ISO", quantity: "10", security_id: resulting[0]!, reason: "ISO_LIMIT" }] })).toThrow(
      /Only an NSO portion/,
    );
  });

  it("tie ISO lots to ISO shares: the rest are withheld, or NSO after the ISO deadline with that reason", () => {
    const m = miniOrg({ pool: "1000000" });
    const option = grant(m, "OPT-1", m.alice, "1000", "2025-01-01", { vesting: null });
    terminate(m, "alice", m.alice, "2025-03-01"); // ISO deadline 2025-06-01 (3 months), contractual 2025-06-01
    // An ISO portion needs as many ISO lots.
    rawExercise(m, "too-few-lots", option, "2025-03-10", "10", [{ portion: "ISO", quantity: "10" }], { iso: "5", nso: "5" });
    // A net exercise: 3 of the 10 ISO lots consumed are withheld, so 7 ISO shares.
    rawExercise(m, "net", option, "2025-03-11", "10", [{ portion: "ISO", quantity: "7" }], { iso: "10", nso: "0" }, { x_withheld_quantity: "3" });
    // ISO lots recorded as NSO shares with no reason: Form 3921 would miss them.
    rawExercise(m, "silent-nso", option, "2025-03-12", "10", [{ portion: "NSO", quantity: "10" }], { iso: "10", nso: "0" });
    // "After the ISO deadline" on or before it isn't a reason.
    rawExercise(m, "early-late", option, "2025-05-01", "10", [{ portion: "NSO", quantity: "10", reason: "AFTER_ISO_DEADLINE" }], { iso: "10", nso: "0" });
    const state = m.b.replay(D);
    expect(state.violations.map((v) => [v.code, v.severity])).toEqual([
      // too-few-lots: 5 ISO lots for 10 ISO shares, and 5 NSO lots the grant doesn't have, skipping ISO lots.
      ["ISO_PORTION_EXCEEDS_ISO_LOTS", "error"],
      ["NSO_LOTS_EXCEEDED", "error"],
      ["LOT_CHOICE_NEEDS_REASON", "error"],
      // silent-nso: ISO lots recorded as NSO shares, with no reason.
      ["ISO_LOTS_RECORDED_AS_NSO", "error"],
      ["NSO_PORTION_NEEDS_REASON", "error"],
      // early-late: "after the ISO deadline" before it.
      ["AFTER_ISO_DEADLINE_REASON_INVALID", "error"],
    ]);
    const net = state.securities.get(option)!.exercises.find((x) => x.withheld.isPositive())!;
    expect([net.lotsConsumed.iso.toString(), net.portions[0]!.quantity.toString()]).toEqual(["10", "7"]);
    // Form 3921 lists the ISO portions within the ISO deadline: 10 (the first, flagged) and 7.
    expect(e.form3921Records(state, 2025).map((r) => r.shares.toString())).toEqual(["10", "7"]);
  });

  it("can't claim NSO lots an ISO grant doesn't have, skip ISO lots without a reason, or leave NSO shares unexplained", () => {
    const m = miniOrg({ pool: "1000000" });
    const option = grant(m, "OPT-1", m.alice, "1000", "2025-01-01", { vesting: null }); // $1,000 of ISO lots: all ISO
    // The review's case: every lot is ISO, yet the exercise claims NSO lots and records NSO shares with no reason.
    rawExercise(m, "nso-claim", option, "2025-02-01", "10", [{ portion: "NSO", quantity: "10" }], { iso: "0", nso: "10" });
    let state = m.b.replay(D);
    expect(codes(state)).toEqual(["NSO_LOTS_EXCEEDED", "LOT_CHOICE_NEEDS_REASON", "NSO_PORTION_NEEDS_REASON"]);
    expect(e.form3921Records(state, 2025)).toEqual([]); // the shares that should be ISO are flagged, not silently lost
    // Over the limit, the NSO lots exist: ISO lots first, the rest NSO "over the $100K limit", is clean.
    const n = miniOrg({ pool: "1000000" });
    const big = grant(n, "OPT-1", n.alice, "150000", "2025-01-01", { vesting: null });
    rawExercise(n, "iso-first", big, "2025-02-01", "120000", [{ portion: "ISO", quantity: "100000" }, { portion: "NSO", quantity: "20000", reason: "ISO_LIMIT" }], { iso: "100000", nso: "20000" });
    state = n.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(e.form3921Records(state, 2025).map((r) => r.shares.toString())).toEqual(["100000"]);
    // Another choice of lots needs its reason; with one, NSO lots may go first.
    const o = miniOrg({ pool: "1000000" });
    const chosen = grant(o, "OPT-1", o.alice, "150000", "2025-01-01", { vesting: null });
    rawExercise(o, "choice", chosen, "2025-02-01", "10", [{ portion: "NSO", quantity: "10", reason: "LOT_CHOICE" }], { iso: "0", nso: "10" });
    rawExercise(o, "choice-with-reason", chosen, "2025-02-02", "10", [{ portion: "NSO", quantity: "10", reason: "LOT_CHOICE" }], { iso: "0", nso: "10" }, { x_lot_reason: "Holder asked for NSO shares" });
    // ISO lots first (all 100,000), then 10 NSO lots labelled a lot choice: the label still needs the lot reason.
    rawExercise(o, "choice-label", chosen, "2025-02-03", "100010", [{ portion: "ISO", quantity: "100000" }, { portion: "NSO", quantity: "10", reason: "LOT_CHOICE" }], { iso: "100000", nso: "10" });
    const flagged = o.b.replay(D).violations.map((v) => [v.code, o.b.transactions.find((t) => t.id === v.transactionId)!.commandId]);
    expect(flagged).toEqual([
      ["LOT_CHOICE_NEEDS_REASON", o.b.commandIds.get("choice")!],
      ["LOT_CHOICE_NEEDS_REASON", o.b.commandIds.get("choice-label")!],
    ]);
  });

  it("accepts NSO shares after the ISO deadline with that reason, and leaves them out of Form 3921", () => {
    const m = miniOrg({ pool: "1000000" });
    const option = grant(m, "OPT-1", m.alice, "1000", "2025-01-01", { vesting: null, windows: [{ reason: "VOLUNTARY_OTHER", period: 12, period_type: "MONTHS" }] });
    terminate(m, "alice", m.alice, "2025-03-01"); // ISO deadline 2025-06-01; contractual 2026-03-01
    rawExercise(m, "late", option, "2025-07-01", "10", [{ portion: "NSO", quantity: "10", reason: "AFTER_ISO_DEADLINE" }], { iso: "10", nso: "0" });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(e.form3921Records(state, 2025)).toEqual([]);
  });

  it("checks that each resulting lot is issued as its portion, and warrant shares as none", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    rawExercise(m, "mislabeled", option, "2025-02-01", "10", [{ portion: "ISO", quantity: "10", issuedAs: "NSO" }], { iso: "10", nso: "0" });
    expect(codes(m.b.replay(D))).toEqual(["PORTION_MISMATCH"]);
    const n = miniOrg();
    n.b.command("warrant", (c) => {
      const warrant = c.security("WAR-1", { family: "WARRANT", subtype: "WARRANT", stakeholderId: n.bob, stockClassId: n.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_WARRANT_ISSUANCE", "2025-01-01", { security_id: warrant, custom_id: "WAR-1", stakeholder_id: n.bob, quantity: "10", exercise_price: usd("1"), purchase_price: usd("0") });
    });
    const warrant = n.b.reference.securities.find((s) => s.displayId === "WAR-1")!.id;
    n.b.command("exercise-warrant", (c) => {
      const lot = addStock(n, c, "CS-1", n.bob, "10", "2025-02-01", { origin: "EXERCISE", source: warrant });
      c.tx("TX_WARRANT_EXERCISE", "2025-02-01", { security_id: warrant, resulting_security_ids: [lot], x_quantity: "10" });
    }, { source: "app" });
    expect(n.b.replay(D).violations).toEqual([]);
    const issuance = n.b.transactions.find((t) => t.type === "TX_STOCK_ISSUANCE" && (t.payload as { custom_id: string }).custom_id === "CS-1")!;
    (issuance.payload as { x_portion?: string }).x_portion = "NSO";
    expect(codes(n.b.replay(D))).toEqual(["PORTION_MISMATCH"]);
  });

  it("keep the mini fixture's default: lots follow the portion", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    exercise(m, "CS-1", option, m.alice, "10", "2025-02-01");
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.securities.get(option)!.exercises[0]!.lotsConsumed).toEqual({ iso: e.Dec.from(10), nso: e.Dec.ZERO });
  });
});
