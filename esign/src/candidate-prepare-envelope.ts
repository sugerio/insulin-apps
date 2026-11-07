import {managementCredential} from './candidate-recovery-authorization.ts';
import {putCandidatePreparationObject} from './candidate-preparation-object.ts';

type Env = {DB:D1Database; ARTIFACTS:R2Bucket};

/** Candidate preparation; the D1 transition rechecks authority and observed facts. */
export async function prepareCandidateEnvelope(env:Env, token:string, envelopeId:string):Promise<void> {
 if(!/^[A-Za-z0-9_-]{32,256}$/.test(token) || !/^[A-Za-z0-9_-]{1,128}$/.test(envelopeId)) throw new Error('Invalid request');
 const keyHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),v=>v.toString(16).padStart(2,'0')).join('');
 const db=env.DB;
 const facts=await db.prepare(`SELECT e.tenant_id,e.template_id,s.object_key,s.sha256,t.roles_json,t.fields_json,e.status FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id JOIN candidate_envelope_sources s ON s.envelope_id=e.id JOIN templates t ON t.id=e.template_id AND t.tenant_id=e.tenant_id AND t.object_key=s.object_key JOIN candidate_template_snapshots snap ON snap.envelope_id=e.id AND snap.roles_json=t.roles_json AND snap.fields_json=t.fields_json WHERE ${managementCredential} AND e.id=? AND e.status IN ('PROCESSING','IN_PROGRESS')`).bind(keyHash,envelopeId).first<{tenant_id:string;template_id:string;object_key:string;sha256:string;roles_json:string;fields_json:string;status:string}>();
 if(!facts) throw new Error('Unavailable');
 const tasks=(await db.prepare('SELECT id,role,recipient_name,recipient_email,routing_order,status FROM tasks WHERE envelope_id=? ORDER BY routing_order').bind(envelopeId).all<{id:string;role:string;recipient_name:string;recipient_email:string;routing_order:number;status:string}>()).results;
 if(tasks.length!==2 || tasks.some((t,i)=>t.routing_order!==i+1 || t.status!==(facts.status==='IN_PROGRESS' && i===0?'ACTIVE':'PENDING'))) throw new Error('Invalid tasks');
 const snapshot=JSON.stringify({tenant_id:facts.tenant_id,template_id:facts.template_id,object_key:facts.object_key,sha256:facts.sha256,roles_json:facts.roles_json,fields_json:facts.fields_json,tasks:tasks.map(({status,...task})=>task)});
 const taskSnapshot=JSON.stringify(tasks.map(({status,...task})=>task));
 const source=await env.ARTIFACTS.get(facts.object_key);if(!source || source.size<1 || source.size>5*1024*1024) throw new Error('Source unavailable');
 const key=`envelopes/${envelopeId}/d0.pdf`;
 const sourceBytes=new Uint8Array(await source.arrayBuffer());
 const hash=async(bytes:ArrayBuffer|Uint8Array<ArrayBuffer>)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 if(await hash(sourceBytes)!==facts.sha256)throw new Error('Source unavailable');
 if(facts.status==='PROCESSING')await putCandidatePreparationObject(env.ARTIFACTS,key,sourceBytes,facts.sha256);
 else {const object=await env.ARTIFACTS.get(key);if(!object||object.size<1||object.size>5*1024*1024||await hash(await object.arrayBuffer())!==facts.sha256)throw new Error('Artifact unavailable');}
 const guard=(status:string,firstStatus:string)=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id JOIN candidate_envelope_sources s ON s.envelope_id=e.id JOIN templates t ON t.id=e.template_id AND t.tenant_id=e.tenant_id JOIN candidate_template_snapshots snap ON snap.envelope_id=e.id AND snap.roles_json=t.roles_json AND snap.fields_json=t.fields_json WHERE ${managementCredential} AND e.id=? AND e.tenant_id=? AND e.template_id=? AND e.status=? AND s.object_key=? AND s.sha256=? AND t.object_key=? AND t.roles_json=? AND t.fields_json=?) AND EXISTS (SELECT 1 FROM candidate_provision_task_snapshots WHERE envelope_id=? AND tasks_json=?) AND (SELECT count(*) FROM tasks WHERE envelope_id=?)=2 AND EXISTS (SELECT 1 FROM tasks WHERE envelope_id=? AND id=? AND role=? AND recipient_name=? AND recipient_email=? AND routing_order=1 AND status=?) AND EXISTS (SELECT 1 FROM tasks WHERE envelope_id=? AND id=? AND role=? AND recipient_name=? AND recipient_email=? AND routing_order=2 AND status='PENDING') THEN 1 ELSE 0 END`).bind(keyHash,envelopeId,facts.tenant_id,facts.template_id,status,facts.object_key,facts.sha256,facts.object_key,facts.roles_json,facts.fields_json,envelopeId,taskSnapshot,envelopeId,envelopeId,tasks[0].id,tasks[0].role,tasks[0].recipient_name,tasks[0].recipient_email,firstStatus,envelopeId,tasks[1].id,tasks[1].role,tasks[1].recipient_name,tasks[1].recipient_email);
 const replayGuard=()=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM candidate_preparation_snapshots WHERE envelope_id=? AND facts_json=?) AND EXISTS (SELECT 1 FROM artifacts WHERE id=? AND envelope_id=? AND object_key=? AND sha256=?) THEN 1 ELSE 0 END`).bind(envelopeId,snapshot,`d0:${envelopeId}`,envelopeId,key,facts.sha256);
 if(facts.status==='IN_PROGRESS'){await db.batch([guard('IN_PROGRESS','ACTIVE'),replayGuard(),db.prepare('DELETE FROM recipient_auth_assertions')]);return;}
 try {await db.batch([guard('PROCESSING','PENDING'),db.prepare('INSERT INTO candidate_preparation_snapshots VALUES (?,?)').bind(envelopeId,snapshot),db.prepare('INSERT INTO artifacts (id,envelope_id,object_key,sha256) VALUES (?,?,?,?)').bind(`d0:${envelopeId}`,envelopeId,key,facts.sha256),db.prepare("UPDATE envelopes SET status='IN_PROGRESS' WHERE id=? AND tenant_id=? AND status='PROCESSING'").bind(envelopeId,facts.tenant_id),db.prepare("UPDATE tasks SET status='ACTIVE' WHERE id=? AND envelope_id=? AND status='PENDING'").bind(tasks[0].id,envelopeId),guard('IN_PROGRESS','ACTIVE'),db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM artifacts WHERE id=? AND envelope_id=? AND object_key=? AND sha256=?) THEN 1 ELSE 0 END`).bind(`d0:${envelopeId}`,envelopeId,key,facts.sha256),replayGuard(),db.prepare('DELETE FROM recipient_auth_assertions')]);} catch(error) {
  const current=await db.prepare('SELECT status FROM envelopes WHERE id=?').bind(envelopeId).first<{status:string}>();
  if(current?.status==='IN_PROGRESS')return prepareCandidateEnvelope(env,token,envelopeId);
  throw error;
 }
}
