CREATE INDEX `tasks_by_recipient_email` ON `tasks` (lower("recipient_email"));--> statement-breakpoint
ALTER TABLE `contacts` DROP COLUMN `envelope_count`;--> statement-breakpoint
ALTER TABLE `contacts` DROP COLUMN `last_used_at`;