import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const key='synthetic-management-key-0123456789-abcdefghijklmnopqrstuvwxyz';
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
test('candidate issuance retains code evidence and fails closed at its bound',async()=>{
 const built=await build({entryPoints:['src/candidate-worker.ts'],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']});
 const mf=new Miniflare({workers:[{name:'caller',modules:true,script:'export default {fetch(r,e){return e.M.fetch(r)}}',serviceBindings:{M:{name:'candidate',entrypoint:'PrivateManagement'}}},{name:'candidate',modules:true,script:built.outputFiles[0].text,d1Databases:['DB'],bindings:{TEST_ISSUANCE_WINDOW_MS:'60000',TEST_ISSUANCE_TENANT_LIMIT:'3',TEST_ISSUANCE_DATABASE_LIMIT:'4',TEST_OUTSTANDING_TENANT_LIMIT:'2',TEST_OUTSTANDING_DATABASE_LIMIT:'3'}}]});
 try {
  const db=await mf.getD1Database('DB','candidate');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(s=>db.prepare(s)));
  await db.exec("INSERT INTO tenants VALUES ('a'),('b'); INSERT INTO templates VALUES ('p','a','src','[\"ana\"]',1,'[]'),('q','b','src2','[\"ana\"]',1,'[]'); INSERT INTO envelopes VALUES ('e','a','p','IN_PROGRESS',1),('f','b','q','IN_PROGRESS',1); INSERT INTO tasks VALUES ('t','e','ana','Ana','ana@example.com',1,'ACTIVE'),('u','f','ana','Ana','ana@example.com',1,'ACTIVE'); INSERT INTO tenant_page_origins VALUES ('a','https://host.example.com'),('b','https://host.example.com');");
  const key2=key+'-b'; for(const [k,t] of [[key,'a'],[key2,'b']]) await db.prepare('INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?,?,NULL)').bind(await hash(k),t).run();
  const call=(k=key,e='e',t='t')=>mf.dispatchFetch(`https://caller.test/v1/envelopes/${e}/tasks/${t}/recipient-view`,{method:'POST',headers:{authorization:`Bearer ${k}`,'content-type':'application/json'},body:JSON.stringify({origin:'https://host.example.com'})});
  await db.exec("INSERT INTO candidate_issuance_budgets VALUES ('database','shared',CAST(unixepoch('subsec')*1000 AS INTEGER),60000,5,3,1,'older')");
  assert.equal((await call()).status,503, 'changed live policy fails closed');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM candidate_issuance_budgets WHERE scope='tenant'").first<any>())!.n,0);
  await db.exec('DELETE FROM candidate_issuance_budgets');
  const rs=await Promise.all(Array.from({length:8},()=>call())); assert.equal(rs.filter(r=>r.status===200).length,2);
  // Discarding successful responses does not release their slots or issuance budget.
  assert.notEqual((await call()).status,200);
  assert.equal((await call(key2,'f','u')).status,200); assert.notEqual((await call(key2,'f','u')).status,200);
  await db.exec("INSERT INTO recipient_code_revocations SELECT code_hash,1 FROM recipient_page_codes WHERE tenant_id='a'");
  assert.equal((await call()).status,200,'revoked unused codes release outstanding capacity');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM recipient_page_codes c JOIN recipient_code_revocations r ON r.code_hash=c.code_hash WHERE c.used_at IS NULL").first<any>())!.n,2);
  await db.exec("UPDATE candidate_issuance_budgets SET issue_count=2 WHERE scope='tenant' AND scope_id='a'; UPDATE candidate_issuance_budgets SET issue_count=3 WHERE scope='database'; UPDATE recipient_page_codes SET expires_at=0 WHERE tenant_id='a'");
  assert.equal((await call()).status,200); assert.notEqual((await call()).status,200);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM recipient_page_codes WHERE expires_at=0').first<any>())!.n,3, 'expired revoked codes retain tenant and task association');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM recipient_page_codes c JOIN recipient_code_revocations r ON r.code_hash=c.code_hash WHERE c.tenant_id='a' AND c.envelope_id='e' AND c.task_id='t' AND c.expires_at=0 AND c.used_at IS NULL").first<any>())!.n,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM recipient_page_codes WHERE expires_at>0').first<any>())!.n,2);
  const counts=await db.prepare('SELECT scope,issue_count FROM candidate_issuance_budgets ORDER BY scope,scope_id').all<any>();
  assert.deepEqual(counts.results.map(r=>r.issue_count),[4,3,1]);
  await db.exec('UPDATE candidate_issuance_budgets SET started_at=0');
  await db.exec("UPDATE recipient_page_codes SET used_at=1 WHERE tenant_id='a'");
  assert.equal((await call()).status,200, 'expired budget window resets; used unexpired codes do not occupy outstanding slots');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM recipient_page_codes WHERE used_at=1 AND expires_at>0").first<any>())!.n,1, 'cleanup retains unexpired used codes');
  await db.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<120) INSERT INTO recipient_page_codes SELECT 'expired-'||x,'a','e','t','https://host.example.com',0,NULL FROM n");
  await db.exec('UPDATE candidate_issuance_budgets SET started_at=0');
  assert.equal((await call()).status,200);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM recipient_page_codes WHERE expires_at=0').first<any>())!.n,123, 'expired codes are retained, including revocation evidence');
  await db.exec("UPDATE recipient_page_codes SET used_at=1 WHERE tenant_id='a' AND expires_at>0; UPDATE recipient_page_codes SET used_at=42 WHERE code_hash='expired-1'");
  await db.exec('UPDATE candidate_issuance_budgets SET started_at=0');
  assert.equal((await call()).status,200);
  assert.deepEqual(await db.prepare("SELECT tenant_id,envelope_id,task_id,used_at FROM recipient_page_codes WHERE code_hash='expired-1'").first(),{tenant_id:'a',envelope_id:'e',task_id:'t',used_at:42});
  const existing=(await db.prepare('SELECT COUNT(*) n FROM recipient_page_codes').first<any>())!.n;
  await db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO recipient_page_codes SELECT 'cap-'||x,'a','e','t','https://host.example.com',0,NULL FROM n").bind(9999-existing).run();
  await db.exec("UPDATE recipient_page_codes SET used_at=1 WHERE expires_at>0; UPDATE candidate_issuance_budgets SET started_at=0");
  const atCap=await Promise.all(Array.from({length:4},()=>call()));
  assert.equal(atCap.filter(r=>r.status===200).length,1,'concurrent issuance cannot exceed the retained-code cap');
  const beforeCap=await db.prepare('SELECT COUNT(*) n FROM recipient_page_codes').first<any>();
  assert.equal(beforeCap!.n,10000);
  const budgetAtCap=(await db.prepare('SELECT * FROM candidate_issuance_budgets ORDER BY scope,scope_id').all()).results;
  assert.notEqual((await call()).status,200,'retained-code cap fails closed');
  assert.deepEqual((await db.prepare('SELECT * FROM candidate_issuance_budgets ORDER BY scope,scope_id').all()).results,budgetAtCap,'failed issuance rolls back budget reservations');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM recipient_page_codes').first<any>())!.n,beforeCap!.n);
  // Isolate issue counters from outstanding limits: consume each code after issuance.
  await db.exec('DELETE FROM recipient_page_codes; DELETE FROM candidate_issuance_budgets');
  for(let i=0;i<3;i++){assert.equal((await call()).status,200);await db.exec('UPDATE recipient_page_codes SET used_at=1');}
  assert.notEqual((await call()).status,200,'tenant issue limit blocks while shared issue budget has capacity');
  assert.equal((await call(key2,'f','u')).status,200,'another tenant can use remaining shared capacity');
  await db.exec('UPDATE recipient_page_codes SET used_at=1');
  assert.notEqual((await call(key2,'f','u')).status,200,'shared issue limit blocks while second tenant has capacity');
  const separate=await db.prepare('SELECT scope,scope_id,issue_count FROM candidate_issuance_budgets ORDER BY scope,scope_id').all<any>();
  assert.deepEqual(separate.results.map(r=>r.issue_count),[4,3,1]);
  await db.exec('DROP TABLE candidate_issuance_budgets');
  assert.equal((await call()).status,503, 'missing migration fails closed');
 } finally {await mf.dispose();}
});
