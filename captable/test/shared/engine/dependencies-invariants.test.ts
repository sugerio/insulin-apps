import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { PLAN_RULES } from "./fixtures/acme.ts";
import { usd, uuid } from "./fixtures/builder.ts";
import { addStock, cancel, codes, exercise, grant, issueStock, miniOrg, terminate } from "./fixtures/mini.ts";

const D = "2026-06-30";

function command(m: ReturnType<typeof miniOrg>, id: string): e.LedgerCommand {
  return m.b.reference.commands.find((c) => c.id === id)!;
}

/** Replays the ledger through a command, as the writer's dry run does, and returns the command's edges. */
function edges(m: ReturnType<typeof miniOrg>, id: string): e.DependencyEdge[] {
  const state = e.replay(m.b.reference, m.b.transactions.filter((t) => t.seq <= command(m, id).lastSeq), { asOf: "2099-12-31" });
  return e.commandDependencies(state, id);
}

describe("command dependencies", () => {
  /** A command's edges as "label:kind", for readable expectations. */
  function named(m: ReturnType<typeof miniOrg>, id: string, labels: Record<string, string>): string[] {
    const byId = new Map(Object.entries(labels).map(([label, commandId]) => [commandId, label]));
    return edges(m, id)
      .map((x) => `${byId.get(x.dependsOnCommandId) ?? x.dependsOnCommandId}:${x.kind}`)
      .sort();
  }

  it("makes a command acting on a lot rely on what issued it and on every earlier command that acted on it", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, execution: "pending_company" });
    const marked = m.b.command("mark", (c) => {
      c.tx("X_EXECUTION_STATUS", "2025-01-15", { security_id: option, status: "executed" });
    }, { source: "app" });
    const termination = terminate(m, "alice", m.alice, "2025-03-01");
    const extension = m.b.command("extend", (c) => {
      c.tx("X_SECURITY_MODIFICATION", "2025-05-01", { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: option, new_contractual_deadline: "2025-12-31" });
    }, { source: "app" });
    const early = exercise(m, "CS-1", option, m.alice, "10", "2025-04-01").command;
    // After the ISO deadline: the ISO lots it consumes are NSO shares, with that reason.
    const late = exercise(m, "CS-2", option, m.alice, "10", "2025-07-01", { portion: "NSO", lots: { iso: "10", nso: "0" }, reason: "AFTER_ISO_DEADLINE" }).command;
    const labels = { grant: m.b.commandIds.get("grant:OPT-1")!, marked, termination, extension, early, late };
    expect(named(m, marked, labels)).toEqual(["grant:consumes_security"]);
    expect(named(m, termination, labels)).toEqual(["grant:consumes_security", "marked:relies_on_terms"]);
    expect(named(m, extension, labels)).toEqual(["grant:consumes_security", "marked:relies_on_terms", "termination:relies_on_deadline"]);
    // Recorded after the extension but dated before it, the first exercise applies first: the extension then acted on
    // a lot the exercise had changed, so the exercise, which re-interprets what the extension saw, relies on it.
    expect(named(m, early, labels)).toEqual(["extension:relies_on_terms", "grant:consumes_security", "marked:relies_on_terms", "termination:relies_on_deadline"]);
    expect(named(m, late, labels)).toEqual([
      "early:consumes_security",
      "extension:relies_on_deadline",
      "grant:consumes_security",
      "marked:relies_on_terms",
      "termination:relies_on_deadline",
    ]);
    expect(m.b.replay(D).violations).toEqual([]);
    // So reversal on the lot runs newest first.
    const all = [marked, termination, extension, early, late].flatMap((id) => edges(m, id));
    const commands = m.b.reference.commands;
    for (const id of [marked, termination, extension, early]) expect(e.reversalRefusal(id, all, commands)).toBe("dependents_exist");
    expect(e.reversalRefusal(late, all, commands)).toBeNull();
  });

  it("makes an expiry rely on the deadline that ended the window and on the pool rule, and a grant on the plan terms", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const termination = terminate(m, "alice", m.alice, "2025-03-01");
    const expiry = cancel(m, "expire", option, "100", "2025-06-02", "EXPIRED");
    const setup = m.b.commandIds.get("mini:setup")!;
    const grantCommand = m.b.commandIds.get("grant:OPT-1")!;
    expect(named(m, expiry, { setup, grant: grantCommand, termination })).toEqual(["grant:consumes_security", "setup:relies_on_terms", "termination:relies_on_deadline"]);
    expect(edges(m, grantCommand)).toEqual([{ commandId: grantCommand, dependsOnCommandId: setup, kind: "relies_on_terms" }]);
    const n = miniOrg();
    const old = grant(n, "OPT-1", n.alice, "100", "2025-01-01", { vesting: null, expiration: "2025-06-01" });
    const lapse = cancel(n, "expire", old, "100", "2025-06-02", "EXPIRED");
    // Expired at the end of its term: no deadline edge, only the lot and the plan's pool rule.
    expect(named(n, lapse, { setup: n.b.commandIds.get("mini:setup")!, grant: n.b.commandIds.get("grant:OPT-1")! })).toEqual(["grant:consumes_security", "setup:relies_on_terms"]);
    const reversal = n.b.reverse(lapse, "2025-07-01");
    expect(edges(n, reversal)).toEqual([]);
  });

  it("makes pool returns, withholding and default exercise windows rely on the plan terms that decided them", () => {
    const m = miniOrg();
    const setup = m.b.commandIds.get("mini:setup")!;
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01");
    const planWindows = grant(m, "OPT-2", m.carol, "100", "2025-01-01", { vesting: null, windows: [] }); // the plan's default windows
    // New plan terms from 2025-06-01: unvested awards cancelled after it RETIRE instead of RETURN.
    const terms2 = m.b.command("terms-2", (c) => {
      c.tx("X_STOCK_PLAN_TERMS", "2025-06-01", {
        stock_plan_id: m.plan,
        return_rules: { ...PLAN_RULES, cancelled_unvested_awards: "RETIRE" },
        default_termination_windows: [],
        default_repurchase_window: null,
        status: "active",
        pour_over_plan_id: null,
      });
    }, { source: "app" });
    const waiver = cancel(m, "waiver", option, "100", "2025-07-01");
    const net = exercise(m, "CS-1", planWindows, m.carol, "50", "2025-07-01", { portion: "ISO", withheld: "10" }).command;
    const termination = terminate(m, "carol", m.carol, "2025-08-01");
    const labels = { setup, terms2, waiver, net, grant1: m.b.commandIds.get("grant:OPT-1")!, grant2: m.b.commandIds.get("grant:OPT-2")! };
    expect(named(m, waiver, labels)).toEqual(["grant1:consumes_security", "terms2:relies_on_terms"]);
    expect(named(m, net, labels)).toEqual(["grant2:consumes_security", "terms2:relies_on_terms"]);
    // OPT-2's window comes from the plan terms in force on its grant date, not from the later terms.
    expect(named(m, termination, labels)).toEqual(["grant2:consumes_security", "net:consumes_security", "setup:relies_on_terms"]);
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.securities.get(planWindows)!.computedDeadline?.deadline).toBe("2025-11-01"); // the setup's 3 months
    // Reversing terms-2 would silently move shares between "retired" and "returned": nothing breaks, so only the
    // edges stop it.
    const all = [terms2, waiver, net, termination].flatMap((id) => edges(m, id));
    expect(e.reversalRefusal(terms2, all, m.b.reference.commands)).toBe("dependents_exist");
    expect(e.reversalBlockers(terms2, all, m.b.reference.commands).map((c) => c.id)).toEqual([net, waiver]);
    const without = e.replay(m.b.reference, m.b.transactions.filter((t) => t.commandId !== terms2), { asOf: D });
    expect(e.violationsIntroduced(state.violations, without.violations)).toEqual([]);
    expect(without.plans.get(m.plan)!.retired.toString()).not.toBe(state.plans.get(m.plan)!.retired.toString());
  });

  it("makes a repurchase rely on the termination that opened the window and the plan's default window, and enforces it", () => {
    const m = miniOrg();
    const setup = m.b.commandIds.get("mini:setup")!;
    const lot = issueStock(m, "RS-1", m.alice, "4800", "2025-01-01", { planId: m.plan, origin: "RSA", vestingMonths: { start: "2025-01-01", months: 48, cliff: 12 }, txSource: "app" });
    const termination = terminate(m, "alice", m.alice, "2025-06-01");
    // New plan terms after the termination decide the repurchase's pool rule; the window still comes from the terms
    // in force at termination (the setup's 90 days).
    const terms2 = m.b.command("terms-2", (c) => {
      c.tx("X_STOCK_PLAN_TERMS", "2025-06-15", { stock_plan_id: m.plan, return_rules: PLAN_RULES, default_termination_windows: [], default_repurchase_window: null, status: "active", pour_over_plan_id: null });
    }, { source: "app" });
    const repurchase = m.b.command("repurchase", (c) => {
      c.tx("TX_STOCK_REPURCHASE", "2025-07-01", { security_id: lot, quantity: "2400", price: usd("1"), x_kind: "UNVESTED" });
    }, { source: "app" });
    const labels = { setup, termination, terms2, issue: m.b.commandIds.get("issue:RS-1")! };
    expect(named(m, repurchase, labels)).toEqual(["issue:consumes_security", "setup:relies_on_terms", "termination:relies_on_deadline", "terms2:relies_on_terms"]);
    expect(m.b.replay(D).violations).toEqual([]);
    // The plan's default window is 90 days from termination: a repurchase after 2025-08-30 is refused.
    m.b.command("late-repurchase", (c) => {
      c.tx("TX_STOCK_REPURCHASE", "2025-09-15", { security_id: lot, quantity: "100", price: usd("1"), x_kind: "UNVESTED" });
    }, { source: "app" });
    expect(codes(m.b.replay(D))).toEqual(["REPURCHASE_AFTER_DEADLINE"]);
  });

  it("makes a termination rely on a leave that ended employment first, and NSO-after-deadline shares on the deadline's sources", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const leave = m.b.command("leave", (c) => {
      c.tx("X_STAKEHOLDER_LEAVE", "2025-02-01", { stakeholder_id: m.alice, start_date: "2025-02-01", end_date: null, return_guaranteed: false });
    }, { source: "app" });
    const termination = terminate(m, "alice", m.alice, "2025-06-01");
    // Employment for the ISO test ended on 2025-05-02 (the leave), so the ISO deadline is 2025-08-02; the
    // contractual deadline is 2025-09-01.
    const late = m.b.command("late-exercise", (c) => {
      const lot = c.security("CS-1", { family: "STOCK", subtype: "COMMON", stakeholderId: m.alice, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: option });
      c.tx("TX_EQUITY_COMPENSATION_EXERCISE", "2025-08-15", {
        security_id: option,
        quantity: "10",
        resulting_security_ids: [lot],
        x_portions: [{ portion: "NSO", quantity: "10", security_id: lot, reason: "AFTER_ISO_DEADLINE" }],
        x_lots_consumed: { iso: "10", nso: "0" },
      });
      c.tx("TX_STOCK_ISSUANCE", "2025-08-15", { security_id: lot, custom_id: "CS-1", stakeholder_id: m.alice, stock_class_id: m.common, stock_plan_id: m.plan, share_price: usd("1"), quantity: "10", x_origin: "EXERCISE", x_source_security_id: option, x_portion: "NSO" });
    }, { source: "app" });
    const labels = { leave, termination, grant: m.b.commandIds.get("grant:OPT-1")! };
    expect(named(m, termination, labels)).toEqual(["grant:consumes_security", "leave:relies_on_terms"]);
    expect(named(m, late, labels)).toEqual(["grant:consumes_security", "leave:relies_on_deadline", "termination:relies_on_deadline"]);
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(e.isoDeadline(state, state.securities.get(option)!)).toMatchObject({ date: "2025-08-02", kind: "leave" });
  });

  it("makes a split rely on every lot of the class, closed ones too, and on the plan's explicit returns", () => {
    const m = miniOrg({ rules: { expired_vested_options: "RETIRE" } });
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    const close = cancel(m, "close", option, "100", "2025-02-01"); // closes the lot; its 100 vested options retire
    const returned = m.b.command("return", (c) => {
      c.tx("TX_STOCK_PLAN_RETURN_TO_POOL", "2025-02-15", { stock_plan_id: m.plan, quantity: "40", reason_text: "Board resolution" });
    }, { source: "app" });
    const split = m.b.command("split", (c) => {
      c.tx("TX_STOCK_CLASS_SPLIT", "2025-03-01", { stock_class_id: m.common, split_ratio: { numerator: "2", denominator: "1" } });
    }, { source: "app" });
    const labels = { close, returned, split, grant: m.b.commandIds.get("grant:OPT-1")!, setup: m.b.commandIds.get("mini:setup")! };
    // The plan terms (the setup's) decided that the cancelled options retire: the split scales that outcome too.
    expect(named(m, split, labels)).toEqual(["close:consumes_security", "grant:consumes_security", "returned:relies_on_terms", "setup:relies_on_terms"]);
    // The explicit return gives back shares the cancellation retired under the setup's rule: without either, it would
    // return more than was retired.
    expect(named(m, returned, labels)).toEqual(["close:consumes_security", "setup:consumes_security"]);
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect([state.plans.get(m.plan)!.retired.toString(), state.plans.get(m.plan)!.explicitReturns.toString()]).toEqual(["200", "80"]);
    // Reversing the cancellation would reopen the lot and change what the split scales, with nothing broken, so the
    // edge is what stops it.
    const all = [close, returned, split].flatMap((id) => edges(m, id));
    expect(e.reversalRefusal(close, all, m.b.reference.commands)).toBe("dependents_exist");
    const without = e.replay(m.b.reference, m.b.transactions.filter((t) => t.commandId !== close), { asOf: D });
    expect(without.securities.get(option)!.outstanding.toString()).toBe("200");
  });

  it("makes a later split rely on an earlier one, through closed lots and the plan aggregates both scale", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    const close = cancel(m, "close", option, "100", "2025-02-01"); // 100 vested options return to the pool
    const split = (label: string, date: string) =>
      m.b.command(label, (c) => c.tx("TX_STOCK_CLASS_SPLIT", date, { stock_class_id: m.common, split_ratio: { numerator: "2", denominator: "1" } }), { source: "app" });
    const split1 = split("split-1", "2025-03-01");
    const split2 = split("split-2", "2025-04-01");
    const labels = { close, split1, split2, grant: m.b.commandIds.get("grant:OPT-1")!, setup: m.b.commandIds.get("mini:setup")! };
    expect(named(m, split2, labels)).toEqual(["close:consumes_security", "grant:consumes_security", "setup:relies_on_terms", "split1:relies_on_terms"]);
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect([state.plans.get(m.plan)!.returned.toString(), state.plans.get(m.plan)!.grantedGross.toString()]).toEqual(["400", "400"]);
    // Without split 1 the second split's effect is different (200, not 400) and nothing breaks: only the edge stops it.
    const all = [close, split1, split2].flatMap((id) => edges(m, id));
    expect(e.reversalRefusal(split1, all, m.b.reference.commands)).toBe("dependents_exist");
    const without = e.replay(m.b.reference, m.b.transactions.filter((t) => t.commandId !== split1), { asOf: D });
    expect(without.violations).toEqual([]);
    expect([without.plans.get(m.plan)!.returned.toString(), without.plans.get(m.plan)!.grantedGross.toString()]).toEqual(["200", "200"]);
  });

  it("makes a correction rely on what it corrects, and later readers of the corrected fact rely on the correction", () => {
    const m = miniOrg();
    const setup = m.b.commandIds.get("mini:setup")!;
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01");
    const terms2 = m.b.command("terms-2", (c) => {
      c.tx("X_STOCK_PLAN_TERMS", "2025-06-01", { stock_plan_id: m.plan, return_rules: PLAN_RULES, default_termination_windows: [], default_repurchase_window: null, status: "active", pour_over_plan_id: null });
    }, { source: "app" });
    const termsTx = m.b.transactions[m.b.transactions.length - 1]!;
    // A correction of the terms: unvested awards cancelled under them retire instead of returning.
    const correction = m.b.command("correct-terms", (c) => {
      c.tx("X_CORRECTION", "2025-06-10", {
        supersedes_tx_id: termsTx.id,
        replacement_payload: { ...termsTx.payload, return_rules: { ...PLAN_RULES, cancelled_unvested_awards: "RETIRE" } },
        reason: "The board resolution says retire",
      });
    }, { source: "app" });
    const waiver = cancel(m, "waiver", option, "100", "2025-07-01");
    const labels = { setup, terms2, correction, waiver, grant: m.b.commandIds.get("grant:OPT-1")! };
    expect(named(m, correction, labels)).toEqual(["terms2:consumes_security"]);
    expect(named(m, waiver, labels)).toEqual(["correction:relies_on_terms", "grant:consumes_security", "terms2:relies_on_terms"]);
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.plans.get(m.plan)!.retired.toString()).toBe("100");
    // Neither the terms nor their correction can be reversed while the waiver stands; the terms not while corrected.
    const all = [terms2, correction, waiver].flatMap((id) => edges(m, id));
    expect(e.reversalBlockers(correction, all, m.b.reference.commands).map((c) => c.id)).toEqual([waiver]);
    expect(e.reversalBlockers(terms2, all, m.b.reference.commands).map((c) => c.id)).toEqual([waiver, correction]);
  });

  it("makes a correction rely on the earlier commands it re-interprets (a case the reversal property found)", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    const terms2 = m.b.command("terms-2", (c) => {
      c.tx("X_STOCK_PLAN_TERMS", "2025-06-01", { stock_plan_id: m.plan, return_rules: PLAN_RULES, default_termination_windows: [], default_repurchase_window: null, status: "active", pour_over_plan_id: null });
    }, { source: "app" });
    const termsTx = m.b.transactions[m.b.transactions.length - 1]!;
    // A net exercise under terms-2: its 10 withheld shares retire.
    const net = exercise(m, "CS-1", option, m.alice, "40", "2025-07-01", { portion: "NSO", withheld: "10" }).command;
    // Recorded afterwards, a correction of terms-2 makes withheld shares return instead: it re-interprets the exercise.
    const correction = m.b.command("correct-terms", (c) => {
      c.tx("X_CORRECTION", "2025-08-01", { supersedes_tx_id: termsTx.id, replacement_payload: { ...termsTx.payload, return_rules: { ...PLAN_RULES, shares_withheld_for_tax: "RETURN" } }, reason: "Clerical" });
    }, { source: "app" });
    const labels = { terms2, net, correction };
    expect(named(m, correction, labels)).toEqual(["net:relies_on_terms", "terms2:consumes_security"]);
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect([state.plans.get(m.plan)!.retired.toString(), state.plans.get(m.plan)!.returned.toString()]).toEqual(["0", "10"]);
    // So the exercise can't be reversed while the correction stands: without it, the correction would mean something else.
    const all = [terms2, net, correction].flatMap((id) => edges(m, id));
    expect(e.reversalBlockers(net, all, m.b.reference.commands).map((c) => c.id)).toEqual([correction]);
    expect(e.reversalRefusal(correction, all, m.b.reference.commands)).toBeNull();
  });

  it("makes a conversion rely on the class ratio it used", () => {
    const m = miniOrg();
    const setup = m.b.commandIds.get("mini:setup")!;
    const preferred = issueStock(m, "PS-1", m.bob, "100", "2025-01-01", { classId: m.preferred });
    const conversion = m.b.command("convert", (c) => {
      const common = addStock(m, c, "CS-1", m.bob, "100", "2025-03-01", { origin: "CONVERSION", source: preferred });
      c.tx("TX_STOCK_CONVERSION", "2025-03-01", { security_id: preferred, quantity_converted: "100", resulting_security_ids: [common] });
    }, { source: "app" });
    expect(named(m, conversion, { setup, issue: m.b.commandIds.get("issue:PS-1")! })).toEqual(["issue:consumes_security", "setup:relies_on_terms"]);
    expect(m.b.replay(D).violations).toEqual([]);
  });

  it("checks a lot's origin command at issuance and points the edge at the command that really issued it", () => {
    const m = miniOrg();
    const setup = m.b.commandIds.get("mini:setup")!;
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const identity = m.b.reference.securities.find((s) => s.id === option)!;
    const grantCommand = identity.originCommandId;
    identity.originCommandId = setup; // a malformed identity row: it names another command as the lot's origin
    const exercised = exercise(m, "CS-1", option, m.alice, "10", "2025-02-01").command;
    const state = m.b.replay(D);
    expect(state.violations.map((v) => [v.code, v.securityId])).toEqual([["ORIGIN_COMMAND_MISMATCH", option]]);
    expect(named(m, exercised, { setup, grant: grantCommand })).toEqual(["grant:consumes_security"]);
  });

  it("keeps the strongest kind per pair, and walks the reversal closure newest first", () => {
    const commands: e.LedgerCommand[] = ["a", "b", "c", "d", "r"].map((id, i) => ({
      id,
      type: "x",
      actorKind: id === "d" ? "import" : "user",
      reversesCommandId: id === "r" ? "c" : null,
      firstSeq: i + 1,
      lastSeq: i + 1,
      declaredTxCount: 1,
      createdAt: i,
    }));
    const graph: e.DependencyEdge[] = [
      { commandId: "b", dependsOnCommandId: "a", kind: "consumes_security" },
      { commandId: "c", dependsOnCommandId: "b", kind: "relies_on_terms" },
      { commandId: "d", dependsOnCommandId: "a", kind: "relies_on_deadline" },
    ];
    expect(e.reversalBlockers("a", graph, commands).map((c) => c.id)).toEqual(["d", "b"]);
    expect(e.dependentClosure("a", graph, commands).map((c) => c.id)).toEqual(["d", "b"]); // c is reversed already
    expect(e.dependentClosure("a", [...graph, { commandId: "e", dependsOnCommandId: "b", kind: "consumes_security" }], [...commands, { ...commands[0]!, id: "e", firstSeq: 9 }]).map((c) => c.id)).toEqual(["e", "d", "b"]);
    expect(e.reversalRefusal("a", graph, commands)).toBe("dependents_exist");
    expect(e.reversalRefusal("c", graph, commands)).toBe("already_reversed");
    expect(e.reversalRefusal("r", graph, commands)).toBe("is_reversal");
    expect(e.reversalRefusal("d", graph, commands)).toBe("migrated_history");
    expect(e.reversalRefusal("b", graph, commands)).toBeNull(); // its dependent c is reversed
    expect(e.reversalRefusal("zzz", graph, commands)).toBe("not_found");
    expect(e.reversalOf("c", commands)?.id).toBe("r");
    expect(e.edgesOnReversedCommands(graph, commands)).toEqual([]);
    expect(e.edgesOnReversedCommands([...graph, { commandId: "b", dependsOnCommandId: "c", kind: "consumes_security" }], commands)).toHaveLength(1);
    expect(e.reversalBlockers("a", [{ commandId: "ghost", dependsOnCommandId: "a", kind: "relies_on_terms" }], commands)).toEqual([]);
  });

  it("keeps one edge per pair with the strongest kind", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const grantCommand = m.b.commandIds.get("grant:OPT-1")!;
    const both = m.b.command("both", (c) => {
      c.tx("X_EXECUTION_STATUS", "2025-02-01", { security_id: option, status: "executed" });
      c.tx("TX_EQUITY_COMPENSATION_ACCEPTANCE", "2025-02-01", { security_id: option });
    }, { source: "app" });
    expect(edges(m, both)).toEqual([{ commandId: both, dependsOnCommandId: grantCommand, kind: "consumes_security" }]);
  });
});

describe("invariants", () => {
  it("finds negative positions and broken position splits on a finished state", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    cancel(m, "too-much", option, "150", "2025-02-01");
    const state = m.b.replay(D);
    expect(e.checkPositions(state).map((v) => v.code)).toEqual(["NEGATIVE_POSITION", "POSITION_SPLIT"]);
    expect(e.checkInvariants(state).map((v) => v.code)).toContain("NEGATIVE_POSITION");
  });

  it("checks the cap table identities (I12)", () => {
    const m = miniOrg();
    grant(m, "OPT-1", m.alice, "100", "2025-01-01");
    const metrics = e.computeMetrics(m.b.replay(D));
    expect(e.checkCapTableIdentity(metrics)).toEqual([]);
    const broken = { ...metrics, fullyDiluted: metrics.fullyDiluted.add(1) };
    expect(e.checkCapTableIdentity(broken).map((v) => v.code)).toEqual(["FD_IDENTITY"]);
    const percent = { ...metrics, availablePool: { ...metrics.availablePool, fullyDilutedPct: e.Rational.ZERO } };
    expect(e.checkCapTableIdentity(percent).map((v) => v.code)).toEqual(["FD_PERCENT_IDENTITY"]);
    const io = { ...metrics, issuedAndOutstanding: e.Dec.from(5) };
    expect(e.checkCapTableIdentity(io).map((v) => v.code)).toEqual(["IO_PERCENT_IDENTITY", "IO_IDENTITY"]);
  });

  it("checks split scaling (I7)", () => {
    const m = miniOrg();
    const before = m.b.replay(D);
    const changed = m.b.replay(D);
    changed.classes.get(m.common)!.authorized = e.Dec.from(1);
    expect(e.checkSplitScaling(before, changed, m.common, e.Rational.of(2)).map((v) => v.code)).toEqual(["SPLIT_CHANGED_AUTHORIZED"]);
    expect(e.checkSplitScaling(before, changed, uuid("ghost"), e.Rational.of(2)).map((v) => v.code)).toEqual(["UNKNOWN_STOCK_CLASS"]);
    grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const withGrant = m.b.replay(D);
    expect(e.checkSplitScaling(withGrant, withGrant, m.common, e.Rational.of(2)).map((v) => v.code)).toEqual(["SPLIT_NOT_SCALED"]);
  });

  it("verifies command seals and reversal completeness (I17)", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    const command = cancel(m, "c", option, "10", "2025-02-01");
    m.b.reverse(command, "2025-03-01");
    expect(e.verifyCommandSeals(m.b.reference.commands, m.b.transactions)).toEqual([]);
    const reversal = m.b.reference.commands[m.b.reference.commands.length - 1]!;
    const tampered = m.b.reference.commands.map((c) => (c.id === command ? { ...c, declaredTxCount: 2 } : c));
    expect(e.verifyCommandSeals(tampered, m.b.transactions).map((v) => v.code)).toEqual(["SEAL_COUNT"]);
    const range = m.b.reference.commands.map((c) => (c.id === command ? { ...c, lastSeq: c.firstSeq - 1 } : c));
    expect(e.verifyCommandSeals(range, m.b.transactions).map((v) => v.code)).toContain("SEAL_RANGE");
    const withoutReversalTx = m.b.transactions.filter((t) => t.commandId !== reversal.id);
    expect(e.verifyCommandSeals(m.b.reference.commands, withoutReversalTx).map((v) => v.code)).toEqual(["SEAL_COUNT", "REVERSAL_INCOMPLETE"]);
    const impure = m.b.reference.commands.map((c) => (c.id === reversal.id ? { ...c, reversesCommandId: m.b.commandIds.get("grant:OPT-1")! } : c));
    expect(e.verifyCommandSeals(impure, m.b.transactions).map((v) => v.code)).toEqual(["REVERSAL_INCOMPLETE"]);
    const extra = e.decodeTransaction({ id: uuid("extra"), seq: reversal.lastSeq, commandId: reversal.id, type: "TX_EQUITY_COMPENSATION_ACCEPTANCE", effectiveDate: "2025-03-01", payload: { security_id: option }, securityId: option, source: "app" });
    expect(e.verifyCommandSeals([{ ...reversal, declaredTxCount: 2 }], [...m.b.transactions, extra]).map((v) => v.code)).toContain("REVERSAL_NOT_PURE");
  });

  it("finds what reversing a command would break, which edges alone may miss", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01");
    const acceleration = m.b.command("accelerate", (c) => {
      c.tx("TX_VESTING_ACCELERATION", "2025-02-01", { security_id: option, quantity: "2000", reason_text: "Board approval" });
    }, { source: "app" });
    exercise(m, "CS-1", option, m.alice, "2000", "2025-03-01");
    const introduced = e.reversalViolations(m.b.reference, m.b.transactions, acceleration, { asOf: D });
    expect(introduced.map((v) => v.code)).toContain("EXCEEDS_VESTED_UNEXERCISED");
    expect(e.reversalViolations(m.b.reference, m.b.transactions, m.b.commandIds.get("exercise:CS-1")!, { asOf: D })).toEqual([]);
    const warning: e.Violation = { code: "W", severity: "warning", message: "" };
    expect(e.violationsIntroduced([], [warning])).toEqual([]);
    expect(e.violationKey({ code: "X", severity: "error", message: "m", securityId: "s" })).toBe("X|s||");
  });
});
