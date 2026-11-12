// 0002_seal_key: the seals table moves from the KMS mode to the seal key's (KMS_TSA -> KEY_TSA, key_arn -> key_id)
// on a database that already holds seals of both kinds, and keeps its constraints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { MIGRATIONS_DIR, splitSql } from './helpers/platform.ts';

const ARN = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000';
const apply = async (db: D1Database, name: string) => db.batch(splitSql(await readFile(new URL(name, MIGRATIONS_DIR), 'utf8')).map(s => db.prepare(s)));

test('existing seals are carried over, the KMS ones as KEY_TSA with their ARN as key_id', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0000_init.sql', '0001_triggers.sql']) await apply(db, name);
    await db.prepare("INSERT INTO templates(id,tenant_id,object_key,roles_json,created_at) VALUES ('t','tenant','templates/t','[]',0)").run();
    for (const id of ['managed', 'local']) await db.prepare("INSERT INTO envelopes(id,tenant_id,template_id,status,created_at,request_sha256) VALUES (?,'tenant','t','COMPLETED',0,'r')").bind(id).run();
    await db.prepare("INSERT INTO seals(envelope_id,mode,object_key,sha256,key_arn,timestamp_time) VALUES ('managed','KMS_TSA','envelopes/managed/managed-evidence.json','a',?,1)").bind(ARN).run();
    await db.prepare("INSERT INTO seals(envelope_id,mode,object_key,sha256) VALUES ('local','LOCAL_TEST','envelopes/local/local-test-evidence.json','b')").run();

    await apply(db, '0002_seal_key.sql');

    assert.deepEqual((await db.prepare('SELECT envelope_id,mode,key_id,timestamp_time FROM seals ORDER BY envelope_id').all()).results, [
      { envelope_id: 'local', mode: 'LOCAL_TEST', key_id: null, timestamp_time: null },
      { envelope_id: 'managed', mode: 'KEY_TSA', key_id: ARN, timestamp_time: 1 },
    ]);
    // The constraints hold on the rebuilt table: the old mode, a managed seal without its key, a repeated object key.
    await db.prepare("INSERT INTO envelopes(id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('next','tenant','t','FINALIZING',0,'r')").run();
    const insert = (mode: string, keyId: string | null, objectKey = 'envelopes/next/managed-evidence.json') =>
      db.prepare("INSERT INTO seals(envelope_id,mode,object_key,sha256,key_id,timestamp_time) VALUES ('next',?,?,'c',?,2)").bind(mode, objectKey, keyId).run();
    await assert.rejects(insert('KMS_TSA', 'k'), /CHECK constraint failed/);
    await assert.rejects(insert('KEY_TSA', null), /CHECK constraint failed/);
    await assert.rejects(insert('KEY_TSA', 'k', 'envelopes/managed/managed-evidence.json'), /UNIQUE constraint failed/);
    await insert('KEY_TSA', 'k');
  } finally {
    await mf.dispose();
  }
});
