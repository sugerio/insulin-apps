-- Esign's schema: every table and index the app uses, as one migration (the history before it was folded in while
-- nothing had shipped). The triggers drizzle-kit can't express are in 0001_triggers.sql. schema.ts describes each table.
CREATE TABLE `access_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`origin` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`entry_json` text,
	CONSTRAINT "access_codes_scope" CHECK("access_codes"."scope" IN ('recipient', 'editor'))
);
--> statement-breakpoint
CREATE TABLE `access_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`origin` text NOT NULL,
	`expires_at` integer NOT NULL,
	`otp_verified_at` integer,
	`entry_json` text,
	CONSTRAINT "access_sessions_scope" CHECK("access_sessions"."scope" IN ('recipient', 'editor')),
	CONSTRAINT "access_sessions_otp_scope" CHECK("access_sessions"."otp_verified_at" IS NULL OR "access_sessions"."scope" = 'recipient')
);
--> statement-breakpoint
CREATE TABLE `api_clients` (
	`tenant_id` text NOT NULL,
	`client_user_id` text NOT NULL,
	`share_email` text NOT NULL,
	`share_email_key` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `client_user_id`)
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`name` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "app_settings_value" CHECK(json_valid("app_settings"."value"))
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`envelope_id` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`envelope_id` text NOT NULL,
	`task_id` text,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`detail_json` text,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `blob_chunks` (
	`upload_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`upload_id`, `chunk_index`)
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`bucket` text NOT NULL,
	`key` text NOT NULL,
	`upload_id` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`bucket`, `key`)
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`email_key` text NOT NULL,
	`name` text NOT NULL,
	`title` text,
	`company` text,
	`envelope_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`recent_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `copy_deliveries` (
	`envelope_id` text NOT NULL,
	`task_id` text NOT NULL,
	`reserved_at` integer NOT NULL,
	`sent_at` integer,
	PRIMARY KEY(`envelope_id`, `task_id`),
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `document_shares` (
	`tenant_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`grantee_email_key` text NOT NULL,
	`grantee_email` text NOT NULL,
	`role` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`resource_type`, `resource_id`, `grantee_email_key`),
	CONSTRAINT "document_shares_type" CHECK("document_shares"."resource_type" IN ('template', 'envelope')),
	CONSTRAINT "document_shares_role" CHECK("document_shares"."role" IN ('admin', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE `document_tags` (
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`tag_key` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `user_id`, `resource_type`, `resource_id`, `tag_key`),
	CONSTRAINT "document_tags_type" CHECK("document_tags"."resource_type" IN ('template', 'envelope'))
);
--> statement-breakpoint
CREATE TABLE `editor_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`parent_origin` text NOT NULL,
	`source_template_id` text,
	`source_sha256` text,
	`preset_roles_json` text DEFAULT '[]' NOT NULL,
	`staged_object_key` text,
	`staged_sha256` text,
	`result_template_id` text,
	`template_name` text,
	`template_metadata_json` text,
	`owner_user_id` text DEFAULT '' NOT NULL,
	`shares_json` text DEFAULT '[]' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`replaces_source` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`source_template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `envelopes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`template_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`request_sha256` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`owner_user_id` text DEFAULT '' NOT NULL,
	`draft_json` text,
	`roles_json` text,
	`fields_json` text,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "envelopes_details_json" CHECK(json_valid("envelopes"."details_json"))
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`task_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`envelope_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`reserved_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `members` (
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`email` text,
	`email_key` text,
	`name` text,
	`org_role` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `user_id`),
	CONSTRAINT "members_kind" CHECK("members"."kind" IN ('person', 'client'))
);
--> statement-breakpoint
CREATE TABLE `otp_challenges` (
	`task_id` text PRIMARY KEY NOT NULL,
	`session_hash` text NOT NULL,
	`otp_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sends` integer DEFAULT 1 NOT NULL,
	`window_started_at` integer NOT NULL,
	`last_sent_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_hash`) REFERENCES `access_sessions`(`token_hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "otp_challenges_attempts" CHECK("otp_challenges"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "otp_challenges_sends" CHECK("otp_challenges"."sends" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE `seals` (
	`envelope_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`key_id` text,
	`timestamp_time` integer,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "seals_mode" CHECK("mode" IN ('LOCAL_TEST', 'KEY_TSA')),
	CONSTRAINT "seals_managed" CHECK(("mode" = 'KEY_TSA') = ("key_id" IS NOT NULL AND "timestamp_time" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `signatures` (
	`id` text PRIMARY KEY NOT NULL,
	`envelope_id` text NOT NULL,
	`task_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	`input_artifact_id` text NOT NULL,
	`input_sha256` text NOT NULL,
	`output_artifact_id` text,
	`output_sha256` text,
	`previous_hash` text,
	`event_hash` text NOT NULL,
	`facts_json` text NOT NULL,
	`render_json` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "signatures_sequence" CHECK(typeof("signatures"."sequence") = 'integer' AND "signatures"."sequence" >= 1),
	CONSTRAINT "signatures_status" CHECK("signatures"."status" IN ('PENDING', 'DONE')),
	CONSTRAINT "signatures_facts_json" CHECK(json_valid("signatures"."facts_json")),
	CONSTRAINT "signatures_render_json" CHECK(json_valid("signatures"."render_json")),
	CONSTRAINT "signatures_attempts" CHECK("signatures"."attempts" >= 0),
	CONSTRAINT "signatures_first" CHECK(("signatures"."sequence" = 1) = ("signatures"."previous_hash" IS NULL)),
	CONSTRAINT "signatures_output" CHECK(("signatures"."status" = 'PENDING' AND "signatures"."output_artifact_id" IS NULL AND "signatures"."output_sha256" IS NULL) OR ("signatures"."status" = 'DONE' AND "signatures"."output_artifact_id" IS NOT NULL AND "signatures"."output_sha256" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `signed_copy_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`envelope_id` text NOT NULL,
	`task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`envelope_id` text NOT NULL,
	`role` text NOT NULL,
	`recipient_name` text NOT NULL,
	`recipient_email` text NOT NULL,
	`routing_order` integer NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer,
	`details_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_details_json" CHECK(json_valid("tasks"."details_json"))
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`object_key` text NOT NULL,
	`roles_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`fields_json` text DEFAULT '[]' NOT NULL,
	`name` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`default_signers_json` text DEFAULT '{}' NOT NULL,
	`owner_user_id` text DEFAULT '' NOT NULL,
	`archived_at` integer,
	`status` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `access_codes_by_subject` ON `access_codes` (`scope`,`subject_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_envelope_id_unique` ON `artifacts` (`envelope_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_object_key_unique` ON `artifacts` (`object_key`);
--> statement-breakpoint
CREATE INDEX `audit_events_by_envelope` ON `audit_events` (`envelope_id`,`id`);
--> statement-breakpoint
CREATE INDEX `blobs_by_upload` ON `blobs` (`upload_id`);
--> statement-breakpoint
CREATE INDEX `contacts_by_recent` ON `contacts` (`tenant_id`,`recent_at`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_tenant_email` ON `contacts` (`tenant_id`,`email_key`);
--> statement-breakpoint
CREATE INDEX `document_shares_by_grantee` ON `document_shares` (`tenant_id`,`grantee_email_key`,`resource_type`);
--> statement-breakpoint
CREATE INDEX `document_tags_by_tag` ON `document_tags` (`tenant_id`,`user_id`,`resource_type`,`tag_key`);
--> statement-breakpoint
CREATE INDEX `envelopes_by_owner` ON `envelopes` (`tenant_id`,`owner_user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `envelopes_by_tenant` ON `envelopes` (`tenant_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `members_by_email` ON `members` (`tenant_id`,`email_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `seals_object_key_unique` ON `seals` (`object_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_envelope_sequence` ON `signatures` (`envelope_id`,`sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_task_id_unique` ON `signatures` (`task_id`);
--> statement-breakpoint
CREATE INDEX `signed_copy_links_by_task` ON `signed_copy_links` (`envelope_id`,`task_id`);
--> statement-breakpoint
CREATE INDEX `tasks_by_recipient_email` ON `tasks` (lower("recipient_email"));
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_envelope_role` ON `tasks` (`envelope_id`,`role`);
--> statement-breakpoint
CREATE INDEX `tasks_expires_at` ON `tasks` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `templates_by_owner` ON `templates` (`tenant_id`,`owner_user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `templates_by_tenant` ON `templates` (`tenant_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_object_key_unique` ON `templates` (`object_key`);
--> statement-breakpoint
CREATE TABLE `metrics_reports` (
	`hour` integer PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`sent_at` integer
);
