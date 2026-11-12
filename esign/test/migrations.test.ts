import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { applyMigrations, splitSql } from './helpers/platform.ts';

const MIGRATIONS = new URL('../src/app/db/migrations/', import.meta.url);

async function database() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  return { mf, db: await mf.getD1Database('DB') };
}

test('every migration is in the journal, in order, and nothing else is', async () => {
  const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', MIGRATIONS), 'utf8')) as { entries: { idx: number; tag: string }[] };
  assert.deepEqual(journal.entries.map((entry) => `${entry.tag}.sql`), files);
  assert.deepEqual(journal.entries.map((entry) => entry.idx), files.map((_, i) => i));
});

test('the migrations make the app\'s tables only: the organization comes from the platform, not a table', async () => {
  const { mf, db } = await database();
  try {
    await applyMigrations(db, { gateway: false });
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name").all<{ name: string }>();
    assert.deepEqual(results.map((row) => row.name), [
      'access_codes', 'access_sessions', 'app_settings', 'artifacts', 'audit_events', 'blob_chunks', 'blobs', 'contacts', 'copy_deliveries',
      'editor_sessions', 'envelopes', 'invitations', 'otp_challenges', 'seals', 'signatures', 'signed_copy_links', 'tasks', 'templates',
    ]);
    const triggers = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all<{ name: string }>();
    assert.deepEqual(triggers.results.map((row) => row.name), [
      'audit_events_no_delete', 'audit_events_no_update', 'immutable_task_recipient_email', 'signatures_facts_immutable', 'signatures_no_delete', 'signatures_output_final',
    ]);
    await assert.rejects(() => db.prepare("INSERT INTO app_settings (name, value) VALUES ('editor_origins', 'not json')").run(), /CHECK/);
  } finally { await mf.dispose(); }
});

test('the custom migration can run again from the start, as publishing does after a failure midway', async () => {
  const { mf, db } = await database();
  try {
    await applyMigrations(db, { gateway: false });
    const triggers = splitSql(await readFile(new URL('0001_triggers.sql', MIGRATIONS), 'utf8'));
    assert.equal(triggers.length, 6);
    for (const statement of triggers) await db.prepare(statement).run();
  } finally { await mf.dispose(); }
});
