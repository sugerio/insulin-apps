import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const key = 'synthetic-management-key-0123456789-abcdefghijklmnopqrstuvwxyz';
const hash = async (s:string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))), b=>b.toString(16).padStart(2,'0')).join('');

test('private management issues tenant-bound one-use view codes using database time, without opening recipient routes', async () => {
  const built=await build({entryPoints:['src/candidate-worker.ts'],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']});
  const mf=new Miniflare({workers:[
    {name:'caller',modules:true,script:'export default {fetch(r,e){return e.M.fetch(r)}}',serviceBindings:{M:{name:'candidate',entrypoint:'PrivateManagement'}}},
    {name:'candidate',modules:true,script:built.outputFiles[0].text,bindings:{TEST_ISSUANCE_WINDOW_MS:'60000',TEST_ISSUANCE_TENANT_LIMIT:'50',TEST_ISSUANCE_DATABASE_LIMIT:'50',TEST_OUTSTANDING_TENANT_LIMIT:'50',TEST_OUTSTANDING_DATABASE_LIMIT:'50'},d1Databases:['DB']}
  ]});
  try {
    const db=await mf.getD1Database('DB','candidate');
    await db.exec(`CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY,tenant_id TEXT,revoked_at INTEGER); CREATE TABLE recipient_page_sessions (token_hash TEXT PRIMARY KEY); CREATE TABLE recipient_page_codes (code_hash TEXT PRIMARY KEY,tenant_id TEXT,envelope_id TEXT,task_id TEXT,origin TEXT,expires_at INTEGER,used_at INTEGER); CREATE TABLE editor_sessions (token_hash TEXT); CREATE TABLE editor_page_tokens (token_hash TEXT); CREATE TABLE editor_codes (code_hash TEXT); CREATE TABLE editor_page_entries (code_hash TEXT); CREATE TABLE envelopes (id TEXT PRIMARY KEY,tenant_id TEXT,status TEXT); CREATE TABLE tasks (id TEXT PRIMARY KEY,envelope_id TEXT,status TEXT); CREATE TABLE tenant_page_origins (tenant_id TEXT,origin TEXT);`);
    await db.exec(`CREATE TABLE recipient_code_revocations (code_hash TEXT PRIMARY KEY,revoked_at INTEGER); CREATE TABLE candidate_issuance_budgets (scope TEXT,scope_id TEXT,started_at INTEGER,window_ms INTEGER,issue_limit INTEGER,outstanding_limit INTEGER,issue_count INTEGER,reservation TEXT,PRIMARY KEY(scope,scope_id)); CREATE TABLE recipient_auth_assertions (ok INTEGER CHECK(ok=1));`);
    await db.prepare('INSERT INTO api_keys VALUES (?, ?, NULL)').bind(await hash(key),'tenant-a').run();
    await db.exec("INSERT INTO envelopes VALUES ('e1','tenant-a','IN_PROGRESS'),('e2','tenant-b','IN_PROGRESS'); INSERT INTO tasks VALUES ('t1','e1','ACTIVE'),('t2','e2','ACTIVE'),('t3','e1','PENDING'); INSERT INTO tenant_page_origins VALUES ('tenant-a','https://host.example.com'),('tenant-b','https://host.example.com');");
    const call=(path:string,body:unknown,auth=key)=>mf.dispatchFetch('https://private.test'+path,{method:'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},body:JSON.stringify(body)});
    const path='/v1/envelopes/e1/tasks/t1/recipient-view';
    const before=Date.now(); const ok=await call(path,{origin:'https://host.example.com'});
    assert.equal(ok.status,200); assert.equal(ok.headers.get('cache-control'),'no-store');
    const data=await ok.json() as {code:string}; assert.match(data.code,/^[a-f0-9]{64}$/);
    const row=await db.prepare('SELECT * FROM recipient_page_codes WHERE code_hash=?').bind(await hash(data.code)).first<any>();
    assert.equal(row.tenant_id,'tenant-a'); assert.equal(row.envelope_id,'e1'); assert.equal(row.task_id,'t1'); assert.equal(row.origin,'https://host.example.com'); assert.equal(row.used_at,null);
    assert.ok(row.expires_at>=before+118000 && row.expires_at<=Date.now()+120000);
    for(const [p,b] of [['/v1/envelopes/e2/tasks/t2/recipient-view',{origin:'https://host.example.com'}],['/v1/envelopes/e1/tasks/t2/recipient-view',{origin:'https://host.example.com'}],['/v1/envelopes/e1/tasks/t3/recipient-view',{origin:'https://host.example.com'}],[path,{origin:'https://evil.example.com'}],[path,{origin:'https://host.example.com',now:0}]] as const) assert.notEqual((await call(p,b)).status,200);
    assert.equal((await call(path,{origin:'https://host.example.com'},data.code)).status,401);
    await db.prepare('INSERT INTO editor_sessions VALUES (?)').bind(await hash(key)).run(); assert.equal((await call(path,{origin:'https://host.example.com'})).status,401);
    await db.exec('DELETE FROM editor_sessions');
    await db.exec("UPDATE envelopes SET status='COMPLETED' WHERE id='e1'"); assert.notEqual((await call(path,{origin:'https://host.example.com'})).status,200);
    await db.exec("UPDATE envelopes SET status='IN_PROGRESS' WHERE id='e1'");
    assert.equal((await call(path,{origin:'https://host.example.com',padding:'x'.repeat(5000)})).status,400);
    await db.prepare('UPDATE api_keys SET revoked_at=1').run(); assert.equal((await call(path,{origin:'https://host.example.com'})).status,401);
    const publicWorker=await mf.getWorker('candidate'); assert.equal((await publicWorker.fetch('https://candidate.test'+path,{method:'POST'})).status,404);
    assert.equal((await call('/v1/page-sessions/exchange',{code:data.code,origin:'https://host.example.com'})).status,404);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_page_codes').first<any>()).n,1);
  } finally { await mf.dispose(); }
});
