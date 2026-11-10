import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {MIGRATIONS_DIR,splitSql as unstable_splitSqlQuery} from './helpers/platform.ts';

const migration='0001_triggers.sql';
test('Wrangler migration splitter preserves a trigger as one D1 statement',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{const db=await mf.getD1Database('DB');await db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, recipient_email TEXT NOT NULL)');const sql=await readFile(new URL(migration,MIGRATIONS_DIR),'utf8');const statements=unstable_splitSqlQuery(sql).filter(s=>s.includes('immutable_task_recipient_email'));assert.equal(statements.length,1);assert.match(statements[0]!,/^CREATE TRIGGER IF NOT EXISTS immutable_task_recipient_email[\s\S]*END;$/);await db.batch(statements.map(s=>db.prepare(s)));}finally{await mf.dispose();}
});
test('migration preserves existing facts and stops A to B to A while new role-bound tasks work',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');
  const apply=async(name:string)=>{const sql=await readFile(new URL(name,MIGRATIONS_DIR),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));};
  for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')&&n<migration).sort())await apply(name);
  await db.exec(`INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at,fields_json) VALUES ('template','tenant','source','["ana","bob"]',1,'[]'); INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('old','tenant','template','IN_PROGRESS',1,'hash'); INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('a','old','ana','Ana','ana@example.test',1,'ACTIVE'); INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('b','old','bob','Bob','bob@example.test',2,'PENDING');`);
  const before=(await db.prepare('SELECT * FROM tasks ORDER BY id').all()).results;await apply(migration);assert.deepEqual((await db.prepare('SELECT * FROM tasks ORDER BY id').all()).results,before,'migration does not rewrite existing tasks');
  await assert.rejects(()=>db.prepare("UPDATE tasks SET recipient_email='lee@example.test' WHERE id='a'").run());
  await assert.rejects(()=>db.batch([db.prepare("UPDATE tasks SET recipient_email='lee@example.test' WHERE id='a'"),db.prepare("UPDATE tasks SET recipient_email='ana@example.test' WHERE id='a'")]));
  const races=await Promise.allSettled(['lee@example.test','bob@example.test'].map(email=>db.prepare("UPDATE tasks SET recipient_email=? WHERE id='a'").bind(email).run()));assert.ok(races.every(r=>r.status==='rejected'));
  await assert.rejects(()=>db.prepare("UPDATE tasks SET recipient_email='ANA@example.test' WHERE id='a'").run(),'binding is byte exact');
  assert.deepEqual((await db.prepare('SELECT * FROM tasks ORDER BY id').all()).results,before);
  await db.prepare("UPDATE tasks SET recipient_email=recipient_email,status='SIGNED' WHERE id='a'").run();
  await db.exec(`INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('new','tenant','template','IN_PROGRESS',2,'hash'); INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('c','new','ana','Ana','ana@example.test',1,'PENDING'); INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('d','new','bob','Bob','bob@example.test',2,'PENDING');`);
  await assert.rejects(()=>db.prepare("INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('duplicate','new','ana','Other','other@example.test',3,'PENDING')").run());
  assert.deepEqual((await db.prepare("SELECT role,recipient_email FROM tasks WHERE envelope_id='new' ORDER BY routing_order").all()).results,[{role:'ana',recipient_email:'ana@example.test'},{role:'bob',recipient_email:'bob@example.test'}]);
 }finally{await mf.dispose();}
});
