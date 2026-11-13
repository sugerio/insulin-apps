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
CREATE INDEX `document_shares_by_grantee` ON `document_shares` (`tenant_id`,`grantee_email_key`,`resource_type`);--> statement-breakpoint
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
CREATE INDEX `document_tags_by_tag` ON `document_tags` (`tenant_id`,`user_id`,`resource_type`,`tag_key`);--> statement-breakpoint
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
CREATE INDEX `members_by_email` ON `members` (`tenant_id`,`email_key`);--> statement-breakpoint
ALTER TABLE `editor_sessions` ADD `owner_user_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `editor_sessions` ADD `shares_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `editor_sessions` ADD `tags_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `envelopes` ADD `owner_user_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `envelopes_by_owner` ON `envelopes` (`tenant_id`,`owner_user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `templates` ADD `owner_user_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `templates_by_owner` ON `templates` (`tenant_id`,`owner_user_id`,`created_at`);