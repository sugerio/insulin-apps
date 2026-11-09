import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
const auth = await import('../src/otp.ts').catch(() => ({}));

test('recipient code and OTP are origin-bound, scoped, one-time and persistently limited', async () => {
  assert.equal(typeof auth.issueRecipientCode, 'function', 'persisted recipient authorization is missing');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0005_access.sql','0006_otp_challenges.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    await db.exec(`INSERT INTO tenants (id) VALUES ('a'), ('b');
INSERT INTO templates VALUES ('template', 'a', 'source', '["ana","marcus"]', 1);
INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('env', 'a', 'template', 'IN_PROGRESS', 1,'hash');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('ana', 'env', 'ana', 'Ana', 'ana@example.com', 1, 'ACTIVE');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('marcus', 'env', 'marcus', 'Marcus', 'marcus@example.com', 2, 'PENDING');
`);
    const view = {tenantId:'a', envelopeId:'env', taskId:'ana', origin:'https://host.example.com', now:1000};
    await assert.rejects(() => auth.issueRecipientCode(db, {...view, tenantId:'b'}));
    await assert.rejects(() => auth.issueRecipientCode(db, {...view, taskId:'marcus'}));
    // Which page origins may be named is the route's check (the Worker's own and SIGNING_PAGE_ORIGINS).
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
    assert.equal((await db.prepare("SELECT attempts FROM otp_challenges WHERE task_id='ana'").first())!.attempts, 2);
    const anotherCode=await auth.issueRecipientCode(db, view);
    const anotherToken=await auth.exchangeRecipientCode(db,anotherCode,view.origin,1008);
    assert.equal(await auth.verifyRecipientOtp(db,anotherToken,view.origin,1009,pepper,delivered!.otp),false);
    await assert.rejects(() => auth.verifyRecipientOtp(db,token,view.origin,10000000,pepper,delivered!.otp));
    assert.equal((await db.prepare("SELECT count(*) AS n FROM access_sessions WHERE scope='recipient' AND subject_id='ana' AND otp_verified_at IS NOT NULL").first())!.n, 1);
    await assert.rejects(() => auth.authorizeRecipientSession(db, token, view.origin, 10000000));
    await db.prepare("UPDATE tasks SET status='ACTIVE' WHERE id='marcus'").run();
    const marcusCode = await auth.issueRecipientCode(db, {...view, taskId:'marcus'});
    const marcusToken = await auth.exchangeRecipientCode(db, marcusCode, view.origin, 1001);
    let marcusOtp = '';
    await auth.sendRecipientOtp(db, marcusToken, view.origin, 1002, pepper, async (_email, otp) => { marcusOtp = otp; });
    const wrong = marcusOtp === '999999' ? '999998' : '999999';
    const tries = await Promise.all(Array.from({length: 8}, () => auth.verifyRecipientOtp(db, marcusToken, view.origin, 1003, pepper, wrong)));
    assert.deepEqual(tries, Array(8).fill(false));
    assert.equal((await db.prepare("SELECT attempts FROM otp_challenges WHERE task_id='marcus'").first())!.attempts, 5);
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
    for (const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0005_access.sql','0006_otp_challenges.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    await db.exec(`INSERT INTO tenants (id) VALUES ('a');
INSERT INTO templates VALUES ('t','a','source','["ana"]',1);
INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('e','a','t','IN_PROGRESS',1,'hash');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('ana','e','ana','Ana','ana@example.com',1,'ACTIVE');
`);
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
    // Only the session that entered the task's latest code is verified: the earlier one no longer is.
    const hashOf=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
    const verified=(await db.prepare("SELECT token_hash FROM access_sessions WHERE scope='recipient' AND subject_id='ana' AND otp_verified_at IS NOT NULL").all<{token_hash:string}>()).results;
    assert.deepEqual(verified.map(v=>v.token_hash),[await hashOf(reentryToken)]);
    assert.notEqual(verified[0].token_hash, await hashOf(nextToken));
  } finally { await mf.dispose(); }
});

test('OTP sends: 60 seconds apart, 3 per 15-minute window per task across sessions, never exceeded concurrently, and a code is used once', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0005_access.sql','0006_otp_challenges.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    await db.exec(`INSERT INTO tenants (id) VALUES ('a');
INSERT INTO templates VALUES ('t','a','source','["ana"]',1);
INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('e','a','t','IN_PROGRESS',1,'hash');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('ana','e','ana','Ana','ana@example.com',1,'ACTIVE');
`);
    const origin='https://host.example.com', pepper=new TextEncoder().encode('local-test-pepper-at-least-32-bytes'), t0=1000;
    const open=async(now:number)=>auth.exchangeRecipientCode(db,await auth.issueRecipientCode(db,{tenantId:'a',envelopeId:'e',taskId:'ana',origin,now}),origin,now);
    const codes: string[] = [];
    const send=(token:string,now:number)=>auth.sendRecipientOtp(db,token,origin,now,pepper,async (_email:string,otp:string) => { codes.push(otp); });
    const row=async()=>(await db.prepare("SELECT sends,attempts,window_started_at,last_sent_at,used_at FROM otp_challenges WHERE task_id='ana'").first<{sends:number;attempts:number;window_started_at:number;last_sent_at:number;used_at:number|null}>())!;
    const first=await open(t0);
    await send(first,t0);
    await assert.rejects(()=>send(first,t0+59_999),'a second send within 60 seconds is refused');
    await send(first,t0+60_000);
    assert.equal(await auth.verifyRecipientOtp(db,first,origin,t0+60_001,pepper,codes[0]),false,'a resend replaces the earlier code');
    // Five sends at once, from two sessions of the task: only one fits the budget (the third send).
    const second=await open(t0+120_000);
    const racing=await Promise.allSettled([first,second,first,second,first].map(token=>send(token,t0+120_000)));
    assert.equal(racing.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await row()).sends,3);
    // The budget is the task's: a new session does not reset it, even after the cooldown.
    const third=await open(t0+600_000);
    await assert.rejects(()=>send(third,t0+600_000),'a fourth send in the window is refused');
    assert.deepEqual(await row(),{sends:3,attempts:1,window_started_at:t0,last_sent_at:t0+120_000,used_at:null});
    // Fifteen minutes after the window opened, a send opens a new window with a fresh budget.
    await send(third,t0+900_000);
    assert.deepEqual(await row(),{sends:1,attempts:0,window_started_at:t0+900_000,last_sent_at:t0+900_000,used_at:null});
    const code=codes[codes.length-1];
    const entries=await Promise.all(Array.from({length:4},()=>auth.verifyRecipientOtp(db,third,origin,t0+900_001,pepper,code)));
    assert.deepEqual(entries,[true,true,true,true],'concurrent entries of the right code all succeed');
    assert.equal((await row()).attempts,1,'the code was used once');
    assert.equal((await row()).used_at,t0+900_001);
    await assert.rejects(()=>send(third,t0+961_000),'a code this session entered is not replaced by its own session');
    // Another session may still ask for a code of its own, and entering it moves the verification there.
    const fourth=await open(t0+961_000);
    await send(fourth,t0+961_000);
    assert.equal(await auth.verifyRecipientOtp(db,fourth,origin,t0+961_001,pepper,code),false,'a used code does not verify in another session');
    assert.equal(await auth.verifyRecipientOtp(db,fourth,origin,t0+961_002,pepper,codes[codes.length-1]),true);
    const verified=(await db.prepare("SELECT count(*) AS n FROM access_sessions WHERE scope='recipient' AND subject_id='ana' AND otp_verified_at IS NOT NULL").first<{n:number}>())!.n;
    assert.equal(verified,1,'only the session that entered the latest code is verified');
  } finally { await mf.dispose(); }
});
