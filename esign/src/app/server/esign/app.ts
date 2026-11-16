import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AUDIT, requestFacts } from './audit.ts';
import { expireDueEnvelopes, expireIfDue, parseDeadline } from './task-expiry.ts';
import { parseAfterSigning, parseDocumentName, parseDocumentVersion, parseNamedBy, parseSender, parseSignerFacts, sha256Hex, type SignerFacts } from './signer-facts.ts';
import { envelopeDetails, taskDetails, type EnvelopeDetails, type TaskDetails } from './details.ts';
import { parseMetadata, parseTemplateName, storedMetadata, unknownKeys, type Metadata } from './metadata.ts';
import { PDFDocument } from 'pdf-lib';
import { assertEditorSigningFields, assertNoOverlappingFields, PREFILL, prefillDefinitions, signingFieldsOf, validateFieldPlacement, validateFields, validateFieldsPdf, validateTemplateFields, type PrefillDefinition, type TemplateField } from './fields.ts';
import { assertRenderableRecipientNames } from './field-render.ts';
import { envelopeIdFor, InitialDocumentConflict, storeInitialDocument } from './prepare.ts';
import { mountSigningRoutes } from './signing-routes.ts';
import { signingEnabled, type EnvironmentEnv } from './environment.ts';
import { mountEditorRoutes } from './editor-routes.ts';
import { sendDueInvitations, sweepEnvelopes } from './envelope-completion.ts';
import { parseDelivery, parseMessage, type Delivery, type Message } from './invitations.ts';
import type { BlobStore } from './blob-store.ts';
import { can, isScheduleTick, PERMISSIONS, readCaller, type Caller } from './identity.ts';
import type { MailEnv } from './mail.ts';
import { reportUsage, type MetricsEnv } from './usage-metrics.ts';
import type { SealEnv } from './seal/config.ts';
import { apiCatalog } from './catalog.ts';
import { contactUpserts, mountContactRoutes } from './contacts.ts';
import { defaultSignerNames, parseDefaultSigners, storedDefaultSigners, type DefaultSigners } from './default-signers.ts';
import { atLeast, documentRole, effectiveRole, mountShareRoutes, ownersOf, parseShares, requireRole, shareInserts, shareKeys, sharedRoleBinds, sharedRoleColumn, sharesFor, visibleBinds, visibleIds, type DocumentRole, type OwnerSummary, type ResourceType } from './ownership.ts';
import { mergeTags, mountTagRoutes, parseTagFilter, parseTags, taggedIds, tagsByDocument, tagsOf, tagWrites } from './tags.ts';
import { mountMemberRoutes, recordMember } from './members.ts';
import { deleteDraftObjects, envelopeDocument, initialDocumentId, mountEnvelopeDocumentRoutes } from './envelope-documents.ts';
import { parsePrefill, PrefillDoesNotFit, resolvePrefill, stampPrefill } from './prefill.ts';
import type { DirectoryEnv } from './directory.ts';
import { callerOf, dueScheduled, parseSendAt, recordScheduleFailure, scheduledBy, scheduleView, splitDraft, type Schedule } from './scheduled-send.ts';

const MAX_PDF_BYTES = 5 * 1024 * 1024;
/**
 * What the app runs with. src/app/server/router.ts builds it from the platform (the D1 binding, the
 * ESIGN_* secrets, the addresses of the mail relay and the usage reports, and the app's token); tests
 * build it directly.
 */
export type Bindings = Omit<EnvironmentEnv, 'TEST_MAIL'> & SealEnv & MailEnv & MetricsEnv & DirectoryEnv & {
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
 * What concerns the caller alone, which someone who may only view Esign does too: setting their own tags (tags.ts), and
 * leaving a document shared with them (ownership.ts, which lets anyone without an admin's role remove only themselves).
 */
const isOwnChoice = (path: string) => /^\/api\/(templates|envelopes)\/[^/]+\/(tags|shares\/delete)$/.test(path);

/**
 * Management routes (`/api/*` but the public ones) belong to the organization of the platform
 * identity: org members in the browser, the host product's service accounts and MCP agents alike.
 * Reading needs `esign.view`, anything else `esign.manage`; a public request never gets here. What
 * each may do with a given template or envelope is then its role in it (ownership.ts). Every caller
 * is recorded as Esign sees them (members.ts), after the response where the platform allows.
 */
export const managementAuth = async (context: import('hono').Context<Env>, next: import('hono').Next) => {
  const caller = readCaller(context.req.raw, context.env.IDENTITY_PREVIEW === true);
  if (!caller) return context.json({ error: 'unauthorized' }, 401);
  const path = context.req.path;
  const reading = context.req.method === 'GET' || context.req.method === 'HEAD';
  const anyRole = path === '/api/me' || path === '/api/catalog';
  if (!anyRole && !can(caller, reading || isOwnChoice(path) ? 'esign.view' : 'esign.manage')) return context.json({ error: 'forbidden' }, 403);
  context.set('caller', caller);
  context.set('tenantId', caller.organizationId);
  const recorded = recordMember(context.env.DB, caller.organizationId, caller, Date.now()).catch(() => undefined);
  if (context.env.WAIT_UNTIL) context.env.WAIT_UNTIL(recorded);
  else await recorded;
  await next();
};
export function createApp() {
const app = new Hono<Env>();
// No configuration is disclosed: only whether the app answers.
app.get('/api/health', (context) => context.json({ status: 'ok', service: 'esign' }));
// The platform's tick, every five minutes (package.json `insulin.scheduled`): the due work of every
// organization, the same work as POST /api/process-due, then the hour's usage report. Only the tick
// passes: a request with a member's, a service account's or an agent's identity, or without
// `x-suger-access-via: schedule`, is refused. Never public and never in the catalog.
app.post('/api/scheduled', async (context) => {
  if (!isScheduleTick(context.req.raw)) return context.json({ error: 'forbidden' }, 403);
  try {
    if (!signingEnabled(context.env)) return context.json({ error: 'signing_disabled' }, 404);
    const scheduled = await sendScheduled(context.env, null);
    const expired = await expireDueEnvelopes(context.env.DB, Date.now(), null);
    const counts = await sweepEnvelopes(context.env, null);
    return context.json({ expired, ...counts, ...scheduled });
  } finally {
    // After the due work, whatever its outcome: this hour's usage report, unless a tick sent it already
    // (usage-metrics.ts). It never throws, and with the request's waitUntil it runs after the response.
    const report = reportUsage(context.env);
    if (context.env.WAIT_UNTIL) context.env.WAIT_UNTIL(report);
    else await report;
  }
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

/**
 * A list request's paging and filters, or null when malformed: `limit` (1 to 100, default 50), `before`
 * (epoch ms), `scope` (`mine`, `shared`, or both by default: everything the caller sees) and `tag` (up
 * to 5 of the caller's own tags, all of which a document has).
 */
function listQuery(context: import('hono').Context<Env>): { limit: number; before: number; scope: 'all' | 'mine' | 'shared'; tags: string[] } | null {
  const query = (name: string) => context.req.query(name);
  const limit = query('limit') === undefined ? 50 : Number(query('limit'));
  const before = query('before') === undefined ? Number.MAX_SAFE_INTEGER : Number(query('before'));
  const scope = query('scope') ?? 'all';
  const tags = parseTagFilter(context.req.queries('tag'));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1 || !['all', 'mine', 'shared'].includes(scope) || tags === 'invalid') return null;
  return { limit, before, scope: scope as 'all' | 'mine' | 'shared', tags };
}

/**
 * SQL and binds: the rows `x` of `type` a list shows the caller (theirs, shared with them, or both;
 * with all the tags asked for), and their share role as `shared_role`.
 */
function listed(context: import('hono').Context<Env>, type: ResourceType, query: NonNullable<ReturnType<typeof listQuery>>) {
  const tenantId = context.get('tenantId'), caller = context.get('caller');
  return {
    sharedRole: `${sharedRoleColumn(type, 'x')} AS shared_role`,
    // A template list shows the live ones only: not those archived (deleted, or replaced by a new version), which are
    // otherwise as they were: read, sent from and edited by their id.
    where: `x.tenant_id = ? AND x.id IN ${visibleIds(type, query.scope)}${query.tags.length ? ` AND x.id IN ${taggedIds(type)}` : ''}${type === 'template' ? ' AND x.archived_at IS NULL' : ''}`,
    binds: (first: unknown[]) => [...sharedRoleBinds(caller), ...first, tenantId, ...visibleBinds(tenantId, caller, query.scope), ...(query.tags.length ? [tenantId, caller.userId, JSON.stringify(query.tags), query.tags.length] : [])],
  };
}

type Owned = { id: string; owner_user_id: string; shared_role: string | null };
/** What a list or a document shows of its ownership to the caller: its owner, the caller's role, the caller's own tags. */
async function ownership(context: import('hono').Context<Env>, type: ResourceType, rows: Owned[]): Promise<Map<string, { owner: OwnerSummary; myRole: DocumentRole; tags: string[] }>> {
  const tenantId = context.get('tenantId'), caller = context.get('caller');
  const [owners, tags] = await Promise.all([ownersOf(context.env.DB, tenantId, rows.map((row) => row.owner_user_id)), tagsByDocument(context.env.DB, tenantId, caller.userId, type, rows.map((row) => row.id))]);
  return new Map(rows.map((row) => [row.id, { owner: owners.get(row.owner_user_id)!, myRole: effectiveRole(row.owner_user_id, row.shared_role, caller) ?? 'viewer', tags: tags.get(row.id) ?? [] }]));
}

/** `%` and `_` match themselves in a LIKE pattern (with ESCAPE '\\'). */
const likeContaining = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** A list's `q` (up to 100 characters, trimmed) and `since` (epoch ms), or 'invalid'. */
function searchQuery(context: import('hono').Context<Env>): { q: string; since: number | null } | 'invalid' {
  const q = (context.req.query('q') ?? '').trim();
  const raw = context.req.query('since');
  const since = raw === undefined ? null : Number(raw);
  return q.length > 100 || (since !== null && (!Number.isSafeInteger(since) || since < 0)) ? 'invalid' : { q, since };
}

// The templates the caller sees, newest first. Filters: `q` (its name contains it, or it is its id), `since` (uploaded at
// or after, epoch ms), `status` (`active`, the default: those envelopes are sent from; `draft`; or `all`), and the lists'
// `scope` and `tag`; `next` is the `before` of the following page, when there may be one.
app.get('/api/templates', async (context) => {
  const query = listQuery(context), search = searchQuery(context), status = context.req.query('status') ?? 'active';
  if (!query || search === 'invalid' || !['active', 'draft', 'all'].includes(status)) return context.json({ error: 'invalid_query' }, 400);
  const list = listed(context, 'template', query);
  const where: string[] = [], binds: unknown[] = [];
  if (status !== 'all') { where.push('x.status = ?'); binds.push(status); }
  if (search.q) { where.push(`(x.id = ? OR lower(x.name) LIKE ? ESCAPE '\\')`); binds.push(search.q, likeContaining(search.q.toLowerCase())); }
  if (search.since !== null) { where.push('x.created_at >= ?'); binds.push(search.since); }
  const { results } = await context.env.DB.prepare(`SELECT x.id, x.roles_json, x.fields_json, x.created_at, x.name, x.metadata_json, x.default_signers_json, x.owner_user_id, x.status, ${list.sharedRole}
      FROM templates x WHERE ${list.where} AND x.created_at < ?${where.map((w) => ` AND ${w}`).join('')} ORDER BY x.created_at DESC, x.id LIMIT ?`)
    .bind(...list.binds([]), query.before, ...binds, query.limit).all<Owned & { roles_json: string; fields_json: string; created_at: number; name: string | null; metadata_json: string; default_signers_json: string; status: string }>();
  const owned = await ownership(context, 'template', results);
  const last = results.length === query.limit ? results[results.length - 1] : undefined;
  return context.json({ templates: results.map((row) => ({ id: row.id, ...templateLabels(row), roles: JSON.parse(row.roles_json), fields: placedFields(row.fields_json), prefill: templatePrefill(row.fields_json), createdAt: row.created_at, status: row.status, ...owned.get(row.id) })), ...(last ? { next: last.created_at } : {}) });
});

const ENVELOPE_STATUSES = new Set(['DRAFT', 'IN_PROGRESS', 'FINALIZING', 'COMPLETED', 'VOIDED', 'DECLINED', 'EXPIRED']);

/** How soon an active signer's sign-by deadline makes an envelope "expiring soon" (`view=expiring`). */
const EXPIRING_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The envelopes the caller sees, newest first. Filters, all optional: `status` (one or more, repeated or comma-separated),
 * `q` (the document name, a signer's name or email, contains it; or the envelope's id), `since` (created at or after,
 * epoch ms), `view` (`waiting`: the caller's own, out for signature; `expiring`: out for signature with the active
 * signer's deadline within 7 days), and the lists' `scope` and `tag`. Each envelope comes with its signers in order, how
 * many have signed, whose turn it is, and when it last changed (its latest audit event); `next` is the `before` of the
 * following page, when there may be one.
 */
app.get('/api/envelopes', async (context) => {
  const query = listQuery(context);
  const statuses = (context.req.queries('status') ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  const search = searchQuery(context);
  const view = context.req.query('view');
  if (!query || search === 'invalid' || statuses.some((status) => !ENVELOPE_STATUSES.has(status)) || (view !== undefined && view !== 'waiting' && view !== 'expiring')) return context.json({ error: 'invalid_query' }, 400);
  const { q, since } = search;
  const list = listed(context, 'envelope', query);
  const caller = context.get('caller'), now = Date.now();
  const where: string[] = [], binds: unknown[] = [];
  // Drafts only when asked for (`status=DRAFT`): a list is of envelopes sent, as it always was.
  if (statuses.length) { where.push(`x.status IN (SELECT value FROM json_each(?))`); binds.push(JSON.stringify(statuses)); }
  else where.push(`x.status <> '${DRAFT}'`);
  if (since !== null) { where.push('x.created_at >= ?'); binds.push(since); }
  if (q) {
    const pattern = likeContaining(q.toLowerCase());
    where.push(`(x.id = ? OR lower(json_extract(x.details_json, '$.documentName')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM tasks qt WHERE qt.envelope_id = x.id AND (lower(qt.recipient_name) LIKE ? ESCAPE '\\' OR lower(qt.recipient_email) LIKE ? ESCAPE '\\')))`);
    binds.push(q, pattern, pattern, pattern);
  }
  if (view === 'waiting') { where.push(`x.status = 'IN_PROGRESS' AND x.owner_user_id = ?`); binds.push(caller.userId); }
  if (view === 'expiring') { where.push(`x.status = 'IN_PROGRESS' AND EXISTS (SELECT 1 FROM tasks et WHERE et.envelope_id = x.id AND et.status = 'ACTIVE' AND et.expires_at IS NOT NULL AND et.expires_at BETWEEN ? AND ?)`); binds.push(now, now + EXPIRING_WITHIN_MS); }
  const { results } = await context.env.DB.prepare(`SELECT x.id, x.template_id, x.status, x.created_at, x.details_json, x.owner_user_id, x.draft_json, ${list.sharedRole} FROM envelopes x
      WHERE ${list.where} AND x.created_at < ?${where.map((w) => ` AND ${w}`).join('')} ORDER BY x.created_at DESC, x.id LIMIT ?`)
    .bind(...list.binds([]), query.before, ...binds, query.limit).all<Owned & { template_id: string; status: string; created_at: number; details_json: string; draft_json: string | null }>();
  const ids = JSON.stringify(results.map((row) => row.id));
  const [owned, tasks, changes] = await Promise.all([
    ownership(context, 'envelope', results),
    context.env.DB.prepare('SELECT envelope_id, id, role, recipient_name, recipient_email, routing_order, status, details_json FROM tasks WHERE envelope_id IN (SELECT value FROM json_each(?)) ORDER BY envelope_id, routing_order')
      .bind(ids).all<{ envelope_id: string; id: string; role: string; recipient_name: string; recipient_email: string; routing_order: number; status: string; details_json: string }>(),
    context.env.DB.prepare('SELECT envelope_id, max(occurred_at) AS at FROM audit_events WHERE envelope_id IN (SELECT value FROM json_each(?)) GROUP BY envelope_id')
      .bind(ids).all<{ envelope_id: string; at: number }>(),
  ]);
  const lastChange = new Map(changes.results.map((row) => [row.envelope_id, row.at]));
  const signersOf = new Map<string, typeof tasks.results>();
  for (const task of tasks.results) signersOf.set(task.envelope_id, [...(signersOf.get(task.envelope_id) ?? []), task]);
  const last = results.length === query.limit ? results[results.length - 1] : undefined;
  return context.json({
    envelopes: results.map((row) => {
      const details = envelopeDetails(row.details_json);
      // A draft has no tasks yet: its signers are those its request names so far.
      const signers = row.status === DRAFT ? draftSigners(row.draft_json) : signersOf.get(row.id) ?? [];
      // A draft to be sent later: when, or why it wasn't (scheduled-send.ts).
      const scheduled = row.status === DRAFT ? scheduleView(splitDraft(row.draft_json).schedule) : {};
      // Whose turn it is, while it is out for signature (voiding or declining leaves the task as it was).
      const active = row.status === 'IN_PROGRESS' ? signers.find((task) => task.status === 'ACTIVE') : undefined;
      return {
        id: row.id, templateId: row.template_id, status: row.status, createdAt: row.created_at, ...(details.documentName ? { documentName: details.documentName } : {}), metadata: details.metadata ?? {},
        signers: signers.map((task) => ({ role: task.role, name: task.recipient_name, email: task.recipient_email, status: task.status })),
        progress: { signed: signers.filter((task) => task.status === 'SIGNED').length, total: signers.length },
        ...(active ? { current: { taskId: active.id, name: active.recipient_name, email: active.recipient_email, delivery: taskDetails(active.details_json).delivery ?? 'host' } } : {}),
        lastChangeAt: Math.max(row.created_at, lastChange.get(row.id) ?? 0),
        ...scheduled,
        ...owned.get(row.id),
      };
    }),
    ...(last ? { next: last.created_at } : {}),
  });
});

// Due work, for the caller's organization only: expire envelopes past a deadline, finish the ones
// whose signing request did not, and send signed-copy notices still owed. The platform's tick runs
// it for every organization every five minutes (POST /api/scheduled); this finishes it at once, for
// anyone who manages envelopes. Reading an envelope also expires it when due.
app.post('/api/process-due', async (context) => {
  if (!signingEnabled(context.env)) return context.json({ error: 'signing_disabled' }, 404);
  const tenantId = context.get('tenantId');
  const scheduled = await sendScheduled(context.env, tenantId);
  const expired = await expireDueEnvelopes(context.env.DB, Date.now(), tenantId);
  const counts = await sweepEnvelopes(context.env, tenantId);
  return context.json({ expired, ...counts, ...scheduled });
});

app.post('/api/templates', bodyLimit({ maxSize: MAX_PDF_BYTES + 65536 }), async (context) => {
  // A JSON body makes a template of an envelope whose document was uploaded with it (templateFromEnvelope).
  if (context.req.header('content-type')?.toLowerCase().startsWith('application/json')) return templateFromEnvelope(context);
  if (!context.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data;')) return context.json({ error: 'multipart_required' }, 400);
  let form: FormData;
  try { form = await context.req.formData(); } catch { return context.json({ error: 'invalid_multipart' }, 400); }
  const file = form.get('file');
  const rawRoles = form.get('roles');
  if (!(file instanceof File) || typeof rawRoles !== 'string' || file.size === 0) return context.json({ error: 'invalid_template' }, 400);
  // The host's name and metadata for the template (metadata.ts), as form fields; metadata is a JSON object.
  const unknown = unknownKeys(Object.fromEntries(Array.from(form.keys(), (key) => [key, true])), ['file', 'roles', 'name', 'metadata', 'defaultSigners', 'tags', 'share']);
  if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
  const name = parseTemplateName(form.get('name') ?? undefined);
  let metadata: ReturnType<typeof parseMetadata> = null;
  const rawMetadata = form.get('metadata');
  if (rawMetadata !== null) {
    try { metadata = typeof rawMetadata === 'string' ? parseMetadata(JSON.parse(rawMetadata)) : 'invalid'; } catch { metadata = 'invalid'; }
  }
  if (name === 'invalid' || metadata === 'invalid') return context.json({ error: 'invalid_template' }, 422);
  // The caller's own tags for it (tags.ts) and whom else it is shared with (ownership.ts), JSON arrays.
  const tags = jsonField(form.get('tags'), parseTags), shares = jsonField(form.get('share'), parseShares);
  if (tags === 'invalid' || shares === 'invalid') return context.json({ error: 'invalid_template' }, 422);
  if (file.size > MAX_PDF_BYTES) return context.json({ error: 'too_large' }, 413);
  let roles: unknown;
  try { roles = JSON.parse(rawRoles); } catch { return context.json({ error: 'invalid_roles' }, 422); }
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > 20 || roles.some((r) => typeof r !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r)) || new Set(roles).size !== roles.length) return context.json({ error: 'invalid_roles' }, 422);
  // Who usually signs as some of the roles (default-signers.ts), a JSON object.
  let defaultSigners: ReturnType<typeof parseDefaultSigners> = null;
  const rawSigners = form.get('defaultSigners');
  if (rawSigners !== null) {
    try { defaultSigners = typeof rawSigners === 'string' ? parseDefaultSigners(JSON.parse(rawSigners), roles as string[]) : 'invalid'; } catch { defaultSigners = 'invalid'; }
  }
  if (defaultSigners === 'invalid') return context.json({ error: 'invalid_template' }, 422);
  try { await assertRenderableRecipientNames(defaultSignerNames(defaultSigners)); }
  catch { return context.json({ error: 'unsupported_recipient_name' }, 422); }
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
  // deleting it here could leave a committed template without its source. The template, its shares and
  // the caller's tags commit together; the caller owns it.
  const tenantId = context.get('tenantId'), caller = context.get('caller'), now = Date.now(), db = context.env.DB;
  const given = sharesFor(shares, caller);
  await db.batch([
    db.prepare('INSERT INTO templates (id, tenant_id, object_key, roles_json, created_at, name, metadata_json, default_signers_json, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, tenantId, key, JSON.stringify(roles), now, name, JSON.stringify(metadata ?? {}), JSON.stringify(defaultSigners ?? {}), caller.userId),
    ...shareInserts(db, tenantId, 'template', id, given, caller.userId, now),
    ...tagWrites(db, tenantId, caller.userId, 'template', id, tags),
  ]);
  return context.json({ id, ...(name ? { name } : {}), metadata: metadata ?? {}, roles, defaultSigners: defaultSigners ?? {}, tags }, 201);
});

/** A multipart field holding JSON, parsed by `parse`; absent is the parser's undefined. */
function jsonField<T>(raw: FormDataEntryValue | null, parse: (value: unknown) => T | 'invalid'): T | 'invalid' {
  if (raw === null) return parse(undefined);
  if (typeof raw !== 'string') return 'invalid';
  try { return parse(JSON.parse(raw)); } catch { return 'invalid'; }
}

app.get('/api/templates/:id', async (context) => {
  const row = await context.env.DB.prepare(`SELECT x.*, ${sharedRoleColumn('template', 'x')} AS shared_role FROM templates x WHERE x.id = ? AND x.tenant_id = ?`)
    .bind(...sharedRoleBinds(context.get('caller')), context.req.param('id'), context.get('tenantId')).first<Owned & { roles_json: string; fields_json?: string; name: string | null; metadata_json: string; default_signers_json: string; archived_at: number | null; created_at: number; status: string }>();
  if (!row || !effectiveRole(row.owner_user_id, row.shared_role, context.get('caller'))) return context.json({ error: 'not_found' }, 404);
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
    const pdf=await PDFDocument.load(await object.arrayBuffer(),{throwOnInvalidObject:true,updateMetadata:false});validateFieldsPdf(pdf);const roles=JSON.parse(row.roles_json),all=validateTemplateFields(JSON.parse(row.fields_json!),roles,pdf.getPageCount());assertNoOverlappingFields(all);validateFieldPlacement(pdf,all);supportedFields(JSON.stringify(signingFieldsOf(all)),roles,pdf.getPageCount());fieldsSupported=true;
  }catch{fieldsSupported=false;}}
  return context.json({ id: row.id, ...templateLabels(row), roles: JSON.parse(row.roles_json), hasPositionedFields: hasFields, positionedFieldsSupported: fieldsSupported, fields: placedFields(row.fields_json, true), prefill: templatePrefill(row.fields_json), createdAt: row.created_at, status: row.status, ...(row.archived_at == null ? {} : { archivedAt: row.archived_at }), ...(await ownership(context, 'template', [row])).get(row.id) });
});

// The template's PDF as uploaded, to read: anyone who sees the template (Viewer). Signers sign a copy of it.
app.get('/api/templates/:id/pdf', async (context) => {
  const id = context.req.param('id');
  const refused = await requireRole(context, 'template', id, 'viewer');
  if (refused) return refused;
  const row = await context.env.DB.prepare('SELECT object_key FROM templates WHERE id = ? AND tenant_id = ?').bind(id, context.get('tenantId')).first<{ object_key: string }>();
  const object = row && await context.env.ARTIFACTS.get(row.object_key);
  if (!object || object.size > MAX_PDF_BYTES) return context.json({ error: 'source_unavailable' }, 409);
  return new Response(await object.arrayBuffer(), { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
});

// Replaces a template's default signers (default-signers.ts): who usually signs as some of its roles. They
// aren't part of what is signed, so unlike the rest of a template they can change; envelopes already sent
// keep the signers they were sent to. `{defaultSigners: {}}` clears them.
app.post('/api/templates/:id/default-signers', bodyLimit({ maxSize: 16384 }), async (context) => {
  let body: unknown;
  try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_default_signers' }, 422);
  const unknown = unknownKeys(body, ['defaultSigners']);
  if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
  const id = context.req.param('id'), tenantId = context.get('tenantId');
  const refused = await requireRole(context, 'template', id, 'editor');
  if (refused) return refused;
  const template = await context.env.DB.prepare('SELECT roles_json FROM templates WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ roles_json: string }>();
  if (!template) return context.json({ error: 'not_found' }, 404);
  const value = (body as { defaultSigners?: unknown }).defaultSigners;
  const signers = value === undefined ? 'invalid' : parseDefaultSigners(value, JSON.parse(template.roles_json));
  if (signers === 'invalid') return context.json({ error: 'invalid_default_signers' }, 422);
  try { await assertRenderableRecipientNames(defaultSignerNames(signers)); }
  catch { return context.json({ error: 'unsupported_recipient_name' }, 422); }
  await context.env.DB.prepare('UPDATE templates SET default_signers_json = ? WHERE id = ? AND tenant_id = ?').bind(JSON.stringify(signers ?? {}), id, tenantId).run();
  return context.json({ id, defaultSigners: signers ?? {} });
});

// Renames a template: `{name}` (null or '' leaves it without one). A name only labels it, so unlike its PDF and fields it
// can change; envelopes already sent keep the document name they were sent with. Its editors, admins and owner.
app.post('/api/templates/:id', bodyLimit({ maxSize: 4096 }), async (context) => {
  let body: unknown;
  try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_template' }, 422);
  const unknown = unknownKeys(body, ['name']);
  if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
  const value = (body as { name?: unknown }).name;
  const name = value === undefined ? 'invalid' : parseTemplateName(value);
  if (name === 'invalid') return context.json({ error: 'invalid_template' }, 422);
  const id = context.req.param('id');
  const refused = await requireRole(context, 'template', id, 'editor');
  if (refused) return refused;
  await context.env.DB.prepare('UPDATE templates SET name = ? WHERE id = ? AND tenant_id = ?').bind(name, id, context.get('tenantId')).run();
  return context.json({ id, ...(name ? { name } : {}) });
});

// Deletes a template: it is archived, which takes it off every list (Esign's pages show it no more). Everything by its id
// works as before, so a host that keeps the id is unaffected, and envelopes sent from it are signed as before. Its
// admins and owner; again is a no-op.
app.post('/api/templates/:id/delete', async (context) => {
  const id = context.req.param('id');
  const refused = await requireRole(context, 'template', id, 'admin');
  if (refused) return refused;
  await context.env.DB.prepare('UPDATE templates SET archived_at = ? WHERE id = ? AND tenant_id = ? AND archived_at IS NULL').bind(Date.now(), id, context.get('tenantId')).run();
  return context.json({ id, deleted: true });
});

/** A template's name, when it has one, its metadata and its default signers, as the API returns them. */
function templateLabels(row: { name: string | null; metadata_json: string; roles_json: string; default_signers_json: string }): { name?: string; metadata: Metadata; defaultSigners: DefaultSigners } {
  return { ...(row.name ? { name: row.name } : {}), metadata: storedMetadata(row.metadata_json), defaultSigners: storedDefaultSigners(row.default_signers_json, JSON.parse(row.roles_json)) };
}

type PlacedField = { type: string; role: string; page: number; rect: { x: number; y: number; width: number; height: number }; required?: boolean; name?: string; label?: string };
/**
 * The placed fields as a host previews them: type, role, page (1-based) and the box in
 * normalized coordinates of the displayed page (top-left origin); with `withRequired` (one template), whether the
 * signer must fill each. Ids stay inside.
 */
/** A template's pre-filled fields, once per name (fields.ts): what a sender gives values for. */
function templatePrefill(raw: string | undefined): PrefillDefinition[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? prefillDefinitions(value.filter((f): f is TemplateField => !!f && typeof f === 'object' && f.type === PREFILL && typeof f.name === 'string' && typeof f.label === 'string' && typeof f.required === 'boolean')) : [];
  } catch { return []; }
}

function placedFields(raw: string | undefined, withRequired = false): PlacedField[] {
  if (raw === undefined) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const out: PlacedField[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const f = item as { type?: unknown; role?: unknown; page?: unknown; required?: unknown; name?: unknown; label?: unknown; rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } };
    const r = f.rect;
    if (typeof f.type !== 'string' || typeof f.role !== 'string' || !Number.isSafeInteger(f.page) || !r || typeof r !== 'object') continue;
    const { x, y, width, height } = r;
    if (![x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    out.push({ type: f.type, role: f.role, page: f.page as number, rect: { x: x as number, y: y as number, width: width as number, height: height as number }, ...(withRequired ? { required: f.required !== false } : {}), ...(f.type === PREFILL && typeof f.name === 'string' && typeof f.label === 'string' ? { name: f.name, label: f.label } : {}) });
  }
  return out;
}

/** The fields a create-envelope request and each of its recipients may have; any other is refused. */
const ENVELOPE_FIELDS = ['templateId', 'recipients', 'documentName', 'documentVersion', 'sender', 'metadata', 'message', 'tags', 'share', 'prefill'];
const validRecipientName = (name: unknown): name is string => typeof name === 'string' && !!name.trim() && name.length <= 200;
const validRecipientEmail = (email: unknown): email is string => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const RECIPIENT_FIELDS = ['role', 'name', 'email', 'expiresAt', 'title', 'onBehalfOf', 'namedBy', 'afterSigning', 'delivery', 'message'];

/** A created envelope starts IN_PROGRESS: its first signer's task is active. */
const CREATED_STATUS = 'IN_PROGRESS';
/** A draft envelope's status (saveDraft): saved, not sent; it has no tasks yet. */
const DRAFT = 'DRAFT';
/**
 * Save as template: a new template of an envelope sent with a document uploaded with it (no template; not a draft), for
 * anyone who sees the envelope and manages in Esign: `POST /api/templates` with `{fromEnvelope, name?, roles?,
 * defaultSigners?, tags?, share?}`. Its PDF is the envelope's document and its fields the envelope's, each role renamed
 * as `roles` says (the new names in the envelope's role order; its own by default); `defaultSigners: true` makes the
 * envelope's signers the template's default signers. The caller owns it; it is ready (active). The envelope is untouched.
 */
async function templateFromEnvelope(context: import('hono').Context<Env>): Promise<Response> {
  let body: unknown;
  try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_template' }, 422);
  const unknown = unknownKeys(body, ['fromEnvelope', 'name', 'roles', 'defaultSigners', 'tags', 'share']);
  if (unknown.length) return context.json({ error: 'unknown_field', fields: unknown }, 422);
  const input = body as { fromEnvelope?: unknown; name?: unknown; roles?: unknown; defaultSigners?: unknown; tags?: unknown; share?: unknown };
  const name = parseTemplateName(input.name), tags = parseTags(input.tags), shares = parseShares(input.share);
  if (typeof input.fromEnvelope !== 'string' || name === 'invalid' || tags === 'invalid' || shares === 'invalid' || (input.defaultSigners !== undefined && typeof input.defaultSigners !== 'boolean')) return context.json({ error: 'invalid_template' }, 422);
  const id = input.fromEnvelope, db = context.env.DB, tenantId = context.get('tenantId'), caller = context.get('caller');
  if (!await documentRole(db, tenantId, caller, 'envelope', id)) return context.json({ error: 'not_found' }, 404);
  const envelope = await db.prepare('SELECT template_id, status, details_json, roles_json, fields_json FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId)
    .first<{ template_id: string | null; status: string; details_json: string; roles_json: string | null; fields_json: string | null }>();
  if (!envelope) return context.json({ error: 'not_found' }, 404);
  if (envelope.template_id !== null || envelope.status === DRAFT || !envelope.roles_json || !envelope.fields_json) return context.json({ error: 'not_an_uploaded_envelope' }, 409);
  const from = JSON.parse(envelope.roles_json) as string[];
  const roles = input.roles === undefined ? from : input.roles;
  if (!Array.isArray(roles) || roles.length !== from.length || roles.some((r) => typeof r !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r)) || new Set(roles.map((r: string) => r.toLowerCase())).size !== roles.length) return context.json({ error: 'invalid_roles' }, 422);
  const renamed = new Map(from.map((role, i) => [role, roles[i] as string]));
  const document = await envelopeDocument(db, context.env.ARTIFACTS, id);
  if (!document) return context.json({ error: 'source_unavailable' }, 409);
  let fields: TemplateField[];
  try {
    const pdf = await PDFDocument.load(document, { throwOnInvalidObject: true, updateMetadata: false });
    fields = validateTemplateFields((JSON.parse(envelope.fields_json) as TemplateField[]).map((f) => ({ ...f, role: renamed.get(f.role) ?? f.role })), roles as string[], pdf.getPageCount());
    assertNoOverlappingFields(fields);
    assertEditorSigningFields(fields, roles as string[]);
  } catch { return context.json({ error: 'invalid_fields' }, 422); }
  // Its signers as default signers, when asked: each role's, renamed.
  let defaultSigners: DefaultSigners = {};
  if (input.defaultSigners === true) {
    const { results } = await db.prepare('SELECT role, recipient_name, recipient_email FROM tasks WHERE envelope_id = ?').bind(id).all<{ role: string; recipient_name: string; recipient_email: string }>();
    defaultSigners = Object.fromEntries(results.filter((t) => renamed.has(t.role)).map((t) => [renamed.get(t.role)!, { name: t.recipient_name, email: t.recipient_email }]));
  }
  const details = envelopeDetails(envelope.details_json);
  const templateName = name ?? (details.documentName ? details.documentName.slice(0, 200) : null);
  const templateId = crypto.randomUUID(), key = `templates/${templateId}/source.pdf`, now = Date.now();
  if (!await context.env.ARTIFACTS.put(key, document, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/pdf' } })) return context.json({ error: 'storage_conflict' }, 503);
  const given = sharesFor(shares, caller);
  await db.batch([
    db.prepare("INSERT INTO templates (id, tenant_id, object_key, roles_json, fields_json, created_at, name, metadata_json, default_signers_json, owner_user_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 'active')")
      .bind(templateId, tenantId, key, JSON.stringify(roles), JSON.stringify(fields), now, templateName, JSON.stringify(defaultSigners), caller.userId),
    ...shareInserts(db, tenantId, 'template', templateId, given, caller.userId, now),
    ...tagWrites(db, tenantId, caller.userId, 'template', templateId, tags),
  ]);
  return context.json({ id: templateId, ...(templateName ? { name: templateName } : {}), roles, defaultSigners, tags }, 201);
}

/** The response to POST /api/envelopes, for the first creation and for every retry of it alike. */
const createdResponse = (id: string) => ({ id, status: CREATED_STATUS });

app.post('/api/envelopes', bodyLimit({ maxSize: 32768 }), async (context) => {
  const key = context.req.header('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) return context.json({ error: 'idempotency_key_required' }, 400);
  const request = await envelopeBody(context);
  if (request instanceof Response) return request;
  if (request.sendAt !== null) return scheduleSend(context, request.body, { key }, request.sendAt);
  return request.draft ? saveDraft(context, request.body, { key }) : sendEnvelope(sendScope(context), request.body, { key });
});

// A draft (status DRAFT, saveDraft below): changed, with `draft: true`, or sent, without it, by its editors, admins
// and owner. The body is a creation's, without an Idempotency-Key: the envelope is this one.
app.post('/api/envelopes/:id', bodyLimit({ maxSize: 32768 }), async (context) => {
  const id = context.req.param('id');
  const refused = await requireRole(context, 'envelope', id, 'editor');
  if (refused) return refused;
  const request = await envelopeBody(context);
  if (request instanceof Response) return request;
  const found = await context.env.DB.prepare('SELECT status FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, context.get('tenantId')).first<{ status: string }>();
  if (found?.status !== DRAFT) return context.json({ error: 'not_draft' }, 409);
  if (request.sendAt !== null) return scheduleSend(context, request.body, { draftId: id }, request.sendAt);
  return request.draft ? saveDraft(context, request.body, { draftId: id }) : sendEnvelope(sendScope(context), request.body, { draftId: id });
});

/**
 * A creation's JSON body, and whether it asks for a draft (`draft: true`) or to be sent later (`sendAt`, an ISO 8601
 * time at least a minute and at most 400 days ahead; scheduled-send.ts), or the answer refusing it. Not both.
 */
async function envelopeBody(context: import('hono').Context<Env>): Promise<{ body: Record<string, unknown>; draft: boolean; sendAt: number | null } | Response> {
  let body: unknown;
  try { body = await context.req.json(); } catch { return context.json({ error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: 'invalid_envelope' }, 422);
  const { draft, sendAt, ...rest } = body as Record<string, unknown>;
  if (draft !== undefined && typeof draft !== 'boolean') return context.json({ error: 'invalid_envelope' }, 422);
  if (sendAt === undefined) return { body: rest, draft: draft === true, sendAt: null };
  const at = parseSendAt(sendAt, Date.now());
  if (at === 'invalid' || draft === true) return context.json({ error: 'invalid_send_at' }, 422);
  return { body: rest, draft: false, sendAt: at };
}

/** Who a send is for and how it answers: a request's caller, or (scheduled-send.ts) whoever scheduled a draft. */
interface SendScope {
  env: Bindings;
  tenantId: string;
  caller: Caller;
  json: (body: unknown, status?: number) => Response;
}
const sendScope = (context: import('hono').Context<Env>): SendScope => ({
  env: context.env, tenantId: context.get('tenantId'), caller: context.get('caller'), json: (body, status = 200) => Response.json(body, { status }),
});

/**
 * Send later: the request is checked now as a send would check it, nothing created but the draft, which keeps when to
 * send it and who scheduled it (scheduled-send.ts). A new one is idempotent by its key, as a draft is.
 */
async function scheduleSend(context: import('hono').Context<Env>, body: Record<string, unknown>, target: { key: string } | { draftId: string }, sendAt: number): Promise<Response> {
  const checked = await sendEnvelope(sendScope(context), body, target, { check: { sendAt } });
  if (checked.status !== 200) return checked;
  return saveDraft(context, body, target, { at: sendAt, by: scheduledBy(context.get('caller')) });
}

/**
 * The scheduled drafts due now, of one organization or (null) all, sent as whoever scheduled them, who must still be an
 * editor of it (shares change); what the send refuses is recorded on the draft (scheduled-send.ts). A draft sent or
 * changed meanwhile is left alone.
 */
async function sendScheduled(env: Bindings, tenantId: string | null): Promise<{ scheduledSent: number; scheduledFailed: number }> {
  let sent = 0, failed = 0;
  for (const row of await dueScheduled(env.DB, Date.now(), tenantId)) {
    const { request, schedule } = splitDraft(row.draft_json);
    if (!schedule || typeof schedule.at !== 'number') continue;
    const caller = callerOf(schedule.by, row.tenant_id);
    let error: string | null = null;
    try {
      if (!can(caller, 'esign.manage') || !atLeast((await documentRole(env.DB, row.tenant_id, caller, 'envelope', row.id))?.role ?? null, 'editor')) error = 'not_allowed';
      else {
        const answer = await sendEnvelope({ env, tenantId: row.tenant_id, caller, json: (body, status = 200) => Response.json(body, { status }) }, request, { draftId: row.id });
        if (answer.ok) { sent += 1; continue; }
        const code = ((await answer.json().catch(() => ({}))) as { error?: unknown }).error;
        if (code === 'not_draft') continue;
        error = typeof code === 'string' ? code : `status_${answer.status}`;
      }
    } catch { error = 'send_failed'; }
    failed += 1;
    await recordScheduleFailure(env.DB, row.id, schedule.at, error);
  }
  return { scheduledSent: sent, scheduledFailed: failed };
}

/**
 * Saves a draft: a new one (`key`, its Idempotency-Key), or changes one (`draftId`). Its request is kept as given
 * (`draft_json`), to be checked as a new envelope's when it is sent: only its shape is checked now (fields Esign knows,
 * a template the caller sees, its tags and shares). It has no tasks: nobody is invited, no contact is added and nothing
 * is stored for signing until it is sent. Its document name, when valid, is its details', for the lists.
 */
async function saveDraft(context: import('hono').Context<Env>, body: Record<string, unknown>, target: { key: string } | { draftId: string }, schedule: Schedule | null = null): Promise<Response> {
  const db = context.env.DB, tenantId = context.get('tenantId'), caller = context.get('caller');
  const unknownFields = unknownKeys(body, ENVELOPE_FIELDS);
  const recipients = body.recipients;
  if (recipients !== undefined && (!Array.isArray(recipients) || recipients.length > 20 || recipients.some((r) => !r || typeof r !== 'object' || Array.isArray(r)))) return context.json({ error: 'invalid_envelope' }, 422);
  for (const recipient of (recipients ?? []) as object[]) unknownFields.push(...unknownKeys(recipient, RECIPIENT_FIELDS).map((field) => `recipients[].${field}`));
  if (unknownFields.length) return context.json({ error: 'unknown_field', fields: unknownFields }, 422);
  const tags = parseTags(body.tags), shares = parseShares(body.share);
  // Without `templateId`, its document is uploaded with it (envelope-documents.ts); a draft keeps the kind it began as.
  const templateId = body.templateId === undefined ? null : body.templateId;
  if ((templateId !== null && typeof templateId !== 'string') || tags === 'invalid' || shares === 'invalid') return context.json({ error: 'invalid_envelope' }, 422);
  if (templateId !== null && !await documentRole(db, tenantId, caller, 'template', templateId)) return context.json({ error: 'not_found' }, 404);
  const documentName = parseDocumentName(body.documentName);
  const details = JSON.stringify(documentName && documentName !== 'invalid' ? { documentName } : {});
  // Saved as a draft, it is not scheduled; scheduled, it keeps when and by whom (scheduled-send.ts).
  const draft = JSON.stringify(schedule ? { ...body, schedule } : body), now = Date.now();
  const view = scheduleView(schedule);
  if ('draftId' in target) {
    const id = target.draftId;
    const [updated] = await db.batch([
      db.prepare(`UPDATE envelopes SET template_id = ?, details_json = ?, draft_json = ? WHERE id = ? AND tenant_id = ? AND status = '${DRAFT}' AND (template_id IS NULL) = (? IS NULL)`).bind(templateId, details, draft, id, tenantId, templateId),
      // The caller's tags, as the form has them now; whom else it is shared with, added.
      ...(body.tags === undefined ? [] : tagWrites(db, tenantId, caller.userId, 'envelope', id, tags)),
      ...shareInserts(db, tenantId, 'envelope', id, sharesFor(shares, caller), caller.userId, now),
    ]);
    if (updated!.meta.changes !== 1) return context.json({ error: 'not_draft' }, 409);
    return context.json({ id, status: DRAFT, ...view });
  }
  // A new draft: idempotent by its key, as a new envelope is.
  const id = await envelopeIdFor(tenantId, target.key);
  const hash = await sha256Hex(draft);
  const lookup = () => db.prepare('SELECT request_sha256, status FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ request_sha256: string; status: string }>();
  const replay = (existing: { request_sha256: string; status: string }) => existing.status === DRAFT && existing.request_sha256 === hash ? context.json({ id, status: DRAFT, ...view }, 201) : context.json({ error: 'idempotency_conflict' }, 409);
  const existing = await lookup();
  if (existing) return replay(existing);
  const given = sharesFor(shares, caller);
  const allTags = templateId === null ? tags : mergeTags(tags, await tagsOf(db, tenantId, caller.userId, 'template', templateId));
  try {
    await db.batch([
      db.prepare('INSERT INTO envelopes (id, tenant_id, template_id, status, created_at, request_sha256, owner_user_id, details_json, draft_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, tenantId, templateId, DRAFT, now, hash, caller.userId, details, draft),
      ...shareInserts(db, tenantId, 'envelope', id, given, caller.userId, now),
      ...tagWrites(db, tenantId, caller.userId, 'envelope', id, allTags),
    ]);
  } catch (error) {
    const raced = await lookup();
    if (raced) return replay(raced);
    throw error;
  }
  return context.json({ id, status: DRAFT, ...view }, 201);
}

/**
 * Sends an envelope: a new one (`key`, its Idempotency-Key), or a draft (`draftId`), which becomes this envelope as it
 * is sent. Everything is checked here, a draft's request as a new one's.
 */
async function sendEnvelope(scope: SendScope, body: Record<string, unknown>, target: { key: string } | { draftId: string }, options: { check?: { sendAt: number } } = {}): Promise<Response> {
  // Every field must be one Esign knows: a misspelled one is refused rather than lost.
  const unknownFields = unknownKeys(body, ENVELOPE_FIELDS);
  for (const [name, allowed] of [['documentVersion', ['label', 'publishedAt']], ['sender', ['name', 'email', 'organization']], ['message', ['subject', 'body']]] as const) {
    const value = (body as Record<string, unknown>)[name];
    if (value && typeof value === 'object' && !Array.isArray(value)) unknownFields.push(...unknownKeys(value, allowed).map((field) => `${name}.${field}`));
  }
  if (unknownFields.length) return scope.json({ error: 'unknown_field', fields: unknownFields }, 422);
  const input = body as { templateId?: unknown; recipients?: unknown; documentName?: unknown; documentVersion?: unknown; sender?: unknown; metadata?: unknown; message?: unknown; tags?: unknown; share?: unknown; prefill?: unknown };
  // The template's pre-filled fields' values, by name (prefill.ts).
  const prefillInput = parsePrefill(input.prefill);
  if (prefillInput === 'invalid') return scope.json({ error: 'invalid_prefill' }, 422);
  // The sender's own tags for it (tags.ts), and whom else it is shared with (ownership.ts).
  const tags = parseTags(input.tags), shares = parseShares(input.share);
  if (tags === 'invalid' || shares === 'invalid') return scope.json({ error: 'invalid_envelope' }, 422);
  // The sender's message to every signer (invitations.ts): in an invitation's email, and on the signing page.
  const message = parseMessage(input.message);
  if (message === 'invalid') return scope.json({ error: 'invalid_envelope' }, 422);
  // The host's own labels for the envelope (metadata.ts): kept and returned, never evidence.
  const metadata = parseMetadata(input.metadata);
  if (metadata === 'invalid') return scope.json({ error: 'invalid_envelope' }, 422);
  // The document's name, shown to the signer and named in the intent statement.
  const documentName = parseDocumentName(input.documentName);
  if (documentName === 'invalid') return scope.json({ error: 'invalid_envelope' }, 422);
  // Which version of the document it is ("v3"), and when it was published, as the host names it.
  const documentVersion = parseDocumentVersion(input.documentVersion);
  if (documentVersion === 'invalid') return scope.json({ error: 'invalid_envelope' }, 422);
  // Who sent it, for the certificate.
  const sender = parseSender(input.sender);
  if (sender === 'invalid') return scope.json({ error: 'invalid_envelope' }, 422);
  // A template, unless a draft whose document was uploaded with it is sent (envelope-documents.ts).
  if ((typeof input.templateId !== 'string' && !(input.templateId === undefined && 'draftId' in target)) || !Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > 20) return scope.json({ error: 'invalid_envelope' }, 422);
  // As requested: a name or an email left out comes from the template's default signer, below.
  const recipients: ({ role: string; name?: string; email?: string; expiresAt?: string } & SignerFacts)[] = [];
  const deadlines: (number | null)[] = [];
  const signerFacts: SignerFacts[] = [];
  const namedBy: (string | null)[] = [];
  const afterSigning: (string[] | null)[] = [];
  const deliveries: Delivery[] = [];
  const messages: (Message | null)[] = [];
  for (const recipient of input.recipients) {
    if (recipient && typeof recipient === 'object' && !Array.isArray(recipient)) {
      const unknownRecipientFields = unknownKeys(recipient, RECIPIENT_FIELDS);
      const message = (recipient as { message?: unknown }).message;
      if (message && typeof message === 'object' && !Array.isArray(message)) unknownRecipientFields.push(...unknownKeys(message, ['subject', 'body']).map((field) => `message.${field}`));
      if (unknownRecipientFields.length) return scope.json({ error: 'unknown_field', fields: unknownRecipientFields.map((field) => `recipients[].${field}`) }, 422);
    }
    // A name and an email each, unless the template's default signer for the role gives them (checked below).
    if (!recipient || typeof recipient !== 'object' || typeof recipient.role !== 'string' || (recipient.name !== undefined && !validRecipientName(recipient.name)) || (recipient.email !== undefined && !validRecipientEmail(recipient.email))) return scope.json({ error: 'invalid_recipient' }, 422);
    // A sign-by deadline for this recipient (ISO 8601, future, within 400 days).
    const deadline = parseDeadline((recipient as { expiresAt?: unknown }).expiresAt);
    if (deadline === 'invalid') return scope.json({ error: 'invalid_recipient' }, 422);
    deadlines.push(deadline);
    // The signer's title and the company they sign for (evidence of authority).
    const facts = parseSignerFacts(recipient as { title?: unknown; onBehalfOf?: unknown });
    if (facts === 'invalid') return scope.json({ error: 'invalid_recipient' }, 422);
    signerFacts.push(facts);
    // Who named this signer, for the certificate.
    const named = parseNamedBy((recipient as { namedBy?: unknown }).namedBy);
    if (named === 'invalid') return scope.json({ error: 'invalid_recipient' }, 422);
    namedBy.push(named);
    // What the host says happens once this signer signs, shown on their signing page only.
    const after = parseAfterSigning((recipient as { afterSigning?: unknown }).afterSigning);
    if (after === 'invalid') return scope.json({ error: 'invalid_recipient' }, 422);
    afterSigning.push(after);
    // How the signer reaches the page: the host's (default), or an invitation Esign emails; and the
    // sender's message to this signer alone.
    const delivery = parseDelivery((recipient as { delivery?: unknown }).delivery);
    const own = parseMessage((recipient as { message?: unknown }).message);
    if (delivery === 'invalid' || own === 'invalid') return scope.json({ error: 'invalid_recipient' }, 422);
    deliveries.push(delivery);
    messages.push(own);
    recipients.push({ role: recipient.role, ...(recipient.name === undefined ? {} : { name: recipient.name as string }), ...(recipient.email === undefined ? {} : { email: recipient.email as string }), ...(deadline === null ? {} : { expiresAt: new Date(deadline).toISOString() }), ...facts, ...(named ? { namedBy: named } : {}), ...(after ? { afterSigning: after } : {}), ...(delivery === 'email' ? { delivery } : {}), ...(own ? { message: own } : {}) });
  }
  const tenantId = scope.tenantId;
  const encoded = JSON.stringify({ templateId: input.templateId, recipients, ...(documentName ? { documentName } : {}), ...(documentVersion ? { documentVersion } : {}), ...(sender ? { sender } : {}), ...(metadata ? { metadata } : {}), ...(message ? { message } : {}), ...(tags.length ? { tags } : {}), ...(shares.length ? { share: shares } : {}), ...(prefillInput ? { prefill: prefillInput } : {}) });
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))), (n) => n.toString(16).padStart(2, '0')).join('');
  // Idempotency is by the envelope itself: its id comes from the tenant and the Idempotency-Key, and
  // it keeps the hash of the request that created it. A retry of that request gets the response a
  // first creation returns (always IN_PROGRESS, whatever the envelope's status is now), and the
  // same key with another request is a conflict.
  // A draft being sent is already this envelope: no key, no replay; it is sent once, when it is still a draft.
  const fromDraft = 'draftId' in target;
  const id = fromDraft ? target.draftId : await envelopeIdFor(tenantId, target.key);
  const lookup = () => scope.env.DB.prepare('SELECT request_sha256, status FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ request_sha256: string; status: string }>();
  const replay = (existing: { request_sha256: string; status: string }) => fromDraft ? scope.json({ error: existing.status === DRAFT ? 'send_failed' : 'not_draft' }, 409)
    : existing.status === DRAFT ? scope.json({ error: 'idempotency_conflict' }, 409)
    : existing.request_sha256 === hash ? scope.json(createdResponse(id), 201) : scope.json({ error: 'idempotency_conflict' }, 409);
  // Checking a send to schedule it creates nothing: a draft by this key is the schedule's own, replayed by saveDraft.
  const existing = fromDraft || options.check ? null : await lookup();
  if (existing) return replay(existing);
  // Anyone who sees the template sends from it (ownership.ts), an archived one too (archiving only takes it off the
  // lists: a host that keeps its id goes on using it); one they can't see doesn't exist for them.
  const caller = scope.caller;
  // A draft whose document was uploaded with it is sent with that document (its initial document, D0) and the roles
  // and fields placed on it; any other envelope with its template's.
  const uploaded = fromDraft && input.templateId === undefined;
  let template: { object_key: string; roles_json: string; fields_json?: string; default_signers_json?: string; status: string } | null;
  let uploadedDocument: { object_key: string; sha256: string } | null = null;
  if (uploaded) {
    const own = await scope.env.DB.prepare('SELECT e.template_id, e.roles_json, e.fields_json, a.object_key, a.sha256 FROM envelopes e LEFT JOIN artifacts a ON a.id = ? AND a.envelope_id = e.id WHERE e.id = ? AND e.tenant_id = ?')
      .bind(initialDocumentId(id), id, tenantId).first<{ template_id: string | null; roles_json: string | null; fields_json: string | null; object_key: string | null; sha256: string | null }>();
    if (!own || own.template_id !== null) return scope.json({ error: 'invalid_envelope' }, 422);
    if (!own.object_key || !own.sha256) return scope.json({ error: 'document_required' }, 409);
    if (!own.roles_json || !own.fields_json) return scope.json({ error: 'fields_required' }, 409);
    uploadedDocument = { object_key: own.object_key, sha256: own.sha256 };
    template = { object_key: own.object_key, roles_json: own.roles_json, fields_json: own.fields_json, default_signers_json: '{}', status: 'active' };
  } else {
    if (!await documentRole(scope.env.DB, tenantId, caller, 'template', input.templateId as string)) return scope.json({ error: 'not_found' }, 404);
    template = await scope.env.DB.prepare('SELECT * FROM templates WHERE id = ? AND tenant_id = ?').bind(input.templateId, tenantId).first<{ object_key: string; roles_json: string; fields_json?: string; default_signers_json?: string; status: string }>();
  }
  if (!template) return scope.json({ error: 'not_found' }, 404);
  // A draft template isn't ready: it is saved as active in the field editor first.
  if (template.status === 'draft') return scope.json({ error: 'template_draft' }, 409);
  const roles = JSON.parse(template.roles_json) as string[];
  // An uploaded document has no signature page to fall back on: every role signs in its fields, a required Signature
  // among them, as a template's editor requires before it is ready.
  if (uploaded) {
    try { assertEditorSigningFields(JSON.parse(template.fields_json ?? '[]') as TemplateField[], roles); }
    catch { return scope.json({ error: 'fields_not_ready' }, 422); }
  }
  // Every placed field (pre-filled ones among them), the source they are on, and the signers' fields alone.
  let placed: TemplateField[] = [], source: Uint8Array | null = null;
  if (template.fields_json !== undefined) {
    try {
      const raw:unknown=JSON.parse(template.fields_json);
      if(!Array.isArray(raw))throw new Error('Invalid fields');
      if(raw.length){
        const object=await scope.env.ARTIFACTS.get(template.object_key);if(!object||object.size>MAX_PDF_BYTES)throw new Error('Source unavailable');
        source=new Uint8Array(await object.arrayBuffer());
        const pdf=await PDFDocument.load(source,{throwOnInvalidObject:true,updateMetadata:false});validateFieldsPdf(pdf);placed=validateTemplateFields(raw,roles,pdf.getPageCount());assertNoOverlappingFields(placed);validateFieldPlacement(pdf,placed);
        supportedFields(JSON.stringify(signingFieldsOf(placed)),roles,pdf.getPageCount());
      }
    } catch { return scope.json({ error: 'positioned_fields_not_supported' }, 422); }
  }
  const prefillFields = placed.filter((f) => f.type === PREFILL);
  if (roles.length !== recipients.length || new Set(recipients.map((r) => r.role)).size !== roles.length || recipients.some((r) => !roles.includes(r.role))) return scope.json({ error: 'invalid_roles' }, 422);
  // A name or an email a recipient left out is their role's default signer's (default-signers.ts), as the
  // template has them now. The request's hash is of the request as sent: a retry gets this envelope even if
  // the default signers have changed since.
  const defaults = storedDefaultSigners(template.default_signers_json, roles);
  const filled = recipients.map((r) => ({ ...r, name: r.name ?? defaults[r.role]?.name, email: r.email ?? defaults[r.role]?.email }));
  if (filled.some((r) => !validRecipientName(r.name) || !validRecipientEmail(r.email))) return scope.json({ error: 'invalid_recipient' }, 422);
  const people = filled as ((typeof recipients)[number] & { name: string; email: string })[];
  try { await assertRenderableRecipientNames(people.map((recipient) => recipient.name)); }
  catch { return scope.json({ error: 'unsupported_recipient_name' }, 422); }
  // Pre-filled fields: their values, as given or by default, drawn on the document signers see (prefill.ts). An
  // uploaded document has none.
  const resolved = resolvePrefill(prefillDefinitions(placed), prefillInput);
  if ('error' in resolved) return scope.json(resolved, 422);
  const prefill = resolved.values.filter((v) => v.value);
  let stamped: Uint8Array | null = null;
  if (prefill.length && source) {
    try { stamped = await stampPrefill(source, placed, prefill); }
    catch (error) { if (error instanceof PrefillDoesNotFit) return scope.json({ error: 'prefill_too_long', fields: error.fields }, 422); throw error; }
  }
  // The envelope keeps its signers' fields only: its template's, byte for byte, when it has no pre-filled ones.
  const envelopeFields = prefillFields.length ? JSON.stringify(signingFieldsOf(placed)) : template.fields_json ?? '[]';
  const details = JSON.stringify({ ...(documentName ? { documentName } : {}), ...(documentVersion ? { documentVersion } : {}), ...(sender ? { sender } : {}), ...(metadata ? { metadata } : {}), ...(message ? { message } : {}), ...(prefill.length ? { prefill } : {}) } satisfies EnvelopeDetails);
  // Checked to be sent later: every signer's deadline comes after it is sent, and nothing more is done.
  if (options.check) {
    if (deadlines.some((deadline) => deadline !== null && deadline <= options.check!.sendAt)) return scope.json({ error: 'deadline_before_send_at' }, 422);
    return scope.json({ checked: true }, 200);
  }
  // The envelope is prepared here, in the same request: its initial document (D0) is the template's
  // source, and the first signer's task is active. The id comes from the tenant and the
  // Idempotency-Key, so a retry after a failure reuses the D0 object stored by the failed attempt.
  let d0: { id: string; objectKey: string; sha256: string };
  // An uploaded document is the envelope's initial document already.
  if (uploadedDocument) d0 = { id: initialDocumentId(id), objectKey: uploadedDocument.object_key, sha256: uploadedDocument.sha256 };
  else try { d0 = await storeInitialDocument(scope.env.ARTIFACTS, template.object_key, id, stamped ? async () => stamped! : undefined); }
  catch (error) {
    if (!(error instanceof InitialDocumentConflict)) return scope.json({ error: 'preparation_failed' }, 503);
    // Another request with this key stored a different document: it is a different request.
    const raced = await lookup();
    return raced ? replay(raced) : scope.json({ error: 'idempotency_conflict' }, 409);
  }
  const taskIds = recipients.map(() => crypto.randomUUID());
  // The sender owns it. It is shared with whom the request names and, for an API client, its person (members.ts),
  // not with the template's people; the sender's tags are the request's and theirs on the template.
  const given = sharesFor(shares, caller);
  const allTags = uploaded ? tags : mergeTags(tags, await tagsOf(scope.env.DB, tenantId, caller.userId, 'template', input.templateId as string));
  const now = Date.now();
  // One batch: the envelope (with the request's hash, and the roles and fields it is signed with, its template's as
  // stored, byte for byte: envelope-fields.ts), its tasks, its D0 artifact, its shares and the sender's
  // tags commit together or not at all.
  const statements = [
    // The certificate layout this envelope is made with is fixed for good (src/delivery-pdf.ts).
    fromDraft
      // A draft becomes the envelope sent, in this batch, only while it is a draft: otherwise its status would be null,
      // which the table refuses, and nothing in the batch is written.
      ? scope.env.DB.prepare(`UPDATE envelopes SET status = CASE WHEN status = '${DRAFT}' THEN ? ELSE NULL END, template_id = ?, created_at = ?, request_sha256 = ?, roles_json = ?, fields_json = ?, details_json = ?, draft_json = NULL WHERE id = ? AND tenant_id = ?`).bind(CREATED_STATUS, input.templateId ?? null, now, hash, template.roles_json, envelopeFields, details, id, tenantId)
      : scope.env.DB.prepare('INSERT INTO envelopes (id, tenant_id, template_id, status, created_at, request_sha256, owner_user_id, roles_json, fields_json, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, tenantId, input.templateId, CREATED_STATUS, now, hash, caller.userId, template.roles_json, envelopeFields, details),
    ...people.map((recipient, index) => scope.env.DB.prepare('INSERT INTO tasks (id, envelope_id, role, recipient_name, recipient_email, routing_order, status, expires_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(taskIds[index], id, recipient.role, recipient.name, recipient.email, index + 1, index === 0 ? 'ACTIVE' : 'PENDING', deadlines[index], JSON.stringify({ ...signerFacts[index], ...(namedBy[index] ? { namedBy: namedBy[index] } : {}), ...(afterSigning[index] ? { afterSigning: afterSigning[index]! } : {}), ...(deliveries[index] === 'email' ? { delivery: 'email' as const } : {}), ...(messages[index] ? { message: messages[index]! } : {}) } satisfies TaskDetails))),
    ...(uploaded ? [] : [scope.env.DB.prepare('INSERT INTO artifacts (id, envelope_id, object_key, sha256) VALUES (?, ?, ?, ?)').bind(d0.id, id, d0.objectKey, d0.sha256)]),
    // The organization's contacts (contacts.ts): each signer added or refreshed, with the envelope only.
    ...contactUpserts(scope.env.DB, tenantId, people, now),
    ...shareInserts(scope.env.DB, tenantId, 'envelope', id, given, caller.userId, now),
    ...tagWrites(scope.env.DB, tenantId, caller.userId, 'envelope', id, allTags),
  ];
  try { await scope.env.DB.batch(statements); }
  catch (error) {
    // A concurrent creation with this key committed first (the envelope id is the primary key), or the draft was sent
    // or discarded meanwhile.
    const raced = await lookup();
    if (raced && (!fromDraft || raced.status !== DRAFT)) return replay(raced);
    if (fromDraft && !raced) return scope.json({ error: 'not_draft' }, 409);
    throw error;
  }
  // The first signer's invitation, when Esign invites them: after the response, where the platform allows.
  if (deliveries[0] === 'email') {
    const invite = sendDueInvitations(scope.env, tenantId, id);
    if (scope.env.WAIT_UNTIL) scope.env.WAIT_UNTIL(invite);
    else await invite;
  }
  return scope.json(createdResponse(id), fromDraft ? 200 : 201);
}

/** The signers a draft's request names so far, as a list shows them (status DRAFT). */
function draftSigners(raw: string | null): { id: string; role: string; recipient_name: string; recipient_email: string; status: string; details_json: string }[] {
  let request: { recipients?: unknown } = {};
  try { request = JSON.parse(raw ?? '{}') as { recipients?: unknown }; } catch { return []; }
  if (!Array.isArray(request.recipients)) return [];
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  return request.recipients.map((r: Record<string, unknown>, i) => ({ id: `draft-${i}`, role: text(r?.role), recipient_name: text(r?.name), recipient_email: text(r?.email), status: DRAFT, details_json: '{}' }));
}

app.get('/api/envelopes/:id', async (context) => {
  const id = context.req.param('id');
  const tenantId = context.get('tenantId');
  // An envelope the caller sees only; expiring a stranger's id is a no-op lookup.
  const refused = await requireRole(context, 'envelope', id, 'viewer');
  if (refused) return refused;
  await expireIfDue(context.env.DB, id);
  const envelope = await context.env.DB.prepare(`SELECT x.id, x.template_id, x.status, x.created_at, x.details_json, x.owner_user_id, x.draft_json, x.roles_json, x.fields_json, ${sharedRoleColumn('envelope', 'x')} AS shared_role FROM envelopes x WHERE x.id = ? AND x.tenant_id = ?`).bind(...sharedRoleBinds(context.get('caller')), id, tenantId).first<Owned & { template_id: string | null; status: string; created_at: number; details_json: string; draft_json: string | null; roles_json: string | null; fields_json: string | null }>();
  if (!envelope) return context.json({ error: 'not_found' }, 404);
  // openedAt: when the recipient first opened the signing page (the audit trail's first SIGNING_SESSION_OPENED).
  // invitedAt: when Esign last emailed the signer's invitation (delivery 'email').
  const tasks = await context.env.DB.prepare(`SELECT t.id, t.role, t.recipient_name, t.recipient_email, t.routing_order, t.status, t.expires_at, t.details_json,
      (SELECT MIN(a.occurred_at) FROM audit_events a WHERE a.envelope_id = t.envelope_id AND a.task_id = t.id AND a.type = ?) AS opened_at,
      (SELECT i.sent_at FROM invitations i WHERE i.task_id = t.id) AS invited_at
    FROM tasks t WHERE t.envelope_id = ? ORDER BY t.routing_order`).bind(AUDIT.sessionOpened, id).all<{ id: string; role: string; recipient_name: string; recipient_email: string; routing_order: number; status: string ; expires_at: number | null; details_json: string; opened_at: number | null; invited_at: number | null }>();
  const details = envelopeDetails(envelope.details_json);
  // A draft: its request as saved (`draft`), to go on with it; it has no tasks yet.
  // Scheduled, also when it sends or why it didn't (scheduled-send.ts), apart from the request.
  let draft: unknown, scheduled: { sendAt?: string; sendError?: string } = {};
  if (envelope.status === DRAFT) { const split = splitDraft(envelope.draft_json); draft = split.request; scheduled = scheduleView(split.schedule); }
  // A draft whose document is uploaded with it: whether it has one yet, and the roles and fields placed on it so far.
  const upload = envelope.status === DRAFT && envelope.template_id === null ? {
    document: !!await context.env.DB.prepare('SELECT 1 FROM artifacts WHERE id = ? AND envelope_id = ?').bind(initialDocumentId(id), id).first(),
    roles: envelope.roles_json ? JSON.parse(envelope.roles_json) as string[] : [],
    fields: placedFields(envelope.fields_json ?? '[]', true),
  } : undefined;
  return context.json({ id: envelope.id, templateId: envelope.template_id, status: envelope.status, createdAt: envelope.created_at, ...(details.documentName ? { documentName: details.documentName } : {}), metadata: details.metadata ?? {}, ...(details.message ? { message: details.message } : {}), ...(details.prefill ? { prefill: details.prefill } : {}), ...(draft === undefined ? {} : { draft }), ...scheduled, ...(upload ? { upload } : {}), ...(await ownership(context, 'envelope', [envelope])).get(envelope.id), tasks: tasks.results.map((task) => { const own = taskDetails(task.details_json); return { id: task.id, role: task.role, recipientName: task.recipient_name, recipientEmail: task.recipient_email, routingOrder: task.routing_order, status: task.status, delivery: own.delivery ?? 'host', ...(own.message ? { message: own.message } : {}), ...(task.expires_at == null ? {} : { expiresAt: new Date(task.expires_at).toISOString() }), ...(task.opened_at == null ? {} : { openedAt: new Date(task.opened_at).toISOString() }), ...(task.invited_at == null ? {} : { invitedAt: new Date(task.invited_at).toISOString() }) }; }) });
});

/**
 * Deprecated: POST /api/envelopes prepares the envelope itself. Kept as a no-op for callers that
 * still call it after creating one: 204 for an envelope of this tenant (always prepared), else 404.
 */
app.post('/api/envelopes/:id/prepare', async (context) => {
  const refused = await requireRole(context, 'envelope', context.req.param('id'), 'editor');
  if (refused) return refused;
  const prepared = await context.env.DB.prepare("SELECT 1 FROM envelopes e JOIN artifacts a ON a.envelope_id = e.id WHERE e.id = ? AND e.tenant_id = ? AND e.status <> 'DRAFT'").bind(context.req.param('id'), context.get('tenantId')).first();
  if (!prepared) return context.json({ error: 'not_found' }, 404);
  return context.body(null, 204);
});

// The envelope's audit trail for its host: each event in order, with the signer it concerns. Only
// detail that is safe to show is passed on (never a code, a message id or a key).
const AUDIT_DETAIL_SHOWN = ['reason', 'title', 'onBehalfOf', 'authorityConfirmed', 'consentDisclosureVersion', 'to', 'delivery', 'hostAuthentication', 'pages', 'total'];
app.get('/api/envelopes/:id/audit', async (context) => {
  const id = context.req.param('id');
  const refused = await requireRole(context, 'envelope', id, 'viewer');
  if (refused) return refused;
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
  const refused = await requireRole(context, 'envelope', id, 'editor');
  if (refused) return refused;
  const read = () => db.prepare('SELECT status FROM envelopes WHERE id = ? AND tenant_id = ?').bind(id, tenantId).first<{ status: string }>();
  const envelope = await read();
  if (!envelope) return context.json({ error: 'not_found' }, 404);
  // A draft was never sent: voiding it discards it, its shares and tags with it.
  if (envelope.status === DRAFT) {
    const [, discarded] = await db.batch([
      // An uploaded document's record first: it references the envelope.
      db.prepare(`DELETE FROM artifacts WHERE envelope_id = ? AND EXISTS (SELECT 1 FROM envelopes WHERE id = ? AND tenant_id = ? AND status = '${DRAFT}')`).bind(id, id, tenantId),
      db.prepare(`DELETE FROM envelopes WHERE id = ? AND tenant_id = ? AND status = '${DRAFT}'`).bind(id, tenantId),
      db.prepare("DELETE FROM document_shares WHERE tenant_id = ? AND resource_type = 'envelope' AND resource_id = ? AND NOT EXISTS (SELECT 1 FROM envelopes WHERE id = ?)").bind(tenantId, id, id),
      db.prepare("DELETE FROM document_tags WHERE tenant_id = ? AND resource_type = 'envelope' AND resource_id = ? AND NOT EXISTS (SELECT 1 FROM envelopes WHERE id = ?)").bind(tenantId, id, id),
    ]);
    if (discarded!.meta.changes !== 1) return context.json({ error: 'envelope_not_voidable' }, 409);
    await deleteDraftObjects(context.env.ARTIFACTS, id);
    return context.json({ id, status: 'DISCARDED' });
  }
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

mountContactRoutes(app);
mountShareRoutes(app);
mountTagRoutes(app);
mountEnvelopeDocumentRoutes(app);
mountMemberRoutes(app);
mountSigningRoutes(app);
return app;
}

// The Hono app: src/app/server/router.ts serves it, tests call it directly.
export default createApp();
