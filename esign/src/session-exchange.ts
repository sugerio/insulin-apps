/** Storage primitive only; the caller must hash cryptographically random credentials and validate origin. */
type Statement = { bind(...values: (string | number)[]): Statement };
type Database = { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown> };
type Exchange = { codeHash: string; tokenHash: string; origin: string; now: number; sessionExpiresAt: number };

export async function exchangeCode(db: Database, cmd: Exchange): Promise<void> {
  if (!cmd.codeHash || !cmd.tokenHash || !cmd.origin || cmd.sessionExpiresAt <= cmd.now) throw new Error('Invalid exchange');
  await db.batch([
    db.prepare(`INSERT INTO assertions (ok) SELECT CASE WHEN EXISTS (
      SELECT 1 FROM page_codes WHERE code_hash = ? AND origin = ? AND used_at IS NULL AND expires_at > ?
    ) THEN 1 ELSE 0 END`).bind(cmd.codeHash, cmd.origin, cmd.now),
    db.prepare(`INSERT INTO page_sessions (token_hash, tenant_id, resource_id, purpose, origin, expires_at)
      SELECT ?, tenant_id, resource_id, purpose, origin, ? FROM page_codes WHERE code_hash = ?`)
      .bind(cmd.tokenHash, cmd.sessionExpiresAt, cmd.codeHash),
    db.prepare('UPDATE page_codes SET used_at = ? WHERE code_hash = ?').bind(cmd.now, cmd.codeHash),
    db.prepare('DELETE FROM assertions'),
  ]);
}
