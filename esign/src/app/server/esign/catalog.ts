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

type Entry = CatalogEndpoint & { permission: Permission | null };

const text = (description: string, maxLength: number) => ({ type: 'string', maxLength, description });
/** The sender's message (invitations.ts): an invitation's subject, and a body in it and on the signing page. */
const message = (description: string) => ({
  type: 'object', additionalProperties: false, description,
  properties: { subject: text('The invitation email\'s subject (one line)', 100), body: { type: 'string', maxLength: 10000, description: 'Plain text; line breaks are kept' } },
})

const recipient = {
  type: 'object',
  required: ['role', 'name', 'email'],
  additionalProperties: false,
  properties: {
    role: text('One of the template\'s roles; each role signs once, in the template\'s order', 64),
    name: text('The signer\'s name, as it appears on the signature', 200),
    email: { type: 'string', format: 'email', maxLength: 254, description: 'Where the signer\'s one-time code is sent' },
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
const templateName = text('A name for the template, shown in Esign\'s Templates page', 200)

const ENTRIES: Entry[] = [
  { method: 'GET', path: '/api/me', summary: 'Who is calling: the organization, the role and its permissions', query: null, body: null, idempotencyKey: false, permission: null },
  { method: 'GET', path: '/api/catalog', summary: 'The endpoints the caller may use, with their query and body schemas', query: null, body: null, idempotencyKey: false, permission: null },
  {
    method: 'GET', path: '/api/templates', summary: 'The organization\'s templates, newest first',
    query: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'integer', description: 'Only templates created before this time (epoch ms), for the next page' } } },
    body: null, idempotencyKey: false, permission: 'esign.view',
  },
  {
    method: 'POST', path: '/api/templates', summary: 'Upload a PDF (at most 5 MiB and 100 pages) with the roles that sign it, in signing order',
    query: null,
    body: { type: 'object', description: 'Sent as multipart/form-data fields', required: ['file', 'roles'], additionalProperties: false, properties: { file: { type: 'string', contentMediaType: 'application/pdf' }, roles: { type: 'string', description: 'A JSON array of 1 to 20 distinct role names ([A-Za-z0-9_-], up to 64 characters)' }, name: templateName, metadata: { type: 'string', description: 'A JSON object: your own keys and values (at most 20 keys of [A-Za-z0-9_.-], up to 40 characters; string values up to 500), returned as given' } } },
    idempotencyKey: false, permission: 'esign.manage',
  },
  { method: 'GET', path: '/api/templates/{id}', summary: 'A template: its roles and placed fields, and whether they can be signed', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  {
    method: 'POST', path: '/api/template-editing-sessions', summary: 'Open the field editor for a host page to embed: a new template, or a copy of an existing one',
    query: null,
    body: { type: 'object', required: ['allowedParentOrigin'], additionalProperties: false, properties: { allowedParentOrigin: { type: 'string', description: 'The host origin that will frame the editor; one of the deployment\'s allowed origins' }, sourceTemplateId: { type: 'string' }, roles: { type: 'array', maxItems: 20, items: text('A role', 64) }, name: { ...templateName, description: 'The saved template\'s name; the source template\'s when left out' }, metadata: { ...metadata, description: 'The saved template\'s metadata; the source template\'s when left out' } } },
    idempotencyKey: false, permission: 'esign.manage',
  },
  { method: 'POST', path: '/api/template-editing-sessions/{id}/source', summary: 'Stage the PDF an editing session starts from, before its page is opened (body: the PDF, application/pdf)', query: null, body: { type: 'string', contentMediaType: 'application/pdf' }, idempotencyKey: false, permission: 'esign.manage' },
  { method: 'GET', path: '/api/template-editing-sessions/{id}', summary: 'The template an editing session saved, once it has', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  {
    method: 'GET', path: '/api/envelopes', summary: 'The organization\'s envelopes, newest first, with their status',
    query: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'integer', description: 'Only envelopes created before this time (epoch ms), for the next page' }, status: { type: 'string', enum: ['IN_PROGRESS', 'FINALIZING', 'COMPLETED', 'VOIDED', 'DECLINED', 'EXPIRED'] } } },
    body: null, idempotencyKey: false, permission: 'esign.view',
  },
  {
    method: 'POST', path: '/api/envelopes', summary: 'Send a template for signature: one recipient per role, who sign in order. The first signer\'s task is active at once',
    query: null,
    body: {
      type: 'object', required: ['templateId', 'recipients'], additionalProperties: false,
      properties: {
        templateId: { type: 'string' },
        recipients: { type: 'array', minItems: 1, maxItems: 20, items: recipient },
        documentName: text('The document\'s name, shown to signers and named in the statement they agree to', 200),
        documentVersion: { type: 'object', required: ['label'], additionalProperties: false, properties: { label: text('The version, such as v3', 16), publishedAt: { type: 'string', format: 'date-time' } } },
        sender: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: text('Who sent it', 200), email: { type: 'string', format: 'email' }, organization: text('Their company', 200) } },
        metadata,
        message: message('The sender\'s message to every signer'),
      },
    },
    idempotencyKey: true, permission: 'esign.manage',
  },
  { method: 'GET', path: '/api/envelopes/{id}', summary: 'An envelope: its status and each signer\'s task, in order', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'GET', path: '/api/envelopes/{id}/audit', summary: 'The envelope\'s audit trail, in order', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'POST', path: '/api/envelopes/{id}/void', summary: 'Withdraw an envelope nobody has finished signing', query: null, body: { type: 'object', additionalProperties: false, properties: { reason: text('Why, for the audit trail', 500) } }, idempotencyKey: false, permission: 'esign.manage' },
  {
    method: 'POST', path: '/api/envelopes/{id}/tasks/{taskId}/recipient-view', summary: 'A one-time code for the active signer\'s signing page: embed <app origin>/sign#code=<code>',
    query: null,
    body: { type: 'object', additionalProperties: false, properties: { signedInEmail: { type: 'string', format: 'email', description: 'The email of the account signed in to your product, which must be the signer\'s (case-insensitive); required for your signers. A signer Esign invites by email is refused (409 recipient_signs_by_email)' }, origin: { type: 'string', description: 'The page origin the code is for; the app\'s own by default' }, hostAuthentication: { type: 'object', required: ['method'], properties: { method: { type: 'string', pattern: '^[A-Z][A-Z_]*$' }, provider: { type: 'string' }, domain: { type: 'string' }, signedInAt: { type: 'string', format: 'date-time' } } } } },
    idempotencyKey: false, permission: 'esign.manage',
  },
  { method: 'POST', path: '/api/envelopes/{id}/tasks/{taskId}/invitation', summary: 'Email the active signer\'s invitation again, with a new link (the earlier one stops working); for a signer Esign invites by email', query: null, body: null, idempotencyKey: false, permission: 'esign.manage' },
  { method: 'GET', path: '/api/envelopes/{id}/delivery-pdf', summary: 'A completed envelope\'s signed PDF followed by its certificate of completion', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'GET', path: '/api/envelopes/{id}/certificate', summary: 'A completed envelope\'s seal, checked: what it binds and how', query: null, body: null, idempotencyKey: false, permission: 'esign.view' },
  { method: 'POST', path: '/api/process-due', summary: 'Expire envelopes past a deadline, finish those left unfinished, and send signed-copy notices still owed', query: null, body: null, idempotencyKey: false, permission: 'esign.manage' },
];

export function apiCatalog(caller: Caller): { endpoints: CatalogEndpoint[] } {
  return {
    endpoints: ENTRIES
      .filter((entry) => entry.permission === null || can(caller, entry.permission))
      .map(({ permission: _permission, ...endpoint }) => endpoint),
  };
}
