// Local synthetic fixtures only; never mount this helper in a Worker or use with remote D1.
export const SYNTHETIC_TENANT='synthetic_test_tenant';

export async function createFirstSyntheticTenant(db: Pick<D1Database,'prepare'>): Promise<void> {
 await db.prepare(`INSERT INTO tenants (id) VALUES (CASE WHEN NOT EXISTS (SELECT 1 FROM tenants) AND NOT EXISTS (SELECT 1 FROM api_keys) THEN ? ELSE NULL END)`).bind(SYNTHETIC_TENANT).run();
}
