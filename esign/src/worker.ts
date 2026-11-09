import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AUDIT, requestFacts } from './audit.ts';
import { expireDueEnvelopes, expireIfDue, parseDeadline } from './task-expiry.ts';
import { parseDocumentName, parseNamedBy, parseSender, parseSignerFacts, type SignerFacts } from './signer-facts.ts';
import { CERTIFICATE_VERSION } from './delivery-pdf.ts';
import type { EnvelopeDetails, TaskDetails } from './details.ts';
import { PDFDocument } from 'pdf-lib';
import { assertNoOverlappingFields } from './template-fields.ts';
import { validatePositionedPdf, validatePositionedPlacement } from './positioned-template.ts';
import {positionedV3Fields} from './positioned-v3-snapshot.ts';
import { assertRenderableRecipientNames } from './recipient-name.ts';
import { envelopeIdFor, InitialDocumentConflict, storeInitialDocument } from './prepare.ts';
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
  SIGNING_PAGE_ORIGINS?: string;
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
function createApp() {
const app = new Hono<Env>();
app.get('/health', (context) => context.json({ status: 'ok', service: 'esign', mode: 'experimental' }));
// The placed fields a document can be signed with: Signature, Date signed and Title.
const supportedFields=(raw:string,roles:string[],pages:number)=>positionedV3Fields(JSON.parse(raw),roles,pages);
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
  return context.json({ id: row.id, roles: JSON.parse(row.roles_json), hasPositionedFields, positionedFieldsSupported, fields: placedFields(row.fields_json) });
});

/**
 * The placed fields as a host previews them: type, role, page (1-based) and the box in
 * normalized coordinates of the displayed page (top-left origin). Ids and flags stay inside.
 */
function placedFields(raw: string | undefined): { type: string; role: string; page: number; rect: { x: number; y: number; width: number; height: number } }[] {
  if (raw === undefined) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const out: { type: string; role: string; page: number; rect: { x: number; y: number; width: number; height: number } }[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const f = item as { type?: unknown; role?: unknown; page?: unknown; rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } };
    const r = f.rect;
    if (typeof f.type !== 'string' || typeof f.role !== 'string' || !Number.isSafeInteger(f.page) || !r || typeof r !== 'object') continue;
    const { x, y, width, height } = r;
    if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    out.push({ type: f.type, role: f.role, page: f.page as number, rect: { x: x as number, y: y as number, width: width as number, height: height as number } });
  }
  return out;
}

app.post('/v1/envelopes', bodyLimit({ maxSize: 32768 }), async (context) => {
  const key = context.req.header('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) return context.json({ error: 'idempotency_key_required' }, 400);
  let body: unknown;
  try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_envelope' }, 422);
  const input = body as { templateId?: unknown; recipients?: unknown; documentName?: unknown; sender?: unknown };
  // The document's name, shown to the signer and named in the intent statement.
  const documentName = parseDocumentName(input.documentName);
  if (documentName === 'invalid') return context.json({ error: 'invalid_envelope' }, 422);
  // Who sent it, for the certificate.
  const sender = parseSender(input.sender);
  if (sender === 'invalid') return context.json({ error: 'invalid_envelope' }, 422);
  if (typeof input.templateId !== 'string' || !Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > 20) return context.json({ error: 'invalid_envelope' }, 422);
  const recipients: { role: string; name: string; email: string; expiresAt?: string }[] = [];
  const deadlines: (number | null)[] = [];
  const signerFacts: SignerFacts[] = [];
  const namedBy: (string | null)[] = [];
  for (const recipient of input.recipients) {
    if (!recipient || typeof recipient !== 'object' || typeof recipient.role !== 'string' || typeof recipient.name !== 'string' || typeof recipient.email !== 'string' || !recipient.name.trim() || recipient.name.length > 200 || recipient.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email)) return context.json({ error: 'invalid_recipient' }, 422);
    // A sign-by deadline for this recipient (ISO 8601, future, within 400 days).
    const deadline = parseDeadline((recipient as { expiresAt?: unknown }).expiresAt);
    if (deadline === 'invalid') return context.json({ error: 'invalid_recipient' }, 422);
    deadlines.push(deadline);
    // The signer's title and the company they sign for (evidence of authority).
    const facts = parseSignerFacts(recipient as { title?: unknown; onBehalfOf?: unknown });
    if (facts === 'invalid') return context.json({ error: 'invalid_recipient' }, 422);
    signerFacts.push(facts);
    // Who named this signer, for the certificate.
    const named = parseNamedBy((recipient as { namedBy?: unknown }).namedBy);
    if (named === 'invalid') return context.json({ error: 'invalid_recipient' }, 422);
    namedBy.push(named);
    recipients.push({ role: recipient.role, name: recipient.name, email: recipient.email, ...(deadline === null ? {} : { expiresAt: new Date(deadline).toISOString() }), ...facts, ...(named ? { namedBy: named } : {}) });
  }
  const tenantId = context.get('tenantId');
  const encoded = JSON.stringify({ templateId: input.templateId, recipients, ...(documentName ? { documentName } : {}), ...(sender ? { sender } : {}) });
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))), (n) => n.toString(16).padStart(2, '0')).join('');
  const lookup = () => context.env.DB.prepare('SELECT request_hash, response_json FROM idempotency_keys WHERE tenant_id = ? AND idempotency_key = ?').bind(tenantId, `envelope:${key}`).first<{ request_hash: string; response_json: string }>();
  const existing = await lookup();
  if (existing) return existing.request_hash === hash ? context.json(JSON.parse(existing.response_json), 201) : context.json({ error: 'idempotency_conflict' }, 409);
  try { await assertRenderableRecipientNames(recipients.map((recipient) => recipient.name)); }
  catch { return context.json({ error: 'unsupported_recipient_name' }, 422); }
  const template = await context.env.DB.prepare('SELECT * FROM templates WHERE id = ? AND tenant_id = ?').bind(input.templateId, tenantId).first<{ object_key: string; roles_json: string; fields_json?: string }>();
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
  // The envelope is prepared here, in the same request: its initial document (D0) is the template's
  // source, and the first signer's task is active. The id comes from the tenant and the
  // Idempotency-Key, so a retry after a failure reuses the D0 object stored by the failed attempt.
  const id = await envelopeIdFor(tenantId, key);
  let d0: { id: string; objectKey: string; sha256: string };
  try { d0 = await storeInitialDocument(context.env.ARTIFACTS, template.object_key, id); }
  catch (error) {
    if (!(error instanceof InitialDocumentConflict)) return context.json({ error: 'preparation_failed' }, 503);
    // Another request with this key stored a different document: it is a different request.
    const raced = await lookup();
    return raced && raced.request_hash === hash ? context.json(JSON.parse(raced.response_json), 201) : context.json({ error: 'idempotency_conflict' }, 409);
  }
  const taskIds = recipients.map(() => crypto.randomUUID());
  const response = { id, status: 'IN_PROGRESS' };
  // One batch: the envelope, its tasks and its D0 artifact commit together or not at all.
  const statements = [
    context.env.DB.prepare('INSERT INTO idempotency_keys (tenant_id, idempotency_key, request_hash, response_json) VALUES (?, ?, ?, ?)').bind(tenantId, `envelope:${key}`, hash, JSON.stringify(response)),
    // The certificate layout this envelope is made with is fixed for good (src/delivery-pdf.ts).
    context.env.DB.prepare('INSERT INTO envelopes (id, tenant_id, template_id, status, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)').bind(id, tenantId, input.templateId, 'IN_PROGRESS', Date.now(), JSON.stringify({ ...(documentName ? { documentName } : {}), ...(sender ? { sender } : {}), certificateVersion: CERTIFICATE_VERSION } satisfies EnvelopeDetails)),
    ...recipients.map((recipient, index) => context.env.DB.prepare('INSERT INTO tasks (id, envelope_id, role, recipient_name, recipient_email, routing_order, status, expires_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(taskIds[index], id, recipient.role, recipient.name, recipient.email, index + 1, index === 0 ? 'ACTIVE' : 'PENDING', deadlines[index], JSON.stringify({ ...signerFacts[index], ...(namedBy[index] ? { namedBy: namedBy[index] } : {}) } satisfies TaskDetails))),
    context.env.DB.prepare('INSERT INTO artifacts (id, envelope_id, object_key, sha256) VALUES (?, ?, ?, ?)').bind(d0.id, id, d0.objectKey, d0.sha256),
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
  // A tenant's own envelope only (checked below); expiring a stranger's id is a no-op lookup.
  if (await context.env.DB.prepare('SELECT 1 FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first()) await expireIfDue(context.env.DB, id);
  const envelope = await context.env.DB.prepare('SELECT id, template_id, status, created_at FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ id: string; template_id: string; status: string; created_at: number }>();
  if (!envelope) return context.json({ error: 'not_found' }, 404);
  // openedAt: when the recipient first opened the signing page (the audit trail's first SIGNING_SESSION_OPENED).
  const tasks = await context.env.DB.prepare(`SELECT t.id, t.role, t.recipient_name, t.recipient_email, t.routing_order, t.status, t.expires_at,
      (SELECT MIN(a.occurred_at) FROM audit_events a WHERE a.envelope_id = t.envelope_id AND a.task_id = t.id AND a.type = ?) AS opened_at
    FROM tasks t WHERE t.envelope_id = ? ORDER BY t.routing_order`).bind(AUDIT.sessionOpened, id).all<{ id: string; role: string; recipient_name: string; recipient_email: string; routing_order: number; status: string ; expires_at: number | null; opened_at: number | null }>();
  return context.json({ id: envelope.id, templateId: envelope.template_id, status: envelope.status, createdAt: envelope.created_at, tasks: tasks.results.map((task) => ({ id: task.id, role: task.role, recipientName: task.recipient_name, recipientEmail: task.recipient_email, routingOrder: task.routing_order, status: task.status, ...(task.expires_at == null ? {} : { expiresAt: new Date(task.expires_at).toISOString() }), ...(task.opened_at == null ? {} : { openedAt: new Date(task.opened_at).toISOString() }) })) });
});

/**
 * Deprecated: POST /v1/envelopes prepares the envelope itself. Kept as a no-op for callers that
 * still call it after creating one: 204 for an envelope of this tenant (always prepared), else 404.
 */
app.post('/v1/envelopes/:id/prepare', async (context) => {
  const prepared = await context.env.DB.prepare('SELECT 1 FROM envelopes e JOIN artifacts a ON a.envelope_id = e.id WHERE e.id = ? AND e.tenant_id = ?').bind(context.req.param('id'), context.get('tenantId')).first();
  if (!prepared) return context.json({ error: 'not_found' }, 404);
  return context.body(null, 204);
});

// The envelope's audit trail for its host: each event in order, with the signer it concerns. Only
// detail that is safe to show is passed on (never a code, a message id or a key).
const AUDIT_DETAIL_SHOWN = ['reason', 'title', 'onBehalfOf', 'authorityConfirmed', 'consentDisclosureVersion', 'to', 'delivery', 'hostAuthentication', 'pages', 'total'];
app.get('/v1/envelopes/:id/audit', async (context) => {
  const id = context.req.param('id');
  if (!await context.env.DB.prepare('SELECT 1 FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, context.get('tenantId')).first()) return context.json({ error: 'not_found' }, 404);
  const rows = await context.env.DB.prepare('SELECT a.type, a.occurred_at, a.ip, a.user_agent, a.detail_json, t.role, t.recipient_name, t.recipient_email FROM audit_events a LEFT JOIN tasks t ON t.id = a.task_id WHERE a.envelope_id = ? ORDER BY a.id')
    .bind(id).all<{ type: string; occurred_at: number; ip: string | null; user_agent: string | null; detail_json: string | null; role: string | null; recipient_name: string | null; recipient_email: string | null }>();
  const events = rows.results.map(row => {
    let detail: Record<string, unknown> | null = null;
    try { detail = row.detail_json ? JSON.parse(row.detail_json) : null; } catch { detail = null; }
    const shown = detail ? Object.fromEntries(Object.entries(detail).filter(([k]) => AUDIT_DETAIL_SHOWN.includes(k))) : {};
    return {
      type: row.type,
      at: new Date(row.occurred_at).toISOString(),
      ...(row.role ? { recipient: { role: row.role, name: row.recipient_name ?? '', email: row.recipient_email ?? '' } } : {}),
      ...(row.ip ? { ip: row.ip } : {}),
      ...(row.user_agent ? { userAgent: row.user_agent } : {}),
      ...(Object.keys(shown).length ? { detail: shown } : {}),
    };
  });
  return context.json({ events });
});

// Withdraws an envelope nobody has finished signing. Every signing path requires an envelope
// IN_PROGRESS, so a VOIDED one can no longer be opened, verified or signed. Repeating it is a
// no-op; an envelope already finishing or completed is refused.
app.post('/v1/envelopes/:id/void', bodyLimit({ maxSize: 4096 }), async (context) => {
  let reason = '';
  const raw = await context.req.text();
  if (raw.trim()) {
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return context.json({ error: 'invalid_json' }, 400); }
    const input = (body ?? {}) as { reason?: unknown };
    if (typeof body !== 'object' || Array.isArray(body) || (input.reason !== undefined && typeof input.reason !== 'string')) return context.json({ error: 'invalid_void' }, 422);
    reason = (input.reason as string | undefined)?.trim() ?? '';
    if (reason.length > 500) return context.json({ error: 'invalid_void' }, 422);
  }
  const id = context.req.param('id');
  const tenantId = context.get('tenantId');
  const db = context.env.DB;
  const read = () => db.prepare('SELECT status FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ status: string }>();
  const envelope = await read();
  if (!envelope) return context.json({ error: 'not_found' }, 404);
  if (envelope.status !== 'VOIDED') {
    const { ip, userAgent } = requestFacts(context.req.raw);
    // One batch: the status change and its audit event commit together, once.
    await db.batch([
      db.prepare("UPDATE envelopes SET status = 'VOIDED' WHERE id = ? AND tenant_id = ? AND status = 'IN_PROGRESS'").bind(id, tenantId),
      db.prepare("INSERT INTO audit_events (envelope_id, task_id, type, occurred_at, ip, user_agent, detail_json) SELECT ?, NULL, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM envelopes WHERE id = ? AND status = 'VOIDED') AND NOT EXISTS (SELECT 1 FROM audit_events WHERE envelope_id = ? AND type = ?)")
        .bind(id, AUDIT.voided, Date.now(), ip, userAgent, JSON.stringify(reason ? { reason } : {}), id, id, AUDIT.voided),
    ]);
    if ((await read())?.status !== 'VOIDED') return context.json({ error: 'envelope_not_voidable' }, 409);
  }
  return context.json({ id, status: 'VOIDED' });
});

mountLocalSigningRoutes(app);
return app;
}

/** Cron trigger: finishes envelopes that the after-signature work did not (see envelope-completion.ts). */
async function scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
  if (!localSigningEnabled(env)) return;
  ctx.waitUntil(expireDueEnvelopes(env.DB).catch(() => console.error('E-sign: the expiry sweep failed; the next run retries it')));
  ctx.waitUntil(sweepEnvelopes(env).then((counts) => {
    if (counts.failed) console.error(`E-sign: ${counts.failed} envelope(s) could not be finished; the next run retries them`);
  }));
}

// The Hono app stays the default export (scripts mount it with app.route); the Worker
// runtime also finds the cron handler on it.
export default Object.assign(createApp(), { scheduled });
