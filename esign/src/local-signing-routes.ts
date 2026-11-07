import {signaturePreviewHash} from './positioned-signature-preview.ts';
import {signatureGeometry,assertSignatureGeometrySafe} from './positioned-signature-geometry.ts';
import { Hono } from 'hono';
import {PDFDocument} from 'pdf-lib';
import {assertPositionedV3TextFits,positionedV3TextGeometry,PositionedV3TextDoesNotFitError} from './positioned-v3-text-fit.ts';
import { bodyLimit } from 'hono/body-limit';
import { issueRecipientCode, exchangeRecipientCode, authorizeRecipientSession, sendRecipientOtp, verifyRecipientOtp } from './page-authorization.ts';
import { recordSignature } from './signature-record.ts';
import { recordPositionedSignature } from './positioned-signature-record.ts';
import { assertNoOverlappingFields } from './template-fields.ts';
import { positionedFields,validatePositionedPdf,validatePositionedPlacement } from './positioned-template.ts';
import {positionedV3Fields} from './positioned-v3-snapshot.ts';
import {recordPositionedV3Signature} from './positioned-v3-record.ts';
import {retryPositionedV3Signature} from './positioned-v3-retry.ts';
import {renderPositionedV3Text} from './positioned-v3-text-render.ts';
import { renderTypedSignature } from './typed-signature-image.ts';
import { completeEnvelopeOfSession, processEnvelopeStep } from './envelope-completion.ts';
import { otpSink, type OtpSinkEnv } from './otp-mail-sink.ts';
import { managedEvidenceFromEnv, type SealEnv } from './seal-config.ts';
import { AUDIT, auditTrail, recordAuditQuietly, requestFacts, sessionContext } from './audit.ts';
import { expireIfDue } from './task-expiry.ts';
import { intentStatement, parseSignerTitle, sha256Hex, signerContext } from './signer-facts.ts';
import { CONSENT_DISCLOSURE, consentDisclosure } from './disclosure.ts';
import { finalizeManagedEvidence, hasManagedEvidence, managedDelivery, verifyManagedEvidence } from './managed-evidence.ts';
import { isValidOtpEmailAddress } from './cloudflare-otp-mail.ts';
import { deliveryPdf } from './delivery-pdf.ts';
import { finalizeLocalTestEvidence } from './local-test-evidence.ts';

type Bindings = { DB: D1Database; ARTIFACTS: R2Bucket; TEST_MAIL?: R2Bucket; LOCAL_TEST_MODE?: string; LOCAL_TEST_OTP_KEY?: string; LOCAL_TEST_SEAL_KEY?: string; COMPLETE_AFTER_SIGN?: string } & OtpSinkEnv & SealEnv;
type Env = { Bindings: Bindings; Variables: { tenantId: string } };

/** Local test signing: recipient pages, OTP to the test mailbox, processing and the local test seal. */
export const localSigningEnabled = (env: Partial<Bindings>) => env.LOCAL_TEST_MODE === 'true' && !!env.TEST_MAIL && (env.LOCAL_TEST_OTP_KEY?.length ?? 0) >= 32;
const tokenFrom = (header: string | undefined) => /^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1] ?? '';
/**
 * The origin of the page a request comes from, which recipient sessions are bound to.
 * Browsers omit Origin on same-origin GETs, which is how the Worker-served /sign page calls
 * this API; Sec-Fetch-Site, which only the browser sets, then names the Worker's own origin.
 */
const requestOrigin = (c: import('hono').Context<any>) => c.req.header('origin') ?? (c.req.header('sec-fetch-site') === 'same-origin' ? new URL(c.req.url).origin : '');
const sha256 = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n=>n.toString(16).padStart(2,'0')).join('');

/** Local experiment only; no external mail adapter and no production authorization claim. */
export function mountLocalSigningRoutes(app: Hono<Env>, v3TestOnly = false): void {
  const local = async (c: import('hono').Context<Env>, next: import('hono').Next) => {
    c.header('Cache-Control','no-store');
    if (!localSigningEnabled(c.env)) return c.json({error:'local_test_disabled'}, 404);
    await next();
  };
  app.use('/v1/page-sessions/*', local);
  app.use('/v1/signing/*', local);
  // A passed sign-by deadline expires the envelope before the signer's request runs.
  app.use('/v1/signing/*', async (c, next) => {
    const session = await sessionContext(c.env.DB, tokenFrom(c.req.header('authorization')));
    if (session) await expireIfDue(c.env.DB, session.envelopeId);
    await next();
  });
  app.use('/v1/page-sessions/*', bodyLimit({maxSize:4096}));
  app.use('/v1/signing/*', bodyLimit({maxSize:4096}));
  const cors = async (c: import('hono').Context<Env>, next: import('hono').Next) => {
    const origin=requestOrigin(c);
    const found=await c.env.DB.prepare('SELECT 1 FROM tenant_page_origins WHERE origin=? LIMIT 1').bind(origin).first();
    if (!found) return c.json({error:'forbidden'},403);
    c.header('Access-Control-Allow-Origin',origin);c.header('Vary','Origin');
    if (c.req.method === 'OPTIONS') {c.header('Access-Control-Allow-Methods','GET, POST, OPTIONS');c.header('Access-Control-Allow-Headers','authorization, content-type');return c.body(null,204);}
    await next();
  };
  app.use('/v1/page-sessions/*', cors);
  app.use('/v1/signing/*', cors);
  app.post('/v1/envelopes/:id/tasks/:taskId/recipient-view', local, bodyLimit({maxSize:4096}), async c => {
    await expireIfDue(c.env.DB, c.req.param('id') ?? '');
    let body: {origin?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    if (!body || typeof body.origin !== 'string') return c.json({error:'invalid_request'},400);
    try {const code=await issueRecipientCode(c.env.DB,{tenantId:c.get('tenantId'),envelopeId:c.req.param('id'),taskId:c.req.param('taskId'),origin:body.origin,now:Date.now()});
      await recordAuditQuietly(c.env.DB,{envelopeId:c.req.param('id') ?? '',taskId:c.req.param('taskId'),type:AUDIT.viewIssued,...requestFacts(c.req.raw),detail:{pageOrigin:body.origin}});
      return c.json({code},201);}
    catch {return c.json({error:'recipient_unavailable'},404);}
  });
  app.post('/v1/page-sessions/exchange', async c => {
    let body: {code?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    if (!body || typeof body.code !== 'string') return c.json({error:'invalid_request'},400);
    try {const token=await exchangeRecipientCode(c.env.DB,body.code,requestOrigin(c),Date.now());
      const session=await sessionContext(c.env.DB,token);if(session)await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.sessionOpened,...requestFacts(c.req.raw)});
      return c.json({token});}
    catch {return c.json({error:'invalid_code'},401);}
  });
  app.post('/v1/signing/otp', async c => {
    const messageId=crypto.randomUUID();
    // With a sink every code is really emailed, to the sink only; without one, codes for
    // synthetic test addresses are only stored in the test mailbox.
    const sink=otpSink(c.env);
    let sentTo='';
    try {
      await sendRecipientOtp(c.env.DB,tokenFrom(c.req.header('authorization')),requestOrigin(c),Date.now(),new TextEncoder().encode(c.env.LOCAL_TEST_OTP_KEY!),async (to,otp)=>{
        if (sink ? !isValidOtpEmailAddress(to) : !/^[^@\s]+@(?:example\.com|[a-z0-9.-]+\.test)$/i.test(to)) throw new Error('Synthetic test email required');
        const session=await c.env.DB.prepare('SELECT tenant_id FROM recipient_page_sessions WHERE token_hash=?').bind(await sha256(new TextEncoder().encode(tokenFrom(c.req.header('authorization'))).buffer)).first<{tenant_id:string}>();
        if (!session) throw new Error('Session unavailable');
        const stored=await c.env.TEST_MAIL!.put(`test-mail/${messageId}.json`,JSON.stringify({to,otp,tenantId:session.tenant_id}),{onlyIf:{etagDoesNotMatch:'*'}});
        if (!stored) throw new Error('Test mailbox collision');
        if (sink) await sink.send(to,otp);
        sentTo=to;
      });
      const session=await sessionContext(c.env.DB,tokenFrom(c.req.header('authorization')));
      if(session)await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.otpSent,...requestFacts(c.req.raw),detail:{to:sentTo,delivery:sink?'email':'test-mailbox',messageId}});
      return c.json(sink?{messageId,emailed:true}:{messageId},202);
    } catch {return c.json({error:'otp_unavailable'},429);}
  });
  // The local test mailbox, read back by the tenant whose recipient was sent the code.
  // Management-key authenticated (see worker.ts); only synthetic test addresses are ever stored.
  app.get('/v1/test-mail/:messageId', local, async c => {
    const id=c.req.param('messageId') ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return c.json({error:'not_found'},404);
    const object=await c.env.TEST_MAIL!.get(`test-mail/${id}.json`);
    if (!object) return c.json({error:'not_found'},404);
    let mail: {to?:unknown;otp?:unknown;tenantId?:unknown};
    try {mail=await object.json();} catch {return c.json({error:'not_found'},404);}
    if (mail.tenantId !== c.get('tenantId') || typeof mail.to !== 'string' || typeof mail.otp !== 'string') return c.json({error:'not_found'},404);
    return c.json({to:mail.to,otp:mail.otp});
  });
  app.post('/v1/signing/otp/verify', async c => {
    let body: {otp?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    if (!body || typeof body.otp !== 'string') return c.json({error:'invalid_request'},400);
    try {const ok=await verifyRecipientOtp(c.env.DB,tokenFrom(c.req.header('authorization')),requestOrigin(c),Date.now(),new TextEncoder().encode(c.env.LOCAL_TEST_OTP_KEY!),body.otp);
      if(!ok)return c.json({error:'invalid_otp'},401);
      const session=await sessionContext(c.env.DB,tokenFrom(c.req.header('authorization')));if(session)await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.otpVerified,...requestFacts(c.req.raw)});
      return c.body(null,204);}
    catch {return c.json({error:'invalid_session'},401);}
  });
  async function current(c: import('hono').Context<Env>): Promise<{id:string;sha256:string;object_key:string}> {
    const task=await authorizeRecipientSession(c.env.DB,tokenFrom(c.req.header('authorization')),requestOrigin(c),Date.now());
    const token=tokenFrom(c.req.header('authorization'));
    const verified=await c.env.DB.prepare('SELECT 1 FROM recipient_otp_verifications v JOIN tasks t ON t.id=v.task_id WHERE v.task_id=? AND v.session_hash=? AND v.recipient_email=t.recipient_email COLLATE BINARY').bind(task,await sha256(new TextEncoder().encode(token).buffer)).first();
    if (!verified) throw new Error('OTP verification required');
    const artifact=await c.env.DB.prepare(`SELECT so.artifact_id AS id, so.sha256, so.object_key FROM tasks t JOIN signature_records r ON r.envelope_id=t.envelope_id JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE' JOIN signature_outputs so ON so.job_id=j.id WHERE t.id=? ORDER BY r.sequence DESC LIMIT 1`).bind(task).first<{id:string;sha256:string;object_key:string}>();
    if (artifact) return artifact;
    const d0=await c.env.DB.prepare(`SELECT a.id,a.sha256,a.object_key FROM tasks t JOIN artifacts a ON a.envelope_id=t.envelope_id WHERE t.id=? AND NOT EXISTS (SELECT 1 FROM signature_records r WHERE r.envelope_id=t.envelope_id)`).bind(task).first<{id:string;sha256:string;object_key:string}>();
    if (!d0) throw new Error('Artifact unavailable');return d0;
  }
  async function fieldsFor(c:import('hono').Context<Env>) {
    const task=await authorizeRecipientSession(c.env.DB,tokenFrom(c.req.header('authorization')),requestOrigin(c),Date.now());
    const row=await c.env.DB.prepare('SELECT t.role,t.recipient_name,p.roles_json,p.fields_json FROM tasks t JOIN envelopes e ON e.id=t.envelope_id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id WHERE t.id=?').bind(task).first<{role:string;recipient_name:string;roles_json:string;fields_json:string}>();
    if(!row)throw new Error('Missing template');const raw:unknown=JSON.parse(row.fields_json);if(!Array.isArray(raw))throw new Error('Invalid fields');
    const v3=raw.some((f:any)=>f.type==='Date signed'||f.type==='Title');
    const all=raw.length?(v3&&v3TestOnly?positionedV3Fields(raw,JSON.parse(row.roles_json),100):positionedFields(row.fields_json,JSON.parse(row.roles_json),100)):[];assertNoOverlappingFields(all);
    return {task,all,fields:all.filter(f=>f.role===row.role),role:row.role,recipientName:row.recipient_name,v3,fieldsJson:row.fields_json,rolesJson:row.roles_json};
  }
  app.get('/v1/signing/current', async c => {try {const a=await current(c),details=await fieldsFor(c);
    // The signer's title and company (when the host named them) and the sentence they adopt.
    const who=await signerContext(c.env.DB,details.task);
    return c.json({id:a.id,sha256:a.sha256,disclosure:{version:CONSENT_DISCLOSURE.version,text:CONSENT_DISCLOSURE.text},intent:intentStatement(who.documentName,who.facts.onBehalfOf),...(who.facts.title||who.facts.onBehalfOf?{signer:who.facts}:{}),...(details.fields.length?{fields:details.fields,role:details.role,recipientName:details.recipientName,...(details.v3?{v3:true}:{})}:{})});} catch {return c.json({error:'unavailable'},401);}});
  // The signer whose turn it is declines, after the code, with a reason: the envelope ends for
  // everyone, and the audit trail records who declined, why, and from where.
  app.post('/v1/signing/decline', async c => {
    let body: {reason?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    const reason=typeof body?.reason==='string'?body.reason.trim():'';
    if(!reason)return c.json({error:'reason_required'},422);
    if(reason.length>1000)return c.json({error:'reason_too_long'},422);
    try {await current(c);} catch {return c.json({error:'unavailable'},401);}
    const session=await sessionContext(c.env.DB,tokenFrom(c.req.header('authorization')));
    if(!session)return c.json({error:'unavailable'},401);
    const {ip,userAgent}=requestFacts(c.req.raw);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE envelopes SET status='DECLINED' WHERE id=? AND status='IN_PROGRESS' AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND envelope_id=? AND status='ACTIVE')").bind(session.envelopeId,session.taskId,session.envelopeId),
      c.env.DB.prepare('INSERT INTO audit_events (envelope_id, task_id, type, occurred_at, ip, user_agent, detail_json) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM envelopes WHERE id=? AND status=\'DECLINED\') AND NOT EXISTS (SELECT 1 FROM audit_events WHERE envelope_id=? AND type=?)')
        .bind(session.envelopeId,session.taskId,AUDIT.declined,Date.now(),ip,userAgent,JSON.stringify({reason}),session.envelopeId,session.envelopeId,AUDIT.declined),
    ]);
    const after=await c.env.DB.prepare('SELECT status FROM envelopes WHERE id=?').bind(session.envelopeId).first<{status:string}>();
    return after?.status==='DECLINED'?c.json({status:'DECLINED'}):c.json({error:'unavailable'},409);
  });
  app.post('/v1/signing/signature-preview',async c=>{try{
    const artifact=await current(c),{task,fields,all,fieldsJson,rolesJson}=await fieldsFor(c),body=await c.req.json() as {fieldId?:unknown;text?:unknown};
    const field=fields.find(f=>f.id===body.fieldId&&f.type==='Signature');if(!field||typeof body.text!=='string')throw new Error('Invalid signature');
    const prior=(await c.env.DB.prepare(`SELECT p.payload_json FROM tasks t JOIN signature_records r ON r.envelope_id=t.envelope_id LEFT JOIN positioned_signature_inputs p ON p.signature_id=r.id WHERE t.id=?`).bind(task).all<{payload_json:string|null}>()).results;if(prior.some(p=>!p.payload_json||JSON.stringify(JSON.parse(p.payload_json).templateFields)!==JSON.stringify(all)))throw new Error('Template snapshot changed');
    const source=await c.env.ARTIFACTS.get(artifact.object_key);if(!source)throw new Error('Missing input');const bytes=await source.arrayBuffer();if(await sha256(bytes)!==artifact.sha256)throw new Error('Input mismatch');
    const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});validatePositionedPdf(pdf);if(field.page>pdf.getPageCount())throw new Error('Invalid page');validatePositionedPlacement(pdf,all);
    const image=await renderTypedSignature(body.text),page=pdf.getPage(field.page-1),g=signatureGeometry(page,field,image);assertSignatureGeometrySafe(page,field,g,all);
    return c.body(Uint8Array.from(image).buffer,200,{'Content-Type':'image/png','X-Content-Type-Options':'nosniff','X-Signature-Width':String(g.width/(field.rect.width*page.getWidth())),'X-Signature-Height':String(g.height/(field.rect.height*page.getHeight())),'X-Signature-Preview':await signaturePreviewHash(artifact.sha256,rolesJson,fieldsJson,field.id,body.text,await sha256(Uint8Array.from(image).buffer),g),'Access-Control-Expose-Headers':'X-Signature-Width, X-Signature-Height, X-Signature-Preview'});
  }catch{return c.json({error:'signature_does_not_fit'},422);}});
  app.post('/v1/signing/text-preview',async c=>{try{
    if(!v3TestOnly)throw new Error('Disabled');const artifact=await current(c);const {task,all,fields,v3,fieldsJson,rolesJson}=await fieldsFor(c);if(!v3)throw new Error('Not v3');
    const prior=(await c.env.DB.prepare(`SELECT p.payload_json FROM tasks t JOIN signature_records r ON r.envelope_id=t.envelope_id LEFT JOIN positioned_signature_inputs p ON p.signature_id=r.id WHERE t.id=?`).bind(task).all<{payload_json:string|null}>()).results;if(prior.some(p=>!p.payload_json||JSON.stringify(JSON.parse(p.payload_json).templateFields)!==JSON.stringify(all)))throw new Error('Template snapshot changed');
    const body=await c.req.json() as {fieldId?:unknown;text?:unknown};const field=fields.find(f=>f.id===body.fieldId);if(!field||!['Title','Date signed'].includes(field.type))throw new Error('Unauthorized field');
    const now=Date.now(),text=field.type==='Date signed'?new Date(now).toISOString().slice(0,10):body.text;
    if(field.type==='Date signed'&&body.text!==undefined)throw new Error('Unexpected date');if(typeof text!=='string'||(field.type==='Title'&&(!text||text.length>128||text.trim()!==text||!/^[\x20-\x7e]+$/.test(text))))throw new Error('Invalid text');
    const headers:Record<string,string>={'Content-Type':'image/png','X-Content-Type-Options':'nosniff','X-Preview-Text':text};
    const image=Uint8Array.from(await renderPositionedV3Text(text));
    const source=await c.env.ARTIFACTS.get(artifact.object_key);if(!source)throw new Error('Missing input');const bytes=await source.arrayBuffer();if(await sha256(bytes)!==artifact.sha256)throw new Error('Input mismatch');const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});if(field.page<1||field.page>pdf.getPageCount())throw new Error('Invalid page');validatePositionedPdf(pdf);validatePositionedPlacement(pdf,all);const page=pdf.getPage(field.page-1);assertPositionedV3TextFits(page,field,image);const geometry=positionedV3TextGeometry(page,field,image);
    headers['X-Text-Width']=String(geometry.width/(field.rect.width*page.getWidth()));headers['X-Text-Height']=String(geometry.height/(field.rect.height*page.getHeight()));
    let sessionHash='',id='';
    if(field.type==='Date signed'){
      const token=tokenFrom(c.req.header('authorization'));sessionHash=await sha256(new TextEncoder().encode(token).buffer);id=crypto.randomUUID();
      const same=`positioned_v3_date_previews.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND positioned_v3_date_previews.date_text=excluded.date_text AND positioned_v3_date_previews.artifact_id=excluded.artifact_id AND positioned_v3_date_previews.artifact_sha256=excluded.artifact_sha256 AND positioned_v3_date_previews.roles_json=excluded.roles_json AND positioned_v3_date_previews.fields_json=excluded.fields_json AND positioned_v3_date_previews.geometry_json=excluded.geometry_json`;
      const saved=await c.env.DB.prepare(`INSERT INTO positioned_v3_date_previews(session_hash,field_id,preview_id,date_text,image_sha256,artifact_id,artifact_sha256,roles_json,fields_json,expires_at,geometry_json)
       SELECT s.token_hash,?,?,?,?,?,?,?,?,MIN(s.expires_at,?),? FROM recipient_page_sessions s JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=e.id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY WHERE s.token_hash=? AND s.origin=? AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND t.role=? AND p.fields_json=? AND p.roles_json=? AND ?=strftime('%Y-%m-%d','now') AND ?>CAST(unixepoch('subsec')*1000 AS INTEGER) AND (EXISTS (SELECT 1 FROM signature_records r JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE' JOIN signature_outputs so ON so.job_id=j.id WHERE r.envelope_id=e.id AND so.artifact_id=? AND so.sha256=? AND NOT EXISTS (SELECT 1 FROM signature_records newer JOIN signature_jobs nj ON nj.signature_id=newer.id AND nj.status='DONE' WHERE newer.envelope_id=e.id AND newer.sequence>r.sequence)) OR (NOT EXISTS (SELECT 1 FROM signature_records r WHERE r.envelope_id=e.id) AND EXISTS (SELECT 1 FROM artifacts a WHERE a.envelope_id=e.id AND a.id=? AND a.sha256=?)))
       ON CONFLICT(session_hash,field_id) DO UPDATE SET preview_id=CASE WHEN ${same} THEN positioned_v3_date_previews.preview_id ELSE excluded.preview_id END,date_text=excluded.date_text,image_sha256=CASE WHEN ${same} THEN positioned_v3_date_previews.image_sha256 ELSE excluded.image_sha256 END,artifact_id=excluded.artifact_id,artifact_sha256=excluded.artifact_sha256,roles_json=excluded.roles_json,fields_json=excluded.fields_json,geometry_json=excluded.geometry_json,expires_at=CASE WHEN ${same} THEN MAX(positioned_v3_date_previews.expires_at,excluded.expires_at) ELSE excluded.expires_at END`).bind(field.id,id,text,'',artifact.id,artifact.sha256,rolesJson,fieldsJson,now+300000,JSON.stringify(geometry),sessionHash,requestOrigin(c),field.role,fieldsJson,rolesJson,text,now+300000,artifact.id,artifact.sha256,artifact.id,artifact.sha256).run();
      if(saved.meta.changes!==1)throw new Error('Preview unavailable');const existing=await c.env.DB.prepare(`SELECT preview_id FROM positioned_v3_date_previews WHERE session_hash=? AND field_id=? AND date_text=? AND artifact_id=? AND artifact_sha256=? AND roles_json=? AND fields_json=? AND geometry_json=? AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)`).bind(sessionHash,field.id,text,artifact.id,artifact.sha256,rolesJson,fieldsJson,JSON.stringify(geometry)).first<{preview_id:string}>();if(!existing)throw new Error('Preview superseded');id=existing.preview_id;
    }
    if(field.type==='Title'){headers['X-Text-Preview']=await signaturePreviewHash(artifact.sha256,rolesJson,fieldsJson,field.id,text,await sha256(image.buffer),geometry);headers['Access-Control-Expose-Headers']='X-Text-Preview, X-Preview-Text, X-Text-Width, X-Text-Height';}
    if(field.type==='Date signed'){const imageHash=await sha256(image.buffer);const completed=await c.env.DB.prepare(`UPDATE positioned_v3_date_previews SET image_sha256=? WHERE session_hash=? AND field_id=? AND preview_id=? AND geometry_json=? AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)`).bind(imageHash,sessionHash,field.id,id,JSON.stringify(geometry)).run();if(completed.meta.changes!==1)throw new Error('Preview superseded');headers['X-Date-Preview-Id']=id;headers['Access-Control-Expose-Headers']='X-Date-Preview-Id, X-Preview-Text, X-Text-Width, X-Text-Height';}
    return c.body(image.buffer,200,headers);
  }catch(error){return c.json({error:error instanceof PositionedV3TextDoesNotFitError?'title_does_not_fit':'invalid_preview'},422);}});
  app.get('/v1/signing/pdf', async c => {try {const a=await current(c), file=await c.env.ARTIFACTS.get(a.object_key);if (!file) throw new Error('Missing');const bytes=await file.arrayBuffer();if (await sha256(bytes)!==a.sha256) throw new Error('Mismatch');
    const session=await sessionContext(c.env.DB,tokenFrom(c.req.header('authorization')));if(session)await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.documentViewed,...requestFacts(c.req.raw),detail:{artifactId:a.id,artifactSha256:a.sha256}});
    return c.body(bytes,200,{'Content-Type':'application/pdf','X-Content-Type-Options':'nosniff'});} catch {return c.json({error:'unavailable'},401);}});
  // COMPLETE_AFTER_SIGN: once a signature is accepted, process it and, after the last one,
  // seal the envelope, without waiting for the caller to request /process and /finalize.
  // The response does not wait; the cron sweep retries whatever this does not finish.
  app.use('/v1/signing/sign', async (c, next) => {
    await next();
    if (c.res.status !== 202 || c.env.COMPLETE_AFTER_SIGN !== 'true') return;
    const work=completeEnvelopeOfSession(c.env,tokenFrom(c.req.header('authorization')),v3TestOnly)
      .catch(() => console.error('E-sign: finishing the envelope after a signature failed; the cron sweep retries it'));
    try {c.executionCtx.waitUntil(work);} catch {/* No execution context in-process: the work continues on its own. */}
  });
  app.post('/v1/signing/sign', async c => {
    let body: {artifactId?:unknown;artifactHash?:unknown;consent?:unknown;signatures?:unknown;datePreviewIds?:unknown;signaturePreviews?:unknown;textPreviews?:unknown;disclosureVersion?:unknown;title?:unknown;authorityConfirmed?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    if (!body || typeof body.artifactId !== 'string' || typeof body.artifactHash !== 'string' || body.consent !== true) return c.json({error:'invalid_request'},400);
    // The signer consents to the disclosure the page showed; refuse consent to an older one.
    if (body.disclosureVersion !== undefined && body.disclosureVersion !== CONSENT_DISCLOSURE.version) return c.json({error:'disclosure_changed'},409);
    const token=tokenFrom(c.req.header('authorization'));
    // Signing for a company: the signer gives a title and confirms they may bind it.
    const who=await sessionContext(c.env.DB,token).then(s=>s?signerContext(c.env.DB,s.taskId):null).catch(()=>null);
    const signerTitle=parseSignerTitle(body.title);
    if(signerTitle==='invalid')return c.json({error:'invalid_request'},400);
    if(who?.facts.onBehalfOf){
      if(!signerTitle)return c.json({error:'title_required'},422);
      if(body.authorityConfirmed!==true)return c.json({error:'authority_required'},422);
    }
    const intent=intentStatement(who?.documentName??null,who?.facts.onBehalfOf);
    const authority={...(signerTitle?{title:signerTitle}:{}),...(who?.facts.onBehalfOf?{onBehalfOf:who.facts.onBehalfOf,authorityConfirmed:true}:{}),...(who?.facts.onBehalfOf||signerTitle?{intentSha256:await sha256Hex(intent)}:{})};
    const replay=async () => {
      if (!token) return null;
      const hash=await sha256(new TextEncoder().encode(token).buffer);
      const found=await c.env.DB.prepare(`SELECT r.id,e.event_version,p.payload_json FROM signature_records r JOIN signature_events e ON e.signature_id=r.id LEFT JOIN positioned_signature_inputs p ON p.signature_id=r.id JOIN recipient_page_sessions s ON s.token_hash=r.session_hash AND s.task_id=r.task_id AND s.envelope_id=r.envelope_id JOIN tasks t ON t.id=r.task_id AND t.envelope_id=r.envelope_id JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY AND v.recipient_email=r.otp_recipient_email COLLATE BINARY AND v.verified_at=r.otp_verified_at JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND r.input_artifact_id=? AND r.input_sha256=?`)
        .bind(hash,requestOrigin(c),Date.now(),body.artifactId,body.artifactHash).first<{id:string;event_version:number;payload_json:string|null}>();
      if(!found)return null;
      if(found.event_version===1)return body.signatures===undefined?{id:found.id}:null;
      if(found.event_version===3 && v3TestOnly){const id=await retryPositionedV3Signature(c.env.DB,c.env.ARTIFACTS,{token,origin:requestOrigin(c),now:Date.now(),artifactId:body.artifactId as string,artifactHash:body.artifactHash as string,values:body.signatures,datePreviewIds:body.datePreviewIds});return id?{id}:null;}
      if(found.event_version!==2||!found.payload_json||!body.signatures||typeof body.signatures!=='object'||Array.isArray(body.signatures))return null;
      try{const payload=JSON.parse(found.payload_json) as {fields:{id:string;text:string}[]};const expected=Object.fromEntries(payload.fields.map(f=>[f.id,f.text]));const supplied=body.signatures as Record<string,unknown>;if(Object.keys(expected).length!==Object.keys(supplied).length||Object.keys(expected).some(k=>expected[k]!==supplied[k]))return null;return {id:found.id};}catch{return null;}
    };
    const existing=await replay();if (existing) return c.json(existing,202);
    try {const a=await current(c);if (a.id!==body.artifactId || a.sha256!==body.artifactHash) throw new Error('Stale artifact');const file=await c.env.ARTIFACTS.get(a.object_key);if (!file || await sha256(await file.arrayBuffer())!==a.sha256) throw new Error('Input mismatch');
      const {fields,v3}=await fieldsFor(c);const command={token,origin:requestOrigin(c),now:Date.now(),artifactId:a.id,artifactHash:a.sha256};
      const id=v3&&v3TestOnly?await recordPositionedV3Signature(c.env.DB,c.env.ARTIFACTS,{...command,values:body.signatures,datePreviewIds:body.datePreviewIds,signaturePreviews:body.signaturePreviews,textPreviews:body.textPreviews}):fields.length?await recordPositionedSignature(c.env.DB,c.env.ARTIFACTS,{...command,signatures:body.signatures,signaturePreviews:body.signaturePreviews}):body.signatures===undefined?await recordSignature(c.env.DB,c.env.ARTIFACTS,{...command,consent:true}):(()=>{throw new Error('Unexpected fields');})();
      const disclosure=await consentDisclosure(),session=await sessionContext(c.env.DB,token);
      if(session)await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.signed,...requestFacts(c.req.raw),detail:{signatureId:id,artifactId:a.id,artifactSha256:a.sha256,consentDisclosureVersion:disclosure.version,consentDisclosureSha256:disclosure.sha256,...authority}});
      return c.json({id},202);
    } catch {const raced=await replay();return raced ? c.json(raced,202) : c.json({error:'signature_rejected'},409);}
  });
  app.get('/v1/envelopes/:id/final-pdf', local, async c => {
    const output=await c.env.DB.prepare(`SELECT o.object_key,o.sha256 FROM envelopes e JOIN signature_records r ON r.envelope_id=e.id JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE' JOIN signature_outputs o ON o.job_id=j.id WHERE e.id=? AND e.tenant_id=? AND e.status='COMPLETED' ORDER BY r.sequence DESC LIMIT 1`).bind(c.req.param('id'),c.get('tenantId')).first<{object_key:string;sha256:string}>();
    if (!output) return c.json({error:'not_found'},404);
    const file=await c.env.ARTIFACTS.get(output.object_key);
    if (!file) return c.json({error:'unavailable'},503);
    const bytes=await file.arrayBuffer();
    if (await sha256(bytes)!==output.sha256) return c.json({error:'unavailable'},503);
    return c.body(bytes,200,{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="signed-local-test.pdf"','X-Content-Type-Options':'nosniff'});
  });
  for (const kind of ['delivery-pdf','delivery-metadata'] as const) app.get(`/v1/envelopes/:id/${kind}`, local, async c => {
    const envelope=await c.env.DB.prepare("SELECT 1 FROM envelopes WHERE id=? AND tenant_id=? AND status='COMPLETED'").bind(c.req.param('id'),c.get('tenantId')).first();
    if(!envelope) return c.json({error:'not_found'},404);
    const id=c.req.param('id') ?? '';
    try {
      // Described by the seal this envelope was completed with.
      let result;
      if (await hasManagedEvidence(c.env.DB,id)) {
        const managed=await managedEvidenceFromEnv(c.env);if(!managed)throw new Error('Managed seal not configured');
        result=await deliveryPdf(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),id,managedDelivery(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),id,managed.trust));
      } else {
        if((c.env.LOCAL_TEST_SEAL_KEY?.length ?? 0)<32) return c.json({error:'local_test_disabled'},404);
        result=await deliveryPdf(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),id,new TextEncoder().encode(c.env.LOCAL_TEST_SEAL_KEY!));
      }
      if(kind==='delivery-metadata') return c.json(result.metadata);
      return c.body(Uint8Array.from(result.bytes).buffer,200,{'Content-Type':'application/pdf','Content-Disposition':`inline; filename="${result.metadata.format==='esign-local-delivery-v3'?'delivery-local-test':'delivery'}.pdf"`,'X-Content-Type-Options':'nosniff'});
    } catch {return c.json({error:'unavailable'},503);}
  });
  app.get('/v1/envelopes/:id/certificate', local, async c => {
    const envelope=await c.env.DB.prepare("SELECT id,template_id,created_at,status FROM envelopes WHERE id=? AND tenant_id=? AND status='COMPLETED'").bind(c.req.param('id'),c.get('tenantId')).first();
    if (!envelope) return c.json({error:'not_found'},404);
    const id=c.req.param('id') ?? '';
    try {
      const recipients=async()=>(await c.env.DB.prepare('SELECT id,role,recipient_name,recipient_email,routing_order,status FROM tasks WHERE envelope_id=? ORDER BY routing_order').bind(id).all()).results;
      if (await hasManagedEvidence(c.env.DB,id)) {
        const managed=await managedEvidenceFromEnv(c.env);if(!managed)throw new Error('Managed seal not configured');
        const verified=await verifyManagedEvidence(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),id,managed.trust);
        return c.json({mode:'KMS_TSA',notice:'Sealed with an AWS KMS signature (ECDSA P-256) over the evidence and an RFC 3161 timestamp over that signature. Revocation of the time-stamping authority certificates is not checked. This separate view is not the signed PDF.',binding:'Source, signatures, event links and output hashes are checked against the sealed manifest and stored files. Envelope metadata and recipient task details are current database values, not bound by the seal.',envelope,recipients:await recipients(),...verified});
      }
      if ((c.env.LOCAL_TEST_SEAL_KEY?.length ?? 0)<32) return c.json({error:'local_test_disabled'},404);
      const verified=await finalizeLocalTestEvidence(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),id,new TextEncoder().encode(c.env.LOCAL_TEST_SEAL_KEY!),true);
      return c.json({mode:'LOCAL TEST ONLY',notice:'Not a legal guarantee. Local HMAC is not a real KMS or TSA; the synthetic timestamp is not independent. This separate view is not the signed PDF.',binding:'Source, signatures, event links and output hashes are checked against the existing local HMAC manifest and stored files. Envelope metadata and recipient task details are current database values, not bound by that manifest.',envelope,recipients:await recipients(),...verified,audit:{sealed:[],afterSeal:await auditTrail(c.env.DB,id)}});
    } catch {return c.json({error:'unavailable'},503);}
  });
  app.post('/v1/envelopes/:id/finalize', local, async c => {
    try {
      const managed=await managedEvidenceFromEnv(c.env);
      if (managed) {await finalizeManagedEvidence(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),c.req.param('id') ?? '',managed);return c.body(null,204);}
    } catch {return c.json({error:'finalization_failed'},503);}
    if ((c.env.LOCAL_TEST_SEAL_KEY?.length ?? 0)<32) return c.json({error:'local_test_disabled'},404);
    try {await finalizeLocalTestEvidence(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),c.req.param('id') ?? '',new TextEncoder().encode(c.env.LOCAL_TEST_SEAL_KEY!));return c.body(null,204);}
    catch {return c.json({error:'finalization_failed'},503);}
  });
  app.post('/v1/envelopes/:id/process', local, async c => {
    const result=await processEnvelopeStep(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),c.req.param('id') ?? '',v3TestOnly);
    if (result === 'processed') return c.body(null,204);
    if (result === 'job_unavailable') return c.json({error:'job_unavailable'},404);
    if (result === 'signature_input_layout_missing') return c.json({error:'signature_input_layout_missing'},409);
    return c.json({error:'processing_failed'},503);
  });
}
