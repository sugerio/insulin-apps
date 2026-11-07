import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
const processing = await import('../src/signature-processing.ts').catch(() => ({}));

test('processing preserves input, creates one signed PDF and activates the next task after retry', async () => {
  assert.equal(typeof processing.processSignatureJob, 'function', 'signature processing is missing');
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
  try {
    const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('ARTIFACTS');
    for (const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0004_artifacts.sql','0006_page_authorization.sql','0007_signature_records.sql','0008_signature_events.sql','0011_signature_layout.sql','0017_positioned_signatures.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = await pdf.save();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n=>n.toString(16).padStart(2,'0')).join('');
    await db.exec(`INSERT INTO tenants VALUES ('a');
INSERT INTO templates VALUES ('template','a','source','["ana","marcus"]',1);
INSERT INTO envelopes VALUES ('env','a','template','IN_PROGRESS',1);
INSERT INTO tasks VALUES ('ana','env','ana','Ana','ana@example.com',1,'SIGNED');
INSERT INTO tasks VALUES ('marcus','env','marcus','Marcus','marcus@example.com',2,'PENDING');
INSERT INTO recipient_page_sessions VALUES ('session','a','env','ana','https://host.example.com',999999);
INSERT INTO signature_records VALUES ('sig','env','ana',1,'session','Ana','d0','${hash}',1000,2000);
INSERT INTO signature_jobs VALUES ('job','sig','PENDING');
INSERT INTO signature_events (signature_id,envelope_id,sequence,previous_hash,event_hash) VALUES ('sig','env',1,'','test');`);
    await db.prepare("INSERT INTO artifacts VALUES ('d0','env','d0.pdf',?)").bind(hash).run();
    await bucket.put('d0.pdf', 'tampered');
    await assert.rejects(() => processing.processSignatureJob(db,bucket,'job'), /hash mismatch/);
    assert.equal((await db.prepare("SELECT status FROM signature_jobs WHERE id='job'").first())!.status, 'PENDING');
    await bucket.put('d0.pdf', bytes);
    await db.prepare("UPDATE signature_records SET recipient_name=? WHERE id='sig'").bind('W'.repeat(200)).run();
    await assert.rejects(() => processing.processSignatureJob(db,bucket,'job'), /unsupported recipient name/i);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_outputs').first())!.n, 0);
    assert.equal((await db.prepare("SELECT status FROM signature_jobs WHERE id='job'").first())!.status, 'PENDING');
    await db.prepare("UPDATE signature_records SET recipient_name='Ana' WHERE id='sig'").run();
    const failingDb = new Proxy(db, {get(target, key) {
      if (key === 'batch') return async () => { throw new Error('simulated D1 failure'); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    await assert.rejects(() => processing.processSignatureJob(failingDb,bucket,'job'), /simulated D1 failure/);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_outputs').first())!.n, 0);
    await Promise.all([processing.processSignatureJob(db,bucket,'job'), processing.processSignatureJob(db,bucket,'job')]);
    await processing.processSignatureJob(db,bucket,'job');
    assert.equal((await db.prepare("SELECT status FROM signature_jobs WHERE id='job'").first())!.status, 'DONE');
    assert.equal((await db.prepare("SELECT status FROM tasks WHERE id='marcus'").first())!.status, 'ACTIVE');
    const out = await db.prepare('SELECT object_key, sha256 FROM signature_outputs').first();
    assert.ok(out); assert.notEqual(out!.sha256, hash);
    assert.equal((await PDFDocument.load(await (await bucket.get(out!.object_key as string))!.arrayBuffer())).getPageCount(), 2);
    assert.deepEqual(new Uint8Array(await (await bucket.get('d0.pdf'))!.arrayBuffer()), bytes);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_outputs').first())!.n, 1);
  } finally { await mf.dispose(); }
});
