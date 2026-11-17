import { can, type Caller, type Permission } from './identity.ts';

/**
 * `GET /api/catalog`: Esign's management API as data, for AI agents and API clients (the hosting
 * platform's MCP `endpoints` tool shows it), limited to what the caller may call. The signer pages'
 * API (`/api/public/*`) is left out: it answers only the codes and sessions a recipient holds.
 */
export type CatalogEndpoint = {
  method: 'GET' | 'POST';
  /** The path, with `{param}` placeholders. */
  path: string;
  summary: string;
  query: Record<string, unknown> | null;
  body: Record<string, unknown> | null;
  /** Whether the request needs an `Idempotency-Key` header (a fresh random value per change). */
  idempotencyKey: boolean;
};

/** `orgRoles`: only callers with one of these organization roles may call it (members.ts). */
type Entry = CatalogEndpoint & { permission: Permission | null; orgRoles?: readonly string[] };

const text = (description: string, maxLength: number) => ({ type: 'string', maxLength, description });
/** The sender's message (invitations.ts): an invitation's subject, and a body in it and on the signing page. */
const message = (description: string) => ({
  type: 'object', additionalProperties: false, description,
  properties: { subject: text('The invitation email\'s subject (one line)', 100), body: { type: 'string', maxLength: 10000, description: 'Plain text; line breaks are kept' } },
})

const recipient = {
  type: 'object',
  required: ['role'],
  additionalProperties: false,
  properties: {
    role: text('One of the template\'s roles; each role signs once, in the template\'s order', 64),
    name: text('The signer\'s name, as it appears on the signature. Required unless the template has a default signer with a name for the role', 200),
    email: { type: 'string', format: 'email', maxLength: 254, description: 'Where the signer\'s one-time code is sent. Required unless the template has a default signer with an email for the role' },
    expiresAt: { type: 'string', format: 'date-time', description: 'Sign-by deadline, in the future and within 400 days; the envelope expires after it' },
    title: text('The signer\'s title', 128),
    onBehalfOf: text('The company the signer signs for; they must then give a title and confirm their authority', 200),
    namedBy: text('Who named this signer, for the certificate', 300),
    afterSigning: { type: 'array', maxItems: 3, items: text('A line shown to this signer after they sign', 200) },
    delivery: { type: 'string', enum: ['host', 'email'], default: 'host', description: 'host: your product opens their signing page (recipient-view, for the account signed in to it, which must have their email), and Esign emails them nothing. email: when it is their turn, Esign emails them an invitation to the signing page, and recipient-view refuses them' },
    message: message('A message to this signer alone, instead of the envelope\'s'),
  },
}

/** The host's own labels: kept and returned as given, never read, sealed or shown to signers. */
const metadata = {
  type: 'object', maxProperties: 20, propertyNames: { pattern: '^[A-Za-z0-9_.-]{1,40}$' },
  additionalProperties: { type: 'string', maxLength: 500 },
  description: 'Your own keys and values (your ids, for instance), returned as given',
}
/** A contact's name, title and company (contacts.ts). */
const CONTACT_FIELDS = { name: text('Their name', 200), title: { type: ['string', 'null'], maxLength: 128, description: 'Their title' }, company: { type: ['string', 'null'], maxLength: 200, description: 'The company they sign for' } }
/** Who usually signs as some of a template's roles (default-signers.ts). */
const defaultSigners = {
  type: 'object', maxProperties: 20,
  additionalProperties: { type: 'object', additionalProperties: false, properties: { name: text('Their name, as it appears on the signature', 200), email: { type: 'string', format: 'email', maxLength: 254 } } },
  description: 'Keyed by role: who usually signs as it, a name, an email or both. A recipient of a new envelope that leaves out its name or email gets its role\'s default',
}
const templateName = text('A name for the template, shown in Esign\'s Templates page', 200)
/** The caller's own tags (tags.ts): nobody else sees them. */
const tags = { type: 'array', maxItems: 20, items: text('A tag (compared case-insensitively)', 50), description: 'Your own tags for it: nobody else sees them' }
const shareRole = { type: 'string', enum: ['admin', 'editor', 'viewer'], description: 'viewer: sees it (and sends envelopes from a template); editor: also changes it; admin: also shares it' }
/** Whom else a new document is shared with (ownership.ts). */
const sharedWith = {
  oneOf: [
    { type: 'object', required: ['email', 'role'], additionalProperties: false, properties: { email: { type: 'string', format: 'email', maxLength: 254 }, role: shareRole } },
    { type: 'object', required: ['organization', 'role'], additionalProperties: false, properties: { organization: { const: true, description: 'Everyone in your organization (people, not API clients)' }, role: { ...shareRole, enum: ['editor', 'viewer'] } } },
  ],
}
const share = {
  type: 'array', maxItems: 20,
  items: sharedWith,
  description: 'People it is shared with besides you, its owner (an API client\'s documents are also shared with the person its settings in Esign name)',
}
/** A list's filters (ownership.ts, tags.ts). */
const listFilters = {
  scope: { type: 'string', enum: ['mine', 'shared'], description: 'mine: those you own; shared: those shared with you; both by default' },
  tag: { type: 'array', maxItems: 5, items: text('One of your tags', 50), description: 'Only those with all of these tags of yours (repeat the parameter)' },
}
const ownedFields = 'Each has its owner, your role in it (myRole) and your tags'
const ORG_OWNER = ['OWNER'] as const

/** A new envelope's body (POST /api/envelopes), and a draft's (POST /api/envelopes/{id}), as the route takes it. */
const envelopeProperties = {
  templateId: { type: 'string', description: 'The template sent. Required, except for a draft (draft: true) whose PDF you upload yourself: POST /api/envelopes/{id}/document, then its fields with an editing session (envelopeId)' },
  recipients: { type: 'array', minItems: 1, maxItems: 20, items: recipient, description: 'One per role of the template, in its order. Required to send or schedule; a draft (draft: true) may leave them out for now' },
  documentName: text('The document\'s name, shown to signers and named in the statement they agree to', 200),
  documentVersion: { type: 'object', required: ['label'], additionalProperties: false, properties: { label: text('The version, such as v3', 16), publishedAt: { type: 'string', format: 'date-time' } } },
  sender: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: text('Who sent it', 200), email: { type: 'string', format: 'email' }, organization: text('Their company', 200) } },
  metadata,
  message: message('The sender\'s message to every signer'),
  tags: { ...tags, description: 'Your tags for it, with yours on the template' },
  share,
  prefill: { type: 'object', additionalProperties: { type: 'string', maxLength: 128 }, description: 'The template\'s pre-filled fields\' values, by name (GET /api/templates/{id} lists them as prefill): drawn on the document before anyone signs; a field not given takes its default. Printable ASCII only' },
  draft: { type: 'boolean', description: 'true: save a draft, as it is (status DRAFT); send it later with POST /api/envelopes/{id}' },
  sendAt: { type: 'string', format: 'date-time', description: 'Send later: checked now as a send, kept a draft that Esign sends at this time (1 minute to 400 days ahead, before every signer\'s deadline), as you. Not with draft' },
}

const ENTRIES: Entry[] = [
  { method: 'GET', path: '/api/me', summary: 'Who is calling: the organization, the role and its permissions', query: null, body: null, idempotencyKey: false, permission: null },
  { method: 'GET', path: '/api/catalog', summary: 'The endpoints the caller may use, with their query and body schemas', query: null, body: null, idempotencyKey: false, permission: null },
  {
    method: 'GET', path: '/api/templates', summary: `The templates you own or that are shared with you, newest first; next is the following page's cursor. ${ownedFields}`,
    query: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: text('The next of the page before, for the following page', 100), before: { type: 'integer', description: 'Only templates created before this time (epoch ms)' }, q: text('Only those whose name contains this, or whose id it is', 100), since: { type: 'integer', description: 'Only those uploaded at or after this time (epoch ms)' }, status: { type: 'string', enum: ['active', 'draft', 'all'], description: 'active (the default): ready to send from; draft: saved from the field editor before it is ready' }, ...listFilters } },
    body: null, idempotencyKey: false, permission: 'esign.view',
  },
  {
    method: 'POST', path: '/api/templates', summary: 'Upload a PDF (at most 5 MiB and 100 pages) with the roles that sign it, in signing order. Or, with a JSON body {fromEnvelope, name?, roles?, defaultSigners?, tags?, share?}, save an envelope sent with an uploaded document as a template (its PDF and fields; roles renamed in order; its signers as default signers if defaultSigners)',
    query: null,
    body: { oneOf: [{ type: 'object', description: 'Sent as multipart/form-data fields', required: ['file', 'roles'], additionalProperties: false, properties: { file: { type: 'string', contentMediaType: 'application/pdf' }, roles: { type: 'string', description: 'A JSON array of 1 to 20 distinct role names ([A-Za-z0-9_-], up to 64 characters)' }, name: templateName, metadata: { type: 'string', description: 'A JSON object: your own keys and values (at most 20 keys of [A-Za-z0-9_.-], up to 40 characters; string values up to 500), returned as given' }, defaultSigners: { type: 'string', description: `A JSON object. ${defaultSigners.description}` }, tags: { type: 'string', description: `A JSON array. ${tags.description}` }, share: { type: 'string', description: `A JSON array of {email, role}, or {organization: true, role} (editor or viewer) for everyone in your organization. ${share.description}` } } }, {
      type: 'object', description: 'Sent as JSON: save an envelope sent with an uploaded document as a template', required: ['fromEnvelope'], additionalProperties: false,
      properties: {
        fromEnvelope: { type: 'string', description: 'The envelope, sent (not a draft) with a document uploaded with it, not a template' },
        name: templateName,
        roles: { type: 'array', minItems: 1, maxItems: 20, items: text('A role name ([A-Za-z0-9_-]), in place of the envelope\'s, in signing order', 64), description: 'One for each of the envelope\'s roles, in signing order: their new names' },
        defaultSigners: { type: 'boolean', description: 'true: the envelope\'s signers become the template\'s default signers' },
        tags, share,
      },
    }] },
    idempotencyKey: false, permission: 'esign.manage',
  },
  { method: 'GET', path: '/api/templates/{id}', summary: 'A template: its roles and placed fields, whether they can be signed, and its default signers', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'GET', path: '/api/templates/{id}/pdf', summary: 'A template\'s PDF, as uploaded (application/pdf)', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'POST', path: '/api/templates/{id}', summary: 'Rename a template (null clears its name); envelopes already sent keep their document name (editors, admins and the owner)', query: null, body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { ...templateName, type: ['string', 'null'] } } }, idempotencyKey: false, permission: 'esign.manage' },
  { method: 'POST', path: '/api/templates/{id}/delete', summary: 'Delete a template: it is archived, off every list, while everything by its id works as before, for a host that keeps it (admins and the owner)', query: null, body: null, idempotencyKey: false, permission: 'esign.manage' },
  { method: 'POST', path: '/api/templates/{id}/default-signers', summary: 'Replace a template\'s default signers ({} clears them). Envelopes already sent keep their signers', query: null, body: { type: 'object', required: ['defaultSigners'], additionalProperties: false, properties: { defaultSigners } }, idempotencyKey: false, permission: 'esign.manage' },
  {
    method: 'POST', path: '/api/template-editing-sessions', summary: 'Open the field editor for a host page to embed: a new template, or a copy of an existing one (which keeps its default signers, for the roles it keeps; a new one\'s are set with POST /api/templates/{id}/default-signers once saved)',
    query: null,
    body: { type: 'object', required: ['allowedParentOrigin'], additionalProperties: false, properties: { allowedParentOrigin: { type: 'string', description: 'The host origin that will frame the editor; one of the deployment\'s allowed origins' }, sourceTemplateId: { type: 'string' }, envelopeId: { type: 'string', description: 'Instead of a template: place the fields of this envelope draft, whose document was uploaded with POST /api/envelopes/{id}/document (its roles are its signers\'; nothing else is given)' }, roles: { type: 'array', maxItems: 20, items: text('A role', 64) }, name: { ...templateName, description: 'The saved template\'s name; the source template\'s when left out' }, metadata: { ...metadata, description: 'The saved template\'s metadata; the source template\'s when left out' }, tags: { ...tags, description: 'Your tags for the saved template, with yours on the source template' }, share, replace: { type: 'boolean', description: 'With sourceTemplateId: save a new version that replaces the source (its editors, admins and owner): it keeps the source\'s owner, shares and everyone\'s tags, and the source is archived: no longer listed, but everything by its id works as before (GET says archivedAt). tags and share are then ignored' }, prefill: { type: 'array', minItems: 1, maxItems: 30, description: 'The pre-filled fields you fill in when you send from the saved template: the editor offers these to place, and no others (its author can\'t add their own)', items: { type: 'object', required: ['name', 'label'], additionalProperties: false, properties: { name: text('Letters, digits and _, in parts joined by dots (partner.name)', 64), label: text('What the author sees', 80) } } } } },
    idempotencyKey: false, permission: 'esign.manage',
  },
  { method: 'POST', path: '/api/template-editing-sessions/{id}/source', summary: 'Stage the PDF an editing session starts from, before its page is opened (body: the PDF, application/pdf)', query: null, body: { type: 'string', contentMediaType: 'application/pdf' }, idempotencyKey: false, permission: 'esign.manage' },
  { method: 'GET', path: '/api/template-editing-sessions/{id}', summary: 'The template an editing session saved, once it has', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  {
    method: 'GET', path: '/api/envelopes', summary: `The envelopes you own or that are shared with you, newest first, with their status, signers, progress (signed of total), whose turn it is (current) and last change; next is the following page's cursor. ${ownedFields}`,
    query: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: text('The next of the page before, for the following page', 100), before: { type: 'integer', description: 'Only envelopes created before this time (epoch ms)' }, status: { type: 'string', description: 'One or more of DRAFT, IN_PROGRESS, FINALIZING, COMPLETED, VOIDED, DECLINED, EXPIRED, comma-separated or repeated; drafts are listed only when asked for' }, q: text('Only those whose document name, or a signer\'s name or email, contains this; or whose id it is', 100), since: { type: 'integer', description: 'Only those created at or after this time (epoch ms)' }, view: { type: 'string', enum: ['waiting', 'expiring'], description: 'waiting: yours, out for signature; expiring: out for signature, the active signer\'s deadline within 7 days' }, ...listFilters } },
    body: null, idempotencyKey: false, permission: 'esign.view',
  },
  {
    method: 'POST', path: '/api/envelopes', summary: 'Send a template for signature: one recipient per role, who sign in order. The first signer\'s task is active at once. With draft: true, save a draft instead (unchecked but for its shape; nobody is asked to sign)',
    query: null,
    body: { type: 'object', additionalProperties: false, properties: envelopeProperties },
    idempotencyKey: true, permission: 'esign.manage',
  },
  {
    method: 'POST', path: '/api/envelopes/{id}', summary: 'A draft: changed (with draft: true, which also cancels a scheduled send), scheduled or rescheduled (with sendAt), or sent (without either: checked and sent as a new envelope, once); its editors, admins and owner. Not a draft: 409 not_draft',
    query: null, body: { type: 'object', description: 'The body of POST /api/envelopes', additionalProperties: false, properties: envelopeProperties },
    idempotencyKey: false, permission: 'esign.manage',
  },
  { method: 'POST', path: '/api/envelopes/{id}/document', summary: 'Upload or replace the PDF of an envelope draft created without templateId (its fields are then placed with an editing session\'s envelopeId, and cleared by a replacement)', query: null, body: { type: 'string', contentMediaType: 'application/pdf' }, idempotencyKey: false, permission: 'esign.manage' },
  { method: 'GET', path: '/api/envelopes/{id}', summary: 'An envelope: its status and each signer\'s task, in order', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'GET', path: '/api/envelopes/{id}/audit', summary: 'The envelope\'s audit trail, in order', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'POST', path: '/api/envelopes/{id}/void', summary: 'Withdraw an envelope nobody has finished signing', query: null, body: { type: 'object', additionalProperties: false, properties: { reason: text('Why, for the audit trail', 500) } }, idempotencyKey: false, permission: 'esign.manage' },
  {
    method: 'POST', path: '/api/envelopes/{id}/tasks/{taskId}/recipient-view', summary: 'A one-time code for the active signer\'s signing page: embed <app origin>/sign#code=<code>',
    query: null,
    body: { type: 'object', required: ['signedInEmail'], additionalProperties: false, properties: { signedInEmail: { type: 'string', format: 'email', description: 'The email of the account signed in to your product, which must be the signer\'s (case-insensitive); required for your signers. A signer Esign invites by email is refused (409 recipient_signs_by_email)' }, origin: { type: 'string', description: 'The page origin the code is for; the app\'s own by default' }, hostAuthentication: { type: 'object', required: ['method'], properties: { method: { type: 'string', pattern: '^[A-Z][A-Z_]*$' }, provider: { type: 'string' }, domain: { type: 'string' }, signedInAt: { type: 'string', format: 'date-time' } } } } },
    idempotencyKey: false, permission: 'esign.manage',
  },
  { method: 'POST', path: '/api/envelopes/{id}/tasks/{taskId}/invitation', summary: 'Email the active signer\'s invitation again, with a new link (the earlier one stops working); for a signer Esign invites by email', query: null, body: null, idempotencyKey: false, permission: 'esign.manage' },
  { method: 'GET', path: '/api/envelopes/{id}/delivery-pdf', summary: 'A completed envelope\'s signed PDF followed by its certificate of completion', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'GET', path: '/api/envelopes/{id}/certificate', summary: 'A completed envelope\'s seal, checked: what it binds and how', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  {
    method: 'GET', path: '/api/contacts', summary: 'The organization\'s contacts (everyone its envelopes named, and those added by hand), most recently used first',
    query: { type: 'object', properties: { q: text('Only contacts whose name or email contains this', 100), limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', description: 'The `next` of the previous page' } } },
    body: null, idempotencyKey: false, permission: 'esign.view',
  },
  { method: 'GET', path: '/api/contacts/{id}', summary: 'A contact, with the envelopes that name them as a signer, newest first', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  {
    method: 'POST', path: '/api/contacts', summary: 'Add a contact, or change the one with this email (201 added, 200 changed). A contact is never evidence: envelopes keep what they were sent with',
    query: null, body: { type: 'object', required: ['email', 'name'], additionalProperties: false, properties: { ...CONTACT_FIELDS, email: { type: 'string', format: 'email', maxLength: 254 } } },
    idempotencyKey: false, permission: 'esign.manage',
  },
  { method: 'POST', path: '/api/contacts/{id}', summary: 'Change a contact\'s name, title or company (null or \'\' clears a title or company); the email stays', query: null, body: { type: 'object', additionalProperties: false, properties: CONTACT_FIELDS }, idempotencyKey: false, permission: 'esign.manage' },
  { method: 'POST', path: '/api/contacts/{id}/delete', summary: 'Delete a contact; their envelopes are untouched, and the next envelope that names them adds them again', query: null, body: null, idempotencyKey: false, permission: 'esign.manage' },
  ...(['templates', 'envelopes'] as const).flatMap((kind): Entry[] => [
    { method: 'GET', path: `/api/${kind}/{id}/shares`, summary: 'Who sees it: its owner and the people it is shared with, and your role in it', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
    { method: 'POST', path: `/api/${kind}/{id}/shares`, summary: 'Share it with someone, or with everyone in your organization, or change their role (admins and the owner; admin at most, everyone editor at most)', query: null, body: sharedWith, idempotencyKey: false, permission: 'esign.manage' },
    { method: 'POST', path: `/api/${kind}/{id}/shares/delete`, summary: 'Stop sharing it with someone, or with everyone (admins and the owner, or anyone for themselves)', query: null, body: { oneOf: [{ type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', format: 'email' } } }, { type: 'object', required: ['organization'], additionalProperties: false, properties: { organization: { const: true } } }] }, idempotencyKey: false, permission: 'esign.view' },
    { method: 'POST', path: `/api/${kind}/{id}/tags`, summary: 'Replace your own tags on it ([] clears them)', query: null, body: { type: 'object', required: ['tags'], additionalProperties: false, properties: { tags } }, idempotencyKey: false, permission: 'esign.view' },
  ]),
  { method: 'GET', path: '/api/tags', summary: 'Your own tags, most used first', query: { type: 'object', properties: { q: text('Only tags containing this', 50), limit: { type: 'integer', minimum: 1, maximum: 100 } } }, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'GET', path: '/api/members', summary: 'People of your organization who can use Esign, to share with (as the platform lists them; else those Esign has seen)', query: { type: 'object', properties: { q: text('Only those whose name or email contains this', 100), limit: { type: 'integer', minimum: 1, maximum: 100 } } }, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'GET', path: '/api/owners', summary: 'Everyone who owns templates or envelopes, with how many (organization owners)', query: null, body: null, idempotencyKey: false, permission: 'esign.manage', orgRoles: ORG_OWNER },
  { method: 'POST', path: '/api/owners/{id}/transfer', summary: 'Take over every template and envelope someone owns (organization owners)', query: null, body: null, idempotencyKey: false, permission: 'esign.manage', orgRoles: ORG_OWNER },
  { method: 'POST', path: '/api/process-due', summary: 'Send scheduled drafts whose time has come, expire envelopes past a deadline, finish those left unfinished, and send signed-copy notices and invitations still owed', query: null, body: null, idempotencyKey: false, permission: 'esign.manage' },
];

export function apiCatalog(caller: Caller): { endpoints: CatalogEndpoint[] } {
  return {
    endpoints: ENTRIES
      .filter((entry) => (entry.permission === null || can(caller, entry.permission)) && (!entry.orgRoles || (caller.orgRole !== null && entry.orgRoles.includes(caller.orgRole))))
      .map(({ permission: _permission, orgRoles: _orgRoles, ...endpoint }) => endpoint),
  };
}
