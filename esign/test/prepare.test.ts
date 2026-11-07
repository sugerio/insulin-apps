import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
const preparation = await import('../src/prepare.ts').catch(() => ({ prepareEnvelope: undefined }));

test('preparation fixes a D0 hash, activates only the first task and is safe to retry', async () => {
  assert.equal(typeof preparation.prepareEnvelope, 'function', 'envelope preparation is missing');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS'] });
  try {
    const db = await mf.getD1Database('DB'); const bucket = await mf.getR2Bucket('ARTIFACTS');
    for (const name of ['0001_tenants.sql', '0002_templates.sql', '0003_envelopes.sql', '0004_artifacts.sql', '0005_preparation_assertions.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
    }
    await db.exec("INSERT INTO tenants VALUES ('tenant');\nINSERT INTO templates VALUES ('template', 'tenant', 'source', '[\"ana\",\"marcus\"]', 1);\nINSERT INTO envelopes VALUES ('env', 'tenant', 'template', 'PROCESSING', 1);\nINSERT INTO tasks VALUES ('t1', 'env', 'ana', 'Ana', 'ana@example.com', 1, 'PENDING');\nINSERT INTO tasks VALUES ('t2', 'env', 'marcus', 'Marcus', 'marcus@example.com', 2, 'PENDING');");
    await bucket.put('source', 'document');
    await assert.rejects(() => preparation.prepareEnvelope!(db, bucket, 'other', 'env'));
    await Promise.all([preparation.prepareEnvelope!(db, bucket, 'tenant', 'env'), preparation.prepareEnvelope!(db, bucket, 'tenant', 'env')]);
    assert.equal((await db.prepare('SELECT status FROM envelopes').first())!.status, 'IN_PROGRESS');
    assert.equal((await db.prepare("SELECT status FROM tasks WHERE id = 't1'").first())!.status, 'ACTIVE');
    assert.equal((await db.prepare("SELECT status FROM tasks WHERE id = 't2'").first())!.status, 'PENDING');
    const artifact = await db.prepare('SELECT object_key, sha256 FROM artifacts').first();
    assert.equal(artifact!.sha256, '43cc23fa52b87b4cc1d02b5b114154151d6adddb17c9fddc06b027fa99e24008');
    assert.equal(await (await bucket.get(artifact!.object_key as string))!.text(), 'document');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM artifacts').first())!.n, 1);
  } finally { await mf.dispose(); }
});

test('preparation rejects a missing first task without committing artifact metadata', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS'] });
  try {
    const db = await mf.getD1Database('DB'); const bucket = await mf.getR2Bucket('ARTIFACTS');
    for (const name of ['0001_tenants.sql', '0002_templates.sql', '0003_envelopes.sql', '0004_artifacts.sql', '0005_preparation_assertions.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
    }
    await db.exec("INSERT INTO tenants VALUES ('tenant');\nINSERT INTO templates VALUES ('template', 'tenant', 'source', '[\"ana\"]', 1);\nINSERT INTO envelopes VALUES ('env', 'tenant', 'template', 'PROCESSING', 1);");
    await bucket.put('source', 'document');
    await assert.rejects(() => preparation.prepareEnvelope!(db, bucket, 'tenant', 'env'));
    assert.equal((await db.prepare('SELECT status FROM envelopes').first())!.status, 'PROCESSING');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM artifacts').first())!.n, 0);
  } finally { await mf.dispose(); }
});
