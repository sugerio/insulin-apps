import { describe, expect, it } from "vitest";
import * as e from "../../../src/app/shared/engine/index.ts";
import { LedgerBuilder } from "./fixtures/builder.ts";
import { addStock, exercise, grant, miniOrg, terminate } from "./fixtures/mini.ts";

function incrementalEdges(b: LedgerBuilder, importBoundary: number): e.DependencyEdge[] {
  const edges: e.DependencyEdge[] = [];
  for (const command of b.reference.commands) {
    if (command.reversesCommandId !== null) continue;
    const knownAt = command.lastSeq <= importBoundary ? importBoundary : command.lastSeq;
    edges.push(...e.commandDependencies(b.replay("2026-12-31", { asKnownAt: knownAt }), command.id));
  }
  return edges;
}

function verificationRows(b: LedgerBuilder, importBoundary: number): e.LedgerVerificationRows {
  return {
    orgId: b.orgId,
    shareUnit: b.reference.shareUnit,
    head: { seq: b.headSeq, head_hash: b.rows.at(-1)?.chain_hash ?? null, genesis_hash: e.genesisHash(b.orgId) },
    transactions: b.rows,
    commands: b.reference.commands.map((row) => ({
      id: row.id, type: row.type, actor_kind: row.actorKind, reverses_command_id: row.reversesCommandId,
      first_seq: row.firstSeq, last_seq: row.lastSeq, declared_tx_count: row.declaredTxCount, created_at: row.createdAt,
    })),
    securities: b.reference.securities.map((row) => ({
      id: row.id, family: row.family, subtype: row.subtype, stakeholder_id: row.stakeholderId,
      stock_class_id: row.stockClassId, stock_plan_id: row.stockPlanId, display_id: row.displayId,
      origin_command_id: row.originCommandId, parent_security_id: row.parentSecurityId,
    })),
    stockClasses: b.reference.stockClasses.map((row) => ({ id: row.id, name: row.name, class_type: row.classType })),
    stockPlans: b.reference.stockPlans.map((row) => ({ id: row.id, name: row.name, stock_class_id: row.stockClassId })),
    stakeholders: b.reference.stakeholders.map((row) => ({ id: row.id, relationship: row.relationship, kind: row.kind ?? "individual", country_of_residence: null, tax_status: "unknown" })),
    vestingTerms: b.reference.vestingTerms.map((row) => ({ id: row.id, definition: e.canonicalJson(row.definition), definition_sha256: row.definitionSha256 })),
    edges: incrementalEdges(b, importBoundary).map((edge) => ({
      command_id: edge.commandId, depends_on_command_id: edge.dependsOnCommandId, kind: edge.kind,
    })),
  };
}

describe("stakeholder identity merges", () => {
  it("attributes both records to the survivor on every as-of date once the fact is known", () => {
    const m = miniOrg();
    m.b.command("founder-stock", (command) => {
      addStock(m, command, "CS-101", m.alice, "600", "2024-01-01");
      addStock(m, command, "CS-102", m.alice, "400", "2024-02-01");
    });
    const option = grant(m, "OPT-201", m.bob, "250", "2025-01-01", { vesting: null });
    exercise(m, "CS-201", option, m.bob, "250", "2025-06-01");
    const beforeMergeSeq = m.b.headSeq;
    m.b.command("merge-founder-records", (command) => {
      command.tx("X_STAKEHOLDER_MERGE", "2026-10-26", {
        merged_stakeholder_id: m.bob,
        surviving_stakeholder_id: m.alice,
        reason: "Duplicate import record",
      });
    }, { source: "app", type: "merge-stakeholders" });

    for (const asOf of ["2026-01-01", "2026-12-31"]) {
      const state = m.b.replay(asOf);
      const metrics = e.computeMetrics(state);
      expect(metrics.stakeholdersWithSecurities).toBe(1);
      expect(metrics.holders.map((holder) => holder.stakeholderId)).toEqual([m.alice]);
      expect(metrics.holders[0]).toMatchObject({ stockOutstanding: e.Dec.from("1250"), fullyDiluted: e.Dec.from("1250") });
      expect(metrics.holders[0]!.issuedAndOutstandingPct.toString()).toBe("1");
      expect(state.securitiesByStakeholder.get(m.alice)).toHaveLength(4);
      expect(state.securitiesByStakeholder.has(m.bob)).toBe(false);
      expect(state.stakeholders.has(m.bob)).toBe(false);
    }

    const notYetKnown = m.b.replay("2026-01-01", { asKnownAt: beforeMergeSeq });
    expect(e.computeMetrics(notYetKnown).holders.map((holder) => holder.stakeholderId).sort()).toEqual([m.alice, m.bob].sort());
  });

  it("is deterministic, verifies its hash chain, and reversal restores the duplicate identity", () => {
    const m = miniOrg();
    m.b.command("stock-a", (command) => { addStock(m, command, "CS-301", m.alice, "100", "2025-01-01"); });
    m.b.command("stock-b", (command) => { addStock(m, command, "CS-302", m.bob, "50", "2025-01-01"); });
    const importBoundary = m.b.headSeq;
    const merge = m.b.command("merge-records", (command) => {
      command.tx("X_STAKEHOLDER_MERGE", "2026-10-26", {
        merged_stakeholder_id: m.bob, surviving_stakeholder_id: m.alice, reason: "Duplicate import record",
      });
    }, { source: "app", type: "merge-stakeholders" });
    const shuffled = [...m.b.transactions].reverse();
    const first = m.b.replay("2025-12-31");
    const second = e.replay(m.b.reference, shuffled, { asOf: "2025-12-31" });
    expect(e.replayHash(first)).toBe(e.replayHash(second));
    expect(e.verifyLedgerRows(verificationRows(m.b, importBoundary), { asOf: "2026-12-31" }).ok).toBe(true);

    m.b.reverse(merge, "2026-10-26");
    expect(e.computeMetrics(m.b.replay("2025-12-31")).holders.map((holder) => holder.stakeholderId).sort()).toEqual([m.alice, m.bob].sort());
    expect(e.verifyLedgerRows(verificationRows(m.b, importBoundary), { asOf: "2026-12-31" }).ok).toBe(true);
  });

  it("derives the missing older edges that make an economically changing merge unsafe", () => {
    const m = miniOrg();
    grant(m, "OPT-B", m.bob, "4800", "2025-01-01", { vesting: { months: 48, cliff: 12 } });
    terminate(m, "A-term", m.alice, "2026-03-01", { source: "import" });
    const importBoundary = m.b.headSeq;
    m.b.command("merge-records", (command) => {
      command.tx("X_STAKEHOLDER_MERGE", "2026-10-26", {
        merged_stakeholder_id: m.bob, surviving_stakeholder_id: m.alice, reason: "Duplicate import record",
      });
    }, { source: "app", type: "merge-stakeholders" });

    const report = e.verifyLedgerRows(verificationRows(m.b, importBoundary), { asOf: "2026-12-31" });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "dependencies")?.problems)
      .toEqual(expect.arrayContaining([expect.stringContaining("DEPENDENCY_EDGE_MISSING")]));
  });

  it("rejects an unknown lot named by a termination without any merge", () => {
    const m = miniOrg();
    const unknown = "00000000-0000-7000-8000-00000000ffff";
    terminate(m, "unknown-lot", m.alice, "2026-03-01", {
      source: "import",
      extra: { securities: [{ security_id: unknown, vesting_stop_date: "2026-03-01" }] },
    });
    expect(m.b.replay("2026-12-31").violations).toContainEqual(expect.objectContaining({
      code: "IDENTITY_MISMATCH", securityId: unknown,
    }));
  });
});
