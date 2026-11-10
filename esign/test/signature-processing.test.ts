import {applyMigrations} from './helpers/platform.ts';
import {blobStore} from './helpers/platform.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { MIGRATIONS_DIR, splitSql as unstable_splitSqlQuery } from './helpers/platform.ts';
import { processSignature } from '../src/app/server/esign/signature-processing.ts';
import { canonicalJson } from '../src/app/server/esign/canonical-json.ts';
import { APPENDED_PAGE_RENDERER, signatureEventHash } from '../src/app/server/esign/signatures.ts';

const sha = async (bytes: Uint8Array | ArrayBuffer) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');

/** A saved signature row as recordSignature writes it: facts, render and their event hash. */
async function signatureRow(db: D1Database, id: string, envelopeId: string, taskId: string, name: string, inputHash: string, eventHash?: string) {
  const facts = { version: 1, signatureId: id, taskId, role: taskId, recipientName: name, recipientEmail: `${taskId}@example.com`, sessionHash: 'a'.repeat(64), otpVerifiedAt: 1000, consentedAt: 2000, inputArtifactId: 'd0' };
  const render = { version: 1, kind: 'appended-page', renderer: APPENDED_PAGE_RENDERER, inputPageCount: 1, slot: 0, name, signedAt: new Date(2000).toISOString() };
  const hash = eventHash ?? await signatureEventHash({ previousHash: null, envelopeId, sequence: 1, inputSha256: inputHash }, facts, render);
  await db.prepare(`INSERT INTO signatures (id,envelope_id,task_id,sequence,status,input_artifact_id,input_sha256,previous_hash,event_hash,facts_json,render_json) VALUES (?,?,?,1,'PENDING','d0',?,NULL,?,?,?)`)
    .bind(id, envelopeId, taskId, inputHash, hash, canonicalJson(facts), canonicalJson(render)).run();
}

test('processing preserves input, creates one signed PDF and activates the next task after retry', async () => {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
  try {
    const db = await mf.getD1Database('DB'), bucket = await blobStore(mf,'artifacts');
    await applyMigrations(db);
    const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = await pdf.save();
    const hash = await sha(bytes);
    await db.exec(`INSERT INTO tenants (id) VALUES ('a');
INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at) VALUES ('template','a','source','["ana","marcus"]',1);
INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('env','a','template','IN_PROGRESS',1,'hash');
INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('forged','a','template','IN_PROGRESS',1,'hash');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('ana','env','ana','Ana','ana@example.com',1,'SIGNED');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('marcus','env','marcus','Marcus','marcus@example.com',2,'PENDING');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('wide','forged','ana','Ana','wide@example.com',1,'SIGNED');`);
    await db.prepare("INSERT INTO artifacts VALUES ('d0','env','d0.pdf',?)").bind(hash).run();
    await signatureRow(db, 'sig', 'env', 'ana', 'Ana', hash);

    // A record whose event hash does not match its facts is never rendered.
    await signatureRow(db, 'forged-sig', 'forged', 'wide', 'W'.repeat(200), hash, 'f'.repeat(64));
    await assert.rejects(() => processSignature(db, bucket, 'forged-sig'), /Event hash mismatch/);

    await bucket.put('d0.pdf', 'tampered');
    await assert.rejects(() => processSignature(db, bucket, 'sig'), /Input mismatch/);
    assert.equal((await db.prepare("SELECT status FROM signatures WHERE id='sig'").first())!.status, 'PENDING');
    await bucket.put('d0.pdf', bytes);

    // After the insert the facts never change and the row is never deleted.
    for (const change of ["facts_json='{}'", "render_json='{}'", "event_hash='x'", "previous_hash='x'", "input_sha256='x'", "task_id='marcus'", 'sequence=2'])
      await assert.rejects(() => db.prepare(`UPDATE signatures SET ${change} WHERE id='sig'`).run(), /immutable/, change);
    await assert.rejects(() => db.prepare("DELETE FROM signatures WHERE id='sig'").run(), /cannot be deleted/);
    await assert.rejects(() => db.prepare("UPDATE signatures SET status='DONE' WHERE id='sig'").run(), /CHECK/);
    await db.prepare("UPDATE signatures SET attempts=attempts+1,last_error='simulated' WHERE id='sig'").run();

    const failingDb = new Proxy(db, {get(target, key) {
      if (key === 'batch') return async () => { throw new Error('simulated D1 failure'); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    await assert.rejects(() => processSignature(failingDb, bucket, 'sig'), /simulated D1 failure/);
    assert.equal((await db.prepare("SELECT output_sha256 FROM signatures WHERE id='sig'").first())!.output_sha256, null);
    await Promise.all([processSignature(db, bucket, 'sig'), processSignature(db, bucket, 'sig')]);
    await processSignature(db, bucket, 'sig');
    const out = (await db.prepare("SELECT status, output_artifact_id, output_sha256 FROM signatures WHERE id='sig'").first<{ status: string; output_artifact_id: string; output_sha256: string }>())!;
    assert.equal(out.status, 'DONE');
    assert.equal(out.output_artifact_id, 'signed:sig');
    assert.equal((await db.prepare("SELECT status FROM tasks WHERE id='marcus'").first())!.status, 'ACTIVE');
    assert.notEqual(out.output_sha256, hash);
    const key = 'envelopes/env/signed:sig.pdf', signed = await (await bucket.get(key))!.arrayBuffer();
    assert.equal(await sha(signed), out.output_sha256);
    assert.equal((await PDFDocument.load(signed)).getPageCount(), 2);
    assert.deepEqual(new Uint8Array(await (await bucket.get('d0.pdf'))!.arrayBuffer()), bytes);

    // A rendered signature stays rendered, with the same output.
    for (const change of ["status='PENDING', output_artifact_id=NULL, output_sha256=NULL", "output_sha256='x'", "output_artifact_id='x'"])
      await assert.rejects(() => db.prepare(`UPDATE signatures SET ${change} WHERE id='sig'`).run(), /final/, change);

    // Rendering again checks the stored PDF byte for byte.
    await bucket.put(key, 'tampered');
    await assert.rejects(() => processSignature(db, bucket, 'sig'), /Output integrity failure/);
    await bucket.put(key, signed);
    await processSignature(db, bucket, 'sig');
  } finally { await mf.dispose(); }
});
