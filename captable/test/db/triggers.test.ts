import { drizzle } from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOCUMENT_BLOB_CHUNK_BYTES, documentBlobs } from '../../src/app/db/schema.ts'
import type { LocalD1 } from '../../src/local-d1.ts'
import {
  ADMIN,
  appendCommand,
  commandStatements,
  count,
  documentStatement,
  FREYA,
  issuance,
  ledgerHead,
  ORG,
  reversal,
  seedCompany,
  sha,
  T0,
  transactionStatement,
} from './fixtures.ts'
import { openMigratedDatabase } from './helpers.ts'

// The ledger code relies on these guards: they turn a lost race or a faulty write into an aborted D1 batch, and the
// server maps the RAISE texts to its answers. Synthetic data only (fixtures.ts).

let db: LocalD1
beforeEach(async () => {
  db = await openMigratedDatabase()
  await seedCompany(db)
})
afterEach(() => db.close())

const run = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run()

describe('append-only tables', () => {
  beforeEach(async () => {
    await appendCommand(db, issuance(1))
    await appendCommand(db, { ...issuance(2), dependsOn: ['cmd_1'] })
    await run("INSERT INTO audit_events (occurred_at, org_id, actor_user_id, auth_method, action, result) VALUES (?, ?, ?, 'console', 'stakeholder.update', 'success')", T0, ORG, ADMIN)
  })

  it.each([
    ["UPDATE commands SET note = 'edited' WHERE id = 'cmd_1'", 'commands are append-only'],
    ["DELETE FROM commands WHERE id = 'cmd_2'", 'commands are append-only'],
    ["UPDATE transactions SET effective_date = '2026-02-01' WHERE id = 'tx_1'", 'transactions are append-only'],
    ["DELETE FROM transactions WHERE id = 'tx_2'", 'transactions are append-only'],
    ["UPDATE audit_events SET result = 'error'", 'audit events are append-only'],
    ['DELETE FROM audit_events', 'audit events are append-only'],
    ["UPDATE securities SET display_id = 'CS-9' WHERE id = 'sec_1'", 'security identities are append-only'],
    ["DELETE FROM securities WHERE id = 'sec_2'", 'security identities are append-only'],
    ["UPDATE command_dependencies SET kind = 'relies_on_terms'", 'command dependencies are append-only'],
    ['DELETE FROM command_dependencies', 'command dependencies are append-only'],
    ["UPDATE idempotency_keys SET response_status = 201 WHERE id = 'idem_cmd_1'", 'idempotency receipts are immutable'],
  ])('%s', async (sql, message) => {
    await expect(run(sql)).rejects.toThrow(message)
  })

  it('keep every row', async () => {
    expect([await count(db, 'commands'), await count(db, 'transactions'), await count(db, 'audit_events')]).toEqual([2, 2, 1])
  })
})

describe('version = old + 1 on every update', () => {
  beforeEach(async () => {
    await db.batch([documentStatement(db)])
  })

  it.each([
    ['users', ADMIN, 'display_name', 'Ada A. Admin'],
    ['orgs', ORG, 'display_name', 'Acme'],
    ['stakeholders', FREYA, 'display_name', 'Freya L.'],
    ['stock_classes', 'class_common', 'name', 'Common Stock'],
    ['documents', 'doc_consent', 'filename', 'consent.pdf'],
  ])('%s', async (table, id, column, value) => {
    const update = (version: string) => run(`UPDATE ${table} SET ${column} = ?, version = ${version} WHERE id = ?`, value, id)
    await expect(update('version')).rejects.toThrow('stale version')
    await expect(update('version + 2')).rejects.toThrow('stale version')
    await update('version + 1')
    expect(await db.prepare(`SELECT version FROM ${table} WHERE id = ?`).bind(id).first('version')).toBe(2)
  })

  it('every table with a version column has the guard', async () => {
    const { results } = await db
      .prepare(
        `SELECT m.name FROM sqlite_master m WHERE m.type = 'table'
           AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'version') ORDER BY m.name`,
      )
      .all<{ name: string }>()
    expect(results.length).toBe(14)
    for (const { name } of results) {
      const trigger = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").bind(`${name}_version`).first<string>('sql')
      expect(trigger, name).toBe(
        `CREATE TRIGGER ${name}_version BEFORE UPDATE ON ${name} WHEN NEW.version IS NOT OLD.version + 1\nBEGIN SELECT RAISE(ABORT, 'stale version'); END`,
      )
    }
  })
})

describe('the one-company invariant', () => {
  it('rejects a second active company in the same app database', async () => {
    await expect(run(
      "INSERT INTO orgs (id, org_key, slug, legal_name, display_name, created_at, updated_at) VALUES ('org_other', 'other', 'other', 'Other, Inc.', 'Other', ?, ?)",
      T0,
      T0,
    )).rejects.toThrow('UNIQUE constraint failed: orgs.status')
  })
})

describe('the ledger sequence', () => {
  it('a command claims the seqs right after the head, so the slower of two writers fails whole', async () => {
    await appendCommand(db, issuance(1))
    const head = await ledgerHead(db)
    const first = commandStatements(db, head, issuance(2))
    const second = commandStatements(db, head, issuance(3))
    await db.batch(first)
    await expect(db.batch(second)).rejects.toThrow('stale ledger: first_seq must be head + 1')
    expect(await db.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE id = 'idem_cmd_3'").first('n')).toBe(0)
    expect((await ledgerHead(db)).seq).toBe(2)
  })

  it('a command fails when the head moved since the dry run it was reviewed against', async () => {
    await appendCommand(db, issuance(1))
    await expect(appendCommand(db, { ...issuance(2), expectedLedgerSeq: 0 })).rejects.toThrow(
      'stale ledger: the head moved since the dry run',
    )
    await appendCommand(db, { ...issuance(2), expectedLedgerSeq: 1 })
  })

  it('each transaction takes the next seq and chains to the head hash', async () => {
    const head = await ledgerHead(db)
    const command = { id: 'cmd_1', securities: [{ id: 'sec_1', displayId: 'CS-1' }] }
    await expect(
      db.batch(commandStatements(db, head, { ...command, transactions: [{ id: 'tx_1', securityId: 'sec_1', seq: 2 }] })),
    ).rejects.toThrow('stale ledger: seq must be head + 1')
    await expect(
      db.batch(commandStatements(db, head, { ...command, transactions: [{ id: 'tx_1', securityId: 'sec_1', prevHash: sha('forged') }] })),
    ).rejects.toThrow('broken chain: prev_hash must equal the head hash')
    expect(await count(db, 'transactions')).toBe(0)
  })

  it("a transaction can't fall outside its command's declared range", async () => {
    const head = await ledgerHead(db)
    const statements = commandStatements(db, head, issuance(1))
    const extra = transactionStatement(db, { id: 'cmd_1' }, { id: 'tx_extra', securityId: 'sec_1', seq: 2, prevHash: sha(`chain:tx_1:${head.hash}`) })
    await expect(db.batch([...statements, extra.statement])).rejects.toThrow("seq outside the command's declared range")
    expect(await count(db, 'commands')).toBe(0)
  })

  it('the head follows the last transaction and moves only with one', async () => {
    const genesis = await ledgerHead(db)
    await appendCommand(db, {
      id: 'cmd_1',
      securities: [
        { id: 'sec_1', displayId: 'CS-1' },
        { id: 'sec_2', displayId: 'CS-2' },
      ],
      transactions: [
        { id: 'tx_1', securityId: 'sec_1' },
        { id: 'tx_2', securityId: 'sec_2' },
      ],
    })
    const last = await db.prepare("SELECT chain_hash, prev_hash FROM transactions WHERE id = 'tx_2'").first<{ chain_hash: string; prev_hash: string }>()
    expect(await db.prepare("SELECT prev_hash FROM transactions WHERE id = 'tx_1'").first('prev_hash')).toBe(genesis.hash)
    expect(await ledgerHead(db)).toEqual({ seq: 2, hash: last!.chain_hash, updatedAt: T0 })
    await expect(run('UPDATE ledger_heads SET seq = 3, updated_at = 0')).rejects.toThrow('the ledger head moves only with a new transaction')
    await expect(run('DELETE FROM ledger_heads')).rejects.toThrow('ledger heads are never deleted')
  })
})

describe('reversals', () => {
  beforeEach(async () => {
    await appendCommand(db, issuance(1))
  })

  it('void every transaction of one command, once, with a reason', async () => {
    await expect(appendCommand(db, { ...reversal('cmd_r1', 'cmd_1', ['tx_1']), note: undefined })).rejects.toThrow(
      'CHECK constraint failed: commands_reversal_by_user_with_note_check',
    )
    await appendCommand(db, reversal('cmd_r1', 'cmd_1', ['tx_1']))
    await expect(appendCommand(db, reversal('cmd_r2', 'cmd_1', ['tx_1']))).rejects.toThrow(
      'UNIQUE constraint failed: commands.org_id, commands.reverses_command_id',
    )
  })

  it("can't be reversed themselves", async () => {
    await appendCommand(db, reversal('cmd_r1', 'cmd_1', ['tx_1']))
    await expect(appendCommand(db, reversal('cmd_r2', 'cmd_r1', ['cmd_r1_tx_1']))).rejects.toThrow('a reversal cannot be reversed')
  })

  it("don't apply to imported history", async () => {
    await appendCommand(db, { ...issuance(2), actorKind: 'import' })
    await expect(appendCommand(db, reversal('cmd_r2', 'cmd_2', ['tx_2']))).rejects.toThrow(
      'migrated history is not reversible in the app',
    )
  })

  it('wait for the commands that depend on the target, newest first', async () => {
    await appendCommand(db, { ...issuance(2), dependsOn: ['cmd_1'] })
    await expect(appendCommand(db, reversal('cmd_r1', 'cmd_1', ['tx_1']))).rejects.toThrow('reverse the dependent commands first')
    await appendCommand(db, reversal('cmd_r2', 'cmd_2', ['tx_2']))
    await appendCommand(db, reversal('cmd_r1', 'cmd_1', ['tx_1']))
    await expect(appendCommand(db, { ...issuance(3), dependsOn: ['cmd_1'] })).rejects.toThrow('cannot build on a reversed command')
  })

  it("void only the reversed command's transactions, and nothing else", async () => {
    await appendCommand(db, issuance(2))
    await expect(appendCommand(db, reversal('cmd_r2', 'cmd_2', ['tx_1']))).rejects.toThrow(
      "an X_REVERSAL must belong to the command that reverses its target's command",
    )
    await expect(
      appendCommand(db, { id: 'cmd_r2', reversesCommandId: 'cmd_2', note: 'Entered in error', transactions: [{ id: 'tx_r', type: 'TX_STOCK_ISSUANCE' }] }),
    ).rejects.toThrow('a reverse-command appends X_REVERSAL transactions only')
  })
})

describe('guarded statements (batch_assertions)', () => {
  const audit = () =>
    db
      .prepare("INSERT INTO audit_events (occurred_at, org_id, actor_kind, action, result) VALUES (?, ?, 'system', 'stakeholder.merge', 'success')")
      .bind(T0, ORG)

  it('a false assertion aborts the whole batch', async () => {
    await expect(
      db.batch([audit(), db.prepare("INSERT INTO batch_assertions (ok) SELECT count(*) = 0 FROM stakeholders WHERE org_id = 'org_acme'")]),
    ).rejects.toThrow('batch assertion failed')
    expect(await count(db, 'audit_events')).toBe(0)
  })

  it('a true assertion lets the batch commit and stores nothing', async () => {
    await db.batch([audit(), db.prepare("INSERT INTO batch_assertions (ok) SELECT count(*) = 1 FROM stakeholders WHERE org_id = 'org_acme'")])
    expect([await count(db, 'audit_events'), await count(db, 'batch_assertions')]).toEqual([1, 0])
  })
})

describe('document bytes (document_blobs)', () => {
  const chunk = (index: number, bytes: Uint8Array, document = 'doc_consent') =>
    db
      .prepare('INSERT INTO document_blobs (org_id, document_id, chunk_index, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(ORG, document, index, bytes, T0)

  beforeEach(async () => {
    await db.batch([documentStatement(db), chunk(0, new Uint8Array([37, 80, 68, 70])), chunk(1, new Uint8Array([10]))])
  })

  it('are append-only', async () => {
    await expect(run("UPDATE document_blobs SET bytes = x'00' WHERE chunk_index = 0")).rejects.toThrow('document blobs are append-only')
    await expect(run('DELETE FROM document_blobs')).rejects.toThrow('document blobs are append-only')
    expect(await count(db, 'document_blobs')).toBe(2)
  })

  it('hold chunks of 1 to DOCUMENT_BLOB_CHUNK_BYTES bytes, numbered from 0, once each', async () => {
    await chunk(2, new Uint8Array(DOCUMENT_BLOB_CHUNK_BYTES)).run()
    await expect(chunk(3, new Uint8Array(DOCUMENT_BLOB_CHUNK_BYTES + 1)).run()).rejects.toThrow(
      'CHECK constraint failed: document_blobs_bytes_check',
    )
    await expect(
      run("INSERT INTO document_blobs (org_id, document_id, chunk_index, bytes, created_at) VALUES (?, 'doc_consent', 3, x'', ?)", ORG, T0),
    ).rejects.toThrow('CHECK constraint failed: document_blobs_bytes_check')
    await expect(chunk(-1, new Uint8Array([1])).run()).rejects.toThrow('CHECK constraint failed: document_blobs_chunk_index_check')
    await expect(chunk(1, new Uint8Array([1])).run()).rejects.toThrow(
      'UNIQUE constraint failed: document_blobs.document_id, document_blobs.chunk_index',
    )
  })

  it('belong to a document of the same org', async () => {
    await expect(chunk(0, new Uint8Array([1]), 'doc_missing').run()).rejects.toThrow('FOREIGN KEY constraint failed')
  })

  it('read back as D1 returns them, and as Uint8Array through Drizzle', async () => {
    expect(await db.prepare('SELECT bytes FROM document_blobs WHERE chunk_index = 0').first('bytes')).toEqual([37, 80, 68, 70])
    const rows = await drizzle(db).select().from(documentBlobs).orderBy(documentBlobs.chunkIndex)
    expect(rows.map((row) => row.bytes)).toEqual([new Uint8Array([37, 80, 68, 70]), new Uint8Array([10])])
    await drizzle(db)
      .insert(documentBlobs)
      .values({ orgId: ORG, documentId: 'doc_consent', chunkIndex: 2, bytes: new Uint8Array([1, 2, 3]), createdAt: T0 })
    expect(await db.prepare('SELECT bytes FROM document_blobs WHERE chunk_index = 2').first('bytes')).toEqual([1, 2, 3])
  })
})

describe('documents and their links', () => {
  beforeEach(async () => {
    await appendCommand(db, issuance(1))
    await db.batch([documentStatement(db)])
  })

  it("keep a document's bytes and identity", async () => {
    for (const change of [`sha256 = '${sha('other')}'`, 'byte_size = 2048', "pulley_id = 'p_1'", 'uploaded_by = NULL']) {
      await expect(run(`UPDATE documents SET ${change}, version = version + 1 WHERE id = 'doc_consent'`)).rejects.toThrow(
        'document bytes and identity are immutable; upload a new version',
      )
    }
  })

  it('link a document to exactly one target', async () => {
    const link = (id: string, targets: string, values: unknown[]) =>
      run(
        `INSERT INTO document_links (id, org_id, document_id, role, ${targets}, created_by, created_at) VALUES (?, ?, 'doc_consent', 'CONSENT', ${values.map(() => '?').join(', ')}, ?, ?)`,
        id,
        ORG,
        ...values,
        ADMIN,
        T0,
      )
    await expect(
      run("INSERT INTO document_links (id, org_id, document_id, role, created_at) VALUES ('l_0', ?, 'doc_consent', 'CONSENT', ?)", ORG, T0),
    ).rejects.toThrow('CHECK constraint failed: document_links_one_target_check')
    await expect(link('l_2', 'security_id, stakeholder_id', ['sec_1', FREYA])).rejects.toThrow(
      'CHECK constraint failed: document_links_one_target_check',
    )
    await link('l_1', 'security_id', ['sec_1'])
    // One live link per document, role and target (the CASE index), until it is revoked.
    await expect(link('l_dup', 'security_id', ['sec_1'])).rejects.toThrow("UNIQUE constraint failed: index 'document_links_live'")
    await link('l_freya', 'stakeholder_id', [FREYA])
    await expect(run("UPDATE document_links SET security_id = NULL, stock_class_id = 'class_common' WHERE id = 'l_1'")).rejects.toThrow(
      'links are immutable; only a one-time revocation is allowed',
    )
    await run("UPDATE document_links SET revoked_at = ?, revoked_by = ?, revoke_reason = 'Wrong lot' WHERE id = 'l_1'", T0 + 1, ADMIN)
    await expect(run("UPDATE document_links SET revoke_reason = 'Typo' WHERE id = 'l_1'")).rejects.toThrow('a revoked link cannot change')
    await link('l_again', 'security_id', ['sec_1'])
  })
})

describe('idempotency receipts', () => {
  it('collide on (scope, actor, route, key) with the message the ledger classifies', async () => {
    await appendCommand(db, issuance(1))
    await expect(
      run(
        "INSERT INTO idempotency_keys (id, scope, actor, route, idem_key, request_sha256, response_status, response_body, created_at) VALUES ('idem_again', ?, ?, 'POST /api/commands', 'idem-key-cmd_1', ?, 200, '{}', ?)",
        ORG,
        ADMIN,
        sha('again'),
        T0,
      ),
    ).rejects.toThrow(
      'UNIQUE constraint failed: idempotency_keys.scope, idempotency_keys.actor, idempotency_keys.route, idempotency_keys.idem_key',
    )
  })
})
