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
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);
--> statement-breakpoint
ALTER TABLE `access_codes` ADD `entry_json` text;--> statement-breakpoint
ALTER TABLE `access_sessions` ADD `entry_json` text;