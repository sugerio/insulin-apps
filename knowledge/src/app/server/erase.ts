/**
 * What goes from D1 when a collection or an organization is deleted (Docs › Your data):
 *
 * - a deleted collection: its questions, gaps, reports, corrections, imports (file names), history, staged files,
 *   exports, shares, fact checks and awake time, its saved answers to changes (idempotency), and its name and purpose.
 *   The activity log keeps that it was deleted, with its name, by whom and when, for the organization;
 * - a deleted organization (insulinapps.com): every row Knowledge kept for it. Only that its engine data was purged
 *   remains (table org_purges: the organization's id and two times).
 */
const COLLECTION_TABLES = [
  'collection_shares', 'staged_files', 'imports', 'history', 'questions', 'gaps', 'reports', 'corrections', 'collection_usage',
  'exports', 'fact_checks', 'correction_checks',
] as const

const ORGANIZATION_TABLES = [
  ...COLLECTION_TABLES, 'collections', 'members', 'org_settings', 'org_limits', 'usage_counters', 'reservations', 'limit_alerts',
  'activity', 'idempotency', 'org_holds',
] as const

/** What a collection's imports hold of the limits, released: they will never count. Before its imports go. */
export function releaseImportsStatement(db: D1Database, org: string, collectionId: string, now: number): D1PreparedStatement {
  return db.prepare(
    `UPDATE reservations SET state = 'released', settled_at = ?3 WHERE org_id = ?1 AND state = 'held'
       AND ref IN (SELECT 'import:' || id FROM imports WHERE org_id = ?1 AND collection_id = ?2)`,
  ).bind(org, collectionId, now)
}

/** The statements that erase a deleted collection's rows; its own row stays, marked deleted, without its words. */
export function eraseCollectionStatements(db: D1Database, org: string, collectionId: string, now = Date.now()): D1PreparedStatement[] {
  return [
    releaseImportsStatement(db, org, collectionId, now),
    ...COLLECTION_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE org_id = ? AND collection_id = ?`).bind(org, collectionId)),
    // Its saved answers to changes: those made in it, and the one that created it (which names it).
    db.prepare(`DELETE FROM idempotency WHERE org_id = ?1 AND (route LIKE ?3 OR route LIKE ?4 OR (route = 'POST /api/collections' AND body LIKE ?5))`)
      .bind(org, collectionId, `% /api/collections/${collectionId}`, `% /api/collections/${collectionId}/%`, `%"${collectionId}"%`),
    db.prepare(`UPDATE collections SET name = '', purpose = '', keep_ready = NULL, general_role = NULL WHERE id = ? AND org_id = ? AND state = 'deleted'`).bind(collectionId, org),
  ]
}

/** Marks a collection deleted (the engine has finished) and erases its rows, in one batch. */
export async function eraseCollection(db: D1Database, org: string, collectionId: string, now: number): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE collections SET state = 'deleted', engine_state = 'deleted', updated_at = ? WHERE id = ? AND org_id = ? AND state != 'deleted'`).bind(now, collectionId, org),
    ...eraseCollectionStatements(db, org, collectionId, now),
  ])
}

/** The statements that erase everything Knowledge kept for an organization. */
export function eraseOrganizationStatements(db: D1Database, org: string): D1PreparedStatement[] {
  return ORGANIZATION_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE org_id = ?`).bind(org))
}
