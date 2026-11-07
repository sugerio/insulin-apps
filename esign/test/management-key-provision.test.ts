import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const script = new URL('../scripts/prepare_management_key.py', import.meta.url).pathname;
test('offline management key preparation is private and SQL provisions only once', () => {
 const dir=mkdtempSync(join(homedir(),'esign-key-test-'));
 try {
  const run=()=>spawnSync('python3',[script,dir,'tenant_test'],{encoding:'utf8'});
  const result=run(); assert.equal(result.status,0, result.stderr); assert.equal(result.stdout,'');
  const token=readFileSync(join(dir,'management-key'),'utf8');
  const sql=readFileSync(join(dir,'management-key.sql'),'utf8');
  assert.match(token,/^[A-Za-z0-9_-]{43}$/); assert.equal(statSync(join(dir,'management-key')).mode & 0o777,0o600);
  assert.equal(statSync(join(dir,'management-key.sql')).mode & 0o777,0o600);
  assert.ok(!sql.includes(token)); assert.ok(sql.includes(createHash('sha256').update(token).digest('hex')));
  assert.equal(run().status,1); assert.equal(readFileSync(join(dir,'management-key'),'utf8'),token);
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL); CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id), revoked_at INTEGER);');
  assert.throws(()=>db.exec(sql)); db.exec("INSERT INTO tenants VALUES ('tenant_test')"); db.exec(sql);
  assert.throws(()=>db.exec(sql)); db.exec('UPDATE api_keys SET revoked_at=1'); assert.throws(()=>db.exec(sql));
  assert.equal((db.prepare('SELECT count(*) AS n FROM api_keys').get() as {n:number}).n,1); db.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('rejects unsafe tenant and existing output without overwriting',()=>{
 const dir=mkdtempSync(join(homedir(),'esign-key-test-'));
 try { writeFileSync(join(dir,'management-key.sql'),'keep');
  assert.equal(spawnSync('python3',[script,dir,"x' OR 1=1"],{encoding:'utf8'}).status,1);
  assert.equal(spawnSync('python3',[script,process.cwd(),'tenant_test'],{encoding:'utf8'}).status,1);
  chmodSync(dir,0o755); assert.equal(spawnSync('python3',[script,dir,'tenant_test'],{encoding:'utf8'}).status,1); chmodSync(dir,0o700);
  assert.equal(spawnSync('python3',[script,dir,'tenant_test'],{encoding:'utf8'}).status,1);
  assert.equal(readFileSync(join(dir,'management-key.sql'),'utf8'),'keep');
 } finally {rmSync(dir,{recursive:true,force:true});}
});


test('descriptor swap and cleanup regressions', () => {
 const result=spawnSync('python3',['-m','unittest','discover','-s','test','-p','management_key_prepare_test.py'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
