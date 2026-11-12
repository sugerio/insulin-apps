/**
 * Esign's tables. Edit this file, then run `npm run db:generate`; the generated migrations in
 * ./migrations are the source of what D1 holds. The triggers that keep signatures and the audit
 * trail append-only are a custom migration (0001_triggers.sql), since Drizzle can't declare them.
 *
 * `tenant_id` is the Insulin organization (`getCurrentUser().organizationId`): every record of an
 * organization carries it, and every query that reads or changes one names it.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text, unique, blob } from 'drizzle-orm/sqlite-core'

/**
 * A PDF with the roles that sign it and, once placed, its fields (JSON, src/app/server/esign/fields.ts).
 * The host's name and metadata for it label it only (src/app/server/esign/metadata.ts).
 */
export const templates = sqliteTable('templates', {
  id: text('id').primaryKey().notNull(),
  tenant_id: text('tenant_id').notNull(),
  object_key: text('object_key').notNull().unique(),
  roles_json: text('roles_json').notNull(),
  created_at: integer('created_at').notNull(),
  fields_json: text('fields_json').notNull().default('[]'),
  name: text('name'),
  metadata_json: text('metadata_json').notNull().default('{}'),
}, (table) => [index('templates_by_tenant').on(table.tenant_id, table.created_at)])

export const envelopes = sqliteTable('envelopes', {
  id: text('id').primaryKey().notNull(),
  tenant_id: text('tenant_id').notNull(),
  template_id: text('template_id').notNull().references(() => templates.id),
  status: text('status').notNull(),
  created_at: integer('created_at').notNull(),
  /** SHA-256 (hex) of the normalized request that created it: the id comes from the tenant and the Idempotency-Key. */
  request_sha256: text('request_sha256').notNull(),
  /** Optional facts (details.ts): document name and version, sender, the host's metadata. */
  details_json: text('details_json').notNull().default('{}'),
}, (table) => [
  index('envelopes_by_tenant').on(table.tenant_id, table.created_at),
  check('envelopes_details_json', sql`json_valid(${table.details_json})`),
])

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey().notNull(),
  envelope_id: text('envelope_id').notNull().references(() => envelopes.id),
  role: text('role').notNull(),
  recipient_name: text('recipient_name').notNull(),
  recipient_email: text('recipient_email').notNull(),
  routing_order: integer('routing_order').notNull(),
  status: text('status').notNull(),
  /** Sign-by deadline (epoch ms); NULL means none. A column because expiry queries it. */
  expires_at: integer('expires_at'),
  /** Optional facts (details.ts): title, on behalf of, named by, after signing. */
  details_json: text('details_json').notNull().default('{}'),
}, (table) => [
  unique('tasks_envelope_role').on(table.envelope_id, table.role),
  index('tasks_expires_at').on(table.expires_at),
  check('tasks_details_json', sql`json_valid(${table.details_json})`),
])

/** An envelope's initial document (D0), copied from its template's source. */
export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey().notNull(),
  envelope_id: text('envelope_id').notNull().unique().references(() => envelopes.id),
  object_key: text('object_key').notNull().unique(),
  sha256: text('sha256').notNull(),
})

/**
 * One-time codes and the sessions they open (access.ts): scope `recipient` (the signing page, subject
 * a task) or `editor` (the embedded editor, subject an editor session). Only SHA-256 hashes are kept.
 */
export const accessCodes = sqliteTable('access_codes', {
  code_hash: text('code_hash').primaryKey().notNull(),
  scope: text('scope').notNull(),
  tenant_id: text('tenant_id').notNull(),
  subject_id: text('subject_id').notNull(),
  origin: text('origin').notNull(),
  expires_at: integer('expires_at').notNull(),
  used_at: integer('used_at'),
  /** How a recipient code was issued (the signer's entry, signer-facts.ts); copied to its session. */
  entry_json: text('entry_json'),
}, (table) => [
  index('access_codes_by_subject').on(table.scope, table.subject_id),
  check('access_codes_scope', sql`${table.scope} IN ('recipient', 'editor')`),
])

export const accessSessions = sqliteTable('access_sessions', {
  token_hash: text('token_hash').primaryKey().notNull(),
  scope: text('scope').notNull(),
  tenant_id: text('tenant_id').notNull(),
  subject_id: text('subject_id').notNull(),
  origin: text('origin').notNull(),
  expires_at: integer('expires_at').notNull(),
  /** When the recipient entered the task's emailed code in this session; always NULL for the editor. */
  otp_verified_at: integer('otp_verified_at'),
  /** How the recipient came to this session (its code's entry_json); recorded when they confirm their code. */
  entry_json: text('entry_json'),
}, (table) => [
  check('access_sessions_scope', sql`${table.scope} IN ('recipient', 'editor')`),
  check('access_sessions_otp_scope', sql`${table.otp_verified_at} IS NULL OR ${table.scope} = 'recipient'`),
])

/** A task's emailed one-time code (otp.ts): only its HMAC, with the per-task limits. */
export const otpChallenges = sqliteTable('otp_challenges', {
  task_id: text('task_id').primaryKey().notNull().references(() => tasks.id),
  session_hash: text('session_hash').notNull().references(() => accessSessions.token_hash),
  otp_hash: text('otp_hash').notNull(),
  expires_at: integer('expires_at').notNull(),
  used_at: integer('used_at'),
  attempts: integer('attempts').notNull().default(0),
  sends: integer('sends').notNull().default(1),
  window_started_at: integer('window_started_at').notNull(),
  last_sent_at: integer('last_sent_at').notNull(),
}, (table) => [
  check('otp_challenges_attempts', sql`${table.attempts} BETWEEN 0 AND 5`),
  check('otp_challenges_sends', sql`${table.sends} BETWEEN 1 AND 3`),
])

/** Each signature, hash-chained in signing order (signatures.ts); facts are immutable (0001_triggers.sql). */
export const signatures = sqliteTable('signatures', {
  id: text('id').primaryKey().notNull(),
  envelope_id: text('envelope_id').notNull().references(() => envelopes.id),
  task_id: text('task_id').notNull().unique().references(() => tasks.id),
  sequence: integer('sequence').notNull(),
  status: text('status').notNull(),
  input_artifact_id: text('input_artifact_id').notNull(),
  input_sha256: text('input_sha256').notNull(),
  output_artifact_id: text('output_artifact_id'),
  output_sha256: text('output_sha256'),
  previous_hash: text('previous_hash'),
  event_hash: text('event_hash').notNull(),
  facts_json: text('facts_json').notNull(),
  render_json: text('render_json').notNull(),
  attempts: integer('attempts').notNull().default(0),
  last_error: text('last_error'),
}, (table) => [
  unique('signatures_envelope_sequence').on(table.envelope_id, table.sequence),
  check('signatures_sequence', sql`typeof(${table.sequence}) = 'integer' AND ${table.sequence} >= 1`),
  check('signatures_status', sql`${table.status} IN ('PENDING', 'DONE')`),
  check('signatures_facts_json', sql`json_valid(${table.facts_json})`),
  check('signatures_render_json', sql`json_valid(${table.render_json})`),
  check('signatures_attempts', sql`${table.attempts} >= 0`),
  check('signatures_first', sql`(${table.sequence} = 1) = (${table.previous_hash} IS NULL)`),
  check('signatures_output', sql`(${table.status} = 'PENDING' AND ${table.output_artifact_id} IS NULL AND ${table.output_sha256} IS NULL)
    OR (${table.status} = 'DONE' AND ${table.output_artifact_id} IS NOT NULL AND ${table.output_sha256} IS NOT NULL)`),
])

/** The seal of a completed envelope: the object it is stored as, never remade or replaced. */
export const seals = sqliteTable('seals', {
  envelope_id: text('envelope_id').primaryKey().notNull().references(() => envelopes.id),
  mode: text('mode').notNull(),
  object_key: text('object_key').notNull().unique(),
  sha256: text('sha256').notNull(),
  /** The managed seal's key fingerprint (seal/keys.ts). */
  key_id: text('key_id'),
  timestamp_time: integer('timestamp_time'),
}, (table) => [
  check('seals_mode', sql`${table.mode} IN ('LOCAL_TEST', 'KEY_TSA')`),
  check('seals_managed', sql`(${table.mode} = 'KEY_TSA') = (${table.key_id} IS NOT NULL AND ${table.timestamp_time} IS NOT NULL)`),
])

/** An embedded editing session (editor-session.ts), for one parent origin the host frames it in. */
export const editorSessions = sqliteTable('editor_sessions', {
  id: text('id').primaryKey().notNull(),
  tenant_id: text('tenant_id').notNull(),
  parent_origin: text('parent_origin').notNull(),
  source_template_id: text('source_template_id').references(() => templates.id),
  source_sha256: text('source_sha256'),
  preset_roles_json: text('preset_roles_json').notNull().default('[]'),
  staged_object_key: text('staged_object_key'),
  staged_sha256: text('staged_sha256'),
  result_template_id: text('result_template_id').references(() => templates.id),
  /** The name and metadata (JSON) the saved template gets; none means the source template's. */
  template_name: text('template_name'),
  template_metadata_json: text('template_metadata_json'),
})

/**
 * Settings the deployment gives every organization, kept where SQL can read them: `editor_origins`
 * (a JSON array) are the host origins that may embed the editor and the signing page, from
 * ESIGN_FRAME_ANCESTORS (access.ts `syncEditorOrigins`).
 */
export const appSettings = sqliteTable('app_settings', {
  name: text('name').primaryKey().notNull(),
  value: text('value').notNull(),
}, (table) => [check('app_settings_value', sql`json_valid(${table.value})`)])

/** The append-only audit trail of an envelope (audit.ts). */
export const auditEvents = sqliteTable('audit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  envelope_id: text('envelope_id').notNull().references(() => envelopes.id),
  task_id: text('task_id').references(() => tasks.id),
  type: text('type').notNull(),
  occurred_at: integer('occurred_at').notNull(),
  ip: text('ip'),
  user_agent: text('user_agent'),
  detail_json: text('detail_json'),
}, (table) => [index('audit_events_by_envelope').on(table.envelope_id, table.id)])

/** Each signer's signed copy: reserved before its notice is sent, so it is sent once (signed-copies.ts). */
export const copyDeliveries = sqliteTable('copy_deliveries', {
  envelope_id: text('envelope_id').notNull().references(() => envelopes.id),
  task_id: text('task_id').notNull().references(() => tasks.id),
  reserved_at: integer('reserved_at').notNull(),
  sent_at: integer('sent_at'),
}, (table) => [primaryKey({ columns: [table.envelope_id, table.task_id] })])

/**
 * The link in a signer's completion notice: the SHA-256 of a random token, opened once on the
 * public /copy page within its lifetime (signed-copies.ts).
 */
export const signedCopyLinks = sqliteTable('signed_copy_links', {
  token_hash: text('token_hash').primaryKey().notNull(),
  tenant_id: text('tenant_id').notNull(),
  envelope_id: text('envelope_id').notNull().references(() => envelopes.id),
  task_id: text('task_id').notNull().references(() => tasks.id),
  created_at: integer('created_at').notNull(),
  expires_at: integer('expires_at').notNull(),
  used_at: integer('used_at'),
}, (table) => [index('signed_copy_links_by_task').on(table.envelope_id, table.task_id)])

/**
 * The invitation of a signer Esign emails (delivery 'email', invitations.ts): the SHA-256 of their
 * link's token, one per task. It is reserved before sending and works once sent, while the task is
 * the active one; sending it again replaces the token, so only the latest link opens the page.
 */
export const invitations = sqliteTable('invitations', {
  task_id: text('task_id').primaryKey().notNull().references(() => tasks.id),
  tenant_id: text('tenant_id').notNull(),
  envelope_id: text('envelope_id').notNull().references(() => envelopes.id),
  token_hash: text('token_hash').notNull().unique(),
  reserved_at: integer('reserved_at').notNull(),
  sent_at: integer('sent_at'),
})

/**
 * The organization's contacts (contacts.ts): one per email address (`email_key`, trimmed and
 * lower-cased), added by every envelope that names them and by members. A convenience for filling
 * in signers, never evidence. `recent_at` is when an envelope last named them, or when they were
 * added: the list's order.
 */
export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  email: text('email').notNull(),
  email_key: text('email_key').notNull(),
  name: text('name').notNull(),
  title: text('title'),
  company: text('company'),
  envelope_count: integer('envelope_count').notNull().default(0),
  last_used_at: integer('last_used_at'),
  recent_at: integer('recent_at').notNull(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (table) => [
  unique('contacts_tenant_email').on(table.tenant_id, table.email_key),
  index('contacts_by_recent').on(table.tenant_id, table.recent_at, table.id),
])

/** Objects (blob-store.ts): a key in a bucket points to one upload's chunks. */
export const blobs = sqliteTable('blobs', {
  bucket: text('bucket').notNull(),
  key: text('key').notNull(),
  upload_id: text('upload_id').notNull(),
  size: integer('size').notNull(),
  content_type: text('content_type'),
  created_at: integer('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.bucket, table.key] }),
  index('blobs_by_upload').on(table.upload_id),
])

export const blobChunks = sqliteTable('blob_chunks', {
  upload_id: text('upload_id').notNull(),
  chunk_index: integer('chunk_index').notNull(),
  bytes: blob('bytes').notNull(),
}, (table) => [primaryKey({ columns: [table.upload_id, table.chunk_index] })])
