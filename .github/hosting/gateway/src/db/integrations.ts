// Stored credentials for outside services an app calls through the gateway's integration proxy (DESIGN.md §6). The
// secret is sealed (crypto.ts) and only the proxy reads it back; pages never get it. Writes re-check the app admin.
import { appAdmin } from './grants.ts'

export type AuthScheme = 'bearer' | 'header' | 'basic'

export interface IntegrationRow {
  id: string
  org_id: string
  app: string
  key: string
  name: string
  base_url: string
  /** JSON array of host names the app may reach besides the base URL's. */
  allowed_hosts: string
  auth_scheme: AuthScheme
  header_name: string | null
  created_at: number
  updated_at: number
  last_used_at: number | null
}

/** With the sealed secret: for the proxy only. */
export interface IntegrationSecretRow extends IntegrationRow {
  secret_enc: string
}

const COLUMNS = 'id, org_id, app, key, name, base_url, allowed_hosts, auth_scheme, header_name, created_at, updated_at, last_used_at'

export async function listIntegrations(db: D1Database, orgId: string, app: string): Promise<IntegrationRow[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM integrations WHERE org_id = ?1 AND app = ?2 ORDER BY key`)
    .bind(orgId, app).all<IntegrationRow>()
  return results
}

export function findIntegration(db: D1Database, orgId: string, app: string, id: string): Promise<IntegrationRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM integrations WHERE org_id = ?1 AND app = ?2 AND id = ?3`).bind(orgId, app, id).first<IntegrationRow>()
}

export function findIntegrationSecret(db: D1Database, orgId: string, app: string, key: string): Promise<IntegrationSecretRow | null> {
  return db.prepare(`SELECT ${COLUMNS}, secret_enc FROM integrations WHERE org_id = ?1 AND app = ?2 AND key = ?3`)
    .bind(orgId, app, key).first<IntegrationSecretRow>()
}

export interface IntegrationInput {
  name: string
  baseUrl: string
  allowedHosts: string[]
  authScheme: AuthScheme
  headerName: string | null
}

/** Creates a stored credential while `actorId` is still the app's admin. False otherwise, or when the key is taken. */
export async function insertIntegration(db: D1Database, row: IntegrationInput & {
  id: string; orgId: string; app: string; key: string; secretEnc: string; actorId: string; now: number
}): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO integrations (id, org_id, app, key, name, base_url, allowed_hosts, auth_scheme, header_name, secret_enc, created_by,
       created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12 WHERE ${appAdmin('?2', '?11', '?3')}
     ON CONFLICT DO NOTHING`,
  ).bind(row.id, row.orgId, row.app, row.key, row.name, row.baseUrl, JSON.stringify(row.allowedHosts), row.authScheme, row.headerName,
    row.secretEnc, row.actorId, row.now).run()
  return result.meta.changes > 0
}

/**
 * Changes a stored credential while `actorId` is still the app's admin. A null secret keeps the current one, and then
 * only while the destination and the way it is sent stay as they are: the stored secret never goes anywhere new.
 */
export async function updateIntegration(db: D1Database, row: IntegrationInput & {
  id: string; orgId: string; app: string; secretEnc: string | null; actorId: string; now: number
}): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE integrations SET name = ?4, base_url = ?5, allowed_hosts = ?6, auth_scheme = ?7, header_name = ?8,
       secret_enc = COALESCE(?9, secret_enc), updated_at = ?10
     WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND ${appAdmin('?2', '?11', '?3')}
       AND (?9 IS NOT NULL OR (base_url = ?5 AND allowed_hosts = ?6 AND auth_scheme = ?7 AND header_name IS ?8))`,
  ).bind(row.id, row.orgId, row.app, row.name, row.baseUrl, JSON.stringify(row.allowedHosts), row.authScheme, row.headerName,
    row.secretEnc, row.now, row.actorId).run()
  return result.meta.changes > 0
}

export async function deleteIntegration(db: D1Database, row: { id: string; orgId: string; app: string; actorId: string }): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM integrations WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND ${appAdmin('?2', '?4', '?3')}`)
    .bind(row.id, row.orgId, row.app, row.actorId).run()
  return result.meta.changes > 0
}

export async function touchIntegration(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare('UPDATE integrations SET last_used_at = ?2 WHERE id = ?1').bind(id, now).run()
}
