// What the Insulin platform gives Esign, for tests: the identity headers the gateway (or the
// console) sends, the migrations as the deployment applies them, and the D1 object store.
import { rmSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { D1BlobStore } from '../../src/app/server/esign/blob-store.ts';

// getCurrentUser reads the platform identity only in console mode, as published.
process.env.SUGER_ACCESS_MODE = 'console';

/** Splits a generated migration at its statement breakpoints (what the deployment applies one by one). */
export function splitSql(sql: string): string[] {
  return sql.split('--> statement-breakpoint').map((statement) => statement.trim()).filter((statement) => statement && !/^(--[^\n]*(\n|$))+$/.test(statement));
}

const APP_MIGRATIONS = new URL('../../src/app/db/migrations/', import.meta.url);

/**
 * The test gateway's own tables (gateway.ts): a host's key in `api_keys` stands for a service account
 * of the organization in `tenants`, and `editor_origins_json` for the origins the deployment lets
 * embed the editor (ESIGN_FRAME_ANCESTORS); the triggers keep `app_settings.editor_origins` their
 * union, as the app's sync does from the setting. Never part of the app.
 */
const TEST_GATEWAY_SQL = `CREATE TABLE tenants (
  id TEXT PRIMARY KEY NOT NULL,
  editor_origins_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(editor_origins_json) AND json_type(editor_origins_json) = 'array')
);
--> statement-breakpoint
CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE TRIGGER tenants_editor_origins_inserted AFTER INSERT ON tenants BEGIN INSERT INTO app_settings (name, value) VALUES ('editor_origins', (SELECT COALESCE(json_group_array(DISTINCT o.value), '[]') FROM tenants t, json_each(t.editor_origins_json) o)) ON CONFLICT (name) DO UPDATE SET value = excluded.value; END;
--> statement-breakpoint
CREATE TRIGGER tenants_editor_origins_updated AFTER UPDATE OF editor_origins_json ON tenants BEGIN INSERT INTO app_settings (name, value) VALUES ('editor_origins', (SELECT COALESCE(json_group_array(DISTINCT o.value), '[]') FROM tenants t, json_each(t.editor_origins_json) o)) ON CONFLICT (name) DO UPDATE SET value = excluded.value; END;`;

/**
 * A directory with the app's migrations and, last, the test gateway's tables, for tests that apply
 * every `.sql` file of a directory in order. Made once per test process, removed at exit.
 */
const dir = await mkdtemp(join(tmpdir(), 'esign-test-migrations-'));
for (const name of (await readdir(APP_MIGRATIONS)).filter((n) => n.endsWith('.sql'))) await copyFile(new URL(name, APP_MIGRATIONS), join(dir, name));
await writeFile(join(dir, '9999_test_gateway.sql'), TEST_GATEWAY_SQL);
process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
export const MIGRATIONS_DIR = pathToFileURL(`${dir}/`);

/** Applies the app's migrations and the test gateway's tables, in order. */
export async function applyMigrations(db: D1Database, { gateway = true } = {}): Promise<void> {
  for (const name of (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort()) {
    if (!gateway && name.startsWith('9999_')) continue;
    for (const statement of splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8'))) await db.prepare(statement).run();
  }
}

/** The app's object store over a Miniflare D1 database (blob-store.ts); `bucket` is `artifacts` or `test-mail`. */
export async function blobStore(mf: { getD1Database(name: string): Promise<unknown> }, bucket: string): Promise<D1BlobStore> {
  return new D1BlobStore(await mf.getD1Database('DB') as D1Database, bucket);
}

export type Identity = { role?: 'OWNER' | 'ADMIN' | 'EDITOR' | 'USER' | 'VIEWER'; permissions?: string; via?: string; userId?: string; email?: string };

/**
 * The platform identity of a member of organization `tenant`, as request headers: an ADMIN by
 * default; `permissions` is the gateway's narrowing header (a custom role), `via` how the request came.
 */
export function identity(tenant: string, options: Identity = {}): Record<string, string> {
  const userId = options.userId ?? `user-${tenant}`;
  return {
    'x-suger-user-id': userId,
    'x-suger-organization-id': tenant,
    'x-suger-app-id': 'insulin-apps-esign',
    'x-suger-app-role': options.role ?? 'ADMIN',
    'x-suger-user-email': encodeURIComponent(options.email ?? `${userId}@example.test`),
    'x-suger-user-name': encodeURIComponent('Synthetic Member'),
    ...(options.permissions === undefined ? {} : { 'x-suger-app-permissions': options.permissions }),
    ...(options.via === undefined ? {} : { 'x-suger-access-via': options.via }),
  };
}
