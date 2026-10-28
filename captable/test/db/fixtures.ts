import { createHash } from 'node:crypto'
import type { LocalD1 } from '../../src/local-d1.ts'

// Synthetic rows for database tests: the fictional Acme Robotics, one admin, one stakeholder and a common class. The
// hashes only need the right shape (64 lowercase hex); the server computes the real chain.

type Statement = ReturnType<LocalD1['prepare']>

/** The fixtures' clock: 2026-01-05 09:00 UTC. */
export const T0 = Date.UTC(2026, 0, 5, 9)
export const ORG = 'org_acme'
export const ADMIN = 'user_admin'
export const FREYA = 'sh_freya'
export const COMMON = 'class_common'

/** A lowercase hexadecimal SHA-256 of `text`. */
export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Acme Robotics with its (empty) ledger head, an admin user, Freya Lindqvist and a common class. */
export async function seedCompany(db: LocalD1): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, 'admin@example.test', 'Ada Admin', ?, ?)",
      )
      .bind(ADMIN, T0, T0),
    db
      .prepare(
        "INSERT INTO orgs (id, org_key, slug, status, legal_name, display_name, created_at, updated_at) VALUES (?, 'acme', 'acme', 'active', 'Acme Robotics, Inc.', 'Acme Robotics', ?, ?)",
      )
      .bind(ORG, T0, T0),
    db.prepare('INSERT INTO ledger_heads (org_id, genesis_hash, updated_at) VALUES (?, ?, ?)').bind(ORG, sha(`genesis:${ORG}`), T0),
    db
      .prepare(
        "INSERT INTO stakeholders (id, org_id, kind, display_name, relationship, created_at, updated_at) VALUES (?, ?, 'individual', 'Freya Lindqvist', 'employee', ?, ?)",
      )
      .bind(FREYA, ORG, T0, T0),
    db
      .prepare(
        "INSERT INTO stock_classes (id, org_id, name, class_type, default_id_prefix, created_at, updated_at) VALUES (?, ?, 'Common', 'COMMON', 'CS', ?, ?)",
      )
      .bind(COMMON, ORG, T0, T0),
  ])
}

/** The ledger head as a writer reads it: the last seq and the hash the next transaction must chain to. */
export interface Head {
  seq: number
  hash: string
}

export async function ledgerHead(db: LocalD1): Promise<Head & { updatedAt: number }> {
  const head = await db
    .prepare('SELECT seq, COALESCE(head_hash, genesis_hash) AS hash, updated_at FROM ledger_heads WHERE org_id = ?')
    .bind(ORG)
    .first<{ seq: number; hash: string; updated_at: number }>()
  if (!head) throw new Error(`No ledger head for ${ORG}`)
  return { seq: head.seq, hash: head.hash, updatedAt: head.updated_at }
}

export interface TransactionSpec {
  id: string
  /** Default TX_STOCK_ISSUANCE. */
  type?: string
  securityId?: string | null
  reversesTxId?: string | null
  /** Overrides of the seq and prev_hash the ledger writer would compute. */
  seq?: number
  prevHash?: string
}

export interface CommandSpec {
  id: string
  type?: string
  actorKind?: 'user' | 'system' | 'import'
  reversesCommandId?: string
  note?: string
  expectedLedgerSeq?: number
  /** Override of first_seq (default: the head + 1). */
  firstSeq?: number
  /** Security identities the command creates (Freya's common shares), written right after the command. */
  securities?: { id: string; displayId: string }[]
  /** Commands whose securities this one consumes. */
  dependsOn?: string[]
  transactions: TransactionSpec[]
}

/** One transaction row chained to `prevHash`; returns the statement and the row's chain hash. */
export function transactionStatement(
  db: LocalD1,
  command: Pick<CommandSpec, 'id' | 'actorKind'>,
  tx: TransactionSpec & { seq: number; prevHash: string },
): { statement: Statement; chainHash: string } {
  const actorKind = command.actorKind ?? 'user'
  const reversal = tx.reversesTxId != null
  const payload = reversal ? `{"reverses":"${tx.reversesTxId}"}` : '{"quantity":"1000"}'
  const chainHash = sha(`chain:${tx.id}:${tx.prevHash}`)
  const statement = db
    .prepare(
      `INSERT INTO transactions (id, org_id, seq, command_id, type, effective_date, security_id, quantity, payload,
         payload_sha256, reverses_tx_id, source, recorded_at, recorded_by, prev_hash, chain_hash)
       VALUES (?, ?, ?, ?, ?, '2026-01-05', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tx.id,
      ORG,
      tx.seq,
      command.id,
      tx.type ?? (reversal ? 'X_REVERSAL' : 'TX_STOCK_ISSUANCE'),
      tx.securityId ?? null,
      reversal ? null : '1000',
      payload,
      sha(payload),
      tx.reversesTxId ?? null,
      actorKind === 'user' ? 'app' : actorKind,
      T0,
      actorKind === 'user' ? ADMIN : null,
      tx.prevHash,
      chainHash,
    )
  return { statement, chainHash }
}

/**
 * The statements the ledger writer batches for one command against the head it read: the idempotency receipt, the
 * command (claiming first_seq..last_seq), the securities it creates, its transactions chained one to the next, and its
 * dependency edges.
 */
export function commandStatements(db: LocalD1, head: Head, spec: CommandSpec): Statement[] {
  const actorKind = spec.actorKind ?? 'user'
  const actor = actorKind === 'user' ? ADMIN : null
  const firstSeq = spec.firstSeq ?? head.seq + 1
  const count = spec.transactions.length
  const statements = [
    db
      .prepare(
        `INSERT INTO idempotency_keys (id, scope, actor, route, idem_key, request_sha256, response_status, response_body, created_at)
         VALUES (?, ?, ?, 'POST /api/commands', ?, ?, 200, '{}', ?)`,
      )
      .bind(`idem_${spec.id}`, ORG, actor ?? `${actorKind}:fixtures`, `idem-key-${spec.id}`, sha(`request:${spec.id}`), T0),
    db
      .prepare(
        `INSERT INTO commands (id, org_id, type, idempotency_key_id, request_sha256, actor_kind, actor_user_id, auth_method, note,
           reverses_command_id, expected_ledger_seq, declared_tx_count, first_seq, last_seq, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
      )
      .bind(
        spec.id,
        ORG,
        spec.type ?? (spec.reversesCommandId ? 'reverse-command' : 'issue-stock'),
        `idem_${spec.id}`,
        sha(`request:${spec.id}`),
        actorKind,
        actor,
        actorKind === 'user' ? 'console' : null,
        spec.note ?? null,
        spec.reversesCommandId ?? null,
        spec.expectedLedgerSeq ?? null,
        count,
        firstSeq,
        firstSeq + count - 1,
        T0,
      ),
  ]
  for (const security of spec.securities ?? []) {
    statements.push(
      db
        .prepare(
          `INSERT INTO securities (id, org_id, family, subtype, stakeholder_id, stock_class_id, display_id, origin_command_id, created_at)
           VALUES (?, ?, 'STOCK', 'COMMON', ?, ?, ?, ?, ?)`,
        )
        .bind(security.id, ORG, FREYA, COMMON, security.displayId, spec.id, T0),
    )
  }
  let prevHash = head.hash
  spec.transactions.forEach((tx, index) => {
    const row = transactionStatement(db, spec, { ...tx, seq: tx.seq ?? firstSeq + index, prevHash: tx.prevHash ?? prevHash })
    statements.push(row.statement)
    prevHash = row.chainHash
  })
  for (const target of spec.dependsOn ?? []) {
    statements.push(
      db
        .prepare(
          "INSERT INTO command_dependencies (org_id, command_id, depends_on_command_id, kind) VALUES (?, ?, ?, 'consumes_security')",
        )
        .bind(ORG, spec.id, target),
    )
  }
  return statements
}

/** Reads the head and appends the command in one batch, as the ledger writer does. */
export async function appendCommand(db: LocalD1, spec: CommandSpec): Promise<void> {
  await db.batch(commandStatements(db, await ledgerHead(db), spec))
}

/** A command issuing Freya `n`'s lot: security sec_<n> (CS-<n>) and transaction tx_<n>. */
export function issuance(n: number): CommandSpec {
  return {
    id: `cmd_${n}`,
    securities: [{ id: `sec_${n}`, displayId: `CS-${n}` }],
    transactions: [{ id: `tx_${n}`, securityId: `sec_${n}` }],
  }
}

/** The admin's reverse-command of `target`, voiding each of its transactions (X_REVERSAL `<id>_<tx id>`). */
export function reversal(id: string, target: string, txIds: string[]): CommandSpec {
  return {
    id,
    reversesCommandId: target,
    note: 'Entered in error',
    transactions: txIds.map((txId) => ({ id: `${id}_${txId}`, reversesTxId: txId })),
  }
}

/** A board consent uploaded by the admin. */
export function documentStatement(db: LocalD1, id = 'doc_consent'): Statement {
  return db
    .prepare(
      `INSERT INTO documents (id, org_id, filename, content_type, byte_size, sha256, kind, source, uploaded_by, created_at, updated_at)
       VALUES (?, ?, 'board-consent.pdf', 'application/pdf', 1024, ?, 'BOARD_CONSENT', 'upload', ?, ?, ?)`,
    )
    .bind(id, ORG, sha(id), ADMIN, T0, T0)
}

/** How many rows `table` holds. */
export async function count(db: LocalD1, table: string): Promise<number> {
  return (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n')) ?? 0
}
