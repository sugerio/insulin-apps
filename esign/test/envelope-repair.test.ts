import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';
import { unstable_splitSqlQuery } from 'wrangler';
import { canonicalJson } from '../src/canonical-json.ts';
import { sweepEnvelopes } from '../src/envelope-completion.ts';
import { expireDueEnvelopes } from '../src/task-expiry.ts';
import { APPENDED_PAGE_RENDERER, signatureEventHash } from '../src/signatures.ts';

/**
 * Signing, rendering and sealing each commit with one conditional write, and the steps after it
 * are idempotent. These tests leave an envelope half-advanced, as a lost or interrupted write
 * would, and check that the cron sweep (and the completion it runs) finishes it.
 */

const sha = async (bytes: Uint8Array | ArrayBuffer) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const SEAL_KEY = 'local-test-seal-key-of-at-least-32-bytes';

/** A saved signature on the appended signature page, as recordSignature writes it. */
async function signatureRow(db: D1Database, row: { id: string; taskId: string; name: string; sequence: number; inputId: string; inputHash: string; inputPages: number; previousHash: string | null }) {
  const facts = { version: 1, signatureId: row.id, taskId: row.taskId, role: row.taskId, recipientName: row.name, recipientEmail: `${row.taskId}@example.com`, sessionHash: 'a'.repeat(64), otpVerifiedAt: 1000 * row.sequence, consentedAt: 2000 * row.sequence, inputArtifactId: row.inputId };
  const render = { version: 1, kind: 'appended-page', renderer: APPENDED_PAGE_RENDERER, inputPageCount: row.inputPages, slot: row.sequence - 1, name: row.name, signedAt: new Date(2000 * row.sequence).toISOString() };
  const eventHash = await signatureEventHash({ previousHash: row.previousHash, envelopeId: 'env', sequence: row.sequence, inputSha256: row.inputHash }, facts, render);
  await db.prepare(`INSERT INTO signatures (id,envelope_id,task_id,sequence,status,input_artifact_id,input_sha256,previous_hash,event_hash,facts_json,render_json) VALUES (?,'env',?,?,'PENDING',?,?,?,?,?,?)`)
    .bind(row.id, row.taskId, row.sequence, row.inputId, row.inputHash, row.previousHash, eventHash, canonicalJson(facts), canonicalJson(render)).run();
  return eventHash;
}

test('the cron sweep finishes an envelope left half-advanced after signing, rendering and sealing', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'], r2Buckets: ['ARTIFACTS'] });
  try {
    const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('ARTIFACTS');
    for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort())
      await db.batch(unstable_splitSqlQuery(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')).map(s => db.prepare(s)));
    const pdf = await PDFDocument.create(); pdf.addPage(); const d0 = await pdf.save(), d0Hash = await sha(d0);
    await bucket.put('envelopes/env/d0.pdf', d0);
    await db.exec(`INSERT INTO tenants (id) VALUES ('a');
INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at) VALUES ('template','a','source','["ana","marcus"]',1);
INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('env','a','template','IN_PROGRESS',1,'hash');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('ana','env','ana','Ana','ana@example.com',1,'ACTIVE');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('marcus','env','marcus','Marcus','marcus@example.com',2,'PENDING');`);
    await db.prepare("INSERT INTO artifacts VALUES ('d0','env','envelopes/env/d0.pdf',?)").bind(d0Hash).run();
    const env = { DB: db, ARTIFACTS: bucket };
    const status = async () => (await db.prepare("SELECT status FROM envelopes WHERE id='env'").first<{ status: string }>())!.status;
    const tasks = async () => Object.fromEntries((await db.prepare("SELECT id,status FROM tasks WHERE envelope_id='env'").all<{ id: string; status: string }>()).results.map(t => [t.id, t.status]));
    const none = { completed: 0, waiting: 0, failed: 0 };

    // A healthy envelope waiting for its signer is not swept.
    assert.deepEqual(await sweepEnvelopes(env), none);

    // Ana's signature is committed but her task is still ACTIVE: she has signed, so her deadline
    // no longer applies, and the sweep renders the signature, marks her task and activates Marcus.
    const first = await signatureRow(db, { id: 'sig1', taskId: 'ana', name: 'Ana', sequence: 1, inputId: 'd0', inputHash: d0Hash, inputPages: 1, previousHash: null });
    await db.prepare("UPDATE tasks SET expires_at=1 WHERE id='ana'").run();
    assert.equal(await expireDueEnvelopes(db), 0);
    assert.equal(await status(), 'IN_PROGRESS');
    assert.deepEqual(await sweepEnvelopes(env), { ...none, waiting: 1 });
    assert.deepEqual(await tasks(), { ana: 'SIGNED', marcus: 'ACTIVE' });
    const d1 = (await db.prepare("SELECT status,output_artifact_id,output_sha256 FROM signatures WHERE id='sig1'").first<{ status: string; output_artifact_id: string; output_sha256: string }>())!;
    assert.equal(d1.status, 'DONE');

    // A rendered signature whose task is still ACTIVE and whose next task is still PENDING.
    await db.exec("UPDATE tasks SET status='ACTIVE' WHERE id='ana'; UPDATE tasks SET status='PENDING' WHERE id='marcus';");
    assert.deepEqual(await sweepEnvelopes(env), { ...none, waiting: 1 });
    assert.deepEqual(await tasks(), { ana: 'SIGNED', marcus: 'ACTIVE' });
    assert.deepEqual(await sweepEnvelopes(env), none, 'a repaired envelope is healthy again');

    // Repairs never move an envelope that is no longer IN_PROGRESS.
    await db.exec("UPDATE tasks SET status='PENDING' WHERE id='marcus'; UPDATE envelopes SET status='VOIDED' WHERE id='env';");
    assert.deepEqual(await sweepEnvelopes(env), none);
    assert.deepEqual(await tasks(), { ana: 'SIGNED', marcus: 'PENDING' });
    await db.exec("UPDATE tasks SET status='ACTIVE' WHERE id='marcus'; UPDATE envelopes SET status='IN_PROGRESS' WHERE id='env';");

    // Marcus's signature is committed with his task still ACTIVE. Without a seal key the envelope
    // is rendered and moved to FINALIZING, then waits.
    await signatureRow(db, { id: 'sig2', taskId: 'marcus', name: 'Marcus', sequence: 2, inputId: d1.output_artifact_id, inputHash: d1.output_sha256, inputPages: 2, previousHash: first });
    assert.deepEqual(await sweepEnvelopes(env), { ...none, waiting: 1 });
    assert.deepEqual(await tasks(), { ana: 'SIGNED', marcus: 'SIGNED' });
    assert.equal(await status(), 'FINALIZING');

    // Every task signed and rendered, but the envelope still IN_PROGRESS.
    await db.prepare("UPDATE envelopes SET status='IN_PROGRESS' WHERE id='env'").run();
    assert.deepEqual(await sweepEnvelopes(env), { ...none, waiting: 1 });
    assert.equal(await status(), 'FINALIZING');

    // With the local test seal key, the sweep seals and completes it.
    const sealing = { ...env, TEST_SEAL_KEY: SEAL_KEY };
    assert.deepEqual(await sweepEnvelopes(sealing), { ...none, completed: 1 });
    assert.equal(await status(), 'COMPLETED');
    const seal = await db.prepare("SELECT mode,object_key,sha256 FROM seals WHERE envelope_id='env'").first<{ mode: string; object_key: string; sha256: string }>();
    assert.equal(seal?.mode, 'LOCAL_TEST');
    const object = (await bucket.head(seal!.object_key))!;

    // Sealed, but the envelope still FINALIZING: completed with the seal already recorded.
    await db.prepare("UPDATE envelopes SET status='FINALIZING' WHERE id='env'").run();
    assert.deepEqual(await sweepEnvelopes(sealing), { ...none, completed: 1 });
    assert.equal(await status(), 'COMPLETED');
    assert.deepEqual((await db.prepare("SELECT mode,object_key,sha256 FROM seals WHERE envelope_id='env'").all()).results, [seal]);
    assert.equal((await bucket.head(seal!.object_key))!.etag, object.etag, 'the stored seal is reused, not replaced');
    assert.deepEqual(await sweepEnvelopes(sealing), none);
  } finally { await mf.dispose(); }
});
