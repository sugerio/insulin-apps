CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`collection_name` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text,
	`at` integer NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_by_org` ON `activity` (`org_id`,`at`);--> statement-breakpoint
CREATE TABLE `collection_shares` (
	`collection_id` text NOT NULL,
	`org_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`shared_by` text NOT NULL,
	`shared_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`collection_id`, `principal_type`, `principal_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shares_principal_type" CHECK("collection_shares"."principal_type" IN ('person', 'client')),
	CONSTRAINT "shares_role" CHECK("collection_shares"."role" IN ('VIEWER', 'EDITOR', 'ADMIN')),
	CONSTRAINT "shares_status" CHECK("collection_shares"."status" IN ('active', 'on_hold'))
);
--> statement-breakpoint
CREATE INDEX `shares_by_principal` ON `collection_shares` (`org_id`,`principal_type`,`principal_id`);--> statement-breakpoint
CREATE TABLE `collection_usage` (
	`collection_id` text NOT NULL,
	`period` text NOT NULL,
	`org_id` text NOT NULL,
	`awake_seconds` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`collection_id`, `period`)
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`owner_since` integer NOT NULL,
	`name` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`last_used_at` integer,
	`documents` integer DEFAULT 0 NOT NULL,
	`active_documents` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`facts` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`general_role` text,
	`assistants` integer DEFAULT 1 NOT NULL,
	`keep_ready` text,
	`keep_ready_paused` integer DEFAULT 0 NOT NULL,
	`awake_minutes` integer DEFAULT 10 NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`engine_state` text DEFAULT 'empty' NOT NULL,
	`last_restore_point_at` integer,
	`last_backup_at` integer,
	`settings_version` integer DEFAULT 0 NOT NULL,
	`settings_synced` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "collections_state" CHECK("collections"."state" IN ('active', 'deleting', 'deleted')),
	CONSTRAINT "collections_general_role" CHECK("collections"."general_role" IS NULL OR "collections"."general_role" IN ('VIEWER', 'EDITOR')),
	CONSTRAINT "collections_keep_ready" CHECK("collections"."keep_ready" IS NULL OR json_valid("collections"."keep_ready"))
);
--> statement-breakpoint
CREATE INDEX `collections_by_org` ON `collections` (`org_id`,`state`);--> statement-breakpoint
CREATE INDEX `collections_by_owner` ON `collections` (`org_id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`question` text,
	`text` text NOT NULL,
	`outdated` text DEFAULT '[]' NOT NULL,
	`import_id` text NOT NULL,
	`report_id` text,
	`fact_id` text,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `corrections_by_collection` ON `corrections` (`org_id`,`collection_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `engine_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `gaps` (
	`collection_id` text NOT NULL,
	`question_key` text NOT NULL,
	`org_id` text NOT NULL,
	`question` text NOT NULL,
	`asked` integer DEFAULT 1 NOT NULL,
	`first_asked_at` integer NOT NULL,
	`last_asked_at` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	PRIMARY KEY(`collection_id`, `question_key`)
);
--> statement-breakpoint
CREATE INDEX `gaps_by_org` ON `gaps` (`org_id`,`collection_id`,`status`);--> statement-breakpoint
CREATE TABLE `history` (
	`collection_id` text NOT NULL,
	`version` integer NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`summary` text NOT NULL,
	`documents` integer NOT NULL,
	`import_id` text,
	PRIMARY KEY(`collection_id`, `version`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `idempotency` (
	`org_id` text NOT NULL,
	`actor` text NOT NULL,
	`key` text NOT NULL,
	`route` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` integer NOT NULL,
	`body` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `actor`, `key`)
);
--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`state` text NOT NULL,
	`files` integer DEFAULT 0 NOT NULL,
	`version` integer,
	`error` text,
	`detail` text DEFAULT '{}' NOT NULL,
	`notified_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "imports_kind" CHECK("imports"."kind" IN ('files', 'web_page', 'note', 'correction'))
);
--> statement-breakpoint
CREATE INDEX `imports_by_collection` ON `imports` (`org_id`,`collection_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `limit_alerts` (
	`org_id` text NOT NULL,
	`period` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `period`, `key`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `limit_defaults` (
	`key` text PRIMARY KEY NOT NULL,
	`value` real,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`org_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`name` text,
	`email` text,
	`app_role` text,
	`org_role` text,
	`away` integer DEFAULT 0 NOT NULL,
	`owner_since` integer,
	`unchecked` integer DEFAULT 0 NOT NULL,
	`seen_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `principal_type`, `principal_id`),
	CONSTRAINT "members_principal_type" CHECK("members"."principal_type" IN ('person', 'client'))
);
--> statement-breakpoint
CREATE TABLE `metrics_reports` (
	`hour` integer PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE TABLE `org_limits` (
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`value` real,
	`until` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `org_purges` (
	`org_id` text PRIMARY KEY NOT NULL,
	`requested_at` integer NOT NULL,
	`done_at` integer
);
--> statement-breakpoint
CREATE TABLE `org_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`answer_writer` text DEFAULT 'builtin' NOT NULL,
	`integration_key` text,
	`model_url` text,
	`model` text,
	`hiding` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "org_settings_writer" CHECK("org_settings"."answer_writer" IN ('builtin', 'own')),
	CONSTRAINT "org_settings_hiding" CHECK(json_valid("org_settings"."hiding"))
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`answer_id` text NOT NULL,
	`org_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`asked_by` text NOT NULL,
	`via` text NOT NULL,
	`asked_at` integer NOT NULL,
	`question` text NOT NULL,
	`covered` integer NOT NULL,
	`outcome` text NOT NULL,
	`model` text
);
--> statement-breakpoint
CREATE INDEX `questions_by_collection` ON `questions` (`org_id`,`collection_id`,`asked_at`);--> statement-breakpoint
CREATE INDEX `questions_by_answer` ON `questions` (`org_id`,`answer_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`answer_id` text,
	`reported_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`question` text NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`correction_id` text,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reports_status" CHECK("reports"."status" IN ('open', 'fixed', 'dismissed'))
);
--> statement-breakpoint
CREATE INDEX `reports_by_collection` ON `reports` (`org_id`,`collection_id`,`status`);--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`period` text NOT NULL,
	`key` text NOT NULL,
	`amount` real NOT NULL,
	`consumed` real DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'held' NOT NULL,
	`ref` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT "reservations_state" CHECK("reservations"."state" IN ('held', 'settled', 'released'))
);
--> statement-breakpoint
CREATE INDEX `reservations_held` ON `reservations` (`org_id`,`period`,`key`,`state`);--> statement-breakpoint
CREATE INDEX `reservations_by_ref` ON `reservations` (`org_id`,`ref`,`state`);--> statement-breakpoint
CREATE TABLE `staged_files` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text,
	`state` text NOT NULL,
	`reason` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`import_id` text,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "staged_state" CHECK("staged_files"."state" IN ('expected', 'staged', 'refused', 'used'))
);
--> statement-breakpoint
CREATE INDEX `staged_by_collection` ON `staged_files` (`org_id`,`collection_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`name` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`resync_started_at` integer,
	`progress` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`org_id` text NOT NULL,
	`period` text NOT NULL,
	`key` text NOT NULL,
	`used` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `period`, `key`)
);
