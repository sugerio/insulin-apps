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
CREATE INDEX `contacts_by_recent` ON `contacts` (`tenant_id`,`recent_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_tenant_email` ON `contacts` (`tenant_id`,`email_key`);