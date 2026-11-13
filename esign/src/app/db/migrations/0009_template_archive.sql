ALTER TABLE `editor_sessions` ADD `replaces_source` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `templates` ADD `archived_at` integer;