import { isCanonicalJsonText } from "./canonical.ts";
import { commandDependencies, DEPENDENCY_STRENGTH, edgesOnReversedCommands, type DependencyEdge, type DependencyKind } from "./dependencies.ts";
import { chainHash, genesisHash, type TransactionRow } from "./hashing.ts";
import { checkInvariants, checkVestingTermsHashes, verifyCommandSeals } from "./invariants.ts";
import { parseCommandRow, parseTransactionRow, type CommandRow, type LedgerCommand, type LedgerTransaction } from "./ledger.ts";
import { replay } from "./replay.ts";
import type { Relationship } from "./schemas.ts";
import { sha256Hex } from "./sha256.ts";
import type { EngineReference, LedgerState, SecurityFamily, SecuritySubtype, Violation } from "./state.ts";
import { parseVestingDefinition } from "./vesting.ts";

/**
 * Ledger verification for the on-demand administrator endpoint and the import's pre-activation integrity check.
 * Callers load the same D1 rows and hand them to `verifyLedgerRows`. Every check reports its problems by id and code
 * only, never a person's name.
 *
 * - payload_hashes: every payload is canonical JSON and hashes to its `payload_sha256`;
 * - chain: seqs run 1… without gaps in one org, each `prev_hash` is the previous link (the genesis first), each chain
 *   hash is recomputed, and the head row agrees with the last link;
 * - seals: each command wrote exactly its declared transactions in its seq range, a reversal covers its target whole;
 * - replay: every payload decodes, the replay holds the invariants, every vesting row matches its stored hash;
 * - dependencies: no standing command stands on a reversed one, and each edge the replay derives is recorded.
 */

export const LEDGER_CHECKS = ["payload_hashes", "chain", "seals", "replay", "dependencies"] as const;
export type LedgerCheckName = (typeof LEDGER_CHECKS)[number];

/** The org's rows as D1 stores them (column names as in migrations/0001), whatever loaded them. */
export interface LedgerVerificationRows {
  orgId: string;
  shareUnit: string;
  head: { seq: number; head_hash: string | null; genesis_hash: string } | null;
  /** The whole ledger, in seq order. */
  transactions: readonly TransactionRow[];
  commands: readonly CommandRow[];
  securities: readonly {
    id: string; family: SecurityFamily; subtype: SecuritySubtype; stakeholder_id: string; stock_class_id: string | null;
    stock_plan_id: string | null; display_id: string; origin_command_id: string; parent_security_id: string | null;
  }[];
  stockClasses: readonly { id: string; name: string; class_type: "COMMON" | "PREFERRED" }[];
  stockPlans: readonly { id: string; name: string; stock_class_id: string }[];
  stakeholders: readonly { id: string; relationship: Relationship; kind: "individual" | "institution"; country_of_residence: string | null; tax_status: "us" | "non_us" | "unknown" }[];
  vestingTerms: readonly { id: string; definition: string; definition_sha256: string }[];
  edges: readonly { command_id: string; depends_on_command_id: string; kind: DependencyKind }[];
}

export interface LedgerCheck {
  name: LedgerCheckName;
  ok: boolean;
  problems: string[];
}

export interface LedgerVerificationReport {
  orgId: string;
  ok: boolean;
  /** The head row's seq and hash (the chain's when there is no head row). */
  ledgerSeq: number;
  ledgerHeadHash: string | null;
  checks: LedgerCheck[];
  /** The replay as of `asOf`, when every payload decoded; callers hash or summarize it. */
  state: LedgerState | null;
}

/** At most this many problems per check are listed (the count says how many more). */
const MAX_PROBLEMS = 50;

function capped(problems: string[]): string[] {
  return problems.length <= MAX_PROBLEMS ? problems : [...problems.slice(0, MAX_PROBLEMS), `${problems.length - MAX_PROBLEMS} more`];
}

function describe(violation: Violation): string {
  const where = violation.securityId ?? violation.transactionId;
  return where === undefined ? violation.code : `${violation.code} ${where}`;
}

/**
 * Edges recorded against the replay's (the ledger rules): every standing command (not reversed, not a reversal) must have
 * each edge the replay derives for it, with at least that kind, or a reversal could pass a command that relies on it.
 * A recorded edge the replay no longer derives is not an error: it only blocks more, and a later correction that
 * re-interprets an earlier reader leaves exactly that.
 */
export function missingDependencyEdges(
  state: LedgerState,
  commands: readonly LedgerCommand[],
  recorded: readonly DependencyEdge[],
): Violation[] {
  const reversed = new Set(commands.filter((command) => command.reversesCommandId !== null).map((command) => command.reversesCommandId!));
  const stored = new Map<string, DependencyKind>();
  for (const edge of recorded) {
    const key = `${edge.commandId}|${edge.dependsOnCommandId}`;
    const kind = stored.get(key);
    if (kind === undefined || DEPENDENCY_STRENGTH[edge.kind] > DEPENDENCY_STRENGTH[kind]) stored.set(key, edge.kind);
  }
  const errors: Violation[] = [];
  for (const command of commands) {
    if (command.reversesCommandId !== null || reversed.has(command.id)) continue;
    for (const edge of commandDependencies(state, command.id)) {
      const kind = stored.get(`${edge.commandId}|${edge.dependsOnCommandId}`);
      if (kind === undefined || DEPENDENCY_STRENGTH[kind] < DEPENDENCY_STRENGTH[edge.kind]) {
        errors.push({ code: "DEPENDENCY_EDGE_MISSING", severity: "error", message: `Command ${command.id} relies on ${edge.dependsOnCommandId} (${edge.kind}) without that edge recorded` });
      }
    }
  }
  return errors;
}

/** The engine's reference from the rows (the same mapping the Worker's ledger loader uses). */
export function referenceFromRows(rows: LedgerVerificationRows, commands: readonly LedgerCommand[]): EngineReference & { commands: LedgerCommand[] } {
  return {
    orgId: rows.orgId,
    shareUnit: rows.shareUnit,
    securities: rows.securities.map((row) => ({
      id: row.id,
      family: row.family,
      subtype: row.subtype,
      stakeholderId: row.stakeholder_id,
      stockClassId: row.stock_class_id,
      stockPlanId: row.stock_plan_id,
      displayId: row.display_id,
      originCommandId: row.origin_command_id,
      parentSecurityId: row.parent_security_id,
    })),
    stockClasses: rows.stockClasses.map((row) => ({ id: row.id, name: row.name, classType: row.class_type })),
    stockPlans: rows.stockPlans.map((row) => ({ id: row.id, name: row.name, stockClassId: row.stock_class_id })),
    stakeholders: rows.stakeholders.map((row) => ({ id: row.id, relationship: row.relationship, kind: row.kind, countryOfResidence: row.country_of_residence, taxStatus: row.tax_status })),
    vestingTerms: rows.vestingTerms.map((row) => ({ id: row.id, definition: parseVestingDefinition(JSON.parse(row.definition)), definitionSha256: row.definition_sha256 })),
    commands: [...commands],
  };
}

function payloadProblems(rows: readonly TransactionRow[]): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    if (!isCanonicalJsonText(row.payload)) problems.push(`seq ${row.seq}: PAYLOAD_NOT_CANONICAL`);
    else if (sha256Hex(row.payload) !== row.payload_sha256) problems.push(`seq ${row.seq}: PAYLOAD_HASH_MISMATCH`);
  }
  return problems;
}

/** The chain walk (I15), payload hashes aside: it stops at the first broken link, since every later link depends on it. */
function chainProblems(rows: LedgerVerificationRows): { problems: string[]; seq: number; headHash: string | null } {
  const problems: string[] = [];
  let prev = genesisHash(rows.orgId);
  let seq = 0;
  if (rows.head !== null && rows.head.genesis_hash !== prev) problems.push("GENESIS_MISMATCH");
  for (const row of rows.transactions) {
    if (row.org_id !== rows.orgId) { problems.push(`seq ${row.seq}: ORG_MISMATCH`); break; }
    if (row.seq !== seq + 1) { problems.push(`seq ${row.seq}: SEQ_GAP after ${seq}`); break; }
    if (row.prev_hash !== prev) { problems.push(`seq ${row.seq}: PREV_HASH_MISMATCH`); break; }
    const expected = chainHash(prev, row);
    if (row.chain_hash !== expected) { problems.push(`seq ${row.seq}: CHAIN_HASH_MISMATCH`); break; }
    prev = row.chain_hash;
    seq = row.seq;
  }
  const headHash = seq === 0 ? null : prev;
  if (problems.length === 0) {
    if (rows.head === null) problems.push("HEAD_MISSING");
    else if (rows.head.seq !== seq || rows.head.head_hash !== headHash) problems.push(`HEAD_MISMATCH at seq ${rows.head.seq}`);
  }
  return { problems, seq, headHash };
}

export function verifyLedgerRows(rows: LedgerVerificationRows, options: { asOf: string }): LedgerVerificationReport {
  const checks = new Map<LedgerCheckName, string[]>(LEDGER_CHECKS.map((name) => [name, []]));
  const add = (name: LedgerCheckName, problems: readonly string[]) => checks.get(name)!.push(...problems);

  add("payload_hashes", payloadProblems(rows.transactions));
  const chain = chainProblems(rows);
  add("chain", chain.problems);

  const commands = rows.commands.map(parseCommandRow);
  const transactions: LedgerTransaction[] = [];
  const undecodable: string[] = [];
  for (const row of rows.transactions) {
    try {
      transactions.push(parseTransactionRow(row));
    } catch (error) {
      undecodable.push(`seq ${row.seq}: ${(error as { code?: string }).code ?? "PAYLOAD_INVALID"}`);
    }
  }
  add("seals", verifyCommandSeals(commands, transactions).map((violation) => `${violation.code}: ${violation.message.match(/[0-9a-f-]{36}/)?.[0] ?? ""}`.trim()));

  let state: LedgerState | null = null;
  let reference: (EngineReference & { commands: LedgerCommand[] }) | null = null;
  try {
    reference = referenceFromRows(rows, commands);
  } catch {
    add("replay", ["VESTING_DEFINITION_INVALID"]);
  }
  if (undecodable.length > 0) add("replay", undecodable);
  else if (reference !== null) {
    try {
      state = replay(reference, transactions, { asOf: options.asOf });
      add("replay", [...checkInvariants(state), ...checkVestingTermsHashes(reference)].filter((violation) => violation.severity === "error").map(describe));
    } catch (error) {
      add("replay", [(error as { code?: string }).code ?? "REPLAY_FAILED"]);
    }
  }

  const recorded = rows.edges.map((edge) => ({ commandId: edge.command_id, dependsOnCommandId: edge.depends_on_command_id, kind: edge.kind }));
  add("dependencies", edgesOnReversedCommands(recorded, commands).map((edge) => `EDGE_ON_REVERSED_COMMAND ${edge.commandId}`));
  if (state !== null) add("dependencies", missingDependencyEdges(state, commands, recorded).map((violation) => `DEPENDENCY_EDGE_MISSING ${violation.message.match(/[0-9a-f-]{36}/)?.[0] ?? ""}`.trim()));

  const list: LedgerCheck[] = LEDGER_CHECKS.map((name) => {
    const problems = checks.get(name)!;
    return { name, ok: problems.length === 0, problems: capped(problems) };
  });
  return {
    orgId: rows.orgId,
    ok: list.every((check) => check.ok),
    ledgerSeq: rows.head?.seq ?? chain.seq,
    ledgerHeadHash: rows.head?.head_hash ?? chain.headHash,
    checks: list,
    state,
  };
}

/** The date a verification replays to: the org's today, or the latest effective date when one is later. */
export function verificationAsOf(rows: Pick<LedgerVerificationRows, "transactions">, today: string): string {
  return rows.transactions.reduce((max, row) => (row.effective_date > max ? row.effective_date : max), today);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The SELECTs that load `LedgerVerificationRows` for one org in one D1 batch. The validated UUID is inlined because
 * the query strings are prepared together by the on-demand verifier.
 */
export function ledgerVerificationQueries(orgId: string): Record<Exclude<keyof LedgerVerificationRows, "orgId" | "shareUnit"> | "org", string> {
  if (!UUID.test(orgId)) throw new RangeError("An org id is a lowercase UUID");
  const quoted = `'${orgId}'`;
  return {
    org: `SELECT share_unit FROM orgs WHERE id = ${quoted}`,
    head: `SELECT seq, head_hash, genesis_hash FROM ledger_heads WHERE org_id = ${quoted}`,
    transactions: `SELECT * FROM transactions WHERE org_id = ${quoted} ORDER BY seq`,
    commands: `SELECT id, type, actor_kind, reverses_command_id, first_seq, last_seq, declared_tx_count, created_at FROM commands WHERE org_id = ${quoted} ORDER BY first_seq`,
    securities: `SELECT id, family, subtype, stakeholder_id, stock_class_id, stock_plan_id, display_id, origin_command_id, parent_security_id FROM securities WHERE org_id = ${quoted}`,
    stockClasses: `SELECT id, name, class_type FROM stock_classes WHERE org_id = ${quoted}`,
    stockPlans: `SELECT id, name, stock_class_id FROM stock_plans WHERE org_id = ${quoted}`,
    stakeholders: `SELECT id, relationship, kind, country_of_residence, tax_status FROM stakeholders WHERE org_id = ${quoted}`,
    vestingTerms: `SELECT id, definition, definition_sha256 FROM vesting_terms WHERE org_id = ${quoted}`,
    edges: `SELECT command_id, depends_on_command_id, kind FROM command_dependencies WHERE org_id = ${quoted}`,
  };
}

/** Assembles the rows from the query results, keyed as `ledgerVerificationQueries` names them. */
export function ledgerVerificationRowsFrom(orgId: string, results: Record<string, readonly Record<string, unknown>[]>): LedgerVerificationRows {
  const head = results.head?.[0] as LedgerVerificationRows["head"] | undefined;
  return {
    orgId,
    shareUnit: String((results.org?.[0] as { share_unit?: string } | undefined)?.share_unit ?? "1"),
    head: head ?? null,
    transactions: (results.transactions ?? []) as unknown as TransactionRow[],
    commands: (results.commands ?? []) as unknown as CommandRow[],
    securities: (results.securities ?? []) as unknown as LedgerVerificationRows["securities"],
    stockClasses: (results.stockClasses ?? []) as unknown as LedgerVerificationRows["stockClasses"],
    stockPlans: (results.stockPlans ?? []) as unknown as LedgerVerificationRows["stockPlans"],
    stakeholders: (results.stakeholders ?? []) as unknown as LedgerVerificationRows["stakeholders"],
    vestingTerms: (results.vestingTerms ?? []) as unknown as LedgerVerificationRows["vestingTerms"],
    edges: (results.edges ?? []) as unknown as LedgerVerificationRows["edges"],
  };
}
