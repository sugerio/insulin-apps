import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import type { LedgerBuilder } from "./fixtures/builder.ts";
import { cancel, grant, miniOrg } from "./fixtures/mini.ts";

/** The on-demand and pre-activation verifier reports each kind of damage using ids and descriptive codes only. */

function rowsOf(b: LedgerBuilder, options: { edges?: boolean } = {}): e.LedgerVerificationRows {
  const history = e.replay(b.reference, b.transactions, { asOf: "2099-12-31" });
  const last = b.rows.at(-1);
  return {
    orgId: b.orgId,
    shareUnit: b.reference.shareUnit,
    head: { seq: b.headSeq, head_hash: last?.chain_hash ?? null, genesis_hash: e.genesisHash(b.orgId) },
    transactions: b.rows.map((row) => ({ ...row })),
    commands: b.reference.commands.map((command) => ({
      id: command.id, type: command.type, actor_kind: command.actorKind, reverses_command_id: command.reversesCommandId,
      first_seq: command.firstSeq, last_seq: command.lastSeq, declared_tx_count: command.declaredTxCount, created_at: command.createdAt,
    })),
    securities: b.reference.securities.map((s) => ({
      id: s.id, family: s.family, subtype: s.subtype, stakeholder_id: s.stakeholderId, stock_class_id: s.stockClassId, stock_plan_id: s.stockPlanId,
      display_id: s.displayId, origin_command_id: s.originCommandId, parent_security_id: s.parentSecurityId,
    })),
    stockClasses: b.reference.stockClasses.map((c) => ({ id: c.id, name: c.name, class_type: c.classType })),
    stockPlans: b.reference.stockPlans.map((p) => ({ id: p.id, name: p.name, stock_class_id: p.stockClassId })),
    stakeholders: b.reference.stakeholders.map((s) => ({ id: s.id, relationship: s.relationship, kind: "individual" as const, country_of_residence: "US", tax_status: "us" as const })),
    vestingTerms: b.reference.vestingTerms.map((t) => ({ id: t.id, definition: e.canonicalJson(t.definition), definition_sha256: t.definitionSha256 })),
    edges: options.edges === false ? [] : b.reference.commands.flatMap((command) => e.commandDependencies(history, command.id))
      .map((edge) => ({ command_id: edge.commandId, depends_on_command_id: edge.dependsOnCommandId, kind: edge.kind })),
  };
}

function ledger(): LedgerBuilder {
  const m = miniOrg();
  const option = grant(m, "OPT-1", m.alice, "4800", "2025-01-01");
  cancel(m, "waiver", option, "100", "2025-07-01");
  return m.b;
}

function failed(report: e.LedgerVerificationReport): Record<string, string[]> {
  return Object.fromEntries(report.checks.filter((check) => !check.ok).map((check) => [check.name, check.problems]));
}

describe("verifyLedgerRows", () => {
  it("passes a sound ledger on every check and replays it", () => {
    const b = ledger();
    const report = e.verifyLedgerRows(rowsOf(b), { asOf: "2026-10-21" });
    expect(report.checks.map((check) => check.name)).toEqual([...e.LEDGER_CHECKS]);
    expect(failed(report)).toEqual({});
    expect(report).toMatchObject({ ok: true, ledgerSeq: b.headSeq, ledgerHeadHash: b.rows.at(-1)!.chain_hash });
    expect(report.state).not.toBeNull();
  });

  it("names a payload that no longer hashes to its digest, and a broken link", () => {
    const b = ledger();
    const rows = rowsOf(b);
    const tampered = rows.transactions.map((row) => (row.seq === 3 ? { ...row, payload_sha256: "0".repeat(64) } : row));
    expect(failed(e.verifyLedgerRows({ ...rows, transactions: tampered }, { asOf: "2026-10-21" }))).toMatchObject({
      payload_hashes: ["seq 3: PAYLOAD_HASH_MISMATCH"],
      chain: ["seq 3: CHAIN_HASH_MISMATCH"],
    });
    const relinked = rows.transactions.map((row) => (row.seq === 2 ? { ...row, prev_hash: "f".repeat(64) } : row));
    expect(failed(e.verifyLedgerRows({ ...rows, transactions: relinked }, { asOf: "2026-10-21" }))).toMatchObject({ chain: ["seq 2: PREV_HASH_MISMATCH"] });
    expect(failed(e.verifyLedgerRows({ ...rows, head: { ...rows.head!, seq: rows.head!.seq + 1 } }, { asOf: "2026-10-21" })).chain![0]).toMatch(/^HEAD_MISMATCH/);
    expect(failed(e.verifyLedgerRows({ ...rows, transactions: rows.transactions.slice(1) }, { asOf: "2026-10-21" })).chain![0]).toMatch(/SEQ_GAP/);
  });

  it("fails a seal, a vesting row's hash and a missing dependency edge", () => {
    const b = ledger();
    const rows = rowsOf(b);
    const command = rows.commands.at(-1)!;
    expect(failed(e.verifyLedgerRows({ ...rows, commands: rows.commands.map((c) => (c.id === command.id ? { ...c, declared_tx_count: 2 } : c)) }, { asOf: "2026-10-21" })).seals)
      .toEqual([`SEAL_COUNT: ${command.id}`]);
    const terms = rows.vestingTerms[0]!;
    expect(failed(e.verifyLedgerRows({ ...rows, vestingTerms: [{ ...terms, definition_sha256: "a".repeat(64) }] }, { asOf: "2026-10-21" })).replay)
      .toContain(`VESTING_TERMS_HASH_MISMATCH`);
    const withoutEdges = failed(e.verifyLedgerRows(rowsOf(b, { edges: false }), { asOf: "2026-10-21" }));
    expect(withoutEdges.dependencies!.every((problem) => problem.startsWith("DEPENDENCY_EDGE_MISSING "))).toBe(true);
  });

  it("reports an undecodable payload without replaying, and refuses a non-UUID org in its queries", () => {
    const b = ledger();
    const rows = rowsOf(b);
    const broken = rows.transactions.map((row) => (row.seq === 1 ? { ...row, payload: "{\"not\":\"a payload\"}" } : row));
    const report = e.verifyLedgerRows({ ...rows, transactions: broken }, { asOf: "2026-10-21" });
    expect(report.state).toBeNull();
    expect(failed(report).replay![0]).toMatch(/^seq 1: /);
    expect(() => e.ledgerVerificationQueries("x' OR '1'='1")).toThrow(RangeError);
  });
});

describe("valuation events of the same day", () => {
  const base = { id: "v", valuationType: "409A" as const, reportVersion: "FINAL" as const, effectiveDate: "2026-01-01", expirationDate: "2027-01-01", prices: [{ stockClassId: "c", pricePerShare: "1" }] };

  it("clears only the flags recorded before the confirmation", () => {
    const flag = { id: "f", kind: "MATERIAL_EVENT" as const, eventDate: "2026-05-01", reversesEventId: null, createdAt: 1 };
    const clear = { id: "c", kind: "REVIEW_CLEARED" as const, eventDate: "2026-05-01", reversesEventId: null, createdAt: 2 };
    const later = { id: "g", kind: "MATERIAL_EVENT" as const, eventDate: "2026-05-01", reversesEventId: null, createdAt: 3 };
    expect(e.valuationStatus({ ...base, events: [flag, clear] }, [], "2026-05-02")).toBe("presumptively_valid");
    expect(e.valuationStatus({ ...base, events: [flag, clear, later] }, [], "2026-05-02")).toBe("review_required");
    // Without recording times (migrated rows), the same date counts as cleared, as before.
    const untimed = [{ ...flag, createdAt: undefined }, { ...clear, createdAt: undefined }, { ...later, createdAt: undefined }];
    expect(e.valuationStatus({ ...base, events: untimed }, [], "2026-05-02")).toBe("presumptively_valid");
    expect(e.presumptivelyValidOn([{ ...base, events: [flag] }], "2026-05-02")).toBeNull();
    expect(e.presumptivelyValidOn([{ ...base, events: [] }], "2026-05-02")?.id).toBe("v");
  });
});
