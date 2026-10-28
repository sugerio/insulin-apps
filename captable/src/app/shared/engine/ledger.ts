import { isIsoDate, type IsoDate } from "./dates.ts";
import { EngineError } from "./errors.ts";
import { chainHash, payloadSha256, payloadText, type TransactionRow, type TransactionSource } from "./hashing.ts";
import { MIGRATION_ONLY_KEYS, parsePayload, PAYLOAD_VERSION, type PayloadOf } from "./payloads.ts";
import { isTransactionType, type TransactionTypeCode } from "./transaction-types.ts";

/** A decoded ledger transaction: the row's columns in camelCase with its payload validated for its type. */
export interface LedgerTransactionOf<T extends TransactionTypeCode> {
  id: string;
  seq: number;
  commandId: string;
  type: T;
  effectiveDate: IsoDate;
  securityId: string | null;
  stakeholderId: string | null;
  stockClassId: string | null;
  stockPlanId: string | null;
  valuationId: string | null;
  quantity: string | null;
  amount: string | null;
  currency: string | null;
  payload: PayloadOf<T>;
  payloadVersion: number;
  reversesTxId: string | null;
  supersedesTxId: string | null;
  source: TransactionSource;
}

/** Any transaction; switching on `type` narrows `payload`. */
export type LedgerTransaction = { [T in TransactionTypeCode]: LedgerTransactionOf<T> }[TransactionTypeCode];

export type ActorKind = "user" | "system" | "import";

/** The parts of a `commands` row the engine uses (dependencies, reversal rules, seals). */
export interface LedgerCommand {
  id: string;
  type: string;
  actorKind: ActorKind;
  reversesCommandId: string | null;
  firstSeq: number;
  lastSeq: number;
  declaredTxCount: number;
  createdAt: number;
}

export interface CommandRow {
  id: string;
  type: string;
  actor_kind: ActorKind;
  reverses_command_id: string | null;
  first_seq: number;
  last_seq: number;
  declared_tx_count: number;
  created_at: number;
}

export function parseCommandRow(row: CommandRow): LedgerCommand {
  return {
    id: row.id,
    type: row.type,
    actorKind: row.actor_kind,
    reversesCommandId: row.reverses_command_id,
    firstSeq: row.first_seq,
    lastSeq: row.last_seq,
    declaredTxCount: row.declared_tx_count,
    createdAt: row.created_at,
  };
}

const COLUMN_KEYS = [
  ["security_id", "securityId"],
  ["stakeholder_id", "stakeholderId"],
  ["stock_class_id", "stockClassId"],
  ["stock_plan_id", "stockPlanId"],
  ["quantity", "quantity"],
] as const;

export type DenormalizedColumn = (typeof COLUMN_KEYS)[number][1] | "valuationId" | "amount" | "currency";

/**
 * The value each denormalized column must hold for a payload: the payload's field of the same name (top level), the
 * snapshotted FMV's 409A for `valuation_id`, and a top-level `amount` money object for `amount` and `currency`; null
 * otherwise. Replay applies the same rule to a corrected payload against the target row's columns.
 */
export function denormalizedColumns(payload: Record<string, unknown>): Record<DenormalizedColumn, string | null> {
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  const fmv = payload.x_fmv as { valuation_id?: unknown } | undefined;
  const money = payload.amount as { amount?: unknown; currency?: unknown } | undefined;
  return {
    securityId: str(payload.security_id),
    stakeholderId: str(payload.stakeholder_id),
    stockClassId: str(payload.stock_class_id),
    stockPlanId: str(payload.stock_plan_id),
    quantity: str(payload.quantity),
    valuationId: str(fmv?.valuation_id),
    amount: typeof money === "object" && money !== null ? str(money.amount) : null,
    currency: typeof money === "object" && money !== null ? str(money.currency) : null,
  };
}

/**
 * Columns duplicate payload fields for filtering and audit; the payload is authoritative and they must agree in both
 * directions: a field the payload has is in its column, and a column the payload doesn't explain is empty. A
 * disagreement is a writer bug, so it is refused rather than silently resolved.
 */
function checkColumns(tx: LedgerTransaction): void {
  const payload = tx.payload as Record<string, unknown>;
  for (const [column, expected] of Object.entries(denormalizedColumns(payload)) as [DenormalizedColumn, string | null][]) {
    if (tx[column] !== expected) {
      const detail = expected === null ? "is set, but the payload has no such field" : tx[column] === null ? "is empty, but the payload has the field" : "differs from the payload";
      const name = column.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      throw new EngineError("COLUMN_PAYLOAD_MISMATCH", `${tx.type} ${tx.id}: column ${name} ${detail}`);
    }
  }
  if (tx.type === "X_REVERSAL" && tx.reversesTxId !== tx.payload.reverses_tx_id) {
    throw new EngineError("COLUMN_PAYLOAD_MISMATCH", `X_REVERSAL ${tx.id}: reverses_tx_id differs from the payload`);
  }
  if (tx.type !== "X_REVERSAL" && tx.reversesTxId !== null) {
    throw new EngineError("COLUMN_PAYLOAD_MISMATCH", `${tx.type} ${tx.id}: only X_REVERSAL has reverses_tx_id`);
  }
  if (tx.type === "X_CORRECTION" && tx.supersedesTxId !== tx.payload.supersedes_tx_id) {
    throw new EngineError("COLUMN_PAYLOAD_MISMATCH", `X_CORRECTION ${tx.id}: supersedes_tx_id differs from the payload`);
  }
  if (tx.type !== "X_CORRECTION" && tx.supersedesTxId !== null) {
    throw new EngineError("COLUMN_PAYLOAD_MISMATCH", `${tx.type} ${tx.id}: only X_CORRECTION has supersedes_tx_id`);
  }
  if (tx.type === "X_STAKEHOLDER_TERMINATION" && tx.payload.termination_date !== tx.effectiveDate) {
    throw new EngineError("COLUMN_PAYLOAD_MISMATCH", `X_STAKEHOLDER_TERMINATION ${tx.id}: the termination date is the effective date`);
  }
  if (tx.source !== "import") {
    if (tx.type === "X_MIGRATION_OPENING_BALANCE") {
      throw new EngineError("MIGRATION_FIELD_NOT_ALLOWED", `${tx.type} ${tx.id}: an opening balance only comes from an import`);
    }
    const migrated = migrationFieldsIn(payload);
    if (migrated.length > 0) {
      throw new EngineError("MIGRATION_FIELD_NOT_ALLOWED", `${tx.type} ${tx.id}: ${migrated.join(", ")} only come from an import`);
    }
  }
}

/**
 * The migration-only fields a payload carries, at its top level or in the payload it wraps (a correction's
 * replacement, an opening balance's issuance), so no entry path lets an app transaction state them.
 */
export function migrationFieldsIn(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const found: string[] = MIGRATION_ONLY_KEYS.filter((key) => key in record);
  for (const nested of ["replacement_payload", "issuance"]) found.push(...migrationFieldsIn(record[nested]).map((key) => `${nested}.${key}`));
  return found;
}

export interface TransactionInput {
  id: string;
  seq: number;
  commandId: string;
  type: TransactionTypeCode;
  effectiveDate: IsoDate;
  payload: unknown;
  payloadVersion?: number;
  securityId?: string | null;
  stakeholderId?: string | null;
  stockClassId?: string | null;
  stockPlanId?: string | null;
  valuationId?: string | null;
  quantity?: string | null;
  amount?: string | null;
  currency?: string | null;
  reversesTxId?: string | null;
  supersedesTxId?: string | null;
  source: TransactionSource;
}

/** Validates and decodes a transaction from engine input (columns in camelCase, payload as an object). */
export function decodeTransaction(input: TransactionInput): LedgerTransaction {
  if (!isTransactionType(input.type)) throw new EngineError("TRANSACTION_TYPE", `Unknown transaction type ${String(input.type)}`);
  if (!isIsoDate(input.effectiveDate)) throw new EngineError("DATE_INVALID", `${input.id}: bad effective date`);
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) throw new EngineError("SEQ_INVALID", `${input.id}: bad seq`);
  const version = input.payloadVersion ?? PAYLOAD_VERSION;
  const tx = {
    id: input.id,
    seq: input.seq,
    commandId: input.commandId,
    type: input.type,
    effectiveDate: input.effectiveDate,
    securityId: input.securityId ?? null,
    stakeholderId: input.stakeholderId ?? null,
    stockClassId: input.stockClassId ?? null,
    stockPlanId: input.stockPlanId ?? null,
    valuationId: input.valuationId ?? null,
    quantity: input.quantity ?? null,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    payload: parsePayload(input.type, input.payload, version),
    payloadVersion: version,
    reversesTxId: input.reversesTxId ?? null,
    supersedesTxId: input.supersedesTxId ?? null,
    source: input.source,
  } as LedgerTransaction;
  checkColumns(tx);
  return tx;
}

/** Decodes a D1 `transactions` row: parses the payload text and validates it for its type and version. */
export function parseTransactionRow(row: TransactionRow): LedgerTransaction {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new EngineError("PAYLOAD_INVALID", `${row.id}: payload isn't JSON`);
  }
  if (!isTransactionType(row.type)) throw new EngineError("TRANSACTION_TYPE", `Unknown transaction type ${row.type}`);
  return decodeTransaction({
    id: row.id,
    seq: row.seq,
    commandId: row.command_id,
    type: row.type,
    effectiveDate: row.effective_date,
    payload,
    payloadVersion: row.payload_version,
    securityId: row.security_id,
    stakeholderId: row.stakeholder_id,
    stockClassId: row.stock_class_id,
    stockPlanId: row.stock_plan_id,
    valuationId: row.valuation_id,
    quantity: row.quantity,
    amount: row.amount,
    currency: row.currency,
    reversesTxId: row.reverses_tx_id,
    supersedesTxId: row.supersedes_tx_id,
    source: row.source,
  });
}

export interface RowContext {
  orgId: string;
  recordedAt: number;
  recordedBy: string | null;
  pulleyRef?: string | null;
}

/**
 * Builds the D1 row for a decoded transaction: canonical payload text, payload hash and the chain link from
 * `prevHash` (the head hash, or the genesis hash for seq 1). The ledger writer and test fixtures both use it, so the
 * chain is computed one way.
 */
export function buildTransactionRow(tx: LedgerTransaction, context: RowContext, prevHash: string): TransactionRow {
  const text = payloadText(tx.payload);
  const row: Omit<TransactionRow, "chain_hash"> = {
    id: tx.id,
    org_id: context.orgId,
    seq: tx.seq,
    command_id: tx.commandId,
    type: tx.type,
    effective_date: tx.effectiveDate,
    security_id: tx.securityId,
    stakeholder_id: tx.stakeholderId,
    stock_class_id: tx.stockClassId,
    stock_plan_id: tx.stockPlanId,
    valuation_id: tx.valuationId,
    quantity: tx.quantity,
    amount: tx.amount,
    currency: tx.currency,
    payload: text,
    payload_version: tx.payloadVersion,
    payload_sha256: payloadSha256(tx.payload),
    reverses_tx_id: tx.reversesTxId,
    supersedes_tx_id: tx.supersedesTxId,
    source: tx.source,
    recorded_at: context.recordedAt,
    recorded_by: context.recordedBy,
    pulley_ref: context.pulleyRef ?? null,
    prev_hash: prevHash,
  };
  return { ...row, chain_hash: chainHash(prevHash, row) };
}
