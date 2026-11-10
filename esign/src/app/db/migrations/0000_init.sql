CREATE TABLE `access_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`origin` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	CONSTRAINT "access_codes_scope" CHECK("access_codes"."scope" IN ('recipient', 'editor'))
);
--> statement-breakpoint
CREATE INDEX `access_codes_by_subject` ON `access_codes` (`scope`,`subject_id`);--> statement-breakpoint
CREATE TABLE `access_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`origin` text NOT NULL,
	`expires_at` integer NOT NULL,
	`otp_verified_at` integer,
	CONSTRAINT "access_sessions_scope" CHECK("access_sessions"."scope" IN ('recipient', 'editor')),
	CONSTRAINT "access_sessions_otp_scope" CHECK("access_sessions"."otp_verified_at" IS NULL OR "access_sessions"."scope" = 'recipient')
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
CREATE UNIQUE INDEX `artifacts_envelope_id_unique` ON `artifacts` (`envelope_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_object_key_unique` ON `artifacts` (`object_key`);--> statement-breakpoint
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
CREATE INDEX `audit_events_by_envelope` ON `audit_events` (`envelope_id`,`id`);--> statement-breakpoint
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
CREATE INDEX `blobs_by_upload` ON `blobs` (`upload_id`);--> statement-breakpoint
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
	FOREIGN KEY (`source_template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `envelopes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`template_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`request_sha256` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "envelopes_details_json" CHECK(json_valid("envelopes"."details_json"))
);
--> statement-breakpoint
CREATE INDEX `envelopes_by_tenant` ON `envelopes` (`tenant_id`,`created_at`);--> statement-breakpoint
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
	`key_arn` text,
	`timestamp_time` integer,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "seals_mode" CHECK("seals"."mode" IN ('LOCAL_TEST', 'KMS_TSA')),
	CONSTRAINT "seals_managed" CHECK(("seals"."mode" = 'KMS_TSA') = ("seals"."key_arn" IS NOT NULL AND "seals"."timestamp_time" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seals_object_key_unique` ON `seals` (`object_key`);--> statement-breakpoint
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
	CONSTRAINT "signatures_output" CHECK(("signatures"."status" = 'PENDING' AND "signatures"."output_artifact_id" IS NULL AND "signatures"."output_sha256" IS NULL)
    OR ("signatures"."status" = 'DONE' AND "signatures"."output_artifact_id" IS NOT NULL AND "signatures"."output_sha256" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_task_id_unique` ON `signatures` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_envelope_sequence` ON `signatures` (`envelope_id`,`sequence`);--> statement-breakpoint
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
CREATE INDEX `signed_copy_links_by_task` ON `signed_copy_links` (`envelope_id`,`task_id`);--> statement-breakpoint
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
CREATE INDEX `tasks_expires_at` ON `tasks` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_envelope_role` ON `tasks` (`envelope_id`,`role`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`object_key` text NOT NULL,
	`roles_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`fields_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_object_key_unique` ON `templates` (`object_key`);--> statement-breakpoint
CREATE INDEX `templates_by_tenant` ON `templates` (`tenant_id`,`created_at`);