import { Hono } from 'hono';
import { SESSION_HEADER, sessionToken } from './session-header.ts';
import {PDFDocument} from 'pdf-lib';
import { bodyLimit } from 'hono/body-limit';
import { issueRecipientCode, exchangeRecipientCode, authorizeRecipientSession, sendRecipientOtp, verifyRecipientOtp, otpEntryRefusal, OtpSendRefused } from './otp.ts';
import { DateChanged, recordSignature, retrySignature } from './signature-record.ts';
import { assertNoOverlappingFields, validateFields, validateFieldPlacement, validateFieldsPdf, type TemplateField } from './fields.ts';
import { assertSignatureGeometrySafe, assertTextFits, renderText, renderTypedSignature, signatureGeometry, signaturePreviewHash, textGeometry, TextDoesNotFitError } from './field-render.ts';
import { canonicalJson } from './canonical-json.ts';
import { artifactObjectKey } from './signatures.ts';
import { completeEnvelopeOfSession } from './envelope-completion.ts';
import { otpMailer } from './mail.ts';
import { isProd, otpKey, signingEnabled, testSealKey } from './environment.ts';
import { managedEvidenceFromEnv } from './seal/config.ts';
import { AUDIT, auditTrail, recordAuditQuietly, requestFacts, sessionContext } from './audit.ts';
import { expireIfDue } from './task-expiry.ts';
import { consentStatement, lastHostAuthentication, parseHostAuthentication, parseSignerTitle, sha256Hex, signerContext } from './signer-facts.ts';
import { CONSENT_DISCLOSURE, consentDisclosure } from './disclosure.ts';
import { taskDetails } from './details.ts';
import { hasManagedEvidence, managedDelivery, verifyManagedEvidence } from './seal/managed.ts';
import { isValidOtpEmailAddress } from './email-address.ts';
import { embedderAllowed, frameAncestors } from './signing-page.ts';
import { releaseCopyLink, useCopyLink } from './signed-copies.ts';
import type { Env } from './app.ts';
import { deliveryPdf } from './delivery-pdf.ts';
import { finalizeLocalTestEvidence } from './seal/local.ts';
import type { BlobStore } from './blob-store.ts';

/**
 * Origins the signing page may run on: the app's own (/sign), plus, in dev only,
 * SIGNING_PAGE_ORIGINS (space-separated) for local UI development. Every organization uses the
 * same signing origin.
 */
const pageOrigins = (c: import('hono').Context<any>): Set<string> => new Set([new URL(c.req.url).origin, ...(isProd(c.env) ? [] : (c.env.SIGNING_PAGE_ORIGINS ?? '').split(/\s+/).filter(Boolean))]);

/** The page session a signing request carries (`x-esign-session`, session-header.ts). */
const pageToken = (c: import('hono').Context<any>) => sessionToken((name) => c.req.header(name));
/**
 * The origin of the page a request comes from, which recipient sessions are bound to.
 * Browsers omit Origin on same-origin GETs, which is how the app's /sign page calls this API;
 * Sec-Fetch-Site, which only the browser sets, then names the app's own origin.
 */
const requestOrigin = (c: import('hono').Context<any>) => c.req.header('origin') ?? (c.req.header('sec-fetch-site') === 'same-origin' ? new URL(c.req.url).origin : '');
const sha256 = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n=>n.toString(16).padStart(2,'0')).join('');

/** The most pages a signer's views are recorded for (the PDF limit). */
const MAX_VIEWED_PAGES = 100;

/** The pages a task's recipient has viewed, from their PAGES_VIEWED audit events. */
export async function viewedPages(db: D1Database, envelopeId: string, taskId: string): Promise<Set<number>> {
  const rows = (await db.prepare('SELECT detail_json FROM audit_events WHERE envelope_id=? AND task_id=? AND type=?').bind(envelopeId, taskId, AUDIT.pagesViewed).all<{ detail_json: string | null }>()).results;
  const seen = new Set<number>();
  for (const row of rows) { try { for (const p of (JSON.parse(row.detail_json ?? '{}') as { pages?: unknown }).pages as number[] ?? []) if (Number.isSafeInteger(p)) seen.add(p); } catch { /* skip */ } }
  return seen;
}

export function mountSigningRoutes(app: Hono<Env>): void {
  const whenSigningEnabled = async (c: import('hono').Context<Env>, next: import('hono').Next) => {
    c.header('Cache-Control','no-store');
    if (!signingEnabled(c.env)) return c.json({error:'signing_disabled'}, 404);
    await next();
  };
  app.use('/api/public/page-sessions/*', whenSigningEnabled);
  app.use('/api/public/signing/*', whenSigningEnabled);
  // A passed sign-by deadline expires the envelope before the signer's request runs.
  app.use('/api/public/signing/*', async (c, next) => {
    const session = await sessionContext(c.env.DB, pageToken(c));
    if (session) await expireIfDue(c.env.DB, session.envelopeId);
    await next();
  });
  app.use('/api/public/page-sessions/*', bodyLimit({maxSize:4096}));
  app.use('/api/public/signing/*', bodyLimit({maxSize:4096}));
  const cors = async (c: import('hono').Context<Env>, next: import('hono').Next) => {
    const origin=requestOrigin(c);
    if (!pageOrigins(c).has(origin)) return c.json({error:'forbidden'},403);
    c.header('Access-Control-Allow-Origin',origin);c.header('Vary','Origin');
    if (c.req.method === 'OPTIONS') {c.header('Access-Control-Allow-Methods','GET, POST, OPTIONS');c.header('Access-Control-Allow-Headers',`${SESSION_HEADER}, content-type`);return c.body(null,204);}
    await next();
  };
  app.use('/api/public/page-sessions/*', cors);
  app.use('/api/public/signing/*', cors);
  // What the signing page needs before it opens a session: the hosts it may tell that the signer
  // closed, signed or declined (the app first), whether signing is available.
  app.get('/api/public/signing-page', c => {
    c.header('Cache-Control','no-store');
    const own=new URL(c.req.url).origin;
    return c.json({hosts:[own,...frameAncestors(c.env.SIGNING_PAGE_FRAME_ANCESTORS,isProd(c.env))],signingEnabled:signingEnabled(c.env)});
  });
  app.post('/api/envelopes/:id/tasks/:taskId/recipient-view', whenSigningEnabled, bodyLimit({maxSize:4096}), async c => {
    await expireIfDue(c.env.DB, c.req.param('id') ?? '');
    let body: {origin?:unknown;hostAuthentication?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    if (!body || (body.origin !== undefined && typeof body.origin !== 'string')) return c.json({error:'invalid_request'},400);
    // The page origin the code is for: the app's own unless the host names another allowed one.
    const origin=typeof body.origin==='string'?body.origin:new URL(c.req.url).origin;
    if (!pageOrigins(c).has(origin)) return c.json({error:'invalid_origin'},400);
    // How the host signed the recipient in, recorded as the host's statement.
    const hostAuthentication=parseHostAuthentication(body.hostAuthentication);
    if (hostAuthentication==='invalid') return c.json({error:'invalid_request'},400);
    try {const code=await issueRecipientCode(c.env.DB,{tenantId:c.get('tenantId'),envelopeId:c.req.param('id'),taskId:c.req.param('taskId'),origin,now:Date.now()});
      await recordAuditQuietly(c.env.DB,{envelopeId:c.req.param('id') ?? '',taskId:c.req.param('taskId'),type:AUDIT.viewIssued,...requestFacts(c.req.raw),detail:{pageOrigin:origin,...(hostAuthentication?{hostAuthentication}:{})}});
      return c.json({code},201);}
    catch {return c.json({error:'recipient_unavailable'},404);}
  });
  app.post('/api/public/page-sessions/exchange', async c => {
    let body: {code?:unknown;embedded?:unknown;embedder?:unknown;embedders?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    if (!body || typeof body.code !== 'string') return c.json({error:'invalid_request'},400);
    // A page framed by a site that may not embed it gets no session (signing-page.ts).
    if (!embedderAllowed(body,new URL(c.req.url).origin,frameAncestors(c.env.SIGNING_PAGE_FRAME_ANCESTORS,isProd(c.env)))) return c.json({error:'embedder_not_allowed'},403);
    try {const token=await exchangeRecipientCode(c.env.DB,body.code,requestOrigin(c),Date.now());
      const session=await sessionContext(c.env.DB,token);if(session)await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.sessionOpened,...requestFacts(c.req.raw)});
      return c.json({token});}
    catch {return c.json({error:'invalid_code'},401);}
  });
  app.post('/api/public/signing/otp', async c => {
    const messageId=crypto.randomUUID();
    // prod: the code is emailed to the recipient, through the mail relay, and kept nowhere. dev (the
    // local preview): every code is kept in the test mailbox; only synthetic test addresses get one,
    // unless a mail relay is configured, which then emails it too.
    const tokenHash=await sha256(new TextEncoder().encode(pageToken(c)).buffer);
    const owner=await c.env.DB.prepare("SELECT tenant_id FROM access_sessions WHERE scope='recipient' AND token_hash=?").bind(tokenHash).first<{tenant_id:string}>();
    const prod=isProd(c.env), mailer=owner?otpMailer(c.env,owner.tenant_id):null;
    let sentTo='';
    try {
      await sendRecipientOtp(c.env.DB,pageToken(c),requestOrigin(c),Date.now(),otpKey(c.env)!,async (to,otp)=>{
        if (prod) {
          if (!mailer || !isValidOtpEmailAddress(to)) throw new Error('Mail unavailable');
          await mailer.send(to,otp);
          sentTo=to;
          return;
        }
        if (mailer ? !isValidOtpEmailAddress(to) : !/^[^@\s]+@(?:example\.com|[a-z0-9.-]+\.test)$/i.test(to)) throw new Error('Synthetic test email required');
        if (!owner || !c.env.TEST_MAIL) throw new Error('Session unavailable');
        const stored=await c.env.TEST_MAIL.put(`test-mail/${messageId}.json`,JSON.stringify({to,otp,tenantId:owner.tenant_id}),{onlyIf:{etagDoesNotMatch:'*'}});
        if (!stored) throw new Error('Test mailbox collision');
        if (mailer) await mailer.send(to,otp);
        sentTo=to;
      });
      const session=await sessionContext(c.env.DB,pageToken(c));
      if(session)await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.otpSent,...requestFacts(c.req.raw),detail:{to:sentTo,delivery:mailer?'email':'test-mailbox',messageId}});
      // testMailbox: the signer does not get this email (the local preview mails nothing without a
      // relay), so the page says the code is in the test mailbox.
      const toSigner=!!mailer;
      return c.json({messageId,...(mailer?{emailed:true}:{}),...(toSigner?{}:{testMailbox:true})},202);
    } catch (error) {
      // The task's send budget (60 seconds apart, 3 per 15 minutes): say when the next send is allowed.
      if (error instanceof OtpSendRefused) {const retryAfterSeconds=Math.ceil(error.retryAfterMs/1000);return c.json({error:'otp_rate_limited',retryAfterSeconds},429,{'Retry-After':String(retryAfterSeconds)});}
      return c.json({error:'otp_unavailable'},429);
    }
  });
  // The test mailbox (the local preview only), read back by the organization whose recipient was
  // sent the code, through the platform identity (app.ts). prod keeps no codes.
  app.get('/api/test-mail/:messageId', whenSigningEnabled, async c => {
    if (isProd(c.env) || !c.env.TEST_MAIL) return c.json({error:'not_found'},404);
    const id=c.req.param('messageId') ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return c.json({error:'not_found'},404);
    const object=await c.env.TEST_MAIL!.get(`test-mail/${id}.json`);
    if (!object) return c.json({error:'not_found'},404);
    let mail: {to?:unknown;otp?:unknown;tenantId?:unknown};
    try {mail=await object.json();} catch {return c.json({error:'not_found'},404);}
    if (mail.tenantId !== c.get('tenantId') || typeof mail.to !== 'string' || typeof mail.otp !== 'string') return c.json({error:'not_found'},404);
    return c.json({to:mail.to,otp:mail.otp});
  });
  app.post('/api/public/signing/otp/verify', async c => {
    let body: {otp?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    if (!body || typeof body.otp !== 'string') return c.json({error:'invalid_request'},400);
    try {const ok=await verifyRecipientOtp(c.env.DB,pageToken(c),requestOrigin(c),Date.now(),otpKey(c.env)!,body.otp);
      if(!ok){
        // Why, so the page can say what to do next.
        const refusal=await otpEntryRefusal(c.env.DB,pageToken(c),requestOrigin(c),Date.now());
        if(refusal.reason==='superseded')return c.json({error:'otp_superseded'},409);
        if(refusal.reason==='locked'){const retryAfterSeconds=Math.ceil(refusal.retryAfterMs/1000);return c.json({error:'otp_attempts_exhausted',retryAfterSeconds},429,{'Retry-After':String(retryAfterSeconds)});}
        if(refusal.reason==='expired')return c.json({error:'otp_expired'},401);
        return c.json({error:'invalid_otp',attemptsLeft:refusal.attemptsLeft},401);
      }
      // Identity confirmed: the emailed code, and the host's sign-in from the link this signer was last given.
      const session=await sessionContext(c.env.DB,pageToken(c));if(session){const hostAuthentication=await lastHostAuthentication(c.env.DB,session.envelopeId,session.taskId);await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.otpVerified,...requestFacts(c.req.raw),...(hostAuthentication?{detail:{hostAuthentication}}:{})});}
      return c.body(null,204);}
    catch {return c.json({error:'invalid_session'},401);}
  });
  /** Whether this page session's recipient entered the emailed code. */
  async function sessionVerified(c: import('hono').Context<Env>, task: string): Promise<boolean> {
    const token=pageToken(c);
    return !!await c.env.DB.prepare("SELECT 1 FROM access_sessions WHERE scope='recipient' AND subject_id=? AND token_hash=? AND otp_verified_at IS NOT NULL").bind(task,await sha256(new TextEncoder().encode(token).buffer)).first();
  }
  /**
   * The document the session's recipient signs now. Reading it needs only the page session (the
   * host issued the link to its signed-in user): the signer reviews it before confirming it is
   * them. Everything that acts on it (previews, declining, signing) also needs the emailed code.
   */
  async function current(c: import('hono').Context<Env>, opts: {verified: boolean} = {verified: true}): Promise<{id:string;sha256:string;object_key:string}> {
    const task=await authorizeRecipientSession(c.env.DB,pageToken(c),requestOrigin(c),Date.now());
    if (opts.verified && !await sessionVerified(c, task)) throw new Error('OTP verification required');
    // The latest signature's rendered PDF, or the source before anyone has signed.
    const signed=await c.env.DB.prepare(`SELECT s.envelope_id, s.output_artifact_id AS id, s.output_sha256 AS sha256 FROM tasks t JOIN signatures s ON s.envelope_id=t.envelope_id WHERE t.id=? AND s.status='DONE' ORDER BY s.sequence DESC LIMIT 1`).bind(task).first<{envelope_id:string;id:string;sha256:string}>();
    if (signed) return {id:signed.id,sha256:signed.sha256,object_key:artifactObjectKey(signed.envelope_id,signed.id)};
    const d0=await c.env.DB.prepare(`SELECT a.id,a.sha256,a.object_key FROM tasks t JOIN artifacts a ON a.envelope_id=t.envelope_id WHERE t.id=? AND NOT EXISTS (SELECT 1 FROM signatures s WHERE s.envelope_id=t.envelope_id)`).bind(task).first<{id:string;sha256:string;object_key:string}>();
    if (!d0) throw new Error('Artifact unavailable');return d0;
  }
  async function fieldsFor(c:import('hono').Context<Env>) {
    const task=await authorizeRecipientSession(c.env.DB,pageToken(c),requestOrigin(c),Date.now());
    const row=await c.env.DB.prepare('SELECT t.role,t.recipient_name,t.recipient_email,p.roles_json,p.fields_json FROM tasks t JOIN envelopes e ON e.id=t.envelope_id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id WHERE t.id=?').bind(task).first<{role:string;recipient_name:string;recipient_email:string;roles_json:string;fields_json:string}>();
    if(!row)throw new Error('Missing template');const raw:unknown=JSON.parse(row.fields_json);if(!Array.isArray(raw))throw new Error('Invalid fields');
    // The page shows Date signed and Title fields only when the template has any.
    const hasTextFields=raw.some((f:any)=>f.type==='Date signed'||f.type==='Title');
    const all=raw.length?validateFields(raw,JSON.parse(row.roles_json),100):[];assertNoOverlappingFields(all);
    return {task,all,fields:all.filter(f=>f.role===row.role),role:row.role,recipientName:row.recipient_name,recipientEmail:row.recipient_email,hasTextFields,fieldsJson:row.fields_json,rolesJson:row.roles_json};
  }
  /** Earlier signers signed against the same placed fields as this signer sees. */
  async function assertSameTemplate(db: D1Database, task: string, all: TemplateField[]): Promise<void> {
    const prior=(await db.prepare('SELECT s.render_json FROM tasks t JOIN signatures s ON s.envelope_id=t.envelope_id WHERE t.id=?').bind(task).all<{render_json:string}>()).results;
    if(prior.some(p=>{const render=JSON.parse(p.render_json) as {kind?:unknown;template?:unknown};return render.kind!=='fields'||canonicalJson(render.template)!==canonicalJson(all);}))throw new Error('Template snapshot changed');
  }
  app.get('/api/public/signing/current', async c => {try {const a=await current(c,{verified:false}),details=await fieldsFor(c);
    // The signer's title and company (when the host named them), the document's version and
    // sender, and the one sentence they agree to.
    const who=await signerContext(c.env.DB,details.task);
    const session=await sessionContext(c.env.DB,pageToken(c));
    // How the host said it signed this recipient in, for "Confirm it's you".
    const hostAuthentication=session?await lastHostAuthentication(c.env.DB,session.envelopeId,session.taskId):null;
    // Who signs before and after this signer, for "After you sign".
    const order=await c.env.DB.prepare('SELECT SUM(CASE WHEN o.routing_order<t.routing_order THEN 1 ELSE 0 END) AS before, SUM(CASE WHEN o.routing_order>t.routing_order THEN 1 ELSE 0 END) AS after FROM tasks t JOIN tasks o ON o.envelope_id=t.envelope_id WHERE t.id=?').bind(details.task).first<{before:number|null;after:number|null}>();
    const nextRow=await c.env.DB.prepare('SELECT n.recipient_name AS name, n.details_json AS details FROM tasks t JOIN tasks n ON n.envelope_id=t.envelope_id AND n.routing_order=t.routing_order+1 WHERE t.id=?').bind(details.task).first<{name:string;details:string}>();
    const nextCompany=nextRow?taskDetails(nextRow.details).onBehalfOf:undefined;
    const next=nextRow?{name:nextRow.name,...(nextCompany?{organization:nextCompany}:{})}:undefined;
    return c.json({id:a.id,sha256:a.sha256,verified:await sessionVerified(c,details.task),disclosure:{version:CONSENT_DISCLOSURE.version,text:CONSENT_DISCLOSURE.text},intent:consentStatement(who.documentName,who.documentVersion,who.facts.onBehalfOf),signerName:details.recipientName,recipientEmail:details.recipientEmail,
      ...(who.documentName?{documentName:who.documentName}:{}),...(who.documentVersion?{documentVersion:who.documentVersion}:{}),
      ...(who.sender?{sender:{name:who.sender.name,...(who.sender.organization?{organization:who.sender.organization}:{})}}:{}),
      ...(hostAuthentication?{hostAuthentication}:{}),signers:{before:order?.before??0,after:order?.after??0,...(next?{next}:{})},...(who.afterSigning.length?{afterSigning:who.afterSigning}:{}),
      ...(who.facts.title||who.facts.onBehalfOf?{signer:who.facts}:{}),...(details.fields.length?{fields:details.fields,role:details.role,recipientName:details.recipientName,...(details.hasTextFields?{v3:true}:{})}:{})});} catch {return c.json({error:'unavailable'},401);}});
  // The signer whose turn it is declines, after the code, with a reason: the envelope ends for
  // everyone, and the audit trail records who declined, why, and from where.
  app.post('/api/public/signing/decline', async c => {
    let body: {reason?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    const reason=typeof body?.reason==='string'?body.reason.trim():'';
    if(!reason)return c.json({error:'reason_required'},422);
    if(reason.length>1000)return c.json({error:'reason_too_long'},422);
    try {await current(c);} catch {return c.json({error:'unavailable'},401);}
    const session=await sessionContext(c.env.DB,pageToken(c));
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
  // A preview of one of the signer's fields as it will be drawn: a Signature (the typed name), a
  // Title (the title given on Review) or a Date signed (the server's date, no text sent). A failure
  // is 422: signature_does_not_fit for a Signature field, title_does_not_fit for a Title that does
  // not fit, otherwise invalid_preview.
  app.post('/api/public/signing/preview',async c=>{let type='';try{
    const artifact=await current(c),{task,fields,all,hasTextFields,fieldsJson,rolesJson}=await fieldsFor(c),body=await c.req.json() as {fieldId?:unknown;text?:unknown};
    const field=fields.find(f=>f.id===body.fieldId);if(!field)throw new Error('Unauthorized field');type=field.type;
    if(field.type==='Signature'){
      if(typeof body.text!=='string')throw new Error('Invalid signature');
      await assertSameTemplate(c.env.DB,task,all);
      const source=await c.env.ARTIFACTS.get(artifact.object_key);if(!source)throw new Error('Missing input');const bytes=await source.arrayBuffer();if(await sha256(bytes)!==artifact.sha256)throw new Error('Input mismatch');
      const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});validateFieldsPdf(pdf);if(field.page>pdf.getPageCount())throw new Error('Invalid page');validateFieldPlacement(pdf,all);
      const image=await renderTypedSignature(body.text),page=pdf.getPage(field.page-1),g=signatureGeometry(page,field,image);assertSignatureGeometrySafe(page,field,g,all);
      return c.body(Uint8Array.from(image).buffer,200,{'Content-Type':'image/png','X-Content-Type-Options':'nosniff','X-Signature-Width':String(g.width/(field.rect.width*page.getWidth())),'X-Signature-Height':String(g.height/(field.rect.height*page.getHeight())),'X-Signature-Preview':await signaturePreviewHash(artifact.sha256,rolesJson,fieldsJson,field.id,body.text,await sha256(Uint8Array.from(image).buffer),g),'Access-Control-Expose-Headers':'X-Signature-Width, X-Signature-Height, X-Signature-Preview'});
    }
    if(!hasTextFields||!['Title','Date signed'].includes(field.type))throw new Error('Unauthorized field');
    await assertSameTemplate(c.env.DB,task,all);
    const now=Date.now(),text=field.type==='Date signed'?new Date(now).toISOString().slice(0,10):body.text;
    if(field.type==='Date signed'&&body.text!==undefined)throw new Error('Unexpected date');if(typeof text!=='string'||(field.type==='Title'&&(!text||text.length>128||text.trim()!==text||!/^[\x20-\x7e]+$/.test(text))))throw new Error('Invalid text');
    const headers:Record<string,string>={'Content-Type':'image/png','X-Content-Type-Options':'nosniff','X-Preview-Text':text};
    const image=Uint8Array.from(await renderText(text));
    const source=await c.env.ARTIFACTS.get(artifact.object_key);if(!source)throw new Error('Missing input');const bytes=await source.arrayBuffer();if(await sha256(bytes)!==artifact.sha256)throw new Error('Input mismatch');const pdf=await PDFDocument.load(bytes,{updateMetadata:false,throwOnInvalidObject:true});if(field.page<1||field.page>pdf.getPageCount())throw new Error('Invalid page');validateFieldsPdf(pdf);validateFieldPlacement(pdf,all);const page=pdf.getPage(field.page-1);assertTextFits(page,field,image);const geometry=textGeometry(page,field,image);
    headers['X-Text-Width']=String(geometry.width/(field.rect.width*page.getWidth()));headers['X-Text-Height']=String(geometry.height/(field.rect.height*page.getHeight()));
    // Title: a receipt binding the image and its place, checked when signing. Date signed: the
    // date shown, which the sign request repeats; another date by then is refused (date_changed).
    if(field.type==='Title')headers['X-Text-Preview']=await signaturePreviewHash(artifact.sha256,rolesJson,fieldsJson,field.id,text,await sha256(image.buffer),geometry);
    headers['Access-Control-Expose-Headers']=field.type==='Title'?'X-Text-Preview, X-Preview-Text, X-Text-Width, X-Text-Height':'X-Preview-Text, X-Text-Width, X-Text-Height';
    return c.body(image.buffer,200,headers);
  }catch(error){return c.json({error:type==='Signature'?'signature_does_not_fit':error instanceof TextDoesNotFitError?'title_does_not_fit':'invalid_preview'},422);}});
  app.get('/api/public/signing/pdf', async c => {try {const a=await current(c,{verified:false}), file=await c.env.ARTIFACTS.get(a.object_key);if (!file) throw new Error('Missing');const bytes=await file.arrayBuffer();if (await sha256(bytes)!==a.sha256) throw new Error('Mismatch');
    const session=await sessionContext(c.env.DB,pageToken(c));if(session)await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.documentViewed,...requestFacts(c.req.raw),detail:{artifactId:a.id,artifactSha256:a.sha256}});
    return c.body(bytes,200,{'Content-Type':'application/pdf','X-Content-Type-Options':'nosniff'});} catch {return c.json({error:'unavailable'},401);}});
  // Which pages the signer has looked at (CS-PRM-042: "Viewed 4 of 4 pages"). Each page is
  // recorded once, in a PAGES_VIEWED audit event listing the pages seen for the first time; it
  // never blocks signing. The page session is enough, as for reading the document.
  app.post('/api/public/signing/page-views', bodyLimit({maxSize:2048}), async c => {
    let body: {pages?:unknown;total?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    const total=body?.total, pages=body?.pages;
    if (!Number.isSafeInteger(total) || (total as number)<1 || (total as number)>MAX_VIEWED_PAGES || !Array.isArray(pages) || pages.length>MAX_VIEWED_PAGES || !pages.every(p=>Number.isSafeInteger(p) && p>=1 && p<=(total as number))) return c.json({error:'invalid_request'},400);
    let task:string;try {task=await authorizeRecipientSession(c.env.DB,pageToken(c),requestOrigin(c),Date.now());} catch {return c.json({error:'unavailable'},401);}
    const session=await sessionContext(c.env.DB,pageToken(c));
    if (!session || session.taskId!==task) return c.json({error:'unavailable'},401);
    const seen=await viewedPages(c.env.DB,session.envelopeId,task);
    const fresh=[...new Set(pages as number[])].filter(p=>!seen.has(p)).sort((a,b)=>a-b);
    if (fresh.length) await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:task,type:AUDIT.pagesViewed,...requestFacts(c.req.raw),detail:{pages:fresh,total}});
    return c.json({viewed:seen.size+fresh.length,total});
  });
  // COMPLETE_AFTER_SIGN: once a signature is accepted, render it and, after the last one, seal the
  // envelope (KMS and the timestamp authority). With the request's waitUntil (Nitro on Workers) that
  // runs after the signer's response, so they never wait for the seal; without it (the tests), in the
  // request. Work cut short (a CPU limit, an outage) leaves the signature PENDING or the envelope
  // FINALIZING, which due work finishes: the platform's five-minute tick (POST /api/scheduled), or
  // POST /api/process-due at once. It is the only way envelopes finish while the setting is off.
  app.use('/api/public/signing/sign', async (c, next) => {
    await next();
    if (c.res.status !== 202 || c.env.COMPLETE_AFTER_SIGN !== 'true') return;
    const work = completeEnvelopeOfSession(c.env,pageToken(c))
      .catch(() => console.error('E-sign: finishing the envelope after a signature failed; process-due retries it'));
    if (c.env.WAIT_UNTIL) c.env.WAIT_UNTIL(work);
    else await work;
  });
  app.post('/api/public/signing/sign', async c => {
    let body: {artifactId?:unknown;artifactHash?:unknown;consent?:unknown;signatures?:unknown;datePreviews?:unknown;signaturePreviews?:unknown;textPreviews?:unknown;disclosureVersion?:unknown;title?:unknown;authorityConfirmed?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    if (!body || typeof body.artifactId !== 'string' || typeof body.artifactHash !== 'string' || body.consent !== true) return c.json({error:'invalid_request'},400);
    // The signer consents to the disclosure the page showed; refuse consent to an older one.
    if (body.disclosureVersion !== undefined && body.disclosureVersion !== CONSENT_DISCLOSURE.version) return c.json({error:'disclosure_changed'},409);
    const token=pageToken(c);
    // Signing for a company: the signer gives a title and confirms they may bind it.
    const who=await sessionContext(c.env.DB,token).then(s=>s?signerContext(c.env.DB,s.taskId):null).catch(()=>null);
    const signerTitle=parseSignerTitle(body.title);
    if(signerTitle==='invalid')return c.json({error:'invalid_request'},400);
    if(who?.facts.onBehalfOf){
      if(!signerTitle)return c.json({error:'title_required'},422);
      if(body.authorityConfirmed!==true)return c.json({error:'authority_required'},422);
    }
    // The sentence the signer agreed to by ticking the box: always recorded, by its SHA-256.
    const intent=consentStatement(who?.documentName??null,who?.documentVersion??null,who?.facts.onBehalfOf);
    const authority={...(signerTitle?{title:signerTitle}:{}),...(who?.facts.onBehalfOf?{onBehalfOf:who.facts.onBehalfOf,authorityConfirmed:true}:{}),intentSha256:await sha256Hex(intent)};
    // A retried request (same session, same document, same values) gets the signature it made.
    const replay=async () => {
      const id=await retrySignature(c.env.DB,c.env.ARTIFACTS,{token,origin:requestOrigin(c),now:Date.now(),artifactId:body.artifactId as string,artifactHash:body.artifactHash as string,values:body.signatures,datePreviews:body.datePreviews});
      return id?{id}:null;
    };
    const existing=await replay();if (existing) return c.json(existing,202);
    try {const a=await current(c);if (a.id!==body.artifactId || a.sha256!==body.artifactHash) throw new Error('Stale artifact');const file=await c.env.ARTIFACTS.get(a.object_key);if (!file || await sha256(await file.arrayBuffer())!==a.sha256) throw new Error('Input mismatch');
      const {fields,hasTextFields}=await fieldsFor(c);const command={token,origin:requestOrigin(c),now:Date.now(),artifactId:a.id,artifactHash:a.sha256};
      // A Title field shows the title the signer gave on Review, nothing else.
      if(hasTextFields&&fields.some(f=>f.type==='Title')){const values=body.signatures as Record<string,unknown>|undefined;if(!signerTitle||signerTitle==='invalid'||fields.some(f=>f.type==='Title'&&values?.[f.id]!==signerTitle))return c.json({error:'title_mismatch'},422);}
      const disclosure=await consentDisclosure();
      const id=await recordSignature(c.env.DB,c.env.ARTIFACTS,{...command,consent:true,values:body.signatures,signaturePreviews:body.signaturePreviews,textPreviews:body.textPreviews,datePreviews:body.datePreviews,disclosure:{version:disclosure.version,sha256:disclosure.sha256},authority});
      const session=await sessionContext(c.env.DB,token);
      if(session)await recordAuditQuietly(c.env.DB,{envelopeId:session.envelopeId,taskId:session.taskId,type:AUDIT.signed,...requestFacts(c.req.raw),detail:{signatureId:id,artifactId:a.id,artifactSha256:a.sha256,consentDisclosureVersion:disclosure.version,consentDisclosureSha256:disclosure.sha256,...authority}});
      return c.json({id},202);
    } catch (error) {const raced=await replay();return raced ? c.json(raced,202) : c.json({error:error instanceof DateChanged?'date_changed':'signature_rejected'},409);}
  });
  app.get('/api/envelopes/:id/delivery-pdf', whenSigningEnabled, async c => {
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
        const testKey=testSealKey(c.env);if(!testKey) return c.json({error:'unavailable'},503);
        result=await deliveryPdf(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),id,testKey);
      }
      return c.body(Uint8Array.from(result.bytes).buffer,200,{'Content-Type':'application/pdf','Content-Disposition':`inline; filename="${result.metadata.format==='esign-local-delivery-v3'?'delivery-local-test':'delivery'}.pdf"`,'X-Content-Type-Options':'nosniff'});
    } catch {return c.json({error:'unavailable'},503);}
  });
  // A signer's copy, from the link in their completion notice (signed-copies.ts): the /copy page
  // posts the token from its fragment, once. The delivery PDF is built from the stored records.
  app.post('/api/public/copies/open', whenSigningEnabled, bodyLimit({maxSize:1024}), async c => {
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({error:'forbidden'},403);
    let body: {token?:unknown};try {body=await c.req.json();} catch {return c.json({error:'invalid_request'},400);}
    const link=typeof body?.token==='string'?await useCopyLink(c.env.DB,body.token):null;
    if(!link)return c.json({error:'link_unavailable'},410);
    try {
      const managed=await hasManagedEvidence(c.env.DB,link.envelopeId)?await managedEvidenceFromEnv(c.env):null;
      const testKey=managed?null:testSealKey(c.env);
      if(!managed&&!testKey)throw new Error('Seal unavailable');
      const result=await deliveryPdf(c.env.DB,c.env.ARTIFACTS,link.tenantId,link.envelopeId,managed?managedDelivery(c.env.DB,c.env.ARTIFACTS,link.tenantId,link.envelopeId,managed.trust):testKey!);
      await recordAuditQuietly(c.env.DB,{envelopeId:link.envelopeId,taskId:link.taskId,type:AUDIT.copyDownloaded,...requestFacts(c.req.raw)});
      return c.body(Uint8Array.from(result.bytes).buffer,200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="signed-${link.envelopeId}.pdf"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    } catch {
      // The copy could not be built this time: the link works again, rather than being spent on a failure.
      await releaseCopyLink(c.env.DB,body.token as string);
      return c.json({error:'unavailable'},503);
    }
  });
  app.get('/api/envelopes/:id/certificate', whenSigningEnabled, async c => {
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
      const testKey=testSealKey(c.env);if(!testKey) return c.json({error:'unavailable'},503);
      const verified=await finalizeLocalTestEvidence(c.env.DB,c.env.ARTIFACTS,c.get('tenantId'),id,testKey,true);
      return c.json({mode:'LOCAL TEST ONLY',notice:'Not a legal guarantee. Local HMAC is not a real KMS or TSA; the synthetic timestamp is not independent. This separate view is not the signed PDF.',binding:'Source, signatures, event links and output hashes are checked against the existing local HMAC manifest and stored files. Envelope metadata and recipient task details are current database values, not bound by that manifest.',envelope,recipients:await recipients(),...verified,audit:{sealed:[],afterSeal:await auditTrail(c.env.DB,id)}});
    } catch {return c.json({error:'unavailable'},503);}
  });
}
