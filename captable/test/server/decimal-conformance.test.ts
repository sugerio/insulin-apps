import { describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { openTestApp, seedOrg } from '../support/ledger-helpers.ts'

// The contract's decimal rule and the database's decimal CHECK must accept and refuse exactly the same strings. Both
// sides run the contract's DECIMAL_VECTORS: this test inserts each one into a decimal column of the test database.

const T = Date.UTC(2026, 9, 19)

describe('decimal conformance', () => {
  it("the database's CHECK accepts exactly what the contract accepts", async () => {
    const { db } = await openTestApp()
    const orgId = await seedOrg(db)
    const vectors = [...api.DECIMAL_VECTORS.accept, ...api.DECIMAL_VECTORS.reject]
    expect(api.DECIMAL_VECTORS.accept.length).toBeGreaterThan(0)
    expect(api.DECIMAL_VECTORS.reject.length).toBeGreaterThan(0)
    for (const [index, value] of vectors.entries()) {
      const accepted = await db.prepare(
        `INSERT INTO stock_classes (id, org_id, name, class_type, default_id_prefix, par_value, created_at, updated_at)
         VALUES (?, ?, ?, 'COMMON', 'CS', ?, ?, ?)`,
      ).bind(crypto.randomUUID(), orgId, `Class ${index}`, value, T, T).run().then(() => true, () => false)
      expect(accepted, JSON.stringify(value)).toBe(api.decimalSchema.safeParse(value).success)
      expect(accepted, JSON.stringify(value)).toBe((api.DECIMAL_VECTORS.accept as readonly string[]).includes(value))
    }
  })
})
