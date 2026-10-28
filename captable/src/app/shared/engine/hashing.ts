import { canonicalJson, isCanonicalJsonText } from "./canonical.ts";
import { EngineError } from "./errors.ts";
import { sha256Hex } from "./sha256.ts";

/**
 * Payload hashes and the per-org hash chain (the ledger rules; migrations/0001 `transactions`).
 *
 * - `payload_sha256` = SHA-256 of the payload's canonical JSON text, which is also what the `payload` column stores.
 * - `chain_hash` = SHA-256(prev_hash ‖ canonical JSON of every other column). The columns are hashed under their D1
 *   names with their stored values (the payload as its text, SQL NULL as null), so `verify-ledger` can recompute a
 *   link from raw rows without decoding anything.
 * - The genesis `prev_hash` of seq 1 is SHA-256('cap-table:ledger:v1:' ‖ org_id).
 */

export const GENESIS_PREFIX = "cap-table:ledger:v1:";

/** The `transactions` columns covered by `chain_hash`: all of them except `prev_hash` and `chain_hash` themselves. */
export const CHAINED_COLUMNS = [
  "id",
  "org_id",
  "seq",
  "command_id",
  "type",
  "effective_date",
  "security_id",
  "stakeholder_id",
  "stock_class_id",
  "stock_plan_id",
  "valuation_id",
  "quantity",
  "amount",
  "currency",
  "payload",
  "payload_version",
  "payload_sha256",
  "reverses_tx_id",
  "supersedes_tx_id",
  "source",
  "recorded_at",
  "recorded_by",
  "pulley_ref",
] as const;

export type TransactionSource = "app" | "import" | "system";

/** A `transactions` row as D1 returns it (snake_case, payload as canonical JSON text). */
export interface TransactionRow {
  id: string;
  org_id: string;
  seq: number;
  command_id: string;
  type: string;
  effective_date: string;
  security_id: string | null;
  stakeholder_id: string | null;
  stock_class_id: string | null;
  stock_plan_id: string | null;
  valuation_id: string | null;
  quantity: string | null;
  amount: string | null;
  currency: string | null;
  payload: string;
  payload_version: number;
  payload_sha256: string;
  reverses_tx_id: string | null;
  supersedes_tx_id: string | null;
  source: TransactionSource;
  recorded_at: number;
  recorded_by: string | null;
  pulley_ref: string | null;
  prev_hash: string;
  chain_hash: string;
}

export type ChainedRow = Pick<TransactionRow, (typeof CHAINED_COLUMNS)[number]>;

export function genesisHash(orgId: string): string {
  return sha256Hex(GENESIS_PREFIX + orgId);
}

/** The text the `payload` column stores. */
export function payloadText(payload: unknown): string {
  return canonicalJson(payload);
}

export function payloadSha256(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/** `definition_sha256` of a vesting definition, embedded in the issuance payload so the chain covers it. */
export function definitionSha256(definition: unknown): string {
  return sha256Hex(canonicalJson(definition));
}

function chainedObject(row: ChainedRow): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (const column of CHAINED_COLUMNS) {
    const value = row[column];
    if (value === undefined) throw new EngineError("CHAIN_ROW_INCOMPLETE", `Column ${column} is missing`);
    object[column] = value;
  }
  return object;
}

export function chainInput(prevHash: string, row: ChainedRow): string {
  return prevHash + canonicalJson(chainedObject(row));
}

export function chainHash(prevHash: string, row: ChainedRow): string {
  return sha256Hex(chainInput(prevHash, row));
}

export type ChainProblem =
  | "SEQ_GAP"
  | "PAYLOAD_NOT_CANONICAL"
  | "PAYLOAD_HASH_MISMATCH"
  | "PREV_HASH_MISMATCH"
  | "CHAIN_HASH_MISMATCH"
  | "ORG_MISMATCH";

export type ChainVerification =
  | { ok: true; headSeq: number; headHash: string | null }
  | { ok: false; seq: number; problem: ChainProblem; message: string };

/**
 * Re-walks the whole chain: contiguous seqs from 1, canonical payload text,
 * payload hashes, prev links and chain hashes. `rows` must be the org's whole ledger in seq order.
 */
export function verifyChain(orgId: string, rows: readonly TransactionRow[]): ChainVerification {
  let prev = genesisHash(orgId);
  let expectedSeq = 1;
  for (const row of rows) {
    const fail = (problem: ChainProblem, message: string): ChainVerification => ({ ok: false, seq: row.seq, problem, message });
    if (row.org_id !== orgId) return fail("ORG_MISMATCH", `Row ${row.id} belongs to another org`);
    if (row.seq !== expectedSeq) return fail("SEQ_GAP", `Expected seq ${expectedSeq}, found ${row.seq}`);
    if (!isCanonicalJsonText(row.payload)) return fail("PAYLOAD_NOT_CANONICAL", `Seq ${row.seq}: payload text isn't canonical`);
    if (sha256Hex(row.payload) !== row.payload_sha256) return fail("PAYLOAD_HASH_MISMATCH", `Seq ${row.seq}: payload hash differs`);
    if (row.prev_hash !== prev) return fail("PREV_HASH_MISMATCH", `Seq ${row.seq}: prev_hash isn't the previous link`);
    const expected = chainHash(prev, row);
    if (row.chain_hash !== expected) return fail("CHAIN_HASH_MISMATCH", `Seq ${row.seq}: chain hash differs`);
    prev = row.chain_hash;
    expectedSeq += 1;
  }
  return { ok: true, headSeq: expectedSeq - 1, headHash: rows.length > 0 ? prev : null };
}
