import { describe, expect, it } from 'vitest'
import { classifyBatchFailure } from '../../src/app/server/lib/ledger/errors.ts'
import { commandAction } from '../../src/app/server/lib/ledger/evaluate.ts'
import { MAX_STATEMENT_BYTES, statementBytes, stmt } from '../../src/app/server/lib/ledger/statements.ts'

describe('ledger writer units', () => {
  it('counts statement size in UTF-8 bytes', () => {
    expect(statementBytes(stmt('SELECT ?', 'é'.repeat(10)))).toBe(8 + 20)
    expect(statementBytes(stmt('SELECT ?', '€'))).toBe(8 + 3)
    expect(statementBytes(stmt('SELECT ?, ?', 42, null))).toBe(11 + 16)
    expect(statementBytes(stmt('SELECT ?', '€'.repeat(MAX_STATEMENT_BYTES)))).toBeGreaterThan(MAX_STATEMENT_BYTES)
  })

  it('classifies only contractual SQLite conflicts', () => {
    const d1 = (text: string, code: string) => new Error(`D1_ERROR: ${text}: SQLITE_CONSTRAINT (extended: ${code})`)
    expect(classifyBatchFailure(d1('stale ledger: first_seq must be head + 1', 'SQLITE_CONSTRAINT_TRIGGER')))
      .toMatchObject({ kind: 'conflict', reason: 'stale_ledger' })
    expect(classifyBatchFailure(d1('stale ledger: first_seq must be head + 1', 'SQLITE_CONSTRAINT_CHECK'))).toBeNull()
    expect(classifyBatchFailure(d1('UNIQUE constraint failed: payment_instructions.org_id', 'SQLITE_CONSTRAINT_UNIQUE')))
      .toMatchObject({ reason: 'state_changed' })
  })

  it('uses the exercise-window label for deadline extensions', () => {
    expect(commandAction({ type: 'extend-exercise-deadline' } as never, [])).toBe('exercise-window extension')
  })
})
