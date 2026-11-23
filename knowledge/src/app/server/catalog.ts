import { can, isOrgOwner, type Caller, type Permission } from './identity.ts'

/**
 * `GET /api/catalog`: Knowledge's API as data, for AI assistants and API clients (the platform's MCP `endpoints` tool
 * shows it), listing only what the caller may use. Browser-only actions (sharing, settings, export, transfer, delete,
 * Rules and data changes) are never listed for assistants or API clients; API clients don't start collections; the
 * tick's route is never listed. Each entry says which collection role it needs, and the errors it can answer.
 */
export interface CatalogEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** The path, with `{param}` placeholders. */
  path: string
  summary: string
  query: Record<string, unknown> | null
  body: Record<string, unknown> | null
  /** Whether the request needs an `Idempotency-Key` header (a fresh random value per change). */
  idempotencyKey: boolean
  /** Optional request headers the endpoint reads besides it, as JSON Schema by name. */
  headers?: Record<string, unknown>
  /** The least role in the collection, where the path names one. */
  collectionRole?: 'VIEWER' | 'EDITOR' | 'ADMIN' | 'OWNER'
  errors: string[]
}

interface Entry extends CatalogEndpoint {
  permission: Permission | null
  browserOnly?: boolean
  people?: boolean
  orgOwners?: boolean
}

const str = (description: string, maxLength: number, extra: Record<string, unknown> = {}) => ({ type: 'string', maxLength, description, ...extra })
const ids = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' }, description: 'The collections to search: at least 1, at most 5 (ids from GET /api/collections). Nothing searches every collection.' }
const COMMON = ['unauthorized', 'forbidden']
const IN_COLLECTION = [...COMMON, 'not_found', 'assistants_off', 'deleting']
const QUOTA = 'quota_exceeded (429: { error, limit, resets_at, message })'
/** A change the engine makes, without an Idempotency-Key. */
const ENGINE_CHANGE = [...IN_COLLECTION, 'bad_request', 'busy_learning', 'engine_unavailable']
/** A change that needs an Idempotency-Key. */
const CHANGE = [...ENGINE_CHANGE, 'idempotency_key_required', 'idempotency_key_reused', 'conflict (the same request is still running)']
/** The engine works, so awake hours count: refused at the organization's limit. */
const AWAKE = 'quota_exceeded (429, limit awake_hours_month)'
/** K3: whom the caller acts for, on changes that add to a collection. */
const ON_BEHALF_OF = {
  'x-on-behalf-of': str('Optional: whom you act for, such as the person who approved the change ("Ana Lee"). Trimmed, 1 to 200 characters, one line. Kept with the import, answered as onBehalfOf with it and in History; a label only, it gives no access. Not part of the request an Idempotency-Key retry repeats: the first request\'s value stays. Longer, or with control characters: 400 bad_request.', 200, { minLength: 1 }),
}
/** K4: the collection version a note or a correction was based on. */
const EXPECTED_VERSION = { type: 'integer', minimum: 0, description: 'Optional: the collection\'s version you based this on (version in GET /api/collections, or an import\'s version once committed). If the collection is at another version now, 409 version_changed and nothing is added; if it moves on before this is learned (the queue, or the 1st for one that waits), the import fails with error version_changed. A retry with the same Idempotency-Key answers the first result, whatever the version now.' }
const VERSION_CHANGED = 'version_changed (409: { error, currentVersion, message }: the collection isn\'t at expectedVersion; nothing was added)'

const ENTRIES: Entry[] = [
  { method: 'GET', path: '/api/me', summary: 'Who is calling: the organization, the role in Knowledge and its permissions', query: null, body: null, idempotencyKey: false, permission: null, errors: COMMON },
  { method: 'GET', path: '/api/catalog', summary: 'The endpoints the caller may use, with their query and body schemas', query: null, body: null, idempotencyKey: false, permission: null, errors: COMMON },
  {
    method: 'GET', path: '/api/collections', summary: 'The collections you can ask, with their names, purposes and your role in each. Start here: every search names collections from this list.',
    query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', errors: COMMON,
  },
  {
    method: 'POST', path: '/api/collections', summary: 'Start a collection; you own it, and it is private until shared',
    query: null, body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: str('1 to 200 characters', 200), purpose: str('One sentence: what it is for', 500) } },
    idempotencyKey: true, permission: 'knowledge.collections.create', people: true, errors: [...COMMON, 'bad_request', QUOTA, 'engine_unavailable'],
  },
  { method: 'GET', path: '/api/collections/others', summary: 'Organization owners: basic information about the collections not shared with you (no contents)', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', orgOwners: true, errors: COMMON },
  { method: 'GET', path: '/api/collections/{id}', summary: 'A collection: its purpose, your role, its state (asleep, ready, learning…), counts and its current import', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: IN_COLLECTION },
  {
    method: 'POST', path: '/api/search', summary: 'Search the named collections for passages that answer a question, with their file, the pages (page and pageEnd: the first and last page or slide they run over) and exact position. covered: false means nothing answers it: say you won\'t guess. A sleeping or learning collection answers at once with status waking or learning and retryAfterSeconds; held means the organization has used this month\'s awake hours, and nothing runs until the 1st.',
    query: null, body: { type: 'object', required: ['collections', 'query'], additionalProperties: false, properties: { collections: ids, query: str('The question', 2000), topK: { type: 'integer', minimum: 1, maximum: 20 } } },
    idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER',
    errors: [...IN_COLLECTION, 'collection_required (400: no collection named)', 'too_many_collections (400: more than 5)', QUOTA, 'engine_unavailable'],
  },
  {
    method: 'POST', path: '/api/ask', summary: 'On the site: a written answer with checked citations, or "I won\'t guess"',
    query: null, body: { type: 'object', required: ['collections', 'question'], additionalProperties: false, properties: { collections: ids, question: str('The question', 2000) } },
    idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', browserOnly: true,
    errors: [...IN_COLLECTION, 'collection_required', 'too_many_collections', QUOTA, 'browser_only'],
  },
  { method: 'POST', path: '/api/answers/{answerId}/right', summary: '"Was this right?" Yes: marks an answer you asked for as right, while you can still open its collections; collections count answers marked right', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', errors: [...COMMON, 'not_found', 'assistants_off'] },
  { method: 'GET', path: '/api/collections/{id}/sources', summary: 'The files, web pages and notes a collection holds, and whether each is used', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: [...IN_COLLECTION, 'engine_unavailable'] },
  { method: 'GET', path: '/api/collections/{id}/sources/{docId}', summary: 'One source\'s text (hidden values show as [hidden]), with its pages, so a citation\'s start and end can be found', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: [...IN_COLLECTION, 'engine_unavailable'] },
  { method: 'GET', path: '/api/collections/{id}/facts', summary: 'What a collection knows: facts as sentences, each with its source sentence and who checked it', query: { type: 'object', properties: { cursor: { type: 'string' } } }, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: [...IN_COLLECTION, 'engine_unavailable'] },
  { method: 'POST', path: '/api/collections/{id}/facts/{factId}/check', summary: 'Mark a fact as checked ("Looks right"), with your name', query: null, body: null, idempotencyKey: false, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...IN_COLLECTION, 'bad_request'] },
  {
    method: 'GET', path: '/api/attention', summary: 'Needs attention: files Insulin couldn\'t read, values hidden before learning, reported answers waiting and corrections to check, in every collection you can change. Values hidden before learning are read for the 50 collections changed most recently (any one collection asked for on its own is read in full): the others are marked partial, and notice says so.',
    query: { type: 'object', properties: { collection: { type: 'string', description: 'Only this collection' } } }, body: null, idempotencyKey: false, permission: 'knowledge.collections.edit', errors: [...IN_COLLECTION],
  },
  { method: 'GET', path: '/api/collections/{id}/history', summary: 'Restore points, newest first, and whether each can be brought back. madeBy lists who made the files, web pages, notes and corrections each holds ({ id, type: person or client, name, onBehalfOf }); going back, undo and stopping a file name no one.', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: [...IN_COLLECTION, 'engine_unavailable'] },
  { method: 'GET', path: '/api/collections/{id}/history/{version}/preview', summary: 'What going back to a restore point would do: files set aside (not deleted) and corrections undone', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: [...IN_COLLECTION, 'engine_unavailable'] },
  {
    method: 'POST', path: '/api/collections/{id}/reports', summary: 'Report that an answer may be wrong; the owner and the collection\'s admins get an e-mail',
    query: null, body: { type: 'object', required: ['question'], additionalProperties: false, properties: { answerId: str('The answer\'s id, from /api/ask', 64), question: str('The question', 2000), answer: str('The answer given', 8000), note: str('What is wrong', 2000) } },
    idempotencyKey: true, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: [...IN_COLLECTION, 'idempotency_key_required'],
  },
  { method: 'GET', path: '/api/collections/{id}/reports', summary: 'Reported answers and whether each is open, fixed or dismissed', query: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'fixed', 'dismissed'] }, answerId: { type: 'string' } } }, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: IN_COLLECTION },
  {
    method: 'POST', path: '/api/collections/{id}/notes', summary: 'Add a note; the collection learns it in about a minute (questions wait meanwhile). When the organization has learned this month\'s documents, it waits and is learned on the 1st: `waiting` says until when. Answers 202 { import } (with onBehalfOf); follow it with GET /api/collections/{id}/imports/{importId}.',
    query: null, body: { type: 'object', required: ['text'], additionalProperties: false, properties: { title: str('A title', 200), text: str('The note', 20_000), expectedVersion: EXPECTED_VERSION } },
    idempotencyKey: true, headers: ON_BEHALF_OF, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...CHANGE, QUOTA, VERSION_CHANGED],
  },
  {
    method: 'POST', path: '/api/collections/{id}/preflight', summary: 'Before adding files: which can be learned and which can\'t (with the reason), within your organization\'s limits. Gives a fileId for each file to upload.',
    query: null, body: { type: 'object', required: ['files'], properties: { files: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['name', 'bytes'], properties: { name: str('The file name, with its extension', 255), bytes: { type: 'integer', minimum: 0, description: 'Its size; an empty file is named as such' }, type: str('Its media type', 200) } } }, export: { type: 'boolean', description: 'Start an empty collection from a Knowledge export: one .zip file a collection\'s Export made' } } },
    idempotencyKey: false, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...IN_COLLECTION, 'bad_request', QUOTA],
  },
  {
    method: 'PUT', path: '/api/collections/{id}/uploads/{fileId}', summary: 'Upload a file preflight accepted (it keeps the name preflight was given): the raw bytes as the body, optionally their SHA-256 in x-file-sha256. Answers accepted: false, with the reason, for a PDF that is only a scanned image.',
    query: null, body: { type: 'string', contentMediaType: 'application/octet-stream' }, idempotencyKey: false, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...ENGINE_CHANGE, 'quota_exceeded (429, limit file_bytes)', 'payload_too_large', 'unsupported_type'],
  },
  {
    method: 'POST', path: '/api/collections/{id}/imports', summary: 'Learn uploaded files, all or nothing. Questions to the collection wait while it learns. When the organization has learned this month\'s documents, the files wait and are learned on the 1st: `waiting` says until when, and names a file Insulin couldn\'t keep until then (listed as failed, to add again).',
    query: null, body: { type: 'object', required: ['fileIds'], additionalProperties: false, properties: { fileIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } } },
    idempotencyKey: true, headers: ON_BEHALF_OF, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...CHANGE, QUOTA, 'capacity'],
  },
  {
    method: 'GET', path: '/api/collections/{id}/imports', summary: 'Imports waiting for the 1st (?state=waiting), or that Insulin has but hasn\'t started learning (?state=queued; once it starts on one, it leaves this list): what each brings, who added it (and onBehalfOf, whom they said they acted for), and when one waiting for the 1st starts by itself',
    query: { type: 'object', required: ['state'], properties: { state: { type: 'string', enum: ['waiting', 'queued'] } } }, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: [...IN_COLLECTION, 'bad_request'],
  },
  { method: 'DELETE', path: '/api/collections/{id}/imports/{importId}', summary: 'Cancel an import waiting for the 1st, or one Insulin has but hasn\'t started learning: it is never learned, and what it held of the limits is free again. Once learning has started it can\'t be cancelled (409), also while a try that was interrupted is made again; one Insulin put back in its queue (a removal for good or the awake-hours stop went first) can be again.', query: null, body: null, idempotencyKey: false, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...IN_COLLECTION, 'conflict (it has started learning or finished, or Insulin can\'t tell yet)'] },
  {
    method: 'POST', path: '/api/collections/{id}/import-export', summary: 'Start an empty collection from a Knowledge export, after preflight with "export": true and the upload: the same sources, the files it stopped using, its notes and corrections. What it holds is reserved against the limits first.',
    query: null, body: { type: 'object', required: ['fileId'], additionalProperties: false, properties: { fileId: str('The export\'s fileId from preflight', 64) } },
    idempotencyKey: true, headers: ON_BEHALF_OF, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...CHANGE, QUOTA, 'conflict (the collection isn\'t empty)'],
  },
  { method: 'GET', path: '/api/collections/{id}/imports/{importId}', summary: 'An import\'s progress: each file waiting, reading, understanding, learned or already here, and the time left. state ends committed (with the version it made), duplicate, failed (error: { error, message }; error version_changed when the collection moved past its expectedVersion) or cancelled. onBehalfOf: the x-on-behalf-of it was added with, or null.', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', errors: [...IN_COLLECTION, 'engine_unavailable'] },
  {
    method: 'POST', path: '/api/collections/{id}/web-pages', summary: 'Add a public web page; add it again to read it again',
    query: null, body: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: str('An http or https address on the public internet', 2000) } },
    idempotencyKey: true, headers: ON_BEHALF_OF, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...CHANGE, QUOTA, 'unreachable', 'unsupported_type', 'payload_too_large'],
  },
  {
    method: 'PATCH', path: '/api/collections/{id}/sources/{docId}', summary: 'Stop using a file (kept, not used for answers) or use it again; a restore point either way',
    query: null, body: { type: 'object', required: ['active'], additionalProperties: false, properties: { active: { type: 'boolean' } } },
    idempotencyKey: false, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: ENGINE_CHANGE,
  },
  { method: 'DELETE', path: '/api/collections/{id}/sources/{docId}', summary: 'Remove a file for good: its text goes, and restore points that held it can no longer be brought back. Answers the version the removal commits as. It goes ahead at the awake-hours stop too.', query: null, body: null, idempotencyKey: false, permission: 'knowledge.collections.share', collectionRole: 'ADMIN', errors: ENGINE_CHANGE },
  {
    method: 'POST', path: '/api/collections/{id}/corrections', summary: 'Fix an answer or a fact once: a note the collection learns, marking the passages it corrects as outdated. New questions use it everywhere. Answers 202 { correction, import } (import with onBehalfOf).',
    query: null, body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: str('The right answer', 20_000), question: str('The question it answers', 2000), outdated: { type: 'array', maxItems: 20, items: { type: 'object', required: ['documentId', 'textHash'], properties: { documentId: { type: 'string' }, textHash: { type: 'string' } } } }, factId: str('A fact from /facts to correct', 200), reportId: str('A report this settles, once the correction is learned', 64), notifyAuthors: { type: 'boolean', description: 'E-mail the people who added the files it corrects (a link, not the correction)' }, expectedVersion: EXPECTED_VERSION } },
    idempotencyKey: true, headers: ON_BEHALF_OF, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...CHANGE, QUOTA, VERSION_CHANGED],
  },
  {
    method: 'GET', path: '/api/collections/{id}/gaps', summary: 'Questions nothing in the collection covered ("I won\'t guess"), still open: what a note or a correction could answer. Newest asked first: { gaps: [{ question, asked, firstAskedAt, lastAskedAt }], next } (next only while there are more: send it as cursor). Values the organization hides show as [hidden]. Needs permission to change content.',
    query: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, cursor: { type: 'string', description: 'next, from the previous page' } } }, body: null,
    idempotencyKey: false, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...IN_COLLECTION, 'bad_request (limit or cursor)'],
  },
  {
    method: 'POST', path: '/api/collections/{id}/correction-checks/clear', summary: 'A correction to check (Needs attention: its file was read again) is still right: it is no longer listed',
    query: null, body: { type: 'object', required: ['noteId', 'documentId', 'textHash'], additionalProperties: false, properties: { noteId: str('From the needs_check item', 100), documentId: str('From the needs_check item', 200), textHash: str('From the needs_check item', 64) } },
    idempotencyKey: false, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...IN_COLLECTION, 'bad_request'],
  },
  {
    method: 'PATCH', path: '/api/collections/{id}/reports/{reportId}', summary: 'Settle a report: fixed (with the correction) or dismissed (the answer is right)',
    query: null, body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['fixed', 'dismissed'] }, correctionId: { type: 'string' } } },
    idempotencyKey: false, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: IN_COLLECTION,
  },
  { method: 'POST', path: '/api/collections/{id}/history/{version}/go-back', summary: 'Answer from an earlier restore point; later files are set aside, not deleted, and it can be undone', query: null, body: null, idempotencyKey: true, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...CHANGE, 'not_restorable', AWAKE] },
  { method: 'POST', path: '/api/collections/{id}/history/undo', summary: 'Undo the last change: go back to the version before it', query: null, body: null, idempotencyKey: true, permission: 'knowledge.collections.edit', collectionRole: 'EDITOR', errors: [...CHANGE, 'not_restorable (nothing to undo)', AWAKE] },
  { method: 'PATCH', path: '/api/collections/{id}', summary: 'Change a collection\'s name, purpose, AI assistants switch or keep-ready window', query: null, body: null, idempotencyKey: false, permission: 'knowledge.collections.share', collectionRole: 'ADMIN', browserOnly: true, errors: [] },
  { method: 'DELETE', path: '/api/collections/{id}', summary: 'Delete a collection', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'OWNER', browserOnly: true, errors: [] },
  { method: 'POST', path: '/api/collections/{id}/transfer', summary: 'Transfer ownership', query: null, body: null, idempotencyKey: true, permission: 'knowledge.collections.share', collectionRole: 'OWNER', browserOnly: true, errors: [] },
  { method: 'GET', path: '/api/collections/{id}/sharing', summary: 'Who a collection is shared with', query: null, body: null, idempotencyKey: false, permission: 'knowledge.use', collectionRole: 'VIEWER', browserOnly: true, errors: [] },
  { method: 'PUT', path: '/api/collections/{id}/sharing/general', summary: 'Share with everyone in the organization', query: null, body: null, idempotencyKey: false, permission: 'knowledge.collections.share', collectionRole: 'ADMIN', browserOnly: true, errors: [] },
  { method: 'PUT', path: '/api/collections/{id}/sharing/{type}/{principalId}', summary: 'Share with a person or an API client', query: null, body: null, idempotencyKey: false, permission: 'knowledge.collections.share', collectionRole: 'ADMIN', browserOnly: true, errors: [] },
  { method: 'DELETE', path: '/api/collections/{id}/sharing/{type}/{principalId}', summary: 'Stop sharing with a person or an API client', query: null, body: null, idempotencyKey: false, permission: 'knowledge.collections.share', collectionRole: 'ADMIN', browserOnly: true, errors: [] },
  { method: 'GET', path: '/api/members', summary: 'People and API clients to share with', query: null, body: null, idempotencyKey: false, permission: 'knowledge.collections.share', browserOnly: true, errors: [] },
  { method: 'POST', path: '/api/collections/{id}/exports', summary: 'Export a collection', query: null, body: null, idempotencyKey: true, permission: 'knowledge.collections.export', collectionRole: 'ADMIN', browserOnly: true, errors: [] },
  { method: 'GET', path: '/api/collections/{id}/exports/{exportId}', summary: 'An export\'s state, or its file', query: null, body: null, idempotencyKey: false, permission: 'knowledge.collections.export', collectionRole: 'ADMIN', browserOnly: true, errors: [] },
  { method: 'GET', path: '/api/rules', summary: 'Rules and data: the time zone, who writes answers on the site, and what is hidden before learning', query: null, body: null, idempotencyKey: false, permission: 'knowledge.rules.manage', errors: COMMON },
  { method: 'PUT', path: '/api/rules', summary: 'Change Rules and data', query: null, body: null, idempotencyKey: false, permission: 'knowledge.rules.manage', browserOnly: true, errors: [] },
  { method: 'POST', path: '/api/rules/hiding-preview', summary: 'Try the hiding rules on a text: what would be hidden before learning', query: null, body: { type: 'object', required: ['text'], properties: { text: str('Any text', 20_000), hiding: { type: 'object' } } }, idempotencyKey: false, permission: 'knowledge.rules.manage', errors: COMMON },
  { method: 'POST', path: '/api/rules/ask-for-more', summary: 'Ask Insulin Apps support for higher limits, with your organization\'s usage', query: null, body: { type: 'object', properties: { limit: str('A limit key', 40), note: str('Why', 2000) } }, idempotencyKey: true, permission: 'knowledge.rules.manage', errors: [...COMMON, 'not_configured'] },
  { method: 'GET', path: '/api/usage', summary: 'Usage beside each limit, and awake hours for the collections you have a role in', query: null, body: null, idempotencyKey: false, permission: 'knowledge.rules.manage', errors: COMMON },
  { method: 'GET', path: '/api/health', summary: 'Health: each collection you have a role in (awake or asleep, last restore point, last backup), and the organization\'s totals', query: null, body: null, idempotencyKey: false, permission: 'knowledge.rules.manage', errors: COMMON },
]

export function apiCatalog(caller: Caller): { endpoints: CatalogEndpoint[] } {
  return {
    endpoints: ENTRIES
      .filter((entry) => entry.permission === null || can(caller, entry.permission))
      .filter((entry) => !entry.browserOnly || caller.via === 'browser')
      .filter((entry) => !entry.people || caller.kind === 'person')
      .filter((entry) => !entry.orgOwners || isOrgOwner(caller))
      .map(({ permission: _permission, browserOnly: _browserOnly, people: _people, orgOwners: _orgOwners, ...endpoint }) => endpoint),
  }
}

/** Every route in the catalog, as `METHOD /path`, for the test that keeps it in step with the app's routes. */
export const CATALOG_ROUTES = ENTRIES.map((entry) => `${entry.method} ${entry.path}`)
