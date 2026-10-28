import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { usd, uuid } from "./fixtures/builder.ts";
import { addStock, cancel, codes, exercise, grant, issueStock, miniOrg, terminate } from "./fixtures/mini.ts";

const D = "2026-06-30";

describe("replay basics", () => {
  it("refuses bad options, duplicate ids and duplicate seqs", () => {
    const m = miniOrg();
    expect(() => m.b.replay("2026-02-30")).toThrow(e.EngineError);
    expect(() => m.b.replay(D, { today: "nope" })).toThrow(e.EngineError);
    expect(() => e.replay({ ...m.b.reference, shareUnit: "0" }, m.b.transactions, { asOf: D })).toThrow(/share unit/);
    const tx = m.b.transactions[0]!;
    expect(() => e.replay(m.b.reference, [tx, tx], { asOf: D })).toThrow(/appears twice/);
    expect(() => e.replay(m.b.reference, [tx, { ...tx, id: uuid("other") }], { asOf: D })).toThrow(/Seq/);
  });

  it("leaves the vesting terms hash recomputation to the integrity check", () => {
    const m = miniOrg();
    grant(m, "OPT-1", m.alice, "48", "2025-01-01");
    expect(e.checkVestingTermsHashes(m.b.reference)).toEqual([]);
    m.b.reference.vestingTerms.push({ id: uuid("vt:bad"), definition: { type: "EXPLICIT", events: [{ date: D, quantity: "1" }] }, definitionSha256: "0".repeat(64) });
    expect(e.checkVestingTermsHashes(m.b.reference).map((v) => v.code)).toEqual(["VESTING_TERMS_HASH_MISMATCH"]);
    expect(codes(m.b.replay(D))).toEqual([]);
  });

  it("filters by effective date (asOf) and by seq (asKnownAt), snapped to command boundaries", () => {
    const m = miniOrg();
    const lot = issueStock(m, "CS-1", m.bob, "100", "2025-01-01");
    m.b.command("transfer", (c) => {
      const to = addStock(m, c, "CS-2", m.carol, "40", "2025-06-01", { origin: "TRANSFER", source: lot });
      const balance = addStock(m, c, "CS-3", m.bob, "60", "2025-06-01", { origin: "BALANCE", source: lot });
      c.tx("TX_STOCK_TRANSFER", "2025-06-01", { security_id: lot, quantity: "40", resulting_security_ids: [to], balance_security_id: balance });
    });
    expect(m.b.replay("2024-12-31").securities.get(lot)!.issued).toBe(false);
    expect(m.b.replay("2025-05-31").securities.get(lot)!.outstanding.toString()).toBe("100");
    const after = m.b.replay(D);
    expect(after.violations).toEqual([]);
    expect(after.securities.get(lot)!.status).toBe("TRANSFERRED");
    const issueEnd = m.b.reference.commands.find((c) => c.type === "issue")!.lastSeq;
    const midTransfer = m.b.replay(D, { asKnownAt: issueEnd + 2 });
    expect(midTransfer.asKnownAt).toBe(issueEnd); // snapped back to the last whole command
    expect(midTransfer.violations).toEqual([]);
    const raw = e.replay({ ...m.b.reference, commands: undefined }, m.b.transactions, { asOf: D, asKnownAt: issueEnd + 1 });
    expect(raw.asKnownAt).toBe(issueEnd + 1);
    expect(raw.ledgerSeq).toBe(issueEnd + 1);
    expect(codes(raw)).toContain("ORPHAN_DERIVED_LOT"); // a half command, as the raw seq asks for
  });

  it("reports transactions dated after today (I10)", () => {
    const m = miniOrg();
    issueStock(m, "CS-1", m.bob, "100", "2026-12-01");
    expect(codes(m.b.replay("2026-12-31", { today: "2026-10-21" }))).toContain("FUTURE_EFFECTIVE_DATE");
    expect(codes(m.b.replay("2026-12-31"))).not.toContain("FUTURE_EFFECTIVE_DATE");
  });
});

describe("reversals and corrections", () => {
  it("skips reversed transactions at every as-of date while as-known still shows them", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "4800", "2024-01-01");
    const command = cancel(m, "c1", option, "1000", "2025-06-01", "HOLDER_WAIVER");
    const beforeReversal = m.b.headSeq;
    m.b.reverse(command, D);
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.securities.get(option)!.outstanding.toString()).toBe("4800");
    expect(state.reversedTransactionIds.size).toBe(1);
    expect(m.b.replay("2025-07-01", { asKnownAt: beforeReversal }).securities.get(option)!.outstanding.toString()).toBe("3800");
  });

  it("flags bad reversals", () => {
    const m = miniOrg();
    const target = m.b.transactions[0]!;
    m.b.command("bad-reversals", (c) => {
      c.tx("X_REVERSAL", D, { reverses_tx_id: uuid("missing") });
      c.tx("X_REVERSAL", D, { reverses_tx_id: target.id });
      c.tx("X_REVERSAL", D, { reverses_tx_id: target.id });
    });
    const first = m.b.transactions[m.b.transactions.length - 3]!;
    m.b.command("reverse-a-reversal", (c) => {
      c.tx("X_REVERSAL", D, { reverses_tx_id: first.id });
    });
    const later = uuid("tx:later");
    const state = e.replay(m.b.reference, [...m.b.transactions, e.decodeTransaction({ id: uuid("tx:early"), seq: 1000, commandId: uuid("c"), type: "X_REVERSAL", effectiveDate: D, payload: { reverses_tx_id: later }, reversesTxId: later, source: "app" }), e.decodeTransaction({ id: later, seq: 1001, commandId: uuid("c"), type: "TX_STOCK_ACCEPTANCE", effectiveDate: D, payload: { security_id: uuid("s") }, securityId: uuid("s"), source: "app" })], { asOf: D });
    expect(codes(state)).toEqual(expect.arrayContaining(["REVERSAL_TARGET_UNKNOWN", "DUPLICATE_REVERSAL", "REVERSAL_OF_REVERSAL", "REVERSAL_OF_LATER"]));
  });

  it("applies clerical corrections, including a moved date, and flags bad ones", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "4800", "2024-01-01", { vesting: null });
    cancel(m, "c1", option, "1000", "2025-06-01");
    const cancellation = m.b.transactions[m.b.transactions.length - 1]!;
    m.b.command("correct", (c) => {
      c.tx("X_CORRECTION", D, {
        supersedes_tx_id: cancellation.id,
        replacement_payload: { ...cancellation.payload, reason_text: "Waiver signed on 2025-07-01" },
        effective_date: "2025-07-01",
        reason: "Wrong date and wording",
      });
    }, { source: "app" });
    expect(m.b.replay("2025-06-15").securities.get(option)!.outstanding.toString()).toBe("4800");
    expect(m.b.replay(D).securities.get(option)!.outstanding.toString()).toBe("3800");
    expect((m.b.replay(D).applied.find((t) => t.id === cancellation.id)!.payload as { reason_text: string }).reason_text).toBe("Waiver signed on 2025-07-01");
    // Bad corrections.
    m.b.command("bad-corrections", (c) => {
      c.tx("X_CORRECTION", D, { supersedes_tx_id: uuid("missing"), replacement_payload: {}, reason: "x" });
      c.tx("X_CORRECTION", D, { supersedes_tx_id: cancellation.id, replacement_payload: { surprise: true }, reason: "x" });
    }, { source: "app" });
    const correction = m.b.transactions.find((t) => t.type === "X_CORRECTION")!;
    m.b.command("correct-a-correction", (c) => {
      c.tx("X_CORRECTION", D, { supersedes_tx_id: correction.id, replacement_payload: {}, reason: "x" });
      c.tx("X_CORRECTION", D, { supersedes_tx_id: cancellation.id, replacement_payload: { ...cancellation.payload, quantity: "600" }, reason: "again" });
    }, { source: "app" });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(expect.arrayContaining(["CORRECTION_TARGET_UNKNOWN", "CORRECTION_PAYLOAD_INVALID", "CORRECTION_TARGET_INVALID", "DUPLICATE_CORRECTION"]));
  });

  it("refuses a correction that would change what the row's indexed columns say (reverse instead)", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "4800", "2024-01-01", { vesting: null });
    const other = grant(m, "OPT-2", m.carol, "4800", "2024-01-01", { vesting: null });
    const target = (label: string) => {
      cancel(m, label, option, "1000", "2025-06-01");
      return m.b.transactions[m.b.transactions.length - 1]!;
    };
    const correct = (label: string, tx: e.LedgerTransaction, changes: Record<string, unknown>) =>
      m.b.command(label, (c) => c.tx("X_CORRECTION", D, { supersedes_tx_id: tx.id, replacement_payload: { ...tx.payload, ...changes }, reason: "Clerical" }), { source: "app" });
    correct("redirect", target("c1"), { security_id: other }); // the security_id column still names OPT-1
    correct("resize", target("c2"), { quantity: "10" }); // the quantity column still says 1000
    const grantTx = m.b.transactions.find((t) => t.type === "TX_EQUITY_COMPENSATION_ISSUANCE" && t.securityId === other)!;
    correct("reassign", grantTx, { stakeholder_id: m.alice });
    const optionGrant = m.b.transactions.find((t) => t.type === "TX_EQUITY_COMPENSATION_ISSUANCE" && t.securityId === option)!;
    correct("revalue", optionGrant, { x_fmv: { price_per_share: usd("1"), valuation_id: uuid("V9"), source: "VALUATION" } });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["CORRECTION_CHANGES_COLUMNS", "CORRECTION_CHANGES_COLUMNS", "CORRECTION_CHANGES_COLUMNS", "CORRECTION_CHANGES_COLUMNS"]);
    expect(state.violations.map((v) => v.message.replace(/^A correction can't change ([^:]+):.*$/, "$1"))).toEqual(["securityId", "quantity", "stakeholderId", "valuationId"]);
    // The targets apply as recorded: both cancellations hit OPT-1, OPT-2 stays with its holder.
    expect(state.securities.get(option)!.outstanding.toString()).toBe("2800");
    expect(state.securities.get(other)!.outstanding.toString()).toBe("4800");
    expect(state.securities.get(other)!.identity.stakeholderId).toBe(m.carol);
  });

  it("puts a corrected payload through every rule a decoded row meets: a termination's date is its effective date", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    terminate(m, "alice", m.alice, "2025-03-01");
    const termination = m.b.transactions.find((t) => t.type === "X_STAKEHOLDER_TERMINATION")!;
    const fix = (label: string, changes: Record<string, unknown>, effectiveDate?: string) =>
      m.b.command(label, (c) => c.tx("X_CORRECTION", D, { supersedes_tx_id: termination.id, replacement_payload: { ...termination.payload, ...changes }, ...(effectiveDate ? { effective_date: effectiveDate } : {}), reason: "Wrong date" }), { source: "app" });
    // Only the termination date moves: the termination would apply on March 1 with a deadline from April 1. Refused.
    fix("date-only", { termination_date: "2025-04-01", vesting_stop_date: "2025-04-01" });
    let state = m.b.replay(D);
    expect(codes(state)).toEqual(["CORRECTION_PAYLOAD_INVALID"]);
    expect(state.violations[0]!.message).toMatch(/termination date is the effective date/);
    expect(state.securities.get(option)!.computedDeadline?.deadline).toBe("2025-06-01"); // as recorded
    // Moving the effective date with it is a valid correction: the deadline follows.
    const n = miniOrg();
    const other = grant(n, "OPT-1", n.alice, "100", "2025-01-01", { vesting: null });
    terminate(n, "alice", n.alice, "2025-03-01");
    const recorded = n.b.transactions.find((t) => t.type === "X_STAKEHOLDER_TERMINATION")!;
    n.b.command("date-and-effective", (c) => c.tx("X_CORRECTION", D, { supersedes_tx_id: recorded.id, replacement_payload: { ...recorded.payload, termination_date: "2025-04-01", vesting_stop_date: "2025-04-01" }, effective_date: "2025-04-01", reason: "Wrong date" }), { source: "app" });
    state = n.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.securities.get(other)!.computedDeadline?.deadline).toBe("2025-07-01");
  });

  it("keeps migration-only fields to imports, through corrections and opening balances too", () => {
    const EVIDENCE = { run: "run-1", file: "securities.jsonl", pointer: "/0", sha256: "a".repeat(64) };
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2024-01-01", { vesting: null });
    const grantTx = m.b.transactions.find((t) => t.type === "TX_EQUITY_COMPENSATION_ISSUANCE")!;
    const flagged = { ...grantTx.payload, x_board_approval_not_recorded_in_pulley: true };
    // Decoding refuses an app correction that carries them, at any depth.
    expect(() =>
      m.b.command("app-correction", (c) => c.tx("X_CORRECTION", D, { supersedes_tx_id: grantTx.id, replacement_payload: flagged, reason: "Clerical" }), { source: "app" }),
    ).toThrow(/replacement_payload\.x_board_approval_not_recorded_in_pulley only come from an import/);
    expect(() =>
      m.b.command("app-opening", (c) => c.tx("X_MIGRATION_OPENING_BALANCE", D, { security_id: option, outstanding: "100", x_evidence: [EVIDENCE] }), { source: "app" }),
    ).toThrow(/opening balance only comes from an import/);
    // An import may correct them in.
    const n = miniOrg();
    grant(n, "OPT-1", n.alice, "100", "2024-01-01", { vesting: null });
    const imported = n.b.transactions.find((t) => t.type === "TX_EQUITY_COMPENSATION_ISSUANCE")!;
    n.b.command("import-correction", (c) => c.tx("X_CORRECTION", D, { supersedes_tx_id: imported.id, replacement_payload: { ...imported.payload, x_board_approval_not_recorded_in_pulley: true }, reason: "Pulley shows no board date" }), { source: "import" });
    const state = n.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.securities.get(imported.securityId!)!.boardApprovalNotRecordedInPulley).toBe(true);
    // Replay doesn't trust the decoder: the same correction or opening balance marked as an app row is refused there too.
    for (const tx of n.b.transactions.filter((t) => t.type === "X_CORRECTION")) (tx as { source: e.TransactionSource }).source = "app";
    expect(codes(n.b.replay(D))).toEqual(["CORRECTION_PAYLOAD_INVALID"]);
    const o = miniOrg();
    const lot = issueStock(o, "CS-1", o.bob, "100", "2024-01-01");
    o.b.command("opening", (c) => c.tx("X_MIGRATION_OPENING_BALANCE", "2024-06-01", { security_id: lot, outstanding: "90", x_evidence: [EVIDENCE] }), { source: "import" });
    (o.b.transactions[o.b.transactions.length - 1] as { source: e.TransactionSource }).source = "app";
    expect(codes(o.b.replay(D))).toEqual(["MIGRATION_FIELD_NOT_ALLOWED"]);
  });

  it("ignores a correction of a reversed transaction", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2024-01-01", { vesting: null });
    const command = cancel(m, "c1", option, "10", "2025-01-01");
    const cancellation = m.b.transactions[m.b.transactions.length - 1]!;
    m.b.reverse(command, "2025-02-01");
    m.b.command("correct", (c) => {
      c.tx("X_CORRECTION", "2025-03-01", { supersedes_tx_id: cancellation.id, replacement_payload: { ...cancellation.payload, quantity: "20" }, reason: "x" });
    }, { source: "app" });
    const state = m.b.replay(D);
    expect(state.securities.get(option)!.outstanding.toString()).toBe("100");
    expect(state.violations).toEqual([]);
  });
});

describe("stock", () => {
  it("counts capital by origin: purchases, founders, RSAs and exercises at price; derived lots at 0; or as stated", () => {
    const m = miniOrg();
    const purchase = issueStock(m, "CS-1", m.bob, "100", "2025-01-01", { price: "2.6" });
    const conversion = issueStock(m, "SAFE-X", m.bob, "1", "2025-01-01");
    m.b.command("stated", (c) => {
      const lot = c.security("CS-2", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_STOCK_ISSUANCE", "2025-01-01", {
        security_id: lot,
        custom_id: "CS-2",
        stakeholder_id: m.bob,
        stock_class_id: m.common,
        share_price: usd("3"),
        quantity: "10",
        x_origin: "PURCHASE",
        x_capital_contribution: usd("29.99"),
        x_repurchase_right: { price_per_share: null, window: { period: 30, period_type: "DAYS" } },
      });
    });
    const state = m.b.replay(D);
    expect(state.securities.get(purchase)!.capitalContribution.toString()).toBe("260");
    expect(state.securities.get(conversion)!.capitalContribution.toString()).toBe("1");
    expect(state.securities.get(uuid("CS-2"))!.capitalContribution.toString()).toBe("29.99");
    expect(state.securities.get(uuid("CS-2"))!.repurchaseRight).toEqual({ pricePerShare: null, window: { period: 30, period_type: "DAYS" } });
  });

  it("keeps a migrated lot's board approval flag, debt cancelled and legend snapshots for the views and the export", () => {
    const m = miniOrg();
    const legend = { legend_id: uuid("legend:1"), name: "Securities Act legend", text: "THE SHARES HAVE NOT BEEN REGISTERED UNDER THE SECURITIES ACT OF 1933." };
    let lot = "";
    m.b.command("import:PA1-1", (c) => {
      lot = c.security("PA1-1", { family: "STOCK", subtype: "PREFERRED", stakeholderId: m.bob, stockClassId: m.preferred, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_STOCK_ISSUANCE", "2025-01-01", {
        security_id: lot,
        custom_id: "PA1-1",
        stakeholder_id: m.bob,
        stock_class_id: m.preferred,
        share_price: usd("1.25"),
        quantity: "200000",
        x_origin: "PURCHASE",
        x_capital_contribution: usd("250000"),
        x_debt_cancelled: usd("250000"),
        x_board_approval_not_recorded_in_pulley: true,
        x_legends: [legend],
      });
    }, { source: "import" });
    const fresh = issueStock(m, "CS-1", m.alice, "10", "2025-02-01", { txSource: "app" });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(e.securityNumbers(state, state.securities.get(lot)!)).toMatchObject({
      boardApprovalDate: null,
      boardApprovalNotRecordedInPulley: true,
      debtCancelled: e.Dec.from(250000),
      legends: [{ legendId: legend.legend_id, name: legend.name, text: legend.text }],
      capitalContribution: e.Dec.from(250000),
    });
    expect(e.securityNumbers(state, state.securities.get(fresh)!)).toMatchObject({ boardApprovalNotRecordedInPulley: false, debtCancelled: null, legends: [] });
  });

  it("checks identity, class, duplicates and vesting terms", () => {
    const m = miniOrg();
    const lot = issueStock(m, "CS-1", m.bob, "100", "2025-01-01");
    m.b.command("again", (c) => {
      c.tx("TX_STOCK_ISSUANCE", "2025-02-01", { ...(m.b.transactions.find((t) => t.type === "TX_STOCK_ISSUANCE")!.payload as Record<string, unknown>), stakeholder_id: m.carol });
    });
    const ghostClass = uuid("class:ghost");
    m.b.command("ghost", (c) => {
      const ghost = c.security("CS-9", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: ghostClass, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_STOCK_ISSUANCE", "2025-01-01", { security_id: ghost, custom_id: "CS-9", stakeholder_id: m.bob, stock_class_id: ghostClass, share_price: usd("1"), quantity: "1", x_origin: "PURCHASE" });
    });
    const sum = m.b.vestingTerms("vt:short", { type: "EXPLICIT", events: [{ date: "2026-01-01", quantity: "5" }] });
    m.b.command("terms", (c) => {
      const a = c.security("CS-10", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_STOCK_ISSUANCE", "2025-01-01", { security_id: a, custom_id: "CS-10", stakeholder_id: m.bob, stock_class_id: m.common, share_price: usd("1"), quantity: "10", x_origin: "PURCHASE", vesting_terms_id: sum.id, x_definition_sha256: sum.sha });
      const b = c.security("CS-11", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_STOCK_ISSUANCE", "2025-01-01", { security_id: b, custom_id: "CS-11", stakeholder_id: m.bob, stock_class_id: m.common, share_price: usd("1"), quantity: "5", x_origin: "PURCHASE", vesting_terms_id: sum.id, x_definition_sha256: "1".repeat(64) });
      const d = c.security("CS-12", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_STOCK_ISSUANCE", "2025-01-01", { security_id: d, custom_id: "CS-12", stakeholder_id: m.bob, stock_class_id: m.common, share_price: usd("1"), quantity: "5", x_origin: "PURCHASE", vesting_terms_id: uuid("vt:none"), x_definition_sha256: sum.sha });
    });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(expect.arrayContaining(["IDENTITY_MISMATCH", "DUPLICATE_ISSUANCE", "UNKNOWN_STOCK_CLASS", "VESTING_SUM_MISMATCH", "VESTING_DEFINITION_MISMATCH", "UNKNOWN_VESTING_TERMS"]));
    expect(state.securities.get(lot)!.outstanding.toString()).toBe("100");
  });

  it("refuses transactions on unknown, unissued, closed or other-family lots, or before the issue date (I9, I10)", () => {
    const m = miniOrg();
    const lot = issueStock(m, "CS-1", m.bob, "100", "2025-01-01");
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    m.b.command("weird", (c) => {
      const unissued = c.security("CS-2", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_STOCK_ACCEPTANCE", "2025-02-01", { security_id: unissued });
      c.tx("TX_STOCK_ACCEPTANCE", "2025-02-01", { security_id: uuid("missing") });
      c.tx("TX_STOCK_ACCEPTANCE", "2025-02-01", { security_id: option });
      c.tx("TX_STOCK_ACCEPTANCE", "2024-12-01", { security_id: lot });
      c.tx("TX_STOCK_CANCELLATION", "2025-03-01", { security_id: lot, quantity: "100", reason_text: "Error" });
      c.tx("TX_STOCK_ACCEPTANCE", "2025-04-01", { security_id: lot });
    });
    // Replay runs in effective order: the acceptance dated 2024-12-01 meets CS-1 before its issue (I10).
    expect(codes(m.b.replay(D))).toEqual(["BEFORE_ISSUE_DATE", "NOT_ISSUED", "UNKNOWN_SECURITY", "FAMILY_MISMATCH", "LOT_CLOSED"]);
  });

  it("transfers whole lots with conservation (I2) and flags every lineage problem", () => {
    const m = miniOrg();
    const lot = issueStock(m, "CS-1", m.bob, "100", "2025-01-01");
    m.b.command("good", (c) => {
      const to = addStock(m, c, "CS-2", m.carol, "40", "2025-06-01", { origin: "TRANSFER", source: lot });
      const balance = addStock(m, c, "CS-3", m.bob, "60", "2025-06-01", { origin: "BALANCE", source: lot });
      c.tx("TX_STOCK_TRANSFER", "2025-06-01", { security_id: lot, quantity: "40", resulting_security_ids: [to], balance_security_id: balance, x_reason: "SECONDARY_SALE" });
    });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    const source = state.securities.get(lot)!;
    expect([source.transferred.toString(), source.movedToBalance.toString(), source.outstanding.toString()]).toEqual(["40", "60", "0"]);
    expect(source.resultingSecurityIds).toEqual([uuid("CS-2")]);

    const bad = miniOrg();
    const a = issueStock(bad, "CS-1", bad.bob, "100", "2025-01-01");
    const b2 = issueStock(bad, "CS-4", bad.bob, "100", "2025-01-01");
    const c2 = issueStock(bad, "CS-7", bad.bob, "100", "2025-01-01");
    bad.b.command("bad", (c) => {
      const to = addStock(bad, c, "CS-2", bad.carol, "41", "2025-06-01", { origin: "TRANSFER", source: a });
      const balance = addStock(bad, c, "CS-3", bad.bob, "50", "2025-06-01", { origin: "BALANCE", source: a });
      c.tx("TX_STOCK_TRANSFER", "2025-06-01", { security_id: a, quantity: "40", resulting_security_ids: [to], balance_security_id: balance });
      c.tx("TX_STOCK_TRANSFER", "2025-06-01", { security_id: b2, quantity: "40", resulting_security_ids: [uuid("CS-404")] });
      const preferredLot = addStock(bad, c, "PS-1", bad.carol, "100", "2025-06-01", { origin: "TRANSFER", source: c2, classId: bad.preferred });
      c.tx("TX_STOCK_TRANSFER", "2025-06-01", { security_id: c2, quantity: "100", resulting_security_ids: [preferredLot], balance_security_id: uuid("CS-405") });
      addStock(bad, c, "CS-5", bad.carol, "1", "2025-06-01", { origin: "TRANSFER", source: uuid("CS-404") });
    });
    expect(codes(bad.b.replay(D))).toEqual([
      "TRANSFER_NEEDS_BALANCE", // CS-4: 40 of 100 with no balance lot
      "TRANSFER_NOT_CONSERVED", // CS-1: 41 transferred for 40
      "TRANSFER_NOT_CONSERVED", // CS-1: the balance holds 50 for 60
      "RESULTING_LOT_MISSING", // CS-4's recipient was never issued
      "TRANSFER_NOT_CONSERVED", // …so CS-4's recipients hold 0
      "LINEAGE_MISMATCH", // CS-7 into a preferred lot
      "BALANCE_LOT_MISSING", // CS-7's balance lot
      "ORPHAN_DERIVED_LOT", // CS-5 claims a source that lists nothing
    ]);
  });

  it("cancels shares in place or with a balance lot, applying the plan rules to plan shares", () => {
    const m = miniOrg({ rules: { repurchased_unvested_shares: "RETIRE" } });
    const lot = issueStock(m, "CS-1", m.alice, "100", "2025-01-01", { planId: m.plan, origin: "RSA", vestingMonths: { start: "2025-01-01", months: 10, cliff: 0 } });
    m.b.command("cancel", (c) => {
      c.tx("TX_STOCK_CANCELLATION", "2025-03-15", { security_id: lot, quantity: "50", reason_text: "Board resolution" });
    });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    const s = state.securities.get(lot)!;
    expect([s.cancelled, s.cancelledUnvested, s.cancelledVested, s.outstanding].map(String)).toEqual(["50", "50", "0", "50"]);
    expect(state.plans.get(m.plan)!.retired.toString()).toBe("50");
    m.b.command("cancel-rest", (c) => {
      const balance = addStock(m, c, "CS-2", m.alice, "10", "2025-04-01", { origin: "BALANCE", source: lot, planId: m.plan });
      c.tx("TX_STOCK_CANCELLATION", "2025-04-01", { security_id: lot, quantity: "40", reason_text: "Board resolution", balance_security_id: balance });
    });
    const after = m.b.replay(D);
    expect(after.violations).toEqual([]);
    expect(after.securities.get(lot)!.status).toBe("CANCELLED");
    expect(after.securities.get(lot)!.movedToBalance.toString()).toBe("10");
  });

  it("repurchases unvested or vested shares, with forfeiture at zero and the plan rules", () => {
    const m = miniOrg();
    const lot = issueStock(m, "CS-1", m.alice, "100", "2025-01-01", { planId: m.plan, origin: "RSA", vestingMonths: { start: "2025-01-01", months: 10, cliff: 0 } });
    terminate(m, "alice", m.alice, "2025-05-15");
    m.b.command("repurchase", (c) => {
      c.tx("TX_STOCK_REPURCHASE", "2025-06-01", { security_id: lot, quantity: "60", price: usd("0"), x_kind: "UNVESTED" });
      c.tx("TX_STOCK_REPURCHASE", "2025-06-02", { security_id: lot, quantity: "10", price: usd("2"), x_kind: "VESTED" });
    });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    const s = state.securities.get(lot)!;
    expect([s.repurchased, s.repurchasedUnvested, s.repurchasedVested, s.forfeited, s.outstanding].map(String)).toEqual(["70", "60", "10", "60", "30"]);
    const plan = state.plans.get(m.plan)!;
    expect([plan.returned.toString(), plan.retired.toString()]).toEqual(["60", "10"]); // vested repurchases RETIRE in this plan
    m.b.command("too-much", (c) => {
      c.tx("TX_STOCK_REPURCHASE", "2025-06-03", { security_id: lot, quantity: "5", price: usd("0"), x_kind: "UNVESTED" });
      c.tx("TX_STOCK_REPURCHASE", "2025-06-03", { security_id: lot, quantity: "50", price: usd("0"), x_kind: "VESTED" });
    });
    expect(codes(m.b.replay(D))).toEqual(expect.arrayContaining(["REPURCHASE_EXCEEDS_UNVESTED", "REPURCHASE_EXCEEDS_VESTED", "NEGATIVE_POSITION"]));
  });

  it("converts shares at the class ratio or a stated one, and reissues lots", () => {
    const m = miniOrg();
    const preferred = issueStock(m, "PS-1", m.bob, "100", "2025-01-01", { classId: m.preferred });
    m.b.command("ratio", (c) => {
      c.tx("TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", "2025-02-01", {
        stock_class_id: m.preferred,
        new_ratio_conversion_mechanism: { type: "RATIO_CONVERSION", ratio: { numerator: "3", denominator: "2" } },
      });
    });
    m.b.command("convert", (c) => {
      const common = addStock(m, c, "CS-1", m.bob, "75", "2025-03-01", { origin: "CONVERSION", source: preferred });
      const balance = addStock(m, c, "PS-2", m.bob, "50", "2025-03-01", { origin: "BALANCE", source: preferred, classId: m.preferred });
      c.tx("TX_STOCK_CONVERSION", "2025-03-01", { security_id: preferred, quantity_converted: "50", resulting_security_ids: [common], balance_security_id: balance });
    });
    m.b.command("convert-bad", (c) => {
      const common = addStock(m, c, "CS-2", m.bob, "10", "2025-04-01", { origin: "CONVERSION", source: uuid("PS-2") });
      c.tx("TX_STOCK_CONVERSION", "2025-04-01", { security_id: uuid("PS-2"), quantity_converted: "10", resulting_security_ids: [common], x_ratio: { numerator: "2", denominator: "1" } });
    });
    const lot = issueStock(m, "CS-8", m.carol, "10", "2025-01-01");
    m.b.command("reissue", (c) => {
      const replacement = addStock(m, c, "CS-9", m.carol, "10", "2025-05-01", { origin: "REISSUANCE", source: lot });
      c.tx("TX_STOCK_REISSUANCE", "2025-05-01", { security_id: lot, resulting_security_ids: [replacement], reason_text: "Lost certificate" });
    });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["CONVERSION_INCONSISTENT"]);
    expect(state.securities.get(preferred)!.status).toBe("CONVERTED");
    expect(state.securities.get(lot)).toMatchObject({ status: "CANCELLED", reissued: e.Dec.from(10) });
    const m2 = e.computeMetrics(state);
    expect(m2.classes.find((c) => c.stockClassId === m.preferred)!.conversionRatio.toString()).toBe("3/2");
  });

  it("retracts only an untouched lot", () => {
    const m = miniOrg();
    const lot = issueStock(m, "CS-1", m.bob, "100", "2025-01-01");
    m.b.command("retract", (c) => {
      c.tx("TX_STOCK_RETRACTION", "2025-02-01", { security_id: lot, reason_text: "Never issued" });
    });
    const state = m.b.replay(D);
    expect(state.securities.get(lot)).toMatchObject({ retracted: true, status: "RETRACTED" });
    expect(e.computeMetrics(state).capitalContribution.toString()).toBe("0");
    const used = issueStock(m, "CS-2", m.bob, "100", "2025-01-01");
    m.b.command("cancel-then-retract", (c) => {
      c.tx("TX_STOCK_CANCELLATION", "2025-02-01", { security_id: used, quantity: "10", reason_text: "x" });
      c.tx("TX_STOCK_RETRACTION", "2025-02-02", { security_id: used, reason_text: "x" });
    });
    expect(codes(m.b.replay(D))).toContain("RETRACTION_OF_USED_LOT");
  });
});

describe("awards", () => {
  it("issues options with their terms and checks subtype, plan and plan status", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01", { price: "0.95", fmv: "0.9", exemption: { federal: "RULE_701" } });
    const state = m.b.replay(D);
    const s = state.securities.get(option)!;
    expect([s.exercisePrice?.toString(), s.fmvAtGrant?.toString(), s.expirationDate, s.currency, s.compensationType]).toEqual(["19/20", "9/10", "2035-01-01", "USD", "OPTION_ISO"]);
    expect(state.plans.get(m.plan)!.grantedGross.toString()).toBe("4800");
    m.b.command("mismatch", (c) => {
      const lot = c.security("OPT-2", { family: "EQUITY_COMPENSATION", subtype: "OPTION_NSO", stakeholderId: m.alice, stockClassId: m.common, stockPlanId: uuid("plan:ghost"), parentSecurityId: null });
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", "2025-01-01", {
        security_id: lot,
        custom_id: "OPT-2",
        stakeholder_id: m.alice,
        stock_plan_id: uuid("plan:ghost"),
        stock_class_id: m.preferred,
        compensation_type: "OPTION_ISO",
        quantity: "10",
        exercise_price: usd("1"),
        expiration_date: null,
        termination_exercise_windows: [],
      });
    });
    expect(codes(m.b.replay(D))).toEqual(expect.arrayContaining(["IDENTITY_MISMATCH", "SUBTYPE_MISMATCH", "UNKNOWN_STOCK_PLAN"]));
  });

  it("blocks grants beyond plan availability (I6), from a terminated plan, and pools below what is used", () => {
    const m = miniOrg({ pool: "1000" });
    grant(m, "OPT-1", m.alice, "800", "2025-01-01");
    grant(m, "OPT-2", m.carol, "300", "2025-01-01");
    expect(codes(m.b.replay(D))).toEqual(["EXCEEDS_PLAN_AVAILABLE"]);
    const m2 = miniOrg({ pool: "1000" });
    grant(m2, "OPT-1", m2.alice, "800", "2025-01-01");
    m2.b.command("shrink", (c) => {
      c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2025-02-01", { stock_plan_id: m2.plan, shares_reserved: "500" });
    });
    expect(codes(m2.b.replay(D))).toEqual(["POOL_BELOW_USED"]);
    const m3 = miniOrg();
    m3.b.command("terminate-plan", (c) => {
      c.tx("X_STOCK_PLAN_TERMS", "2025-01-01", {
        stock_plan_id: m3.plan,
        return_rules: { cancelled_unvested_awards: "RETURN", expired_vested_options: "RETURN", repurchased_unvested_shares: "RETURN", repurchased_vested_shares: "RETURN", shares_withheld_for_tax: "RETURN" },
        default_termination_windows: [],
        default_repurchase_window: null,
        status: "terminated",
        pour_over_plan_id: m3.plan,
      });
    });
    grant(m3, "OPT-1", m3.alice, "10", "2025-02-01", { source: "app" });
    grant(m3, "OPT-2", m3.alice, "10", "2025-02-01", { source: "import" });
    const state = m3.b.replay(D);
    expect(state.violations.map((v) => [v.code, v.severity])).toEqual([
      ["POUR_OVER_INVALID", "error"],
      ["PLAN_TERMINATED", "error"],
      ["PLAN_TERMINATED", "warning"],
    ]);
  });

  it("exercises vested options and refuses what the rules forbid (I3)", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01");
    exercise(m, "CS-1", option, m.alice, "1300", "2026-02-01"); // 13/48 vested
    let state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.securities.get(option)!.exercised.toString()).toBe("1300");
    exercise(m, "CS-2", option, m.alice, "1000", "2026-02-02");
    state = m.b.replay(D);
    // Nothing vested is left, so the ISO lots are exhausted too.
    expect(codes(state)).toEqual(["EXCEEDS_VESTED_UNEXERCISED", "ISO_LOTS_EXCEEDED"]);
  });

  it("allows early exercise of an early-exercisable grant", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01", { early: true });
    exercise(m, "CS-1", option, m.alice, "4800", "2025-02-01", { early: true });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.securities.get(option)!.status).toBe("EXERCISED");
    expect(state.securities.get(option)!.exercises[0]!.earlyExercise).toBe(true);
    exercise(m, "CS-2", option, m.alice, "1", "2025-03-01");
    expect(codes(m.b.replay(D))).toContain("LOT_CLOSED");
  });

  it("refuses exercises after expiration or the contractual deadline unless extended", () => {
    const m = miniOrg();
    const short = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, expiration: "2025-06-01", type: "OPTION_NSO" });
    exercise(m, "CS-1", short, m.alice, "10", "2025-06-02", { portion: "NSO" });
    const option = grant(m, "OPT-2", m.carol, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    terminate(m, "carol", m.carol, "2025-03-01");
    exercise(m, "CS-2", option, m.carol, "10", "2025-06-02", { portion: "NSO" });
    expect(codes(m.b.replay(D))).toEqual(["AFTER_EXPIRATION", "AFTER_CONTRACTUAL_DEADLINE"]);
    const m2 = miniOrg();
    const option2 = grant(m2, "OPT-2", m2.carol, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    terminate(m2, "carol", m2.carol, "2025-03-01");
    m2.b.command("extend", (c) => {
      c.tx("X_SECURITY_MODIFICATION", "2025-05-01", { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: option2, new_contractual_deadline: "2025-12-31" });
    }, { source: "app" });
    exercise(m2, "CS-2", option2, m2.carol, "10", "2025-06-02", { portion: "NSO" });
    expect(m2.b.replay(D).violations).toEqual([]);
  });

  it("gates exercise on execution status (an error for app commands, a warning on imported history)", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, execution: "pending_company" });
    exercise(m, "CS-1", option, m.alice, "10", "2025-02-01", { source: "app" });
    exercise(m, "CS-2", option, m.alice, "10", "2025-02-02", { source: "import" });
    expect(m.b.replay(D).violations.map((v) => [v.code, v.severity])).toEqual([
      ["EXECUTION_PENDING", "error"],
      ["EXECUTION_PENDING", "warning"],
    ]);
  });

  it("checks ISO portions, lots and the ISO deadline", () => {
    const m = miniOrg();
    const nso = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    exercise(m, "CS-1", nso, m.alice, "10", "2025-02-01", { portion: "ISO" });
    const iso = grant(m, "OPT-2", m.carol, "100", "2025-01-01", { vesting: null });
    terminate(m, "carol", m.carol, "2025-03-01", { extra: {} });
    m.b.command("extend", (c) => {
      c.tx("X_SECURITY_MODIFICATION", "2025-05-01", { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: iso, new_contractual_deadline: "2025-12-31" });
    });
    exercise(m, "CS-2", iso, m.carol, "10", "2025-06-15", { portion: "ISO" });
    exercise(m, "CS-3", iso, m.carol, "10", "2025-06-16", { portion: "NSO", lots: { iso: "5", nso: "4" } });
    const state = m.b.replay(D);
    // CS-3's lots don't add up; 5 ISO lots it consumed became NSO shares with no reason (Form 3921 would miss them);
    // it claims NSO lots the grant doesn't have, skips ISO lots without a lot reason, and gives its NSO shares no reason.
    expect(codes(state)).toEqual([
      "ISO_PORTION_ON_NSO",
      "ISO_PORTION_AFTER_ISO_DEADLINE",
      "LOTS_MISMATCH",
      "ISO_LOTS_RECORDED_AS_NSO",
      "NSO_LOTS_EXCEEDED",
      "LOT_CHOICE_NEEDS_REASON",
      "NSO_PORTION_NEEDS_REASON",
    ]);
    // The $100K limit: 200,000 ISO options at $1 vesting at once leave only 100,000 ISO lots.
    const m2 = miniOrg({ pool: "1000000" });
    const big = grant(m2, "OPT-3", m2.alice, "200000", "2025-01-01", { vesting: null });
    exercise(m2, "CS-4", big, m2.alice, "150000", "2025-02-01", { portion: "ISO" });
    exercise(m2, "CS-5", big, m2.alice, "150", "2025-02-02", { portion: "ISO", source: "import" });
    expect(m2.b.replay(D).violations.map((v) => [v.code, v.severity])).toEqual([
      ["ISO_LOTS_EXCEEDED", "error"],
      ["ISO_LOTS_EXCEEDED", "warning"],
    ]);
  });

  it("checks that exercise portions match the resulting lots and the holder (I4)", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    m.b.command("bad-portions", (c) => {
      const lot = c.security("CS-1", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: option });
      c.tx("TX_EQUITY_COMPENSATION_EXERCISE", "2025-02-01", {
        security_id: option,
        quantity: "10",
        resulting_security_ids: [lot],
        x_portions: [{ portion: "NSO", quantity: "9", security_id: lot }],
        x_lots_consumed: { iso: "0", nso: "10" },
      });
      c.tx("TX_STOCK_ISSUANCE", "2025-02-01", {
        security_id: lot,
        custom_id: "CS-1",
        stakeholder_id: m.bob,
        stock_class_id: m.common,
        stock_plan_id: m.plan,
        share_price: usd("1"),
        quantity: "8",
        x_origin: "EXERCISE",
        x_source_security_id: option,
      });
    });
    expect(codes(m.b.replay(D))).toEqual(["LINEAGE_MISMATCH", "RESULTING_QUANTITY_MISMATCH", "PORTION_MISMATCH", "PORTION_MISMATCH"]);
  });

  it("nets out shares withheld on a net exercise under the plan rule", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, type: "OPTION_NSO" });
    exercise(m, "CS-1", option, m.alice, "100", "2025-02-01", { portion: "NSO", withheld: "30" });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.plans.get(m.plan)!.retired.toString()).toBe("30"); // withheld shares RETIRE in this plan
    expect(state.securities.get(uuid("CS-1"))!.outstanding.toString()).toBe("70");
  });

  it("cancels unvested first, expired options vested first, or the stated portion", () => {
    const m = miniOrg({ rules: { expired_vested_options: "RETIRE" } });
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01", { vesting: { months: 48, cliff: 0 } });
    cancel(m, "a", option, "100", "2025-06-15", "MUTUAL_AGREEMENT"); // 500 vested by Jun 1
    cancel(m, "b", option, "200", "2025-06-15", "EXPIRED");
    cancel(m, "c", option, "50", "2025-06-15", "OTHER", { x_vesting_portion: "VESTED" });
    cancel(m, "d", option, "50", "2025-06-15", "OTHER", { x_vesting_portion: "UNVESTED" });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    const s = state.securities.get(option)!;
    expect([s.cancelledUnvested, s.cancelledVested, s.expired, s.forfeited].map(String)).toEqual(["150", "250", "200", "150"]);
    const plan = state.plans.get(m.plan)!;
    expect([plan.returned.toString(), plan.retired.toString()]).toEqual(["150", "250"]);
    cancel(m, "e", option, "300", "2025-06-15", "OTHER", { x_vesting_portion: "VESTED" });
    cancel(m, "f", option, "9999", "2025-06-15", "OTHER", { x_vesting_portion: "UNVESTED" });
    expect(codes(m.b.replay(D))).toEqual(expect.arrayContaining(["CANCELLATION_EXCEEDS_VESTED", "CANCELLATION_EXCEEDS_UNVESTED", "NEGATIVE_POSITION"]));
  });

  it("moves the rest of a partially cancelled award to its balance lot", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    m.b.command("cancel-with-balance", (c) => {
      const balance = c.security("OPT-1B", { family: "EQUITY_COMPENSATION", subtype: "OPTION_ISO", stakeholderId: m.alice, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: option });
      c.tx("TX_EQUITY_COMPENSATION_ISSUANCE", "2025-02-01", {
        security_id: balance,
        custom_id: "OPT-1B",
        stakeholder_id: m.alice,
        stock_plan_id: m.plan,
        compensation_type: "OPTION_ISO",
        quantity: "60",
        exercise_price: usd("1"),
        expiration_date: "2035-01-01",
        termination_exercise_windows: [],
        x_origin: "BALANCE",
        x_source_security_id: option,
      });
      c.tx("TX_EQUITY_COMPENSATION_CANCELLATION", "2025-02-01", { security_id: option, quantity: "40", reason_text: "Waiver", x_reason: "HOLDER_WAIVER", balance_security_id: balance });
    });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.plans.get(m.plan)!.grantedGross.toString()).toBe("100"); // the balance lot isn't a new grant
    expect(e.computeMetrics(state).plans[0]!.awardsOutstanding.toString()).toBe("60");
  });

  it("releases vested RSUs net of withholding, and refuses a release of an option", () => {
    const m = miniOrg();
    const rsu = grant(m, "RSU-1", m.alice, "100", "2025-01-01", { type: "RSU", vesting: null });
    m.b.command("release", (c) => {
      const lot = c.security("CS-1", { family: "STOCK", subtype: "COMMON", stakeholderId: m.alice, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: rsu });
      c.tx("TX_EQUITY_COMPENSATION_RELEASE", "2025-02-01", { security_id: rsu, quantity: "100", settlement_date: "2025-02-01", release_price: usd("2"), resulting_security_ids: [lot], x_withheld_quantity: "40" });
      c.tx("TX_STOCK_ISSUANCE", "2025-02-01", { security_id: lot, custom_id: "CS-1", stakeholder_id: m.alice, stock_class_id: m.common, stock_plan_id: m.plan, share_price: usd("0"), quantity: "60", x_origin: "RELEASE", x_source_security_id: rsu });
    });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    expect(state.securities.get(rsu)!.status).toBe("EXERCISED");
    expect(state.plans.get(m.plan)!.retired.toString()).toBe("40");
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null });
    m.b.command("bad", (c) => {
      c.tx("TX_EQUITY_COMPENSATION_RELEASE", "2025-02-01", { security_id: option, quantity: "1", settlement_date: "2025-02-01", release_price: usd("2"), resulting_security_ids: [uuid("x")] });
    });
    const rsu2 = grant(m, "RSU-2", m.alice, "100", "2025-01-01", { type: "RSU" });
    m.b.command("too-early", (c) => {
      const lot = c.security("CS-2", { family: "STOCK", subtype: "COMMON", stakeholderId: m.alice, stockClassId: m.common, stockPlanId: m.plan, parentSecurityId: rsu2 });
      c.tx("TX_EQUITY_COMPENSATION_RELEASE", "2025-02-01", { security_id: rsu2, quantity: "10", settlement_date: "2025-02-01", release_price: usd("2"), resulting_security_ids: [lot] });
      c.tx("TX_STOCK_ISSUANCE", "2025-02-01", { security_id: lot, custom_id: "CS-2", stakeholder_id: m.alice, stock_class_id: m.common, stock_plan_id: m.plan, share_price: usd("0"), quantity: "10", x_origin: "RELEASE", x_source_security_id: rsu2 });
      c.tx("TX_EQUITY_COMPENSATION_EXERCISE", "2025-02-01", {
        security_id: rsu2,
        quantity: "1",
        resulting_security_ids: [lot],
        x_portions: [{ portion: "NSO", quantity: "1", security_id: lot }],
        x_lots_consumed: { iso: "0", nso: "1" },
      });
    });
    expect(codes(m.b.replay(D))).toEqual(expect.arrayContaining(["FAMILY_MISMATCH", "EXCEEDS_VESTED_UNEXERCISED"]));
  });
});

describe("warrants and convertibles", () => {
  function warrant(m: ReturnType<typeof miniOrg>, label: string, quantity: string, expiration?: string): string {
    let lot = "";
    m.b.command(`warrant:${label}`, (c) => {
      lot = c.security(label, { family: "WARRANT", subtype: "WARRANT", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_WARRANT_ISSUANCE", "2025-01-01", {
        security_id: lot,
        custom_id: label,
        stakeholder_id: m.bob,
        quantity,
        exercise_price: usd("0.5"),
        purchase_price: usd("100"),
        ...(expiration ? { warrant_expiration_date: expiration } : {}),
      });
    });
    return lot;
  }

  it("exercises warrants for cash or net, and cancels them", () => {
    const m = miniOrg();
    const w = warrant(m, "WAR-1", "100");
    m.b.command("cash", (c) => {
      const lot = addStock(m, c, "CS-1", m.bob, "40", "2025-02-01", { origin: "EXERCISE", source: w });
      c.tx("TX_WARRANT_EXERCISE", "2025-02-01", { security_id: w, resulting_security_ids: [lot], x_quantity: "40" });
    });
    m.b.command("net", (c) => {
      const lot = addStock(m, c, "CS-2", m.bob, "25", "2025-03-01", { origin: "EXERCISE", source: w });
      c.tx("TX_WARRANT_EXERCISE", "2025-03-01", { security_id: w, resulting_security_ids: [lot], x_quantity: "50", x_net_exercise: true });
    });
    m.b.command("cancel", (c) => {
      c.tx("TX_WARRANT_CANCELLATION", "2025-04-01", { security_id: w, quantity: "10", reason_text: "Expired", x_reason: "EXPIRED" });
    });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    const s = state.securities.get(w)!;
    expect([s.exercised.toString(), s.status, s.capitalContribution.toString()]).toEqual(["90", "EXPIRED", "100"]);
  });

  it("refuses warrant exercises beyond the outstanding, after expiry or while pending", () => {
    const m = miniOrg();
    const w = warrant(m, "WAR-1", "10", "2025-06-01");
    m.b.command("pending", (c) => {
      c.tx("X_EXECUTION_STATUS", "2025-01-02", { security_id: w, status: "pending_holder" });
    });
    m.b.command("bad", (c) => {
      const lot = addStock(m, c, "CS-1", m.bob, "20", "2025-07-01", { origin: "EXERCISE", source: w });
      c.tx("TX_WARRANT_EXERCISE", "2025-07-01", { security_id: w, resulting_security_ids: [lot], x_quantity: "20" });
    });
    expect(codes(m.b.replay(D))).toEqual(["EXCEEDS_VESTED_UNEXERCISED", "AFTER_EXPIRATION", "EXECUTION_PENDING"]);
  });

  it("converts the whole convertible (I8), or moves the rest to a balance lot; cancels and transfers principal", () => {
    const m = miniOrg();
    let safe = "";
    m.b.command("safe", (c) => {
      safe = c.security("SAFE-1", { family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: m.bob, stockClassId: null, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_CONVERTIBLE_ISSUANCE", "2025-01-01", { security_id: safe, custom_id: "SAFE-1", stakeholder_id: m.bob, investment_amount: usd("1000"), convertible_type: "SAFE" });
    });
    m.b.command("partial", (c) => {
      const balance = c.security("SAFE-1B", { family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: m.bob, stockClassId: null, stockPlanId: null, parentSecurityId: safe });
      c.tx("TX_CONVERTIBLE_ISSUANCE", "2025-02-01", { security_id: balance, custom_id: "SAFE-1B", stakeholder_id: m.bob, investment_amount: usd("400"), convertible_type: "SAFE", x_origin: "BALANCE", x_source_security_id: safe });
      const lot = addStock(m, c, "PS-1", m.bob, "600", "2025-02-01", { origin: "CONVERSION", source: safe, classId: m.preferred });
      c.tx("TX_CONVERTIBLE_CONVERSION", "2025-02-01", { security_id: safe, resulting_security_ids: [lot], quantity_converted: "600", balance_security_id: balance });
    });
    m.b.command("cancel", (c) => {
      c.tx("TX_CONVERTIBLE_CANCELLATION", "2025-03-01", { security_id: uuid("SAFE-1B"), amount: usd("100"), reason_text: "Repaid" });
    });
    m.b.command("transfer", (c) => {
      const to = c.security("SAFE-2", { family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: m.carol, stockClassId: null, stockPlanId: null, parentSecurityId: uuid("SAFE-1B") });
      c.tx("TX_CONVERTIBLE_ISSUANCE", "2025-04-01", { security_id: to, custom_id: "SAFE-2", stakeholder_id: m.carol, investment_amount: usd("300"), convertible_type: "SAFE", x_origin: "TRANSFER", x_source_security_id: uuid("SAFE-1B") });
      c.tx("TX_CONVERTIBLE_TRANSFER", "2025-04-01", { security_id: uuid("SAFE-1B"), amount: usd("300"), resulting_security_ids: [to] });
    });
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    const metrics = e.computeMetrics(state);
    expect(metrics.capitalContribution.toString()).toBe("1000"); // gross: derived lots add nothing
    expect(metrics.holders.find((h) => h.stakeholderId === m.carol)!.convertiblesOutstanding.toString()).toBe("300");
    expect(state.securities.get(safe)!.status).toBe("CONVERTED");
    let other = "";
    m.b.command("safe-2", (c) => {
      other = c.security("SAFE-3", { family: "CONVERTIBLE", subtype: "SAFE", stakeholderId: m.bob, stockClassId: null, stockPlanId: null, parentSecurityId: null });
      c.tx("TX_CONVERTIBLE_ISSUANCE", "2025-01-01", { security_id: other, custom_id: "SAFE-3", stakeholder_id: m.bob, investment_amount: usd("1000"), convertible_type: "SAFE" });
    });
    m.b.command("not-whole", (c) => {
      const lot = addStock(m, c, "PS-2", m.bob, "1", "2025-05-01", { origin: "CONVERSION", source: other, classId: m.preferred });
      c.tx("TX_CONVERTIBLE_CONVERSION", "2025-05-01", { security_id: other, resulting_security_ids: [lot], quantity_converted: "999" });
      c.tx("TX_CONVERTIBLE_CONVERSION", "2025-05-01", { security_id: uuid("SAFE-2"), resulting_security_ids: [lot], quantity_converted: "5000" });
    });
    expect(codes(m.b.replay(D))).toEqual(expect.arrayContaining(["CONVERSION_NOT_WHOLE", "NEGATIVE_POSITION"]));
  });
});

describe("classes, issuer, plans and vesting facts", () => {
  it("checks class and issuer authorized shares at every date (I5)", () => {
    const m = miniOrg();
    m.b.command("issuer", (c) => {
      c.tx("TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT", "2024-01-01", { issuer_id: m.b.orgId, new_shares_authorized: "1000" });
      c.tx("TX_ISSUER_AUTHORIZED_SHARES_ADJUSTMENT", "2024-01-01", { issuer_id: uuid("org:other"), new_shares_authorized: "1000" });
    });
    issueStock(m, "PS-1", m.bob, "600000", "2025-01-01", { classId: m.preferred });
    expect(codes(m.b.replay(D))).toEqual(["IDENTITY_MISMATCH", "CLASS_OVER_AUTHORIZED", "ISSUER_OVER_AUTHORIZED"]);
  });

  it("returns retired shares to the pool explicitly, never more than were retired", () => {
    const m = miniOrg({ rules: { cancelled_unvested_awards: "RETIRE" } });
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01");
    cancel(m, "a", option, "100", "2025-02-01", "HOLDER_WAIVER");
    m.b.command("return", (c) => {
      c.tx("TX_STOCK_PLAN_RETURN_TO_POOL", "2025-03-01", { stock_plan_id: m.plan, quantity: "60", reason_text: "Board resolution" });
    });
    let metrics = e.computeMetrics(m.b.replay(D));
    expect([metrics.plans[0]!.equityRetired.toString(), metrics.plans[0]!.availableToGrant.toString()]).toEqual(["40", "99960"]);
    m.b.command("return-too-much", (c) => {
      c.tx("TX_STOCK_PLAN_RETURN_TO_POOL", "2025-04-01", { stock_plan_id: m.plan, quantity: "41", reason_text: "Board resolution" });
      c.tx("TX_STOCK_PLAN_RETURN_TO_POOL", "2025-04-01", { stock_plan_id: uuid("plan:ghost"), quantity: "1", reason_text: "x" });
      c.tx("TX_STOCK_PLAN_POOL_ADJUSTMENT", "2025-04-01", { stock_plan_id: uuid("plan:ghost"), shares_reserved: "1" });
      c.tx("X_STOCK_PLAN_TERMS", "2025-04-01", {
        stock_plan_id: uuid("plan:ghost"),
        return_rules: { cancelled_unvested_awards: "RETURN", expired_vested_options: "RETURN", repurchased_unvested_shares: "RETURN", repurchased_vested_shares: "RETURN", shares_withheld_for_tax: "RETURN" },
        default_termination_windows: [],
        default_repurchase_window: null,
        status: "active",
        pour_over_plan_id: null,
      });
    });
    expect(codes(m.b.replay(D))).toEqual(["RETURN_EXCEEDS_RETIRED", "UNKNOWN_STOCK_PLAN", "UNKNOWN_STOCK_PLAN", "UNKNOWN_STOCK_PLAN"]);
    metrics = e.computeMetrics(m.b.replay(D));
    expect(metrics.plans[0]!.equityRetired.toString()).toBe("-1"); // 100 retired, 101 returned
  });

  it("warns and uses the single default when no plan terms are in force", () => {
    const m = miniOrg({ planTerms: false });
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01");
    cancel(m, "a", option, "10", "2025-02-01");
    const state = m.b.replay(D);
    expect(state.violations.map((v) => [v.code, v.severity])).toEqual([["PLAN_TERMS_MISSING", "warning"]]);
    expect(state.plans.get(m.plan)!.returned.toString()).toBe("10");
  });

  it("records class terms, conversion targets and unknown classes", () => {
    const m = miniOrg();
    m.b.command("terms", (c) => {
      c.tx("X_STOCK_CLASS_TERMS", "2025-01-01", {
        stock_class_id: m.preferred,
        votes_per_share: "2",
        exclude_from_fully_diluted: true,
        seniority: 1,
        liquidation_preference_multiple: "1.5",
        participation: "CAPPED",
        participation_cap_multiple: "3",
        dividend_terms: { rate: "0.08" },
        anti_dilution: "FULL_RATCHET",
        not_recorded_in_pulley: [],
      });
      c.tx("X_STOCK_CLASS_TERMS", "2025-01-01", { ...(c.transactions[0]!.payload as Record<string, unknown>), stock_class_id: uuid("class:ghost") });
      c.tx("TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", "2025-01-01", {
        stock_class_id: m.preferred,
        new_ratio_conversion_mechanism: { type: "RATIO_CONVERSION", ratio: { numerator: "1", denominator: "1" } },
        x_converts_to_stock_class_id: uuid("class:ghost"),
      });
      c.tx("TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT", "2025-01-01", { stock_class_id: uuid("class:ghost"), new_shares_authorized: "1" });
      c.tx("TX_STOCK_CLASS_CONVERSION_RATIO_ADJUSTMENT", "2025-01-01", {
        stock_class_id: uuid("class:ghost"),
        new_ratio_conversion_mechanism: { type: "RATIO_CONVERSION", ratio: { numerator: "1", denominator: "1" } },
      });
    });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["UNKNOWN_STOCK_CLASS", "UNKNOWN_STOCK_CLASS", "UNKNOWN_STOCK_CLASS", "UNKNOWN_STOCK_CLASS"]);
    const terms = state.classes.get(m.preferred)!.terms;
    expect([terms.votesPerShare.toString(), terms.excludeFromFullyDiluted, terms.liquidationPreferenceMultiple?.toString(), terms.participationCapMultiple?.toString()]).toEqual(["2", true, "1.5", "3"]);
  });

  it("records accelerations, milestone vesting, pauses and repricing", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01");
    m.b.command("facts", (c) => {
      c.tx("TX_VESTING_ACCELERATION", "2025-06-01", { security_id: option, quantity: "1200", reason_text: "Board approval" });
      c.tx("TX_VESTING_ACCELERATION", "2025-06-01", { security_id: option, quantity: "100", reason_text: "Already in the imported events", x_explicit_already_applied: true });
      c.tx("TX_VESTING_EVENT", "2025-07-01", { security_id: option, vesting_condition_id: "milestone-1", x_quantity: "100" });
      c.tx("X_EQUITY_COMPENSATION_REPRICING", "2025-08-01", { security_id: option, new_exercise_price: usd("0.5") });
      c.tx("X_VESTING_PAUSE", "2025-09-01", { security_id: option, reason: "Leave" });
      c.tx("X_VESTING_PAUSE", "2025-09-02", { security_id: option });
      c.tx("X_VESTING_RESUME", "2025-10-01", { security_id: option });
      c.tx("X_VESTING_RESUME", "2025-10-02", { security_id: option });
      c.tx("TX_VESTING_ACCELERATION", "2025-11-01", { security_id: option, quantity: "9999", reason_text: "Too much" });
    });
    const lot = issueStock(m, "CS-1", m.bob, "1", "2025-01-01");
    m.b.command("reprice-stock", (c) => {
      c.tx("X_EQUITY_COMPENSATION_REPRICING", "2025-08-01", { security_id: lot, new_exercise_price: usd("0.5") });
    });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["FAMILY_MISMATCH", "ALREADY_PAUSED", "NOT_PAUSED", "ACCELERATION_EXCEEDS_UNVESTED"]); // effective order
    const s = state.securities.get(option)!;
    expect(s.exercisePrice?.toString()).toBe("1/2");
    expect(s.pauses).toEqual([{ from: "2025-09-01", to: "2025-10-01" }]);
    expect(e.positionAt(state, s, "2025-07-01").vested.toString()).toBe("1300"); // accelerations add once; the milestone adds its 100
  });

  it("applies terminations: stops, per-lot overrides, exact cancelled events and missing windows", () => {
    const m = miniOrg();
    const a = grant(m, "OPT-1", m.alice, "4800", "2025-01-01", { vesting: { months: 48, cliff: 0 } });
    const b = grant(m, "OPT-2", m.alice, "4800", "2025-01-01", { vesting: { months: 48, cliff: 0 }, windows: [] }); // the plan's windows apply
    const later = grant(m, "OPT-3", m.alice, "100", "2026-01-01");
    grant(m, "OPT-4", m.alice, "100", "2025-01-01", { planId: null, windows: [] }); // no window anywhere
    const bobs = issueStock(m, "CS-1", m.bob, "1", "2025-01-01");
    terminate(m, "alice", m.alice, "2025-06-30", {
      type: "with_cause",
      extra: {
        securities: [
          { security_id: a, vesting_stop_date: "2025-03-31" },
          { security_id: b, cancelled_vesting_event_ids: [] },
          { security_id: bobs },
        ],
      },
    });
    m.b.command("bad-stop", (c) => {
      c.tx("X_STAKEHOLDER_TERMINATION", "2025-07-01", { stakeholder_id: m.carol, termination_date: "2025-07-01", termination_type: "voluntary", vesting_stop_date: "2025-08-01", relationship_before: "employee", relationship_after: "ex_employee" });
      c.tx("X_STAKEHOLDER_TERMINATION", "2025-07-01", { stakeholder_id: uuid("ghost"), termination_date: "2025-07-01", termination_type: "voluntary", vesting_stop_date: "2025-07-01", relationship_before: "employee", relationship_after: "ex_employee" });
      c.tx("X_STAKEHOLDER_LEAVE", "2025-07-01", { stakeholder_id: m.carol, start_date: "2025-07-01", end_date: "2025-06-01", return_guaranteed: false });
    });
    const state = m.b.replay(D);
    expect(state.violations.map((v) => [v.code, v.severity])).toEqual([
      ["IDENTITY_MISMATCH", "error"],
      ["NO_TERMINATION_WINDOW", "warning"],
      ["VESTING_STOP_AFTER_TERMINATION", "error"],
      ["UNKNOWN_STAKEHOLDER", "error"],
      ["LEAVE_DATES", "error"],
    ]);
    expect(e.positionAt(state, state.securities.get(a)!, D).vested.toString()).toBe("200"); // Feb 1 and Mar 1 vest before the Mar 31 stop
    expect(e.positionAt(state, state.securities.get(b)!, D).vested.toString()).toBe(e.Dec.from(4800 * 17).divideTo(48, 0, "FLOOR").toString());
    expect(state.securities.get(a)!.computedDeadline?.deadline).toBe("2025-06-30"); // 0 days with cause
    expect(state.securities.get(later)!.termination).toBeNull(); // granted after the termination
    expect(state.stakeholders.get(m.alice)!.terminations).toHaveLength(1);
  });

  it("applies execution status and deadline modifications with their checks", () => {
    const m = miniOrg();
    const option = grant(m, "OPT-1", m.alice, "100", "2025-01-01", { vesting: null, expiration: "2026-01-01" });
    const lot = issueStock(m, "CS-1", m.bob, "1", "2025-01-01");
    terminate(m, "alice", m.alice, "2025-03-01");
    m.b.command("mods", (c) => {
      c.tx("X_SECURITY_MODIFICATION", "2025-04-01", { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: option, new_contractual_deadline: "2026-06-01" });
      c.tx("X_SECURITY_MODIFICATION", "2025-04-01", { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: option, new_contractual_deadline: "2025-05-01" });
      c.tx("X_SECURITY_MODIFICATION", "2025-04-01", { kind: "CONTRACTUAL_DEADLINE_EXTENSION", security_id: lot, new_contractual_deadline: "2025-05-01" });
      c.tx("X_SECURITY_MODIFICATION", "2025-04-01", { kind: "REPURCHASE_DEADLINE", security_id: option, last_repurchase_date: "2025-05-01" });
      c.tx("X_SECURITY_MODIFICATION", "2025-04-01", { kind: "REPURCHASE_DEADLINE", security_id: lot, last_repurchase_date: "2025-05-01" });
      c.tx("X_EXECUTION_STATUS", "2025-04-01", { security_id: option, status: "pending_holder" });
    });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["EXTENSION_AFTER_EXPIRATION", "EXTENSION_SHORTENS_DEADLINE", "FAMILY_MISMATCH", "FAMILY_MISMATCH"]);
    expect(state.securities.get(lot)!.lastRepurchaseDate?.deadline).toBe("2025-05-01");
    expect(state.securities.get(option)!.executionStatus).toBe("pending_holder");
  });
});

describe("opening balances and splits", () => {
  const evidence = [{ run: "r04", file: "cap_table_raw_2022-01-01.xlsx", pointer: "Securities!A2", sha256: "0".repeat(64) }];

  it("states a migrated lot's position at a date; earlier as-of views say history isn't migrated", () => {
    const m = miniOrg();
    let lot = "";
    m.b.command("opening", (c) => {
      lot = c.security("CS-1", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("X_MIGRATION_OPENING_BALANCE", "2025-01-01", {
        security_id: lot,
        outstanding: "900",
        exercised: "0",
        cancelled: "100",
        issuance: { security_id: lot, custom_id: "CS-1", stakeholder_id: m.bob, stock_class_id: m.common, share_price: usd("0.0001"), quantity: "1000", x_origin: "FOUNDERS_STOCK" },
        x_evidence: evidence,
      });
    });
    const before = m.b.replay("2024-12-31");
    expect(before.pendingOpeningBalances.get(lot)).toBe("2025-01-01");
    expect(e.computeMetrics(before).openingBalances).toEqual([{ securityId: lot, date: "2025-01-01" }]);
    const state = m.b.replay(D);
    expect(state.violations).toEqual([]);
    const s = state.securities.get(lot)!;
    expect([s.issuedQuantity, s.outstanding, s.cancelled, s.capitalContribution].map(String)).toEqual(["1000", "900", "100", "0.1"]);
    expect(s.openingBalance?.date).toBe("2025-01-01");
  });

  it("can stand in for a missing issuance, close an empty lot, and refuses bad positions", () => {
    const m = miniOrg();
    let lot = "";
    let empty = "";
    m.b.command("opening", (c) => {
      lot = c.security("CS-1", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("X_MIGRATION_OPENING_BALANCE", "2025-01-01", { security_id: lot, outstanding: "10", issued: "5", x_evidence: evidence });
      empty = c.security("CS-2", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("X_MIGRATION_OPENING_BALANCE", "2025-01-01", { security_id: empty, outstanding: "0", cancelled: "7", x_evidence: evidence });
      const invalid = c.security("CS-3", { family: "STOCK", subtype: "COMMON", stakeholderId: m.bob, stockClassId: m.common, stockPlanId: null, parentSecurityId: null });
      c.tx("X_MIGRATION_OPENING_BALANCE", "2025-01-01", { security_id: invalid, outstanding: "1", issuance: { nonsense: true }, x_evidence: evidence });
    });
    const state = m.b.replay(D);
    expect(codes(state)).toEqual(["OPENING_BALANCE_INVALID", "OPENING_BALANCE_INVALID"]);
    expect(state.securities.get(empty)!.status).toBe("CANCELLED");
    m.b.command("later-opening", (c) => {
      c.tx("X_MIGRATION_OPENING_BALANCE", "2027-01-01", { security_id: lot, outstanding: "1", x_evidence: evidence });
      c.tx("X_MIGRATION_OPENING_BALANCE", "2026-12-01", { security_id: lot, outstanding: "1", x_evidence: evidence });
    });
    expect(m.b.replay(D).pendingOpeningBalances.get(lot)).toBe("2026-12-01");
  });

  it("splits a class: lots, awards and warrants scale; prices scale inversely; authorized doesn't move (I7)", () => {
    const m = miniOrg();
    const lot = issueStock(m, "CS-1", m.bob, "101", "2025-01-01");
    const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01", { price: "0.9", fmv: "0.9" });
    cancel(m, "a", option, "100", "2025-03-01", "MUTUAL_AGREEMENT");
    m.b.command("split", (c) => {
      c.tx("TX_STOCK_CLASS_SPLIT", "2025-06-01", { stock_class_id: m.common, split_ratio: { numerator: "3", denominator: "2" } });
      c.tx("TX_STOCK_CLASS_SPLIT", "2025-06-01", { stock_class_id: uuid("class:ghost"), split_ratio: { numerator: "2", denominator: "1" } });
    });
    const before = m.b.replay("2025-05-31");
    const after = m.b.replay("2025-06-01");
    expect(codes(after)).toEqual(["UNKNOWN_STOCK_CLASS"]);
    expect(e.checkSplitScaling(before, after, m.common, e.Rational.of(3, 2))).toEqual([]);
    expect(after.securities.get(lot)!.outstanding.toString()).toBe("151"); // 151.5 rounds down, cash in lieu
    const s = after.securities.get(option)!;
    expect([s.issuedQuantity.toString(), s.outstanding.toString(), s.exercisePrice?.toString(), s.fmvAtGrant?.toString()]).toEqual(["7200", "7050", "3/5", "3/5"]);
    expect(after.classes.get(m.common)!.authorized?.toString()).toBe("1000000");
    expect(after.classes.get(m.common)!.splits).toHaveLength(1);
    const timeline = e.securityVestingTimeline(after, s);
    expect(e.Dec.sum(timeline.map((t) => t.quantity)).toString()).toBe("7200");
  });
});
