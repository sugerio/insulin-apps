import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { PDFDocument } from 'pdf-lib';
import { assertNoOverlappingFields } from './template-fields.ts';
import { positionedFields, validatePositionedPdf, validatePositionedPlacement } from './positioned-template.ts';
import {positionedV3Fields} from './positioned-v3-snapshot.ts';
import { assertRenderableRecipientNames } from './recipient-name.ts';
import { prepareEnvelope } from './prepare.ts';
import { localSigningEnabled, mountLocalSigningRoutes } from './local-signing-routes.ts';
import { mountEditorRoutes } from './editor-routes.ts';
import { demoPage, EMBEDDABLE_HEADERS, signingPage } from './signing-page.ts';
import { sweepEnvelopes } from './envelope-completion.ts';

const MAX_PDF_BYTES = 5 * 1024 * 1024;
type Bindings = {
  DB: D1Database; ARTIFACTS: R2Bucket; TEST_MAIL?: R2Bucket; ASSETS?: Fetcher;
  LOCAL_TEST_MODE?: string; LOCAL_TEST_OTP_KEY?: string; LOCAL_TEST_SEAL_KEY?: string;
  /** "true": finish each envelope after every accepted signature (see envelope-completion.ts). */
  COMPLETE_AFTER_SIGN?: string;
  /** Space-separated origins allowed to embed the signing page at /sign. */
  SIGNING_PAGE_FRAME_ANCESTORS?: string;
};
type Env = { Bindings: Bindings; Variables: { tenantId: string } };

export const managementAuth = async (context: import('hono').Context<Env>, next: import('hono').Next) => {
  const authorization = context.req.header('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization);
  if (!match) return context.json({ error: 'unauthorized' }, 401);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  const row = await context.env.DB.prepare('SELECT tenant_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').bind(hash).first<{ tenant_id: string }>();
  if (!row) return context.json({ error: 'unauthorized' }, 401);
  context.set('tenantId', row.tenant_id);
  await next();
};
function createApp(v3TestOnly: boolean) {
const app = new Hono<Env>();
app.get('/health', (context) => context.json({ status: 'ok', service: 'esign', mode: 'experimental' }));
const supportedFields=(raw:string,roles:string[],pages:number)=>v3TestOnly?positionedV3Fields(JSON.parse(raw),roles,pages):positionedFields(raw,roles,pages);
app.use('/v1/me', managementAuth);
app.use('/v1/templates', managementAuth);
app.use('/v1/templates/*', managementAuth);
app.use('/v1/envelopes', managementAuth);
app.use('/v1/envelopes/*', managementAuth);
app.use('/v1/test-mail/*', managementAuth);

mountEditorRoutes(app, managementAuth);
app.get('/assets/*', async (context) => {
  if (!context.env.ASSETS) return context.notFound();
  const asset = await context.env.ASSETS.fetch(context.req.raw);
  const response = new Response(asset.body, asset);
  // Scripts started as Web Workers (pdf.js) by a COEP require-corp page need COEP as well.
  for (const [name, value] of Object.entries(EMBEDDABLE_HEADERS)) response.headers.set(name, value);
  return response;
});

// The recipient signing page, for the host to embed: <origin>/sign#code=<recipient-view code>.
app.get('/sign', async (context) => {
  if (!localSigningEnabled(context.env)) return context.notFound();
  return (await signingPage(context.req.raw, context.env.ASSETS, context.env.SIGNING_PAGE_FRAME_ANCESTORS)) ?? context.notFound();
});

// A page to try the whole flow with a tenant key: upload, sign, download (ui/DemoPage.ts).
app.get('/demo', async (context) => {
  if (!localSigningEnabled(context.env)) return context.notFound();
  return (await demoPage(context.req.raw, context.env.ASSETS)) ?? context.notFound();
});

app.get('/v1/me', (context) => context.json({ tenantId: context.get('tenantId') }));

app.post('/v1/templates', bodyLimit({ maxSize: MAX_PDF_BYTES + 65536 }), async (context) => {
  if (!context.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data;')) return context.json({ error: 'multipart_required' }, 400);
  let form: FormData;
  try { form = await context.req.formData(); } catch { return context.json({ error: 'invalid_multipart' }, 400); }
  const file = form.get('file');
  const rawRoles = form.get('roles');
  if (!(file instanceof File) || typeof rawRoles !== 'string' || file.size === 0) return context.json({ error: 'invalid_template' }, 400);
  if (file.size > MAX_PDF_BYTES) return context.json({ error: 'too_large' }, 413);
  let roles: unknown;
  try { roles = JSON.parse(rawRoles); } catch { return context.json({ error: 'invalid_roles' }, 422); }
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > 20 || roles.some((r) => typeof r !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r)) || new Set(roles).size !== roles.length) return context.json({ error: 'invalid_roles' }, 422);
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const pdf = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > 100) throw new Error('invalid page count');
  } catch { return context.json({ error: 'invalid_pdf' }, 422); }
  const id = crypto.randomUUID();
  const key = `templates/${id}/source.pdf`;
  const stored = await context.env.ARTIFACTS.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/pdf' } });
  if (!stored) return context.json({ error: 'storage_conflict' }, 503);
  // An ambiguous D1 failure may have committed. Keep the object for later reconciliation;
  // deleting it here could leave a committed template without its source.
  await context.env.DB.prepare('INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, context.get('tenantId'), key, JSON.stringify(roles), Date.now()).run();
  return context.json({ id, roles }, 201);
});

app.get('/v1/templates', async context => {
  const params=new URL(context.req.url).searchParams;
  if([...params.keys()].some(key=>key!=='cursor')||params.getAll('cursor').length>1)return context.json({error:'invalid_cursor'},400);
  const cursor=params.get('cursor')??'',tenant=context.get('tenantId');
  if(cursor&&!/^[A-Za-z0-9_-]{1,128}$/.test(cursor))return context.json({error:'invalid_cursor'},400);
  const previous=cursor?await context.env.DB.prepare('SELECT id,created_at FROM templates WHERE tenant_id=? AND id=?').bind(tenant,cursor).first<{id:string;created_at:number}>():null;
  if(cursor&&!previous)return context.json({error:'invalid_cursor'},400);
  const rows=(await context.env.DB.prepare('SELECT id,created_at FROM templates WHERE tenant_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 21').bind(tenant,previous?.id??null,previous?.created_at??0,previous?.created_at??0,previous?.id??'').all<{id:string;created_at:number}>()).results;
  return context.json({templates:rows.slice(0,20).map(row=>({id:row.id,createdAt:row.created_at})),nextCursor:rows.length>20?rows[19].id:null});
});

app.get('/v1/templates/:id', async (context) => {
  const row = await context.env.DB.prepare('SELECT * FROM templates WHERE id = ? AND tenant_id = ?')
    .bind(context.req.param('id'), context.get('tenantId')).first<{ id: string; roles_json: string; fields_json?: string }>();
  if (!row) return context.json({ error: 'not_found' }, 404);
  let hasPositionedFields = false;
  if (row.fields_json !== undefined) {
    try { const fields: unknown = JSON.parse(row.fields_json); hasPositionedFields = !Array.isArray(fields) || fields.length > 0; }
    catch { hasPositionedFields = true; }
  }
  let positionedFieldsSupported=false;
  if(hasPositionedFields){try{
    const source=await context.env.DB.prepare('SELECT object_key FROM templates WHERE id=? AND tenant_id=?').bind(row.id,context.get('tenantId')).first<{object_key:string}>();
    const object=source&&await context.env.ARTIFACTS.get(source.object_key);if(!object||object.size>MAX_PDF_BYTES)throw new Error('Missing source');
    const pdf=await PDFDocument.load(await object.arrayBuffer(),{throwOnInvalidObject:true,updateMetadata:false});validatePositionedPdf(pdf);const fields=supportedFields(row.fields_json!,JSON.parse(row.roles_json),pdf.getPageCount());assertNoOverlappingFields(fields);validatePositionedPlacement(pdf,fields);positionedFieldsSupported=true;
  }catch{positionedFieldsSupported=false;}}
  return context.json({ id: row.id, roles: JSON.parse(row.roles_json), hasPositionedFields, positionedFieldsSupported });
});

app.post('/v1/envelopes', bodyLimit({ maxSize: 32768 }), async (context) => {
  const key = context.req.header('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) return context.json({ error: 'idempotency_key_required' }, 400);
  let body: unknown;
  try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_envelope' }, 422);
  const input = body as { templateId?: unknown; recipients?: unknown };
  if (typeof input.templateId !== 'string' || !Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > 20) return context.json({ error: 'invalid_envelope' }, 422);
  const recipients: { role: string; name: string; email: string }[] = [];
  for (const recipient of input.recipients) {
    if (!recipient || typeof recipient !== 'object' || typeof recipient.role !== 'string' || typeof recipient.name !== 'string' || typeof recipient.email !== 'string' || !recipient.name.trim() || recipient.name.length > 200 || recipient.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email)) return context.json({ error: 'invalid_recipient' }, 422);
    recipients.push({ role: recipient.role, name: recipient.name, email: recipient.email });
  }
  const tenantId = context.get('tenantId');
  const encoded = JSON.stringify({ templateId: input.templateId, recipients });
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))), (n) => n.toString(16).padStart(2, '0')).join('');
  const lookup = () => context.env.DB.prepare('SELECT request_hash, response_json FROM idempotency_keys WHERE tenant_id = ? AND idempotency_key = ?').bind(tenantId, `envelope:${key}`).first<{ request_hash: string; response_json: string }>();
  const existing = await lookup();
  if (existing) return existing.request_hash === hash ? context.json(JSON.parse(existing.response_json), 201) : context.json({ error: 'idempotency_conflict' }, 409);
  try { await assertRenderableRecipientNames(recipients.map((recipient) => recipient.name)); }
  catch { return context.json({ error: 'unsupported_recipient_name' }, 422); }
  const template = await context.env.DB.prepare('SELECT * FROM templates WHERE id = ? AND tenant_id = ?').bind(input.templateId, tenantId).first<{ roles_json: string; fields_json?: string }>();
  if (!template) return context.json({ error: 'not_found' }, 404);
  const roles = JSON.parse(template.roles_json) as string[];
  if (template.fields_json !== undefined) {
    try {
      const raw:unknown=JSON.parse(template.fields_json);
      if(!Array.isArray(raw))throw new Error('Invalid fields');
      if(raw.length){
        const source=await context.env.DB.prepare('SELECT object_key FROM templates WHERE id=? AND tenant_id=?').bind(input.templateId,tenantId).first<{object_key:string}>();
        const object=source&&await context.env.ARTIFACTS.get(source.object_key);if(!object||object.size>MAX_PDF_BYTES)throw new Error('Source unavailable');
        const pdf=await PDFDocument.load(await object.arrayBuffer(),{throwOnInvalidObject:true,updateMetadata:false});validatePositionedPdf(pdf);const fields=supportedFields(template.fields_json,roles,pdf.getPageCount());assertNoOverlappingFields(fields);validatePositionedPlacement(pdf,fields);
      }
    } catch { return context.json({ error: 'positioned_fields_not_supported' }, 422); }
  }
  if (roles.length !== recipients.length || new Set(recipients.map((r) => r.role)).size !== roles.length || recipients.some((r) => !roles.includes(r.role))) return context.json({ error: 'invalid_roles' }, 422);
  const id = crypto.randomUUID();
  const response = { id, status: 'PROCESSING' };
  const statements = [
    context.env.DB.prepare('INSERT INTO idempotency_keys (tenant_id, idempotency_key, request_hash, response_json) VALUES (?, ?, ?, ?)').bind(tenantId, `envelope:${key}`, hash, JSON.stringify(response)),
    context.env.DB.prepare('INSERT INTO envelopes (id, tenant_id, template_id, status, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, tenantId, input.templateId, 'PROCESSING', Date.now()),
    ...recipients.map((recipient, index) => context.env.DB.prepare('INSERT INTO tasks (id, envelope_id, role, recipient_name, recipient_email, routing_order, status) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), id, recipient.role, recipient.name, recipient.email, index + 1, 'PENDING')),
  ];
  try { await context.env.DB.batch(statements); }
  catch (error) {
    const raced = await lookup();
    if (raced) return raced.request_hash === hash ? context.json(JSON.parse(raced.response_json), 201) : context.json({ error: 'idempotency_conflict' }, 409);
    throw error;
  }
  return context.json(response, 201);
});

app.get('/v1/envelopes/:id', async (context) => {
  const id = context.req.param('id');
  const tenantId = context.get('tenantId');
  const envelope = await context.env.DB.prepare('SELECT id, template_id, status, created_at FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ id: string; template_id: string; status: string; created_at: number }>();
  if (!envelope) return context.json({ error: 'not_found' }, 404);
  const tasks = await context.env.DB.prepare('SELECT id, role, recipient_name, recipient_email, routing_order, status FROM tasks WHERE envelope_id = ? ORDER BY routing_order').bind(id).all<{ id: string; role: string; recipient_name: string; recipient_email: string; routing_order: number; status: string }>();
  return context.json({ id: envelope.id, templateId: envelope.template_id, status: envelope.status, createdAt: envelope.created_at, tasks: tasks.results.map((task) => ({ id: task.id, role: task.role, recipientName: task.recipient_name, recipientEmail: task.recipient_email, routingOrder: task.routing_order, status: task.status })) });
});

app.post('/v1/envelopes/:id/prepare', async (context) => {
  const id = context.req.param('id');
  const tenantId = context.get('tenantId');
  const exists = await context.env.DB.prepare('SELECT id FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first();
  if (!exists) return context.json({ error: 'not_found' }, 404);
  try { await prepareEnvelope(context.env.DB, context.env.ARTIFACTS, tenantId, id); }
  catch { return context.json({ error: 'preparation_failed' }, 503); }
  return context.body(null, 204);
});

mountLocalSigningRoutes(app, v3TestOnly);
return app;
}

// Explicit local loopback demo and in-process tests only; never the Worker entrypoint.
export const createV3TestApp = () => createApp(true);

/** Cron trigger: finishes envelopes that the after-signature work did not (see envelope-completion.ts). */
async function scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
  if (!localSigningEnabled(env)) return;
  ctx.waitUntil(sweepEnvelopes(env).then((counts) => {
    if (counts.failed) console.error(`E-sign: ${counts.failed} envelope(s) could not be finished; the next run retries them`);
  }));
}

// The Hono app stays the default export (scripts mount it with app.route); the Worker
// runtime also finds the cron handler on it.
export default Object.assign(createApp(false), { scheduled });
