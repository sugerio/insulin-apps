/**
 * Knowledge's tables in D1. Edit this file, then run `npm run db:generate`; the generated migrations in ./migrations
 * are the source of what D1 holds.
 *
 * D1 holds who may do what, lists and logs: collections and their owners, shares, the members cache, imports, the
 * history list mirrored from the engine's outbox, the questions log and its gaps, reports, corrections, usage and
 * limits, and the tick's cursors. Anything that changes answers (sources, corrections, outdated marks) lives in the
 * engine and is restored with it; going back never changes what is here.
 *
 * `org_id` is the Insulin organization (`getCurrentUser().organizationId`): every record of an organization carries
 * it, and every query that reads or changes one names it. Times are epoch milliseconds.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** A collection: files and notes about one subject, with its own owner, sharing and history. */
export const collections = sqliteTable('collections', {
  id: text('id').primaryKey().notNull(),
  org_id: text('org_id').notNull(),
  /** The person who owns it (a platform user id). */
  owner_id: text('owner_id').notNull(),
  /** Since when the current owner owns it. */
  owner_since: integer('owner_since').notNull(),
  name: text('name').notNull(),
  purpose: text('purpose').notNull().default(''),
  created_at: integer('created_at').notNull(),
  created_by: text('created_by').notNull(),
  last_used_at: integer('last_used_at'),
  /** Counts from the engine's latest restore point (outbox `committed`). */
  documents: integer('documents').notNull().default(0),
  active_documents: integer('active_documents').notNull().default(0),
  /** The redacted text kept, with page maps: what "Stored files" counts. */
  bytes: integer('bytes').notNull().default(0),
  facts: integer('facts').notNull().default(0),
  /** The engine's committed restore point (0: nothing learned yet). */
  version: integer('version').notNull().default(0),
  /** The role everyone in the organization who can use Knowledge gets: VIEWER, EDITOR or none. */
  general_role: text('general_role'),
  /** One switch for AI assistants and API clients. */
  assistants: integer('assistants').notNull().default(1),
  /** The keep-ready window, JSON `{ days, start, hours }`, or none. */
  keep_ready: text('keep_ready'),
  /** Paused at 90% of the organization's awake hours this month. */
  keep_ready_paused: integer('keep_ready_paused').notNull().default(0),
  awake_minutes: integer('awake_minutes').notNull().default(10),
  /** active, deleting (the engine is deleting it; the tick retries) or deleted. */
  state: text('state').notNull().default('active'),
  /** The engine's last known state (asleep, ready, learning…), for lists and Health. */
  engine_state: text('engine_state').notNull().default('empty'),
  last_restore_point_at: integer('last_restore_point_at'),
  last_backup_at: integer('last_backup_at'),
  /** No longer read: settings_revision and settings_pushed say whether the engine has the collection's settings. */
  settings_version: integer('settings_version').notNull().default(0),
  /** When the engine last took the collection's settings. */
  settings_synced: integer('settings_synced').notNull().default(0),
  /**
   * The revision of the collection's engine settings: it grows with every change to them (its own, its organization's
   * rules and limits), in the same statement as the change. The engine refuses a revision older than it has.
   */
  settings_revision: integer('settings_revision').notNull().default(1),
  /** The revision the engine has taken; behind settings_revision, the tick sends the settings again. */
  settings_pushed: integer('settings_pushed').notNull().default(0),
  /** When the settings were last sent, taken or not: the tick retries the longest-waiting first. */
  settings_tried_at: integer('settings_tried_at'),
  deleted_at: integer('deleted_at'),
  deleted_by: text('deleted_by'),
  updated_at: integer('updated_at').notNull(),
}, (table) => [
  index('collections_by_org').on(table.org_id, table.state),
  index('collections_by_owner').on(table.org_id, table.owner_id),
  check('collections_state', sql`${table.state} IN ('active', 'deleting', 'deleted')`),
  check('collections_general_role', sql`${table.general_role} IS NULL OR ${table.general_role} IN ('VIEWER', 'EDITOR')`),
  check('collections_keep_ready', sql`${table.keep_ready} IS NULL OR json_valid(${table.keep_ready})`),
])

/** Who a collection is shared with by name: people and API clients, with their role and whether they are away. */
export const collectionShares = sqliteTable('collection_shares', {
  collection_id: text('collection_id').notNull().references(() => collections.id),
  org_id: text('org_id').notNull(),
  /** person or client (an API client: a platform service account). */
  principal_type: text('principal_type').notNull(),
  principal_id: text('principal_id').notNull(),
  role: text('role').notNull(),
  /** active, or on_hold while the person is out of the organization or Knowledge. */
  status: text('status').notNull().default('active'),
  shared_by: text('shared_by').notNull(),
  shared_at: integer('shared_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.collection_id, table.principal_type, table.principal_id] }),
  index('shares_by_principal').on(table.org_id, table.principal_type, table.principal_id),
  check('shares_principal_type', sql`${table.principal_type} IN ('person', 'client')`),
  check('shares_role', sql`${table.role} IN ('VIEWER', 'EDITOR', 'ADMIN')`),
  check('shares_status', sql`${table.status} IN ('active', 'on_hold')`),
])

/**
 * What Knowledge knows about the organization's people and API clients: from their own requests, the member lookup,
 * member status and member events. Names and addresses only for mail and the sharing dialog.
 */
export const members = sqliteTable('members', {
  org_id: text('org_id').notNull(),
  principal_type: text('principal_type').notNull(),
  principal_id: text('principal_id').notNull(),
  name: text('name'),
  email: text('email'),
  /** ADMIN, EDITOR or VIEWER in Knowledge. */
  app_role: text('app_role'),
  /** OWNER, ADMIN, EDITOR, VIEWER or APPS in the organization, when known. */
  org_role: text('org_role'),
  /** Left the organization or Knowledge (their shares are on hold). */
  away: integer('away').notNull().default(0),
  /** An owner of the organization since then (member events `owners`). */
  owner_since: integer('owner_since'),
  /** Set during a resync until member status has checked them. */
  unchecked: integer('unchecked').notNull().default(0),
  /** Their permissions in Knowledge (JSON), when narrowed by a custom role; NULL means the role's own. */
  permissions: text('permissions'),
  seen_at: integer('seen_at'),
  updated_at: integer('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.org_id, table.principal_type, table.principal_id] }),
  check('members_principal_type', sql`${table.principal_type} IN ('person', 'client')`),
])

/** A file announced by preflight and then staged in the engine's inbox, until an import uses it. */
export const stagedFiles = sqliteTable('staged_files', {
  id: text('id').primaryKey().notNull(),
  org_id: text('org_id').notNull(),
  collection_id: text('collection_id').notNull().references(() => collections.id),
  name: text('name').notNull(),
  type: text('type').notNull(),
  bytes: integer('bytes').notNull(),
  sha256: text('sha256'),
  /** expected (preflight passed), staged (in the inbox), refused (with a reason) or used (by an import). */
  state: text('state').notNull(),
  reason: text('reason'),
  created_by: text('created_by').notNull(),
  created_at: integer('created_at').notNull(),
  import_id: text('import_id'),
  /** JSON, for a Knowledge export uploaded to start a collection: its documents and their text's bytes, from its zip. */
  detail: text('detail'),
}, (table) => [
  index('staged_by_collection').on(table.org_id, table.collection_id, table.created_at),
  check('staged_state', sql`${table.state} IN ('expected', 'staged', 'refused', 'used')`),
])

/** An import the app started: files, a web page, a note or a correction. Its state follows the engine. */
export const imports = sqliteTable('imports', {
  id: text('id').primaryKey().notNull(),
  org_id: text('org_id').notNull(),
  collection_id: text('collection_id').notNull().references(() => collections.id),
  kind: text('kind').notNull(),
  created_by: text('created_by').notNull(),
  /** person or client (an API client): who `created_by` is. NULL on rows kept before it was recorded: a person. */
  created_by_type: text('created_by_type'),
  /**
   * Whom the caller said it acted for (`x-on-behalf-of`, 1 to 200 characters), as it wrote it: a label for History and
   * the import's status, never used for access. The first request's value stays: a retry with the same key keeps it.
   */
  on_behalf_of: text('on_behalf_of'),
  created_at: integer('created_at').notNull(),
  state: text('state').notNull(),
  files: integer('files').notNull().default(0),
  version: integer('version'),
  /** Plain words for a person: why it failed. */
  error: text('error'),
  /** The engine's code for why it failed (`version_changed`, `bad_request`…), when it did. */
  error_code: text('error_code'),
  /** JSON: the files' names, and the documents they became once learned (`documents`), for mail and Needs attention. */
  detail: text('detail').notNull().default('{}'),
  /** JSON: the request of an import waiting for next month's documents learned, sent to the engine on the 1st. */
  request: text('request'),
  /**
   * How many times the tick has sent it from waiting, counted before each send; kept apart from `request`, which other
   * writers rewrite. A cancel stands only if no send came after it read the import.
   */
  sends: integer('sends').notNull().default(0),
  /** When the tick last sent it from waiting; cleared when the engine says it never had it. Until then it may be learning. */
  sent_at: integer('sent_at'),
  notified_at: integer('notified_at'),
  finished_at: integer('finished_at'),
}, (table) => [
  index('imports_by_collection').on(table.org_id, table.collection_id, table.created_at),
  check('imports_kind', sql`${table.kind} IN ('files', 'web_page', 'note', 'correction')`),
])

/** The history list: one row per restore point, mirrored from the engine's outbox once per (collection, version). */
export const history = sqliteTable('history', {
  collection_id: text('collection_id').notNull().references(() => collections.id),
  version: integer('version').notNull(),
  org_id: text('org_id').notNull(),
  created_at: integer('created_at').notNull(),
  summary: text('summary').notNull(),
  documents: integer('documents').notNull(),
  import_id: text('import_id'),
}, (table) => [primaryKey({ columns: [table.collection_id, table.version] })])

/** The questions log: one row per collection a question searched, with where it came from. */
export const questions = sqliteTable('questions', {
  id: text('id').primaryKey().notNull(),
  /** The answer the question got, shared by every collection it searched. */
  answer_id: text('answer_id').notNull(),
  org_id: text('org_id').notNull(),
  collection_id: text('collection_id').notNull(),
  asked_by: text('asked_by').notNull(),
  /** browser, mcp or api. */
  via: text('via').notNull(),
  asked_at: integer('asked_at').notNull(),
  question: text('question').notNull(),
  covered: integer('covered').notNull(),
  /** answered, sources_only, wont_guess or waiting. */
  outcome: text('outcome').notNull(),
  model: text('model'),
  /** "Was this right?" Yes, by whoever asked: when. Collections count answers marked right. */
  marked_right_at: integer('marked_right_at'),
}, (table) => [
  index('questions_by_collection').on(table.org_id, table.collection_id, table.asked_at),
  index('questions_by_answer').on(table.org_id, table.answer_id),
])

/** Questions nothing covered, counted per collection: what the owner could write an answer for. */
export const gaps = sqliteTable('gaps', {
  collection_id: text('collection_id').notNull(),
  question_key: text('question_key').notNull(),
  org_id: text('org_id').notNull(),
  question: text('question').notNull(),
  asked: integer('asked').notNull().default(1),
  first_asked_at: integer('first_asked_at').notNull(),
  last_asked_at: integer('last_asked_at').notNull(),
  status: text('status').notNull().default('open'),
}, (table) => [primaryKey({ columns: [table.collection_id, table.question_key] }), index('gaps_by_org').on(table.org_id, table.collection_id, table.status)])

/** "This answer is wrong", from anyone who can ask, for the owner and the collection's admins. */
export const reports = sqliteTable('reports', {
  id: text('id').primaryKey().notNull(),
  org_id: text('org_id').notNull(),
  collection_id: text('collection_id').notNull().references(() => collections.id),
  answer_id: text('answer_id'),
  reported_by: text('reported_by').notNull(),
  created_at: integer('created_at').notNull(),
  question: text('question').notNull(),
  answer: text('answer').notNull().default(''),
  note: text('note').notNull().default(''),
  /** open, fixed or dismissed. */
  status: text('status').notNull().default('open'),
  resolved_by: text('resolved_by'),
  resolved_at: integer('resolved_at'),
  correction_id: text('correction_id'),
}, (table) => [
  index('reports_by_collection').on(table.org_id, table.collection_id, table.status),
  check('reports_status', sql`${table.status} IN ('open', 'fixed', 'dismissed')`),
])

/** A correction: a note the engine learns, with the passages it marks outdated. */
export const corrections = sqliteTable('corrections', {
  id: text('id').primaryKey().notNull(),
  org_id: text('org_id').notNull(),
  collection_id: text('collection_id').notNull().references(() => collections.id),
  created_by: text('created_by').notNull(),
  created_at: integer('created_at').notNull(),
  question: text('question'),
  text: text('text').notNull(),
  /** JSON PassageRef[]. */
  outdated: text('outdated').notNull().default('[]'),
  import_id: text('import_id').notNull(),
  report_id: text('report_id'),
  fact_id: text('fact_id'),
}, (table) => [index('corrections_by_collection').on(table.org_id, table.collection_id, table.created_at)])

/** Month-to-date use per organization (`period` YYYY-MM, UTC): questions, answers, documents learned, awake seconds. */
export const usageCounters = sqliteTable('usage_counters', {
  org_id: text('org_id').notNull(),
  period: text('period').notNull(),
  key: text('key').notNull(),
  /** Awake hours are kept in seconds; everything else in its own unit. */
  used: real('used').notNull().default(0),
  updated_at: integer('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.org_id, table.period, table.key] })])

/** Awake seconds per collection and month, from the engine's ledger: Health and Rules and data show them. */
export const collectionUsage = sqliteTable('collection_usage', {
  collection_id: text('collection_id').notNull(),
  period: text('period').notNull(),
  org_id: text('org_id').notNull(),
  awake_seconds: real('awake_seconds').notNull().default(0),
}, (table) => [primaryKey({ columns: [table.collection_id, table.period] })])

/**
 * Use reserved before work and settled after (limits.ts): inserted only while what is used, plus what is reserved,
 * plus this amount stays within the limit, in one statement, so two requests never pass the same last unit.
 */
export const reservations = sqliteTable('reservations', {
  id: text('id').primaryKey().notNull(),
  org_id: text('org_id').notNull(),
  /** YYYY-MM for a monthly limit, `all` for one that doesn't reset. */
  period: text('period').notNull(),
  key: text('key').notNull(),
  amount: real('amount').notNull(),
  /** How much of it the work has used so far (awake blocks are used up by the engine's ledger). */
  consumed: real('consumed').notNull().default(0),
  /** held, settled or released. */
  state: text('state').notNull().default('held'),
  /** What it is for: an import, a question, a collection's awake block. */
  ref: text('ref').notNull(),
  created_at: integer('created_at').notNull(),
  expires_at: integer('expires_at').notNull(),
  settled_at: integer('settled_at'),
}, (table) => [
  index('reservations_held').on(table.org_id, table.period, table.key, table.state),
  index('reservations_by_ref').on(table.org_id, table.ref, table.state),
  check('reservations_state', sql`${table.state} IN ('held', 'settled', 'released')`),
])

/** The defaults in force for every organization, from the platform (`/__insulin/limits`); NULL value is unlimited. */
export const limitDefaults = sqliteTable('limit_defaults', {
  key: text('key').primaryKey().notNull(),
  value: real('value'),
  updated_at: integer('updated_at').notNull(),
})

/** One organization's overrides, from the platform; NULL value is unlimited, `until` an end date. */
export const orgLimits = sqliteTable('org_limits', {
  org_id: text('org_id').notNull(),
  key: text('key').notNull(),
  value: real('value'),
  until: integer('until'),
  updated_at: integer('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.org_id, table.key] })])

/** The tick's cursors: limits, member events (with a resync's mark and progress) and the engine's outbox. */
export const syncState = sqliteTable('sync_state', {
  name: text('name').primaryKey().notNull(),
  cursor: text('cursor'),
  /** Member events: a resync is under way since then; its progress is in `progress`. */
  resync_started_at: integer('resync_started_at'),
  progress: text('progress'),
  updated_at: integer('updated_at').notNull(),
})

/** An organization's Rules and data: time zone, who writes answers on the site, and what is hidden before learning. */
export const orgSettings = sqliteTable('org_settings', {
  org_id: text('org_id').primaryKey().notNull(),
  time_zone: text('time_zone').notNull().default('UTC'),
  /** builtin (Gemma 4 through the engine) or own (the organization's model through its integration). */
  answer_writer: text('answer_writer').notNull().default('builtin'),
  integration_key: text('integration_key'),
  model_url: text('model_url'),
  model: text('model'),
  /** JSON HidingRules. */
  hiding: text('hiding').notNull(),
  /** Bumped on every change the engine must hear about (collections.settings_version follows it). */
  version: integer('version').notNull().default(1),
  updated_by: text('updated_by'),
  updated_at: integer('updated_at').notNull(),
}, (table) => [
  check('org_settings_writer', sql`${table.answer_writer} IN ('builtin', 'own')`),
  check('org_settings_hiding', sql`json_valid(${table.hiding})`),
])

/** Mail sent once per organization, month and limit: the 80% notice and keep-ready paused. */
export const limitAlerts = sqliteTable('limit_alerts', {
  org_id: text('org_id').notNull(),
  period: text('period').notNull(),
  key: text('key').notNull(),
  kind: text('kind').notNull(),
  sent_at: integer('sent_at').notNull(),
}, (table) => [primaryKey({ columns: [table.org_id, table.period, table.key, table.kind] })])

/** The hours whose usage report was sent (usage-metrics.ts). */
export const metricsReports = sqliteTable('metrics_reports', {
  hour: integer('hour').primaryKey().notNull(),
  started_at: integer('started_at').notNull(),
  sent_at: integer('sent_at'),
})

/** Deletes and transfers, kept after the collection is gone. */
export const activity = sqliteTable('activity', {
  id: text('id').primaryKey().notNull(),
  org_id: text('org_id').notNull(),
  collection_id: text('collection_id').notNull(),
  collection_name: text('collection_name').notNull(),
  /** deleted, deleted_by_org_owner, transferred, ownership_moved. */
  action: text('action').notNull(),
  actor_id: text('actor_id'),
  at: integer('at').notNull(),
  detail: text('detail').notNull().default('{}'),
}, (table) => [index('activity_by_org').on(table.org_id, table.at)])

/** Responses to changes sent with an Idempotency-Key, replayed when the same request comes again. */
export const idempotency = sqliteTable('idempotency', {
  org_id: text('org_id').notNull(),
  actor: text('actor').notNull(),
  key: text('key').notNull(),
  route: text('route').notNull(),
  request_hash: text('request_hash').notNull(),
  /** 0 while the first request is running. */
  status: integer('status').notNull(),
  body: text('body'),
  created_at: integer('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.org_id, table.actor, table.key] })])

/** Exports asked for, so an export is fetched only through the collection it belongs to. */
export const exportsTable = sqliteTable('exports', {
  id: text('id').primaryKey().notNull(),
  org_id: text('org_id').notNull(),
  collection_id: text('collection_id').notNull().references(() => collections.id),
  requested_by: text('requested_by').notNull(),
  created_at: integer('created_at').notNull(),
})

/** Engine outbox events already applied to D1, so a repeated page changes nothing; kept 8 days (the outbox keeps 7). */
export const engineEvents = sqliteTable('engine_events', {
  id: text('id').primaryKey().notNull(),
  at: integer('at').notNull(),
})

/**
 * Engine outbox events that couldn't be applied to D1 (outbox.ts), kept as the engine sent them so the outbox goes on
 * for everything else; the later events of the same collection wait here behind them, in order. Each tick tries them
 * again, oldest first; Health shows the collections they hold up. They go with their collection.
 */
export const parkedEvents = sqliteTable('parked_events', {
  /** The engine's event id: it orders a collection's events. */
  id: text('id').primaryKey().notNull(),
  org_id: text('org_id').notNull(),
  collection_id: text('collection_id').notNull(),
  event: text('event').notNull(),
  /** Why it failed the last time it was tried; null for one only waiting behind another. */
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  parked_at: integer('parked_at').notNull(),
  tried_at: integer('tried_at').notNull(),
}, (table) => [index('parked_events_by_collection').on(table.org_id, table.collection_id)])

/**
 * The awake-hours hold Knowledge wants the engine to have for each organization (POST /v1/orgs/:org/hold): held until
 * `until` (the 1st), or let go (`until` 0). Each change is a new `version` (a new row's starts from the time, so versions
 * only grow), written before it is sent with it; `delivered` is the version the engine's answer showed it took (-1:
 * unknown, after a send that failed or went unanswered). The tick sends again while the two differ.
 */
export const orgHolds = sqliteTable('org_holds', {
  org_id: text('org_id').primaryKey().notNull(),
  until: integer('until').notNull(),
  version: integer('version').notNull().default(1),
  delivered: integer('delivered').notNull().default(0),
  held_at: integer('held_at').notNull(),
})

/** Organizations deleted on insulinapps.com whose engine data must be purged; the tick retries until the engine agrees. */
export const orgPurges = sqliteTable('org_purges', {
  org_id: text('org_id').primaryKey().notNull(),
  requested_at: integer('requested_at').notNull(),
  done_at: integer('done_at'),
})

/** "Looks right": who checked a fact of a collection, and when. Like sharing, it lives here and going back keeps it. */
export const factChecks = sqliteTable('fact_checks', {
  collection_id: text('collection_id').notNull().references(() => collections.id),
  fact_id: text('fact_id').notNull(),
  org_id: text('org_id').notNull(),
  checked_by: text('checked_by').notNull(),
  checked_at: integer('checked_at').notNull(),
}, (table) => [primaryKey({ columns: [table.collection_id, table.fact_id] }), index('fact_checks_by_org').on(table.org_id, table.collection_id)])

/**
 * Corrections that ask to be checked: the file they correct was read again and the passage they marked outdated now
 * reads differently (the engine's outbox `needs_check`). Needs attention shows them until the correction is written
 * again or the collection is deleted.
 */
export const correctionChecks = sqliteTable('correction_checks', {
  collection_id: text('collection_id').notNull().references(() => collections.id),
  note_id: text('note_id').notNull(),
  document_id: text('document_id').notNull(),
  text_hash: text('text_hash').notNull(),
  org_id: text('org_id').notNull(),
  at: integer('at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.collection_id, table.note_id, table.document_id, table.text_hash] }),
  index('correction_checks_by_org').on(table.org_id, table.collection_id),
])
