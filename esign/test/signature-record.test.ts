import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import * as auth from '../src/page-authorization.ts';
const signing = await import('../src/signature-record.ts').catch(() => ({}));

test('signature atomically requires persisted verified session, consent and the current artifact', async () => {
  assert.equal(typeof signing.recordSignature, 'function', 'signature recording is missing');
  const mf = new Miniflare({modules:true, script:'export default {fetch(){return new Response("ok")}}', d1Databases:['DB'], r2Buckets:['ARTIFACTS']});
  try {
    const db = await mf.getD1Database('DB'), bucket=await mf.getR2Bucket('ARTIFACTS');
    const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
    const h0=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    await bucket.put('d0.pdf',bytes);
    for (const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0004_artifacts.sql','0006_page_authorization.sql','0007_signature_records.sql','0008_signature_events.sql','0009_otp_lifecycle.sql','0025_otp_recipient_binding.sql','0029_recipient_session_revocations.sql','0030_recipient_code_revocations.sql','0026_signature_otp_recipient.sql','0011_signature_layout.sql','0012_signature_input_layouts.sql', '0050_task_expiry.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    await db.exec(`INSERT INTO tenants VALUES ('a');
INSERT INTO templates VALUES ('template', 'a', 'source', '["ana"]', 1);
INSERT INTO envelopes VALUES ('env', 'a', 'template', 'IN_PROGRESS', 1);
INSERT INTO tasks VALUES ('ana', 'env', 'ana', 'Ana', 'ana@example.com', 1, 'ACTIVE');
INSERT INTO artifacts VALUES ('d0', 'env', 'd0.pdf', '${h0}');
INSERT INTO tenant_page_origins VALUES ('a', 'https://host.example.com');`);
    const origin = 'https://host.example.com';
    const code = await auth.issueRecipientCode(db, {tenantId:'a', envelopeId:'env', taskId:'ana', origin, now:1000});
    const token = await auth.exchangeRecipientCode(db, code, origin, 1001);
    const cmd = {token, origin, now:1003, artifactId:'d0', artifactHash:h0, consent:true};
    await assert.rejects(() => signing.recordSignature(db, bucket, cmd));
    const pepper = new TextEncoder().encode('local-test-pepper-at-least-32-bytes'); let otp = '';
    await auth.sendRecipientOtp(db, token, origin, 1002, pepper, async (_email, value) => { otp = value; });
    assert.equal(await auth.verifyRecipientOtp(db, token, origin, 1003, pepper, otp), true);
    await db.prepare("UPDATE tasks SET recipient_email='other@example.test' WHERE id='ana'").run();
    await assert.rejects(() => signing.recordSignature(db, bucket, cmd),'v1 must not sign against a changed recipient');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n,0);
    await db.prepare("UPDATE tasks SET recipient_email='ana@example.com' WHERE id='ana'").run();
    await assert.rejects(() => signing.recordSignature(db, bucket, {...cmd, consent:false}));
    await assert.rejects(() => signing.recordSignature(db, bucket, {...cmd, artifactHash:'stale'}));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n, 0);
    await db.prepare("UPDATE tasks SET recipient_name='李雷' WHERE id='ana'").run();
    await assert.rejects(() => signing.recordSignature(db, bucket, cmd), /unsupported recipient name/i);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_jobs').first())!.n, 0);
    await db.prepare("UPDATE tasks SET recipient_name=? WHERE id='ana'").bind('W'.repeat(200)).run();
    await assert.rejects(() => signing.recordSignature(db, bucket, cmd), /unsupported recipient name/i);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_jobs').first())!.n, 0);
    assert.equal((await db.prepare("SELECT status FROM tasks WHERE id='ana'").first())!.status, 'ACTIVE');
    await db.prepare("UPDATE tasks SET recipient_name='Ana' WHERE id='ana'").run();
    await db.prepare("INSERT INTO tasks VALUES ('marcus','env','marcus',?,'marcus@example.com',2,'PENDING')").bind('W'.repeat(200)).run();
    await assert.rejects(() => signing.recordSignature(db, bucket, cmd), /unsupported recipient name/i);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n, 0);
    assert.equal((await db.prepare("SELECT status FROM tasks WHERE id='ana'").first())!.status, 'ACTIVE');
    await db.prepare("UPDATE tasks SET recipient_name=? WHERE id='marcus'").bind('AV'.repeat(29)).run();
    await assert.rejects(() => signing.recordSignature(db, bucket, cmd), /unsupported recipient name/i);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n, 0);
    await db.prepare("UPDATE tasks SET recipient_name='Marcus' WHERE id='marcus'").run();
    const racedDb = new Proxy(db, {get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        await target.prepare("UPDATE tasks SET recipient_name=? WHERE id='marcus'").bind('W'.repeat(200)).run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    await assert.rejects(() => signing.recordSignature(racedDb, bucket, cmd));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n, 0);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_jobs').first())!.n, 0);
    assert.equal((await db.prepare("SELECT status FROM tasks WHERE id='ana'").first())!.status, 'ACTIVE');
    await db.prepare("DELETE FROM tasks WHERE id='marcus'").run();
    assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signature_events'").first(), 'hash-linked signing events must be persisted');
    const outcomes = await Promise.allSettled([signing.recordSignature(db, bucket, cmd), signing.recordSignature(db, bucket, cmd)]);
    assert.equal(outcomes.filter(o=>o.status === 'fulfilled').length, 1);
    assert.equal((await db.prepare("SELECT status FROM tasks WHERE id='ana'").first())!.status, 'SIGNED');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_jobs').first())!.n, 1);
  } finally { await mf.dispose(); }
});
