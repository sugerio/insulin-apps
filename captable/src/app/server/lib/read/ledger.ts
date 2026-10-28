import { engine } from "#shared";
import { ByteBoundedLru } from "./cache.ts";

/**
 * The read model's source: an org's ledger and the reference rows the engine needs, decoded once and kept in the
 * isolate (the ledger rules). The cache key is (org, seq, head hash, ENGINE_VERSION) plus a fingerprint of the reference
 * tables: distinct ledger histories can share a sequence number, so the head hash is part of it, and a stakeholder's
 * relationship or a new vesting row changes what replay sees without moving the head. Writes never trust the cache:
 * the batch's seq claim fails if the head moved (the ledger rules).
 */

/** Total budget of the isolate cache: one unusually large company can use about 42 MB of the 48 MB budget. */
export const LEDGER_CACHE_BYTES = 48 * 1024 * 1024;
/**
 * The byte estimate is calibrated on a large synthetic org (20,000 transactions, 8,508 securities, 9,645 commands,
 * 1,250 stakeholders and 5.2 MB of vesting JSON measured about 42 MB loaded and replayed): the decoded ledger counts
 * 800 bytes a transaction, its vesting definitions once and 100 bytes a reference row; a replayed state 1,000 bytes a
 * transaction and 100 a security. That mix estimates 44 MB.
 */
const PARSED_BYTES_PER_TRANSACTION = 800;
const STATE_BYTES_PER_TRANSACTION = 1000;
const STATE_BYTES_PER_SECURITY = 100;
const BYTES_PER_REFERENCE_ROW = 100;
/** Replayed states kept per ledger: the default view (today) and one more as-of or as-known view. */
const MAX_STATES_PER_LEDGER = 2;

const cache = new ByteBoundedLru<LoadedLedger>(LEDGER_CACHE_BYTES);

/** The isolate's ledger cache (tests clear it between cases and read its size). */
export function ledgerCache(): ByteBoundedLru<LoadedLedger> {
  return cache;
}

export interface LedgerHead {
  orgId: string;
  seq: number;
  headHash: string | null;
  genesisHash: string;
  shareUnit: string;
  /** Counts and last-update times of the reference tables replay reads (see the module comment). */
  fingerprint: string;
}

export interface CommandInfo extends engine.LedgerCommand {
  actorUserId: string | null;
  authMethod: "console" | null;
  note: string | null;
}

export interface TxMeta {
  recordedAt: number;
  recordedBy: string | null;
  pulleyRef: string | null;
}

export interface SecurityMeta {
  pulleyId: string | null;
  createdAt: number;
}

export interface LoadedLedger {
  key: string;
  orgId: string;
  seq: number;
  headHash: string | null;
  genesisHash: string;
  reference: engine.EngineReference & { commands: engine.LedgerCommand[] };
  transactions: engine.LedgerTransaction[];
  txMeta: Map<string, TxMeta>;
  commands: Map<string, CommandInfo>;
  securityMeta: Map<string, SecurityMeta>;
  states: Map<string, engine.LedgerState>;
  parsedBytes: number;
}

interface HeadQueryRow {
  seq: number;
  head_hash: string | null;
  genesis_hash: string;
  share_unit: string;
  fingerprint: string;
}

const HEAD_SQL = `SELECT h.seq, h.head_hash, h.genesis_hash, o.share_unit,
       (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM stakeholders WHERE org_id = ?1)
       || '/' || (SELECT COUNT(*) FROM securities WHERE org_id = ?1)
       || '/' || (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM stock_classes WHERE org_id = ?1)
       || '/' || (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM stock_plans WHERE org_id = ?1)
       || '/' || (SELECT COUNT(*) FROM vesting_terms WHERE org_id = ?1)
       || '/' || (SELECT COUNT(*) FROM commands WHERE org_id = ?1) AS fingerprint
     FROM ledger_heads h JOIN orgs o ON o.id = h.org_id WHERE h.org_id = ?1 AND o.status = 'active'`;

function headOf(orgId: string, row: HeadQueryRow | undefined | null): LedgerHead | null {
  if (!row) return null;
  return {
    orgId,
    seq: row.seq,
    headHash: row.head_hash,
    genesisHash: row.genesis_hash,
    shareUnit: row.share_unit,
    fingerprint: row.fingerprint,
  };
}

/** The head and the reference fingerprint in one query: a cache hit costs one round trip. */
export async function readHead(db: D1Database, orgId: string): Promise<LedgerHead | null> {
  return headOf(orgId, await db.prepare(HEAD_SQL).bind(orgId).first<HeadQueryRow>());
}

/**
 * What a cached replay depends on: the head, the engine, the org's share unit (vesting, splits and conversions round
 * down to it, and an import's org profile can set it while the head and the reference rows stay as they are) and a
 * fingerprint of the reference rows.
 */
export function cacheKey(head: LedgerHead): string {
  return [head.orgId, head.seq, head.headHash ?? "genesis", engine.ENGINE_VERSION, head.shareUnit, head.fingerprint].join("|");
}

interface TransactionQueryRow {
  id: string;
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
  reverses_tx_id: string | null;
  supersedes_tx_id: string | null;
  source: engine.TransactionSource;
  recorded_at: number;
  recorded_by: string | null;
  pulley_ref: string | null;
}

interface SecurityQueryRow {
  id: string;
  family: engine.SecurityFamily;
  subtype: engine.SecuritySubtype;
  stakeholder_id: string;
  stock_class_id: string | null;
  stock_plan_id: string | null;
  display_id: string;
  origin_command_id: string;
  parent_security_id: string | null;
  pulley_id: string | null;
  created_at: number;
}

interface CommandQueryRow extends engine.CommandRow {
  actor_user_id: string | null;
  auth_method: string | null;
  note: string | null;
}

export class LedgerCorruptError extends Error {
  override name = "LedgerCorruptError";
}

/** Decodes one stored transaction; a row the engine refuses means the ledger itself is damaged. */
export function decodeRow(row: Omit<TransactionQueryRow, "recorded_at" | "recorded_by" | "pulley_ref">): engine.LedgerTransaction {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new LedgerCorruptError(`Transaction ${row.id}: payload isn't JSON`);
  }
  if (!engine.isTransactionType(row.type)) throw new LedgerCorruptError(`Transaction ${row.id}: unknown type`);
  try {
    return engine.decodeTransaction({
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
  } catch (error) {
    throw new LedgerCorruptError(`Transaction ${row.id}: ${(error as Error).message}`);
  }
}

function estimateStateBytes(ledger: Pick<LoadedLedger, "transactions" | "reference">): number {
  return ledger.transactions.length * STATE_BYTES_PER_TRANSACTION + ledger.reference.securities.length * STATE_BYTES_PER_SECURITY;
}

function totalBytes(ledger: LoadedLedger): number {
  return ledger.parsedBytes + ledger.states.size * estimateStateBytes(ledger);
}

/**
 * The org's decoded ledger: from the cache when the head and the reference fingerprint are unchanged, otherwise from
 * D1. Null when the org has no ledger head (no such org). `fresh` reads D1 and keeps nothing so an integrity check
 * examines what the database holds, not what an isolate remembers.
 *
 * A load is one snapshot: the head and fingerprint are read again inside the same D1 batch as the rows (a batch is one
 * SQL transaction), and the ledger reports and is cached under that head, never the one read before it. A writer that
 * commits between the cheap head check and the load therefore yields its own, newer, consistent head.
 */
export async function loadLedger(db: D1Database, orgId: string, options: { head?: LedgerHead; fresh?: boolean } = {}): Promise<LoadedLedger | null> {
  const probe = options.head ?? (await readHead(db, orgId));
  if (!probe) return null;
  const cached = options.fresh ? undefined : cache.get(cacheKey(probe));
  if (cached) return cached;

  const [headRows, transactions, securities, classes, plans, stakeholders, vestingTerms, commands] = await db.batch([
    db.prepare(HEAD_SQL).bind(orgId),
    db.prepare(
      `SELECT id, seq, command_id, type, effective_date, security_id, stakeholder_id, stock_class_id, stock_plan_id,
              valuation_id, quantity, amount, currency, payload, payload_version, reverses_tx_id, supersedes_tx_id,
              source, recorded_at, recorded_by, pulley_ref
       FROM transactions WHERE org_id = ? ORDER BY seq`,
    ).bind(orgId),
    db.prepare(
      `SELECT id, family, subtype, stakeholder_id, stock_class_id, stock_plan_id, display_id, origin_command_id,
              parent_security_id, pulley_id, created_at
       FROM securities WHERE org_id = ?`,
    ).bind(orgId),
    db.prepare("SELECT id, name, class_type FROM stock_classes WHERE org_id = ?").bind(orgId),
    db.prepare("SELECT id, name, stock_class_id FROM stock_plans WHERE org_id = ?").bind(orgId),
    db.prepare("SELECT id, relationship, kind, country_of_residence, tax_status FROM stakeholders WHERE org_id = ?").bind(orgId),
    db.prepare("SELECT id, definition, definition_sha256 FROM vesting_terms WHERE org_id = ?").bind(orgId),
    db.prepare(
      `SELECT id, type, actor_kind, reverses_command_id, first_seq, last_seq, declared_tx_count, created_at,
              actor_user_id, auth_method, note
       FROM commands WHERE org_id = ? ORDER BY first_seq`,
    ).bind(orgId),
  ]);

  const head = headOf(orgId, ((headRows?.results ?? []) as HeadQueryRow[])[0]);
  if (!head) return null;
  const key = cacheKey(head);
  const txRows = (transactions?.results ?? []) as TransactionQueryRow[];
  // Seqs run 1..head without gaps (UNIQUE plus the sequence trigger), so the snapshot has exactly `head.seq` rows.
  if (txRows.length !== head.seq || (head.seq > 0 && txRows[txRows.length - 1]!.seq !== head.seq)) {
    throw new LedgerCorruptError(`Org ${orgId}: ${txRows.length} transactions read with the head at seq ${head.seq}`);
  }
  const decoded: engine.LedgerTransaction[] = [];
  const txMeta = new Map<string, TxMeta>();
  for (const row of txRows) {
    decoded.push(decodeRow(row));
    txMeta.set(row.id, { recordedAt: row.recorded_at, recordedBy: row.recorded_by, pulleyRef: row.pulley_ref });
  }
  const securityRows = (securities?.results ?? []) as SecurityQueryRow[];
  const securityMeta = new Map<string, SecurityMeta>();
  for (const row of securityRows) securityMeta.set(row.id, { pulleyId: row.pulley_id, createdAt: row.created_at });
  const termsRows = (vestingTerms?.results ?? []) as { id: string; definition: string; definition_sha256: string }[];
  const commandRows = (commands?.results ?? []) as CommandQueryRow[];
  const commandInfo = new Map<string, CommandInfo>();
  for (const row of commandRows) {
    commandInfo.set(row.id, {
      ...engine.parseCommandRow(row),
      actorUserId: row.actor_user_id,
      authMethod: row.auth_method === "console" ? "console" : null,
      note: row.note,
    });
  }
  let definitionBytes = 0;
  const reference: LoadedLedger["reference"] = {
    orgId,
    shareUnit: head.shareUnit,
    securities: securityRows.map((row) => ({
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
    stockClasses: ((classes?.results ?? []) as { id: string; name: string; class_type: "COMMON" | "PREFERRED" }[]).map((row) => ({
      id: row.id,
      name: row.name,
      classType: row.class_type,
    })),
    stockPlans: ((plans?.results ?? []) as { id: string; name: string; stock_class_id: string }[]).map((row) => ({
      id: row.id,
      name: row.name,
      stockClassId: row.stock_class_id,
    })),
    stakeholders: (
      (stakeholders?.results ?? []) as { id: string; relationship: engine.Relationship; kind: "individual" | "institution"; country_of_residence: string | null; tax_status: "us" | "non_us" | "unknown" }[]
    ).map((row) => ({ id: row.id, relationship: row.relationship, kind: row.kind, countryOfResidence: row.country_of_residence, taxStatus: row.tax_status })),
    vestingTerms: termsRows.map((row) => {
      definitionBytes += row.definition.length;
      let definition: engine.VestingDefinition;
      try {
        definition = engine.parseVestingDefinition(JSON.parse(row.definition));
      } catch (error) {
        throw new LedgerCorruptError(`Vesting terms ${row.id}: ${(error as Error).message}`);
      }
      return { id: row.id, definition, definitionSha256: row.definition_sha256 };
    }),
    commands: [...commandInfo.values()],
  };
  const loaded: LoadedLedger = {
    key,
    orgId,
    seq: head.seq,
    headHash: head.headHash,
    genesisHash: head.genesisHash,
    reference,
    transactions: decoded,
    txMeta,
    commands: commandInfo,
    securityMeta,
    states: new Map(),
    parsedBytes:
      decoded.length * PARSED_BYTES_PER_TRANSACTION + definitionBytes
      + (securityRows.length + reference.stakeholders.length + reference.stockClasses.length + reference.stockPlans.length + commandRows.length) * BYTES_PER_REFERENCE_ROW,
  };
  if (options.fresh) return loaded;
  // Older heads of the org are useless once a newer one is loaded; drop them before they crowd out other orgs.
  cache.deleteWhere((other) => other.startsWith(`${orgId}|`) && other !== key);
  cache.set(key, loaded, totalBytes(loaded));
  return loaded;
}

export interface ReplayView {
  asOf: string;
  asKnownAt?: number | null;
  /** The org's today for writes (I10); read views leave it out, since they only report what the ledger says. */
  today?: string | null;
}

/** The replayed state for a view, memoized on the loaded ledger (at most a couple per head, within the byte budget). */
export function stateAt(ledger: LoadedLedger, view: ReplayView): engine.LedgerState {
  const memoKey = `${view.asOf}|${view.asKnownAt ?? ""}|${view.today ?? ""}`;
  const memo = ledger.states.get(memoKey);
  if (memo) {
    ledger.states.delete(memoKey);
    ledger.states.set(memoKey, memo);
    return memo;
  }
  const state = engine.replay(ledger.reference, ledger.transactions, { asOf: view.asOf, asKnownAt: view.asKnownAt ?? null, today: view.today ?? null });
  ledger.states.set(memoKey, state);
  while (ledger.states.size > MAX_STATES_PER_LEDGER) ledger.states.delete(ledger.states.keys().next().value!);
  if (cache.get(ledger.key) === ledger) {
    // A state that would push the entry past the budget isn't kept: the next request replays again.
    if (!cache.set(ledger.key, ledger, totalBytes(ledger))) {
      ledger.states.clear();
      cache.set(ledger.key, ledger, totalBytes(ledger));
    }
  }
  return state;
}
