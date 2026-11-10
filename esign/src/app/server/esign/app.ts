import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AUDIT, requestFacts } from './audit.ts';
import { expireDueEnvelopes, expireIfDue, parseDeadline } from './task-expiry.ts';
import { parseAfterSigning, parseDocumentName, parseDocumentVersion, parseNamedBy, parseSender, parseSignerFacts, type SignerFacts } from './signer-facts.ts';
import { CERTIFICATE_VERSION } from './delivery-pdf.ts';
import { envelopeDetails, type EnvelopeDetails, type TaskDetails } from './details.ts';
import { PDFDocument } from 'pdf-lib';
import { assertNoOverlappingFields, validateFieldPlacement, validateFields, validateFieldsPdf } from './fields.ts';
import { assertRenderableRecipientNames } from './field-render.ts';
import { envelopeIdFor, InitialDocumentConflict, storeInitialDocument } from './prepare.ts';
import { mountSigningRoutes } from './signing-routes.ts';
import { signingEnabled, type EnvironmentEnv } from './environment.ts';
import { mountEditorRoutes } from './editor-routes.ts';
import { sweepEnvelopes } from './envelope-completion.ts';
import type { BlobStore } from './blob-store.ts';
import { can, isScheduleTick, PERMISSIONS, readCaller, type Caller } from './identity.ts';
import type { MailEnv } from './mail.ts';
import type { SealEnv } from './seal/config.ts';
import { apiCatalog } from './catalog.ts';

const MAX_PDF_BYTES = 5 * 1024 * 1024;
/**
 * What the app runs with. src/app/server/router.ts builds it from the platform (the D1 binding, the
 * ESIGN_* secrets, the mail relay's address and token); tests build it directly.
 */
export type Bindings = Omit<EnvironmentEnv, 'TEST_MAIL'> & SealEnv & MailEnv & {
  DB: D1Database;
  /** PDFs, field images, seals and delivery PDFs, in D1 (blob-store.ts). */
  ARTIFACTS: BlobStore;
  /** The local preview's test mailbox, where every code is kept; never in prod. */
  TEST_MAIL?: BlobStore;
  /** The local preview: no console identity means its stand-in owner (identity.ts). */
  IDENTITY_PREVIEW?: boolean;
  /** "true": finish each envelope once its signature is accepted (see envelope-completion.ts). */
  COMPLETE_AFTER_SIGN?: string;
  /**
   * The request's waitUntil, when the runtime gives one (Nitro on Workers puts it on the request): finishing an
   * envelope then runs after the signer's response instead of before it.
   */
  WAIT_UNTIL?: (work: Promise<unknown>) => void;
  /** Space-separated host origins that may embed the signing page and the editor (ESIGN_FRAME_ANCESTORS). */
  SIGNING_PAGE_FRAME_ANCESTORS?: string;
  /** dev only: other origins the signing page may run on, for local UI development. */
  SIGNING_PAGE_ORIGINS?: string;
  /** The app's own origin, which signed-copy links point to (the router sets it per request). */
  APP_ORIGIN?: string;
};
export type Env = { Bindings: Bindings; Variables: { tenantId: string; caller: Caller } };

/**
 * Paths outside the platform identity: the signer pages' API (declared public in package.json), the
 * health check, and the platform's tick (`POST /api/scheduled`, which checks for the tick itself).
 */
const isOpenPath = (path: string) => path.startsWith('/api/public/') || path === '/api/health' || path === '/api/scheduled';

/**
 * Management routes (`/api/*` but the public ones) belong to the organization of the platform
 * identity: org members in the browser, the host product's service accounts and MCP agents alike.
 * Reading needs `esign.view`, anything else `esign.manage`; a public request never gets here.
 */
export const managementAuth = async (context: import('hono').Context<Env>, next: import('hono').Next) => {
  const caller = readCaller(context.req.raw, context.env.IDENTITY_PREVIEW === true);
  if (!caller) return context.json({ error: 'unauthorized' }, 401);
  const path = context.req.path;
  const reading = context.req.method === 'GET' || context.req.method === 'HEAD';
  const anyRole = path === '/api/me' || path === '/api/catalog';
  if (!anyRole && !can(caller, reading ? 'esign.view' : 'esign.manage')) return context.json({ error: 'forbidden' }, 403);
  context.set('caller', caller);
  context.set('tenantId', caller.organizationId);
  await next();
};
export function createApp() {
const app = new Hono<Env>();
// No configuration is disclosed: only whether the app answers.
app.get('/api/health', (context) => context.json({ status: 'ok', service: 'esign' }));
// The platform's tick, every five minutes (package.json `insulin.scheduled`): the due work of every
// organization, the same work as POST /api/process-due. Only the tick passes: a request with a
// member's, a service account's or an agent's identity, or without `x-suger-access-via: schedule`,
// is refused. Never public and never in the catalog.
app.post('/api/scheduled', async (context) => {
  if (!isScheduleTick(context.req.raw)) return context.json({ error: 'forbidden' }, 403);
  if (!signingEnabled(context.env)) return context.json({ error: 'signing_disabled' }, 404);
  const expired = await expireDueEnvelopes(context.env.DB, Date.now(), null);
  const counts = await sweepEnvelopes(context.env, null);
  return context.json({ expired, ...counts });
});
// The placed fields a document can be signed with: Signature, Date signed and Title.
const supportedFields=(raw:string,roles:string[],pages:number)=>validateFields(JSON.parse(raw),roles,pages);
app.use('/api/*', async (context, next) => (isOpenPath(context.req.path) ? next() : managementAuth(context, next)));

mountEditorRoutes(app);

// Who is calling, for the app's pages and for agents: the organization, the role and what it allows.
app.get('/api/me', (context) => {
  const caller = context.get('caller');
  return context.json({
    organizationId: caller.organizationId,
    user: { id: caller.userId, email: caller.email, name: caller.name },
    role: caller.role,
    permissions: PERMISSIONS.filter((permission) => can(caller, permission)),
    accessVia: caller.accessVia,
    preview: caller.preview,
    signingEnabled: signingEnabled(context.env),
  });
});

// The management API as data, for AI agents and API clients (catalog.ts).
app.get('/api/catalog', (context) => context.json(apiCatalog(context.get('caller'))));

/** `limit` (1 to 100, default 50) and `before` (epoch ms) of a list request, or null when malformed. */
function page(query: (name: string) => string | undefined): { limit: number; before: number } | null {
  const limit = query('limit') === undefined ? 50 : Number(query('limit'));
  const before = query('before') === undefined ? Number.MAX_SAFE_INTEGER : Number(query('before'));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) return null;
  return { limit, before };
}

// The organization's templates, newest first.
app.get('/api/templates', async (context) => {
  const paging = page((name) => context.req.query(name));
  if (!paging) return context.json({ error: 'invalid_query' }, 400);
  const { results } = await context.env.DB.prepare('SELECT id, roles_json, fields_json, created_at FROM templates WHERE tenant_id = ? AND created_at < ? ORDER BY created_at DESC, id LIMIT ?')
    .bind(context.get('tenantId'), paging.before, paging.limit).all<{ id: string; roles_json: string; fields_json: string; created_at: number }>();
  return context.json({ templates: results.map((row) => ({ id: row.id, roles: JSON.parse(row.roles_json), fields: placedFields(row.fields_json), createdAt: row.created_at })) });
});

const ENVELOPE_STATUSES = new Set(['IN_PROGRESS', 'FINALIZING', 'COMPLETED', 'VOIDED', 'DECLINED', 'EXPIRED']);

// The organization's envelopes, newest first, optionally of one status.
app.get('/api/envelopes', async (context) => {
  const paging = page((name) => context.req.query(name));
  const status = context.req.query('status');
  if (!paging || (status !== undefined && !ENVELOPE_STATUSES.has(status))) return context.json({ error: 'invalid_query' }, 400);
  const { results } = await context.env.DB.prepare(`SELECT id, template_id, status, created_at, details_json FROM envelopes
      WHERE tenant_id = ? AND created_at < ? AND (? IS NULL OR status = ?) ORDER BY created_at DESC, id LIMIT ?`)
    .bind(context.get('tenantId'), paging.before, status ?? null, status ?? null, paging.limit).all<{ id: string; template_id: string; status: string; created_at: number; details_json: string }>();
  return context.json({
    envelopes: results.map((row) => {
      const details = envelopeDetails(row.details_json);
      return { id: row.id, templateId: row.template_id, status: row.status, createdAt: row.created_at, ...(details.documentName ? { documentName: details.documentName } : {}) };
    }),
  });
});

// Due work, for the caller's organization only: expire envelopes past a deadline, finish the ones
// whose signing request did not, and send signed-copy notices still owed. The platform's tick runs
// it for every organization every five minutes (POST /api/scheduled); this finishes it at once, for
// anyone who manages envelopes. Reading an envelope also expires it when due.
app.post('/api/process-due', async (context) => {
  if (!signingEnabled(context.env)) return context.json({ error: 'signing_disabled' }, 404);
  const tenantId = context.get('tenantId');
  const expired = await expireDueEnvelopes(context.env.DB, Date.now(), tenantId);
  const counts = await sweepEnvelopes(context.env, tenantId);
  return context.json({ expired, ...counts });
});

app.post('/api/templates', bodyLimit({ maxSize: MAX_PDF_BYTES + 65536 }), async (context) => {
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

app.get('/api/templates/:id', async (context) => {
  const row = await context.env.DB.prepare('SELECT * FROM templates WHERE id = ? AND tenant_id = ?')
    .bind(context.req.param('id'), context.get('tenantId')).first<{ id: string; roles_json: string; fields_json?: string }>();
  if (!row) return context.json({ error: 'not_found' }, 404);
  // The response names keep the word "positioned": hosts read them.
  let hasFields = false;
  if (row.fields_json !== undefined) {
    try { const fields: unknown = JSON.parse(row.fields_json); hasFields = !Array.isArray(fields) || fields.length > 0; }
    catch { hasFields = true; }
  }
  let fieldsSupported=false;
  if(hasFields){try{
    const source=await context.env.DB.prepare('SELECT object_key FROM templates WHERE id=? AND tenant_id=?').bind(row.id,context.get('tenantId')).first<{object_key:string}>();
    const object=source&&await context.env.ARTIFACTS.get(source.object_key);if(!object||object.size>MAX_PDF_BYTES)throw new Error('Missing source');
    const pdf=await PDFDocument.load(await object.arrayBuffer(),{throwOnInvalidObject:true,updateMetadata:false});validateFieldsPdf(pdf);const fields=supportedFields(row.fields_json!,JSON.parse(row.roles_json),pdf.getPageCount());assertNoOverlappingFields(fields);validateFieldPlacement(pdf,fields);fieldsSupported=true;
  }catch{fieldsSupported=false;}}
  return context.json({ id: row.id, roles: JSON.parse(row.roles_json), hasPositionedFields: hasFields, positionedFieldsSupported: fieldsSupported, fields: placedFields(row.fields_json) });
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

/** A created envelope starts IN_PROGRESS: its first signer's task is active. */
const CREATED_STATUS = 'IN_PROGRESS';
/** The response to POST /api/envelopes, for the first creation and for every retry of it alike. */
const createdResponse = (id: string) => ({ id, status: CREATED_STATUS });

app.post('/api/envelopes', bodyLimit({ maxSize: 32768 }), async (context) => {
  const key = context.req.header('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) return context.json({ error: 'idempotency_key_required' }, 400);
  let body: unknown;
  try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_envelope' }, 422);
  const input = body as { templateId?: unknown; recipients?: unknown; documentName?: unknown; documentVersion?: unknown; sender?: unknown };
  // The document's name, shown to the signer and named in the intent statement.
  const documentName = parseDocumentName(input.documentName);
  if (documentName === 'invalid') return context.json({ error: 'invalid_envelope' }, 422);
  // Which version of the document it is ("v3"), and when it was published, as the host names it.
  const documentVersion = parseDocumentVersion(input.documentVersion);
  if (documentVersion === 'invalid') return context.json({ error: 'invalid_envelope' }, 422);
  // Who sent it, for the certificate.
  const sender = parseSender(input.sender);
  if (sender === 'invalid') return context.json({ error: 'invalid_envelope' }, 422);
  if (typeof input.templateId !== 'string' || !Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > 20) return context.json({ error: 'invalid_envelope' }, 422);
  const recipients: { role: string; name: string; email: string; expiresAt?: string }[] = [];
  const deadlines: (number | null)[] = [];
  const signerFacts: SignerFacts[] = [];
  const namedBy: (string | null)[] = [];
  const afterSigning: (string[] | null)[] = [];
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
    // What the host says happens once this signer signs, shown on their signing page only.
    const after = parseAfterSigning((recipient as { afterSigning?: unknown }).afterSigning);
    if (after === 'invalid') return context.json({ error: 'invalid_recipient' }, 422);
    afterSigning.push(after);
    recipients.push({ role: recipient.role, name: recipient.name, email: recipient.email, ...(deadline === null ? {} : { expiresAt: new Date(deadline).toISOString() }), ...facts, ...(named ? { namedBy: named } : {}), ...(after ? { afterSigning: after } : {}) });
  }
  const tenantId = context.get('tenantId');
  const encoded = JSON.stringify({ templateId: input.templateId, recipients, ...(documentName ? { documentName } : {}), ...(documentVersion ? { documentVersion } : {}), ...(sender ? { sender } : {}) });
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))), (n) => n.toString(16).padStart(2, '0')).join('');
  // Idempotency is by the envelope itself: its id comes from the tenant and the Idempotency-Key, and
  // it keeps the hash of the request that created it. A retry of that request gets the response a
  // first creation returns (always IN_PROGRESS, whatever the envelope's status is now), and the
  // same key with another request is a conflict.
  const id = await envelopeIdFor(tenantId, key);
  const lookup = () => context.env.DB.prepare('SELECT request_sha256 FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ request_sha256: string }>();
  const replay = (existing: { request_sha256: string }) => existing.request_sha256 === hash ? context.json(createdResponse(id), 201) : context.json({ error: 'idempotency_conflict' }, 409);
  const existing = await lookup();
  if (existing) return replay(existing);
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
        const pdf=await PDFDocument.load(await object.arrayBuffer(),{throwOnInvalidObject:true,updateMetadata:false});validateFieldsPdf(pdf);const fields=supportedFields(template.fields_json,roles,pdf.getPageCount());assertNoOverlappingFields(fields);validateFieldPlacement(pdf,fields);
      }
    } catch { return context.json({ error: 'positioned_fields_not_supported' }, 422); }
  }
  if (roles.length !== recipients.length || new Set(recipients.map((r) => r.role)).size !== roles.length || recipients.some((r) => !roles.includes(r.role))) return context.json({ error: 'invalid_roles' }, 422);
  // The envelope is prepared here, in the same request: its initial document (D0) is the template's
  // source, and the first signer's task is active. The id comes from the tenant and the
  // Idempotency-Key, so a retry after a failure reuses the D0 object stored by the failed attempt.
  let d0: { id: string; objectKey: string; sha256: string };
  try { d0 = await storeInitialDocument(context.env.ARTIFACTS, template.object_key, id); }
  catch (error) {
    if (!(error instanceof InitialDocumentConflict)) return context.json({ error: 'preparation_failed' }, 503);
    // Another request with this key stored a different document: it is a different request.
    const raced = await lookup();
    return raced ? replay(raced) : context.json({ error: 'idempotency_conflict' }, 409);
  }
  const taskIds = recipients.map(() => crypto.randomUUID());
  // One batch: the envelope (with the request's hash), its tasks and its D0 artifact commit together
  // or not at all.
  const statements = [
    // The certificate layout this envelope is made with is fixed for good (src/delivery-pdf.ts).
    context.env.DB.prepare('INSERT INTO envelopes (id, tenant_id, template_id, status, created_at, request_sha256, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, tenantId, input.templateId, CREATED_STATUS, Date.now(), hash, JSON.stringify({ ...(documentName ? { documentName } : {}), ...(documentVersion ? { documentVersion } : {}), ...(sender ? { sender } : {}), certificateVersion: CERTIFICATE_VERSION } satisfies EnvelopeDetails)),
    ...recipients.map((recipient, index) => context.env.DB.prepare('INSERT INTO tasks (id, envelope_id, role, recipient_name, recipient_email, routing_order, status, expires_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(taskIds[index], id, recipient.role, recipient.name, recipient.email, index + 1, index === 0 ? 'ACTIVE' : 'PENDING', deadlines[index], JSON.stringify({ ...signerFacts[index], ...(namedBy[index] ? { namedBy: namedBy[index] } : {}), ...(afterSigning[index] ? { afterSigning: afterSigning[index]! } : {}) } satisfies TaskDetails))),
    context.env.DB.prepare('INSERT INTO artifacts (id, envelope_id, object_key, sha256) VALUES (?, ?, ?, ?)').bind(d0.id, id, d0.objectKey, d0.sha256),
  ];
  try { await context.env.DB.batch(statements); }
  catch (error) {
    // A concurrent creation with this key committed first (the envelope id is the primary key).
    const raced = await lookup();
    if (raced) return replay(raced);
    throw error;
  }
  return context.json(createdResponse(id), 201);
});

app.get('/api/envelopes/:id', async (context) => {
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
 * Deprecated: POST /api/envelopes prepares the envelope itself. Kept as a no-op for callers that
 * still call it after creating one: 204 for an envelope of this tenant (always prepared), else 404.
 */
app.post('/api/envelopes/:id/prepare', async (context) => {
  const prepared = await context.env.DB.prepare('SELECT 1 FROM envelopes e JOIN artifacts a ON a.envelope_id = e.id WHERE e.id = ? AND e.tenant_id = ?').bind(context.req.param('id'), context.get('tenantId')).first();
  if (!prepared) return context.json({ error: 'not_found' }, 404);
  return context.body(null, 204);
});

// The envelope's audit trail for its host: each event in order, with the signer it concerns. Only
// detail that is safe to show is passed on (never a code, a message id or a key).
const AUDIT_DETAIL_SHOWN = ['reason', 'title', 'onBehalfOf', 'authorityConfirmed', 'consentDisclosureVersion', 'to', 'delivery', 'hostAuthentication', 'pages', 'total'];
app.get('/api/envelopes/:id/audit', async (context) => {
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
app.post('/api/envelopes/:id/void', bodyLimit({ maxSize: 4096 }), async (context) => {
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

mountSigningRoutes(app);
return app;
}

// The Hono app: src/app/server/router.ts serves it, tests call it directly.
export default createApp();
