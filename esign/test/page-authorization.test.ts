import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
const auth = await import('../src/page-authorization.ts').catch(() => ({}));

test('recipient code and OTP are origin-bound, scoped, one-time and persistently limited', async () => {
  assert.equal(typeof auth.issueRecipientCode, 'function', 'persisted recipient authorization is missing');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0006_page_authorization.sql','0009_otp_lifecycle.sql','0025_otp_recipient_binding.sql','0029_recipient_session_revocations.sql','0030_recipient_code_revocations.sql', '0050_task_expiry.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    await db.exec(`INSERT INTO tenants VALUES ('a'), ('b');
INSERT INTO templates VALUES ('template', 'a', 'source', '["ana","marcus"]', 1);
INSERT INTO envelopes VALUES ('env', 'a', 'template', 'IN_PROGRESS', 1);
INSERT INTO tasks VALUES ('ana', 'env', 'ana', 'Ana', 'ana@example.com', 1, 'ACTIVE');
INSERT INTO tasks VALUES ('marcus', 'env', 'marcus', 'Marcus', 'marcus@example.com', 2, 'PENDING');
INSERT INTO tenant_page_origins VALUES ('a', 'https://host.example.com');`);
    const view = {tenantId:'a', envelopeId:'env', taskId:'ana', origin:'https://host.example.com', now:1000};
    await assert.rejects(() => auth.issueRecipientCode(db, {...view, tenantId:'b'}));
    await assert.rejects(() => auth.issueRecipientCode(db, {...view, taskId:'marcus'}));
    await assert.rejects(() => auth.issueRecipientCode(db, {...view, origin:'https://wrong.example.com'}));
    const code = await auth.issueRecipientCode(db, view);
    await assert.rejects(() => auth.exchangeRecipientCode(db, code, 'https://wrong.example.com', 1001));
    const exchanges = await Promise.allSettled([auth.exchangeRecipientCode(db, code, view.origin, 1001), auth.exchangeRecipientCode(db, code, view.origin, 1001)]);
    assert.equal(exchanges.filter(x => x.status === 'fulfilled').length, 1);
    const token = (exchanges.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
    assert.equal(await auth.authorizeRecipientSession(db, token, view.origin, 1002), 'ana');
    await assert.rejects(() => auth.authorizeRecipientSession(db, token, 'https://wrong.example.com', 1002));
    let delivered: {email:string; otp:string} | undefined;
    const pepper = new TextEncoder().encode('local-test-pepper-at-least-32-bytes');
    await auth.sendRecipientOtp(db, token, view.origin, 1002, pepper, async (email, otp) => { delivered = {email, otp}; });
    assert.equal(delivered?.email, 'ana@example.com');
    assert.match(delivered!.otp, /^\d{6}$/);
    await assert.rejects(() => auth.sendRecipientOtp(db, token, view.origin, 1003, pepper, async () => {}));
    assert.equal(await auth.verifyRecipientOtp(db, token, view.origin, 1004, pepper, '999999' === delivered!.otp ? '999998' : '999999'), false);
    assert.equal(await auth.verifyRecipientOtp(db, token, view.origin, 1005, pepper, delivered!.otp), true);
    assert.equal(await auth.verifyRecipientOtp(db, token, view.origin, 1006, pepper, delivered!.otp), true);
    assert.equal(await auth.verifyRecipientOtp(db, token, view.origin, 1007, pepper, delivered!.otp === '999999' ? '999998' : '999999'), false);
    await assert.rejects(() => auth.verifyRecipientOtp(db, token, 'https://wrong.example.com', 1007, pepper, delivered!.otp));
    assert.equal((await db.prepare("SELECT attempts FROM recipient_otp_challenges WHERE task_id='ana'").first())!.attempts, 2);
    const anotherCode=await auth.issueRecipientCode(db, view);
    const anotherToken=await auth.exchangeRecipientCode(db,anotherCode,view.origin,1008);
    assert.equal(await auth.verifyRecipientOtp(db,anotherToken,view.origin,1009,pepper,delivered!.otp),false);
    await assert.rejects(() => auth.verifyRecipientOtp(db,token,view.origin,10000000,pepper,delivered!.otp));
    assert.equal((await db.prepare("SELECT count(*) AS n FROM recipient_otp_verifications WHERE task_id='ana'").first())!.n, 1);
    await assert.rejects(() => auth.authorizeRecipientSession(db, token, view.origin, 10000000));
    await db.prepare("UPDATE tasks SET status='ACTIVE' WHERE id='marcus'").run();
    const marcusCode = await auth.issueRecipientCode(db, {...view, taskId:'marcus'});
    const marcusToken = await auth.exchangeRecipientCode(db, marcusCode, view.origin, 1001);
    let marcusOtp = '';
    await auth.sendRecipientOtp(db, marcusToken, view.origin, 1002, pepper, async (_email, otp) => { marcusOtp = otp; });
    const wrong = marcusOtp === '999999' ? '999998' : '999999';
    const tries = await Promise.all(Array.from({length: 8}, () => auth.verifyRecipientOtp(db, marcusToken, view.origin, 1003, pepper, wrong)));
    assert.deepEqual(tries, Array(8).fill(false));
    assert.equal((await db.prepare("SELECT attempts FROM recipient_otp_challenges WHERE task_id='marcus'").first())!.attempts, 5);
    assert.equal(await auth.verifyRecipientOtp(db, marcusToken, view.origin, 1004, pepper, marcusOtp), false);
    const secondCode = await auth.issueRecipientCode(db, {...view, taskId:'marcus'});
    const secondToken = await auth.exchangeRecipientCode(db, secondCode, view.origin, 1001);
    await assert.rejects(() => auth.sendRecipientOtp(db, secondToken, view.origin, 1004, pepper, async () => {}));
  } finally { await mf.dispose(); }
});

test('OTP resend recovers after cooldown without resetting the task attempt budget', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0006_page_authorization.sql','0009_otp_lifecycle.sql','0025_otp_recipient_binding.sql','0029_recipient_session_revocations.sql','0030_recipient_code_revocations.sql', '0050_task_expiry.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    await db.exec(`INSERT INTO tenants VALUES ('a');
INSERT INTO templates VALUES ('t','a','source','["ana"]',1);
INSERT INTO envelopes VALUES ('e','a','t','IN_PROGRESS',1);
INSERT INTO tasks VALUES ('ana','e','ana','Ana','ana@example.com',1,'ACTIVE');
INSERT INTO tenant_page_origins VALUES ('a','https://host.example.com');`);
    const origin='https://host.example.com', pepper=new TextEncoder().encode('local-test-pepper-at-least-32-bytes');
    const code=await auth.issueRecipientCode(db,{tenantId:'a',envelopeId:'e',taskId:'ana',origin,now:1000});
    const token=await auth.exchangeRecipientCode(db,code,origin,1001);
    let otp='';
    const send=async (_email:string,value:string) => {otp=value;};
    await auth.sendRecipientOtp(db,token,origin,1002,pepper,send);
    const wrong=otp==='999999'?'999998':'999999';
    for(let i=0;i<4;i++) assert.equal(await auth.verifyRecipientOtp(db,token,origin,1003+i,pepper,wrong),false);
    await assert.rejects(()=>auth.sendRecipientOtp(db,token,origin,2000,pepper,send));
    await auth.sendRecipientOtp(db,token,origin,61002,pepper,send);
    const secondWrong=otp==='999999'?'999998':'999999';
    assert.equal(await auth.verifyRecipientOtp(db,token,origin,61003,pepper,secondWrong),false);
    assert.equal(await auth.verifyRecipientOtp(db,token,origin,61004,pepper,otp),false);
    const nextCode=await auth.issueRecipientCode(db,{tenantId:'a',envelopeId:'e',taskId:'ana',origin,now:901002});
    const nextToken=await auth.exchangeRecipientCode(db,nextCode,origin,901003);
    await auth.sendRecipientOtp(db,nextToken,origin,901004,pepper,send);
    assert.equal(await auth.verifyRecipientOtp(db,nextToken,origin,901005,pepper,otp),true);
    const reentryCode=await auth.issueRecipientCode(db,{tenantId:'a',envelopeId:'e',taskId:'ana',origin,now:1802004});
    const reentryToken=await auth.exchangeRecipientCode(db,reentryCode,origin,1802005);
    await auth.sendRecipientOtp(db,reentryToken,origin,1802006,pepper,send);
    assert.equal(await auth.verifyRecipientOtp(db,reentryToken,origin,1802007,pepper,otp),true);
    const verified=await db.prepare("SELECT session_hash FROM recipient_otp_verifications WHERE task_id='ana'").first();
    assert.ok(verified?.session_hash);
    assert.notEqual(verified!.session_hash, Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(nextToken))),n=>n.toString(16).padStart(2,'0')).join(''));
  } finally { await mf.dispose(); }
});
