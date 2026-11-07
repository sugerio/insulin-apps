import {candidateRecipientSessionValid} from './candidate-recipient-access.ts';
import {issueCandidateEditorSession,exchangeCandidateEditorSession,authorizeCandidateEditorSession} from './candidate-editor-session.ts';
import {readCandidateUpload} from './candidate-upload-body.ts';
import {reserveCandidateTemplateAdmission} from './candidate-template-admission.ts';
import {createCandidateTemplate,candidateTemplatePolicy} from './candidate-create-template.ts';
import {createCandidateEnvelope} from './candidate-provision-envelope.ts';
import {prepareCandidateEnvelope} from './candidate-prepare-envelope.ts';
import {candidateTemplateBinding} from './candidate-template-binding.ts';
import {processCandidatePositionedV3Job} from './candidate-v3-processing.ts';
import {processPositionedV3Job} from './positioned-v3-processing.ts';
import {managementCredential} from './candidate-recovery-authorization.ts';
import {acceptCandidateSignature,CandidateSignError,CandidateRecipientAccessError} from './candidate-sign.ts';
import {CandidateAttemptSlotsExhausted} from './candidate-attempt-slots.ts';
import {signaturePreviewHash} from './positioned-signature-preview.ts';
import {signatureGeometry,assertSignatureGeometrySafe} from './positioned-signature-geometry.ts';
import {assertPositionedV3TextFits,positionedV3TextGeometry} from './positioned-v3-text-fit.ts';
import {validatePositionedPdf,validatePositionedPlacement} from './positioned-template.ts';
import {renderPositionedV3Text} from './positioned-v3-text-render.ts';
import {renderTypedSignature} from './typed-signature-image.ts';
import {PDFDocument} from 'pdf-lib';
import {positionedV3Fields,validatePositionedV3} from './positioned-v3-snapshot.ts';
import {sendIsolatedCloudflareOtp,verifyIsolatedCloudflareOtp} from './isolated-cloudflare-otp.ts';
import { WorkerEntrypoint } from 'cloudflare:workers';

type EditorConfig = { TEST_EDITOR_WINDOW_MS?:string; TEST_EDITOR_TENANT_ISSUANCE?:string; TEST_EDITOR_DATABASE_ISSUANCE?:string; TEST_EDITOR_TENANT_OUTSTANDING?:string; TEST_EDITOR_DATABASE_OUTSTANDING?:string; TEST_EDITOR_TENANT_RETAINED?:string; TEST_EDITOR_DATABASE_RETAINED?:string };
type CandidateEnv = EditorConfig & Parameters<typeof sendIsolatedCloudflareOtp>[0] & { CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS?:string; CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT?:string; CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT?:string; CANDIDATE_TEMPLATE_WINDOW_MS?:string; CANDIDATE_TEMPLATE_TENANT_LIMIT?:string; CANDIDATE_TEMPLATE_DATABASE_LIMIT?:string; CANDIDATE_TEMPLATE_RETAINED_LIMIT?:string; CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT?:string; ARTIFACTS?: R2Bucket; DB?: D1Database; CANDIDATE_PROVISION_WINDOW_MS?: string; CANDIDATE_PROVISION_TENANT_LIMIT?: string; CANDIDATE_PROVISION_DATABASE_LIMIT?: string; CANDIDATE_PROVISION_RETAINED_LIMIT?: string; TEST_ISSUANCE_WINDOW_MS?: string; TEST_ISSUANCE_TENANT_LIMIT?: string; TEST_ISSUANCE_DATABASE_LIMIT?: string; TEST_OUTSTANDING_TENANT_LIMIT?: string; TEST_OUTSTANDING_DATABASE_LIMIT?: string };
// Explicitly experimental configuration: these values are not an approved production policy.
const testIssuancePolicy = (env: CandidateEnv) => {
  const raw = [env.TEST_ISSUANCE_WINDOW_MS, env.TEST_ISSUANCE_TENANT_LIMIT, env.TEST_ISSUANCE_DATABASE_LIMIT, env.TEST_OUTSTANDING_TENANT_LIMIT, env.TEST_OUTSTANDING_DATABASE_LIMIT];
  if (raw.some(v => typeof v !== 'string' || !/^[1-9][0-9]{0,8}$/.test(v))) return null;
  const values = raw.map(Number);
  if (values[0] < 60000 || values[0] > 86400000 || values.slice(1).some(v => v > 100000)) return null;
  return values;
};
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const notFound = () => json({ error: 'not_found' }, 404);
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const digestBytes = async (value: ArrayBuffer) => hex(await crypto.subtle.digest('SHA-256', value));
const digest = async (value: string) => digestBytes(new TextEncoder().encode(value).buffer);


/** The public surface never consults bindings or mounts the local experiment. */
export default {
  fetch(request: Request): Response {
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') return json({ status: 'ok', service: 'esign', mode: 'candidate' });
    return notFound();
  }
};

/** Available only through a named service binding; completion remains unavailable. */
export async function fetchCandidateManagement(request: Request, env: CandidateEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (new URL(request.url).search) return notFound();
    const editorIssue = request.method === 'POST' && path === '/v1/editor-sessions';
    const editorResult = request.method === 'GET' ? /^\/v1\/editor-sessions\/([a-f0-9]{64})\/result$/.exec(path) : null;
    const create = request.method === 'POST' && path === '/v1/envelopes';
    const template = request.method === 'POST' && path === '/v1/templates';
    const prepare = request.method === 'POST' ? /^\/v1\/envelopes\/([A-Za-z0-9_-]{1,128})\/prepare$/.exec(path) : null;
    const me = request.method === 'GET' && path === '/v1/me';
    const taskList = request.method === 'GET' ? /^\/v1\/envelopes\/([A-Za-z0-9_-]{1,128})\/tasks$/.exec(path) : null;
    const issue = request.method === 'POST' ? /^\/v1\/envelopes\/([A-Za-z0-9_-]{1,128})\/tasks\/([A-Za-z0-9_-]{1,128})\/recipient-view$/.exec(path) : null;
    const revoke = request.method === 'POST' ? /^\/v1\/envelopes\/([A-Za-z0-9_-]{1,128})\/tasks\/([A-Za-z0-9_-]{1,128})\/recipient-revoke$/.exec(path) : null;
    const recover = request.method === 'POST' ? /^\/v1\/envelopes\/([A-Za-z0-9_-]{1,128})\/tasks\/([A-Za-z0-9_-]{1,128})\/jobs\/([A-Za-z0-9_-]{1,128})\/recover$/.exec(path) : null;
    const lookup = request.method === 'GET' ? /^\/v1\/envelopes\/([A-Za-z0-9_-]{1,128})\/tasks\/([A-Za-z0-9_-]{1,128})\/job$/.exec(path) : null;
    if (!editorIssue && !editorResult && !template && !create && !prepare && !me && !taskList && !issue && !revoke && !recover && !lookup) return notFound();
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('authorization') ?? '');
    if (!match) return json({ error: 'unauthorized' }, 401);
    try {
      const keyHash = await digest(match[1]);
      if (!env.DB) return json({ error: 'unavailable' }, 503);
      const row = await env.DB.prepare(`SELECT k.tenant_id FROM api_keys k WHERE ${managementCredential}`).bind(keyHash).first<{ tenant_id: string }>();
      if (!row || typeof row.tenant_id !== 'string') return json({ error: 'unauthorized' }, 401);
      if (editorIssue) {
        if(request.headers.get('content-type')!=='application/json') return json({error:'invalid_request'},400);
        const names=['TEST_EDITOR_WINDOW_MS','TEST_EDITOR_TENANT_ISSUANCE','TEST_EDITOR_DATABASE_ISSUANCE','TEST_EDITOR_TENANT_OUTSTANDING','TEST_EDITOR_DATABASE_OUTSTANDING','TEST_EDITOR_TENANT_RETAINED','TEST_EDITOR_DATABASE_RETAINED'] as const;
        const raw=names.map(name=>env[name]);
        if(raw.some(v=>typeof v!=='string'||!/^[1-9][0-9]{0,8}$/.test(v))) return json({error:'unavailable'},503);
        const [windowMs,tenantIssuance,databaseIssuance,tenantOutstanding,databaseOutstanding,tenantRetained,databaseRetained]=raw.map(Number);
        let body:unknown; try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readCandidateUpload(request.body,10000,4096)));} catch{return json({error:'invalid_request'},400);}
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='origin,roles') return json({error:'invalid_request'},400);
        const input=body as {origin:unknown;roles:unknown};
        if(typeof input.origin!=='string'||!Array.isArray(input.roles)) return json({error:'invalid_request'},400);
        try{return json(await issueCandidateEditorSession(env.DB,match[1],input.origin,input.roles,0,{windowMs,tenantIssuance,databaseIssuance,tenantOutstanding,databaseOutstanding,tenantRetained,databaseRetained}));} catch(error){if(error instanceof Error && error.message==='Invalid request')return json({error:'invalid_request'},400);return json({error:'unavailable'},503);}
      }
      if (editorResult) {
        const result=await env.DB.prepare(`SELECT c.template_id FROM api_keys k JOIN candidate_editor_template_bindings b ON b.tenant_id=k.tenant_id JOIN candidate_created_templates c ON c.tenant_id=b.tenant_id AND c.idempotency_key=b.idempotency_key AND c.request_hash=b.request_hash AND c.template_id=b.template_id JOIN templates t ON t.id=c.template_id AND t.tenant_id=c.tenant_id AND t.object_key=c.object_key AND t.roles_json=c.roles_json AND t.fields_json=c.fields_json WHERE ${managementCredential} AND b.page_id=?`).bind(keyHash,editorResult[1]).first<{template_id:string}>();
        return result ? json({templateId:result.template_id}) : notFound();
      }
      if (me) return json({ tenantId: row.tenant_id });
      if (template) {
        if (!env.ARTIFACTS) return json({error:'unavailable'},503);
        await reserveCandidateTemplateAdmission({...env,DB:env.DB},match[1]);
        candidateTemplatePolicy({...env,DB:env.DB,ARTIFACTS:env.ARTIFACTS});
        const key=request.headers.get('idempotency-key') ?? '', type=request.headers.get('content-type') ?? '';
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || !/^multipart\/form-data;\s*boundary=(?:[A-Za-z0-9'()+_,.\/:=?-]{1,70}|"[A-Za-z0-9'()+_,.\/:=?-]{1,70}")$/i.test(type)) return json({error:'invalid_request'},400);
        let bytes: Uint8Array;
        try { bytes=await readCandidateUpload(request.body); }
        catch (error) { return error instanceof Error && error.message==='Upload too large' ? json({error:'body_too_large'},413) : json({error:'invalid_request'},400); }
        const size=bytes.byteLength;
        let form:FormData; try { form=await new Request('https://private.example.test/',{method:'POST',headers:{'content-type':type},body:Uint8Array.from(bytes).buffer}).formData(); } catch {return json({error:'invalid_request'},400);}
        const entries=[...form.entries()]; if(entries.length!==3 || ['file','roles','fields'].some(n=>form.getAll(n).length!==1) || entries.some(([n])=>!['file','roles','fields'].includes(n))) return json({error:'invalid_request'},400);
        const file=form.get('file'),roles=form.get('roles'),fields=form.get('fields');
        if(!(file instanceof File)||file.size<1||file.size>5*1024*1024||size-file.size>65536||typeof roles!=='string'||typeof fields!=='string'||roles.length+fields.length>65536) return json({error:'invalid_request'},400);
        let parsedRoles:unknown,parsedFields:unknown;try {parsedRoles=JSON.parse(roles);parsedFields=JSON.parse(fields);} catch {return json({error:'invalid_request'},400);}
        try{return json(await createCandidateTemplate({...env,DB:env.DB,ARTIFACTS:env.ARTIFACTS},match[1],key,new Uint8Array(await file.arrayBuffer()),parsedRoles,parsedFields));}
        catch(error){if(error instanceof Error && error.message==='Template conflict')return json({error:'conflict'},409);return json({error:'unavailable'},503);}
      }
      if (create || prepare) {
        if (!env.ARTIFACTS) return json({error:'unavailable'},503);
        const reader=request.body?.getReader(); const chunks:Uint8Array[]=[]; let size=0;
        if (reader) for (;;) { const part=await reader.read(); if(part.done) break; size+=part.value.length; if(size>(create?4096:0)){await reader.cancel();return json({error:'invalid_request'},400);} chunks.push(part.value); }
        if (prepare) { await prepareCandidateEnvelope({DB:env.DB,ARTIFACTS:env.ARTIFACTS},match[1],prepare[1]); return json({status:'IN_PROGRESS'}); }
        const key=request.headers.get('idempotency-key') ?? '';
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || request.headers.get('content-type') !== 'application/json') return json({error:'invalid_request'},400);
        let body:unknown; try { const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;} body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { return json({error:'invalid_request'},400); }
        try { return json(await createCandidateEnvelope({...env,DB:env.DB,ARTIFACTS:env.ARTIFACTS},match[1],key,body)); }
        catch(error) { if(error instanceof Error && error.message==='Idempotency conflict') return json({error:'conflict'},409); if(error instanceof Error && (error.message.startsWith('Invalid') || error.message==='Unsupported recipient name for local PDF renderer')) return json({error:'invalid_request'},400); throw error; }
      }

      if (taskList) {
        const tasks = await env.DB.prepare(`SELECT t.id,t.role,t.routing_order FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id JOIN tasks t ON t.envelope_id=e.id WHERE ${managementCredential} AND k.tenant_id=? AND e.id=? ORDER BY t.routing_order,t.id LIMIT 3`).bind(keyHash,row.tenant_id,taskList[1]).all<{id:string;role:string;routing_order:number}>();
        if (!tasks.results.length) return notFound();
        if (tasks.results.length > 2) return json({error:'unavailable'},503);
        return json({tasks:tasks.results.map(t=>({id:t.id,role:t.role,routingOrder:t.routing_order}))});
      }
      if (lookup) {
        const jobs = await env.DB.prepare(`SELECT j.id FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id JOIN tasks t ON t.envelope_id=e.id JOIN signature_records r ON r.envelope_id=e.id AND r.task_id=t.id JOIN signature_jobs j ON j.signature_id=r.id WHERE ${managementCredential} AND k.tenant_id=? AND e.id=? AND t.id=? AND r.sequence IN (1,2) AND j.status IN ('PENDING','DONE') LIMIT 2`).bind(keyHash,row.tenant_id,lookup[1],lookup[2]).all<{id:string}>();
        if (jobs.results.length !== 1) return json({error:'unavailable'},503);
        return json({jobId:jobs.results[0].id});
      }
      if (recover) {
        if (request.body) { const reader=request.body.getReader(); for (;;) { const part=await reader.read(); if (part.done) break; if (part.value.length) { await reader.cancel(); return json({error:'invalid_request'},400); } } }
        if (!env.ARTIFACTS) return json({error:'unavailable'},503);
        await processCandidatePositionedV3Job(env.DB,env.ARTIFACTS,recover[3],{keyHash,tenantId:row.tenant_id,envelopeId:recover[1],taskId:recover[2]});
        return json({status:'PROCESSED_UNSEALED'});
      }
      if (revoke) {
        const db = env.DB;
        const authorized = `SELECT 1 FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id JOIN tasks t ON t.envelope_id=e.id WHERE ${managementCredential} AND e.id=? AND t.id=? AND e.tenant_id=?`;
        await db.batch([
          db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (${authorized}) THEN 1 ELSE 0 END`).bind(keyHash,revoke[1],revoke[2],row.tenant_id),
          db.prepare(`INSERT OR IGNORE INTO recipient_session_revocations(token_hash,revoked_at) SELECT s.token_hash,CAST(unixepoch('subsec')*1000 AS INTEGER) FROM recipient_page_sessions s WHERE s.tenant_id=? AND s.envelope_id=? AND s.task_id=?`).bind(row.tenant_id,revoke[1],revoke[2]),
          db.prepare(`INSERT OR IGNORE INTO recipient_code_revocations(code_hash,revoked_at) SELECT c.code_hash,CAST(unixepoch('subsec')*1000 AS INTEGER) FROM recipient_page_codes c WHERE c.tenant_id=? AND c.envelope_id=? AND c.task_id=? AND c.used_at IS NULL`).bind(row.tenant_id,revoke[1],revoke[2]),
          db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (${authorized}) AND NOT EXISTS (SELECT 1 FROM recipient_page_sessions s WHERE s.tenant_id=? AND s.envelope_id=? AND s.task_id=? AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations r WHERE r.token_hash=s.token_hash)) AND NOT EXISTS (SELECT 1 FROM recipient_page_codes c WHERE c.tenant_id=? AND c.envelope_id=? AND c.task_id=? AND c.used_at IS NULL AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=c.code_hash)) THEN 1 ELSE 0 END`).bind(keyHash,revoke[1],revoke[2],row.tenant_id,row.tenant_id,revoke[1],revoke[2],row.tenant_id,revoke[1],revoke[2]),
          db.prepare('DELETE FROM recipient_auth_assertions')
        ]);
        return new Response(null,{status:204,headers});
      }
      let body: unknown;
      try {
        if (!request.body) throw new Error();
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4096) { await reader.cancel(); throw new Error(); } chunks.push(next.value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch { return json({ error: 'invalid_request' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as {origin?: unknown}).origin !== 'string') return json({ error: 'invalid_request' }, 400);
      const origin = (body as {origin: string}).origin;
      try { const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin || origin.length > 2048) throw new Error(); }
      catch { return json({ error: 'invalid_request' }, 400); }
      const policy = testIssuancePolicy(env);
      if (!policy) return json({ error: 'unavailable' }, 503);
      const [windowMs, tenantLimit, databaseLimit, tenantOutstanding, databaseOutstanding] = policy;
      const code = hex(crypto.getRandomValues(new Uint8Array(32))), codeHash = await digest(code);
      const db = env.DB;
      const reservation = codeHash;
      const budget = (scope: string, id: string, limit: number, outstanding: number) => db.prepare(`INSERT INTO candidate_issuance_budgets (scope,scope_id,started_at,window_ms,issue_limit,outstanding_limit,issue_count,reservation)
        VALUES (?,?,CAST(unixepoch('subsec')*1000 AS INTEGER),?,?,?,1,?)
        ON CONFLICT(scope,scope_id) DO UPDATE SET
          started_at=CASE WHEN candidate_issuance_budgets.started_at+candidate_issuance_budgets.window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) THEN excluded.started_at ELSE candidate_issuance_budgets.started_at END,
          window_ms=excluded.window_ms,issue_limit=excluded.issue_limit,outstanding_limit=excluded.outstanding_limit,
          issue_count=CASE WHEN candidate_issuance_budgets.started_at+candidate_issuance_budgets.window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) THEN 1 ELSE candidate_issuance_budgets.issue_count+1 END,reservation=excluded.reservation
        WHERE candidate_issuance_budgets.started_at+candidate_issuance_budgets.window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER)
          OR (candidate_issuance_budgets.window_ms=excluded.window_ms AND candidate_issuance_budgets.issue_limit=excluded.issue_limit AND candidate_issuance_budgets.outstanding_limit=excluded.outstanding_limit AND candidate_issuance_budgets.issue_count<excluded.issue_limit)`)
        .bind(scope,id,windowMs,limit,outstanding,reservation);
      const result = await db.batch([
        budget('database','shared',databaseLimit,databaseOutstanding), budget('tenant',row.tenant_id,tenantLimit,tenantOutstanding),
        db.prepare(`INSERT INTO recipient_page_codes (code_hash, tenant_id, envelope_id, task_id, origin, expires_at)
        SELECT ?, e.tenant_id, e.id, t.id, o.origin, CAST(strftime('%s','now') AS INTEGER)*1000+120000
        FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id
        JOIN tasks t ON t.envelope_id=e.id JOIN tenant_page_origins o ON o.tenant_id=e.tenant_id AND o.origin=?
        WHERE ${managementCredential} AND e.id=? AND t.id=? AND e.status='IN_PROGRESS' AND t.status='ACTIVE'
        AND EXISTS (SELECT 1 FROM candidate_issuance_budgets WHERE scope='database' AND scope_id='shared' AND reservation=?1)
        AND EXISTS (SELECT 1 FROM candidate_issuance_budgets WHERE scope='tenant' AND scope_id=e.tenant_id AND reservation=?1)
        AND (SELECT COUNT(*) FROM recipient_page_codes c WHERE NOT EXISTS (SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=c.code_hash) AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND used_at IS NULL) < ?6
        AND (SELECT COUNT(*) FROM recipient_page_codes c WHERE NOT EXISTS (SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=c.code_hash) AND tenant_id=e.tenant_id AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND used_at IS NULL) < ?7
        AND (SELECT COUNT(*) FROM recipient_page_codes) < 10000
        AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations WHERE code_hash=?1)
        AND NOT EXISTS (SELECT 1 FROM api_keys WHERE key_hash=?1)
        AND NOT EXISTS (SELECT 1 FROM recipient_page_sessions WHERE token_hash=?1)
        AND NOT EXISTS (SELECT 1 FROM editor_sessions WHERE token_hash=?1)
        AND NOT EXISTS (SELECT 1 FROM editor_page_tokens WHERE token_hash=?1)
        AND NOT EXISTS (SELECT 1 FROM editor_codes WHERE code_hash=?1)
        AND NOT EXISTS (SELECT 1 FROM editor_page_entries WHERE code_hash=?1)`).bind(codeHash, origin, keyHash, issue![1], issue![2],databaseOutstanding,tenantOutstanding),
        db.prepare('INSERT INTO recipient_auth_assertions SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END'),
        db.prepare('DELETE FROM recipient_auth_assertions'),
      ]);
      if (result[2].meta.changes !== 1) return json({ error: 'recipient_unavailable' }, 404);
      return json({ code });
    } catch { return json({ error: 'unavailable' }, 503); }
}

export class PrivateManagement extends WorkerEntrypoint<CandidateEnv> {
  fetch(request: Request): Promise<Response> { return fetchCandidateManagement(request, this.env); }
}

/** Isolated service-binding experiment; this is not a public browser endpoint. */
export async function fetchCandidateRecipient(request: Request, env: CandidateEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !['/v1/page-sessions/exchange','/v1/otp/send','/v1/otp/verify','/v1/document','/v1/fields','/v1/preview','/v1/sign'].includes(path)) return notFound();
    let body: unknown;
    try {
      if (!request.body) throw new Error();
      const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4096) { await reader.cancel(); throw new Error(); } chunks.push(next.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    } catch { return json({error:'invalid_request'}, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({error:'invalid_request'},400);
    if (path === '/v1/sign') {
      try { if(!env.DB || !env.ARTIFACTS) throw new Error(); return json(await acceptCandidateSignature(env.DB,env.ARTIFACTS,body as Record<string,unknown>),202); } catch(error) { if(error instanceof CandidateRecipientAccessError) return json({error:'invalid_session'},401); if(error instanceof CandidateAttemptSlotsExhausted) return json({error:'investigation_required'},409); if(error instanceof CandidateSignError) return json({error:error.status===400?'invalid_request':'conflict'},error.status); return json({error:'unavailable'},503); }
    }
    if (path === '/v1/document' || path === '/v1/fields' || path === '/v1/preview') {
      const {token,origin}=body as {token?:unknown;origin?:unknown};
      const previewInput=body as {fieldId?:unknown;text?:unknown};
      if ((path==='/v1/preview' ? (Object.keys(body).some(k=>!['token','origin','fieldId','text'].includes(k)) || typeof previewInput.fieldId!=='string' || (previewInput.text!==undefined && typeof previewInput.text!=='string')) : Object.keys(body).length!==2) || typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token) || typeof origin!=='string' || origin.length>2048) return json({error:'invalid_request'},400);
      try {
        const url=new URL(origin); if(url.protocol!=='https:' || url.origin!==origin || !env.DB || !env.ARTIFACTS) throw new Error();
        const tokenHash=await digest(token), db=env.DB;
        type CurrentArtifact={id:string;object_key:string;sha256:string;role:string;recipient_name:string;roles_json:string;fields_json:string;envelope_id:string;task_id:string;job_id:string|null;predecessor_task_id:string|null;payload_json:string|null;input_page_count:number|null;consented_at:number|null};
        type DateBinding={fieldId:string;id:string;text:string;imageHash:string;geometryJson:string};
        const currentSql=(date?:DateBinding)=>`SELECT COALESCE(o2.artifact_id,a.id) AS id,COALESCE(o2.object_key,a.object_key) AS object_key,COALESCE(o2.sha256,a.sha256) AS sha256,t.role,t.recipient_name,p.roles_json,p.fields_json,e.id AS envelope_id,t.id AS task_id,j.id AS job_id,r.task_id AS predecessor_task_id,pi.payload_json,pi.input_page_count,r.consented_at FROM recipient_page_sessions s
          JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin
          JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id
          JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id
          JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY
          JOIN artifacts a ON a.envelope_id=e.id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id
          LEFT JOIN signature_records r ON r.envelope_id=e.id AND r.sequence=1
          LEFT JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE'
          LEFT JOIN signature_outputs o2 ON o2.job_id=j.id
          LEFT JOIN positioned_signature_inputs pi ON pi.signature_id=r.id
          WHERE s.token_hash=? AND s.origin=? AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
          AND s.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+900000 AND v.verified_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
          AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND ${candidateTemplateBinding}
          AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations WHERE token_hash=s.token_hash)
          AND NOT EXISTS (SELECT 1 FROM api_keys WHERE key_hash=s.token_hash)
          AND ((r.id IS NULL AND NOT EXISTS (SELECT 1 FROM signature_records WHERE envelope_id=e.id)) OR
            (r.id IS NOT NULL AND j.id IS NOT NULL AND o2.artifact_id IS NOT NULL AND pi.signature_id IS NOT NULL
             AND (SELECT count(*) FROM signature_records WHERE envelope_id=e.id)=1
             AND (SELECT count(*) FROM tasks WHERE envelope_id=e.id)=2
             AND EXISTS (SELECT 1 FROM tasks prior WHERE prior.id=r.task_id AND prior.envelope_id=e.id AND prior.status='SIGNED' AND prior.routing_order<t.routing_order)
             AND NOT EXISTS (SELECT 1 FROM signature_records WHERE task_id=t.id)))
          ${date ? `AND EXISTS (SELECT 1 FROM positioned_v3_date_previews d WHERE d.session_hash=s.token_hash AND d.field_id=? AND d.preview_id=? AND d.date_text=? AND d.date_text=strftime('%Y-%m-%d','now') AND d.image_sha256=? AND d.artifact_id=? AND d.artifact_sha256=? AND d.roles_json=? AND d.fields_json=? AND d.geometry_json=? AND d.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER))` : ''}`;
        const currentArgs=(date?:DateBinding,expected?:CurrentArtifact)=>([tokenHash,origin,...(date && expected ? [date.fieldId,date.id,date.text,date.imageHash,expected.id,expected.sha256,expected.roles_json,expected.fields_json,date.geometryJson] : [])]);
        const current=(date?:DateBinding,expected?:CurrentArtifact)=>db.prepare(currentSql(date)).bind(...currentArgs(date,expected)).first<CurrentArtifact>();
        const artifact=await current(); if(!artifact) return await candidateRecipientSessionValid(db,tokenHash,origin,false) ? json({error:'unavailable'},503) : json({error:'invalid_session'},401);
        const expectedSql=`x.id=? AND x.object_key=? AND x.sha256=? AND x.role=? AND x.recipient_name=? AND x.roles_json=? AND x.fields_json=? AND x.envelope_id=? AND x.task_id=? AND x.job_id IS ? AND x.predecessor_task_id IS ? AND x.payload_json IS ? AND x.input_page_count IS ? AND x.consented_at IS ?`;
        const expectedArgs=()=>[artifact.id,artifact.object_key,artifact.sha256,artifact.role,artifact.recipient_name,artifact.roles_json,artifact.fields_json,artifact.envelope_id,artifact.task_id,artifact.job_id,artifact.predecessor_task_id,artifact.payload_json,artifact.input_page_count,artifact.consented_at];
        if(artifact.job_id){
          if(!artifact.payload_json || artifact.input_page_count===null || artifact.consented_at===null || !artifact.predecessor_task_id) throw new Error();
          const prior=validatePositionedV3(JSON.parse(artifact.payload_json),artifact.input_page_count,artifact.consented_at);
          const roles:unknown=JSON.parse(artifact.roles_json); if(!Array.isArray(roles) || JSON.stringify(positionedV3Fields(JSON.parse(artifact.fields_json),roles,artifact.input_page_count))!==JSON.stringify(prior.templateFields)) throw new Error();
        }
        const file=await env.ARTIFACTS.get(artifact.object_key); if(!file || file.size>5*1024*1024) throw new Error();
        const bytes=await file.arrayBuffer(); if(await digestBytes(bytes)!==artifact.sha256) throw new Error();
        let fields: ReturnType<typeof positionedV3Fields> | undefined;
        let preview: {image: Uint8Array; headers: Record<string,string>} | undefined;
        let dateBinding: {fieldId:string; id:string; text:string; imageHash:string; geometryJson:string} | undefined;
        if(path==='/v1/fields' || path==='/v1/preview') {
          const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true}); const roles:unknown=JSON.parse(artifact.roles_json); if(!Array.isArray(roles) || !roles.includes(artifact.role)) throw new Error();
          const all=positionedV3Fields(JSON.parse(artifact.fields_json),roles,pdf.getPageCount()); fields=all.filter(f=>f.role===artifact.role);
          if(path==='/v1/preview') {
            validatePositionedPdf(pdf); validatePositionedPlacement(pdf,all);
            const field=fields.find(f=>f.id===previewInput.fieldId);
            if(!field || !['Signature','Title','Date signed'].includes(field.type)) throw new Error();
            if(field.type==='Date signed' ? Object.hasOwn(body,'text') : typeof previewInput.text!=='string') throw new Error();
            const text=field.type==='Date signed' ? (await db.prepare("SELECT strftime('%Y-%m-%d','now') AS date_text").first<{date_text:string}>())?.date_text : previewInput.text as string;
            if(!text) throw new Error();
            if(field.type==='Date signed' ? false : field.type==='Signature' ? text.length>64 || !/^[A-Za-z]+(?: [A-Za-z]+)*$/.test(text) : !text || text.length>128 || text.trim()!==text || !/^[\x20-\x7e]+$/.test(text)) throw new Error();
            const image=Uint8Array.from(await (field.type==='Signature'?renderTypedSignature(text):renderPositionedV3Text(text))), page=pdf.getPage(field.page-1);
            const geometry=field.type==='Signature'?signatureGeometry(page,field,image):positionedV3TextGeometry(page,field,image);
            if(field.type==='Signature') assertSignatureGeometrySafe(page,field,geometry,all); else assertPositionedV3TextFits(page,field,image);
            const key=field.type==='Signature'?'Signature':'Text';
            const imageHash=await digestBytes(image.buffer);
            const previewHeaders:Record<string,string>={'Content-Type':'image/png',[`X-${key}-Width`]:String(geometry.width/(field.rect.width*page.getWidth())),[`X-${key}-Height`]:String(geometry.height/(field.rect.height*page.getHeight()))};
            if(field.type==='Date signed') {
              const geometryJson=JSON.stringify(geometry), id=crypto.randomUUID();
              const same=`positioned_v3_date_previews.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND positioned_v3_date_previews.date_text=excluded.date_text AND positioned_v3_date_previews.image_sha256=excluded.image_sha256 AND positioned_v3_date_previews.artifact_id=excluded.artifact_id AND positioned_v3_date_previews.artifact_sha256=excluded.artifact_sha256 AND positioned_v3_date_previews.roles_json=excluded.roles_json AND positioned_v3_date_previews.fields_json=excluded.fields_json AND positioned_v3_date_previews.geometry_json=excluded.geometry_json`;
              const saved=await db.prepare(`INSERT INTO positioned_v3_date_previews(session_hash,field_id,preview_id,date_text,image_sha256,artifact_id,artifact_sha256,roles_json,fields_json,expires_at,geometry_json)
                SELECT s.token_hash,?,?,?,?,?,?,?,?,MIN(s.expires_at,CAST(unixepoch('subsec')*1000 AS INTEGER)+300000),? FROM recipient_page_sessions s JOIN (${currentSql()}) x ON s.token_hash=?
                WHERE ${expectedSql} AND ?=strftime('%Y-%m-%d','now')
                ON CONFLICT(session_hash,field_id) DO UPDATE SET preview_id=CASE WHEN ${same} THEN positioned_v3_date_previews.preview_id ELSE excluded.preview_id END,date_text=excluded.date_text,image_sha256=excluded.image_sha256,artifact_id=excluded.artifact_id,artifact_sha256=excluded.artifact_sha256,roles_json=excluded.roles_json,fields_json=excluded.fields_json,expires_at=CASE WHEN ${same} THEN MIN(positioned_v3_date_previews.expires_at,excluded.expires_at) ELSE excluded.expires_at END,geometry_json=excluded.geometry_json RETURNING preview_id`).bind(field.id,id,text,imageHash,artifact.id,artifact.sha256,artifact.roles_json,artifact.fields_json,geometryJson,...currentArgs(),tokenHash,...expectedArgs(),text).first<{preview_id:string}>();
              if(!saved) throw new Error();
              dateBinding={fieldId:field.id,id:saved.preview_id,text,imageHash,geometryJson};
              previewHeaders['X-Date-Preview-Id']=saved.preview_id; previewHeaders['X-Preview-Text']=text;
            } else previewHeaders[`X-${key}-Preview`]=await signaturePreviewHash(artifact.sha256,artifact.roles_json,artifact.fields_json,field.id,text,imageHash,geometry);
            preview={image,headers:previewHeaders};
          }
        }
        // Final preview validation.
        if(artifact.job_id){
          await processPositionedV3Job(db,env.ARTIFACTS,artifact.job_id,undefined,undefined,undefined,{envelopeId:artifact.envelope_id,taskId:artifact.predecessor_task_id!,assertion:()=>db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM (${currentSql(dateBinding)}) x WHERE ${expectedSql}) THEN 1 ELSE 0 END`).bind(...currentArgs(dateBinding,artifact),...expectedArgs())});
        } else {
          const checked=await current(dateBinding,artifact); if(!checked || JSON.stringify(checked)!==JSON.stringify(artifact)) throw new Error();
        }
        if(preview) return new Response(Uint8Array.from(preview.image).buffer,{headers:{...headers,...preview.headers}});
        if(fields) return json({artifactId:artifact.id,artifactHash:artifact.sha256,role:artifact.role,recipientName:artifact.recipient_name,fields});
        return new Response(bytes,{headers:{...headers,'Content-Type':'application/pdf'}});
      } catch { return json({error:'unavailable'},503); }
    }
    if (path !== '/v1/page-sessions/exchange') {
      const data=body as {token?:unknown;origin?:unknown;otp?:unknown};
      if (Object.keys(body).length !== (path==='/v1/otp/send'?2:3) || typeof data.token!=='string' || typeof data.origin!=='string' || (path==='/v1/otp/verify' && typeof data.otp!=='string')) return json({error:'invalid_request'},400);
      try {
        if(path==='/v1/otp/send') { await sendIsolatedCloudflareOtp(env,data.token,data.origin); return new Response(null,{status:204,headers}); }
        return await verifyIsolatedCloudflareOtp(env,data.token,data.origin,data.otp as string) ? new Response(null,{status:204,headers}) : json({error:'invalid_otp'},401);
      } catch { return json({error:'unavailable'},503); }
    }
    if (Object.keys(body).length !== 2) return json({error:'invalid_request'},400);
    const {code,origin} = body as {code?:unknown;origin?:unknown};
    if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code) || typeof origin !== 'string' || origin.length > 2048) return json({error:'invalid_request'},400);
    try { const url = new URL(origin); if (url.protocol !== 'https:' || url.origin !== origin) throw new Error(); } catch { return json({error:'invalid_request'},400); }
    if (!env.DB) return json({error:'unavailable'},503);
    try {
      const codeHash = await digest(code), token = hex(crypto.getRandomValues(new Uint8Array(32))), tokenHash = await digest(token), db = env.DB;
      const result = await db.batch([
        db.prepare(`INSERT INTO recipient_page_sessions (token_hash,tenant_id,envelope_id,task_id,origin,expires_at)
          SELECT ?1,c.tenant_id,c.envelope_id,c.task_id,c.origin,CAST(unixepoch('subsec')*1000 AS INTEGER)+900000
          FROM recipient_page_codes c JOIN envelopes e ON e.id=c.envelope_id AND e.tenant_id=c.tenant_id
          JOIN tasks t ON t.id=c.task_id AND t.envelope_id=e.id JOIN tenant_page_origins o ON o.tenant_id=c.tenant_id AND o.origin=c.origin
          WHERE c.code_hash=?2 AND c.origin=?3 AND c.used_at IS NULL AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=c.code_hash) AND c.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
          AND e.status='IN_PROGRESS' AND t.status='ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM api_keys WHERE key_hash IN (?1,?2))
          AND NOT EXISTS (SELECT 1 FROM recipient_page_codes WHERE code_hash=?1)
          AND NOT EXISTS (SELECT 1 FROM recipient_page_sessions WHERE token_hash IN (?1,?2))
          AND NOT EXISTS (SELECT 1 FROM editor_sessions WHERE token_hash IN (?1,?2))
          AND NOT EXISTS (SELECT 1 FROM editor_page_tokens WHERE token_hash IN (?1,?2))
          AND NOT EXISTS (SELECT 1 FROM editor_codes WHERE code_hash IN (?1,?2))
          AND NOT EXISTS (SELECT 1 FROM editor_page_entries WHERE code_hash IN (?1,?2))`).bind(tokenHash,codeHash,origin),
        db.prepare(`UPDATE recipient_page_codes SET used_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE code_hash=? AND used_at IS NULL AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=recipient_page_codes.code_hash) AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND EXISTS (SELECT 1 FROM recipient_page_sessions WHERE token_hash=?)`).bind(codeHash,tokenHash),
        db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM recipient_page_sessions WHERE token_hash=?) AND (changes()<>1 OR EXISTS (SELECT 1 FROM recipient_session_revocations WHERE token_hash=?) OR EXISTS (SELECT 1 FROM recipient_code_revocations WHERE code_hash=?)) THEN 0 ELSE 1 END`).bind(tokenHash,tokenHash,codeHash),
        db.prepare('DELETE FROM recipient_auth_assertions'),
      ]);
      if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1) return json({error:'invalid_code'},401);
      return json({token});
    } catch { return json({error:'unavailable'},503); }
}

export class PrivateRecipient extends WorkerEntrypoint<CandidateEnv> {
  fetch(request: Request): Promise<Response> { return fetchCandidateRecipient(request, this.env); }
}

/** Candidate browser protocol; legacy editor routes remain unavailable. */
export async function fetchCandidateEditor(request: Request, env: CandidateEnv): Promise<Response> {
  const url=new URL(request.url), exchange=url.pathname==='/v1/editor-sessions/exchange', context=url.pathname==='/v1/editor-sessions/context', save=url.pathname==='/v1/editor-sessions/save';
  if(request.method!=='POST'||url.search||(!exchange&&!context&&!save))return notFound();
  if(!env.DB)return json({error:'unavailable'},503);
  if(save) {
   if(request.headers.has('authorization'))return json({error:'invalid_request'},400);
   const token=request.headers.get('x-editor-token') ?? '', origin=request.headers.get('origin') ?? '', key=request.headers.get('idempotency-key') ?? '', type=request.headers.get('content-type') ?? '';
   if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))return json({error:'invalid_session'},401);
   let session:Awaited<ReturnType<typeof authorizeCandidateEditorSession>>;
   try {session=await authorizeCandidateEditorSession(env.DB,token,origin,0);} catch {return json({error:'invalid_session'},401);}
   if(!env.ARTIFACTS)return json({error:'unavailable'},503);
   const credential={kind:'editor' as const,token,origin};
   try {await reserveCandidateTemplateAdmission({...env,DB:env.DB},credential);candidateTemplatePolicy({...env,DB:env.DB,ARTIFACTS:env.ARTIFACTS});} catch{return json({error:'unavailable'},503);}
   if(!/^[A-Za-z0-9_-]{1,128}$/.test(key)||!/^multipart\/form-data;\s*boundary=(?:[A-Za-z0-9'()+_,.\/:=?-]{1,70}|"[A-Za-z0-9'()+_,.\/:=?-]{1,70}")$/i.test(type))return json({error:'invalid_request'},400);
   let bytes:Uint8Array;try {bytes=await readCandidateUpload(request.body);} catch(error){return error instanceof Error && error.message==='Upload too large'?json({error:'body_too_large'},413):json({error:'invalid_request'},400);}
   let form:FormData;try {form=await new Request('https://private.example.test/',{method:'POST',headers:{'content-type':type},body:Uint8Array.from(bytes).buffer}).formData();} catch{return json({error:'invalid_request'},400);}
   const entries=[...form.entries()];if(entries.length!==2||['file','fields'].some(n=>form.getAll(n).length!==1)||entries.some(([n])=>!['file','fields'].includes(n)))return json({error:'invalid_request'},400);
   const file=form.get('file'),fields=form.get('fields');if(!(file instanceof File)||file.size<1||file.size>5*1024*1024||bytes.byteLength-file.size>65536||typeof fields!=='string'||fields.length>65536)return json({error:'invalid_request'},400);
   let parsed:unknown;try {parsed=JSON.parse(fields);} catch{return json({error:'invalid_request'},400);}
   try {return json(await createCandidateTemplate({...env,DB:env.DB,ARTIFACTS:env.ARTIFACTS},credential,key,new Uint8Array(await file.arrayBuffer()),session.roles,parsed));} catch(error){if(error instanceof Error && error.message==='Template conflict')return json({error:'conflict'},409);return json({error:'unavailable'},503);}
  }
  if(request.headers.has('authorization')||request.headers.get('content-type')!=='application/json')return json({error:'invalid_request'},400);
  let body:unknown;try {body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readCandidateUpload(request.body,10000,4096)));}catch{return json({error:'invalid_request'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'invalid_request'},400);
  const data=body as Record<string,unknown>;
  if(Object.keys(data).sort().join(',')!==(exchange?'code,origin,pageId':'origin,token') || typeof data.origin!=='string')return json({error:'invalid_request'},400);
  if(exchange && (typeof data.pageId!=='string'||typeof data.code!=='string') || context && typeof data.token!=='string')return json({error:'invalid_request'},400);
  try {
   if(exchange)return json({token:await exchangeCandidateEditorSession(env.DB,data.pageId as string,data.code as string,data.origin,0)});
   return json(await authorizeCandidateEditorSession(env.DB,data.token as string,data.origin,0));
  }catch{return json({error:'invalid_session'},401);}
}

export class PrivateEditor extends WorkerEntrypoint<CandidateEnv> {
  fetch(request: Request): Promise<Response> { return fetchCandidateEditor(request, this.env); }
}
