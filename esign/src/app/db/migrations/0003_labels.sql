ALTER TABLE `templates` ADD `name` text;--> statement-breakpoint
ALTER TABLE `templates` ADD `metadata_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `editor_sessions` ADD `template_name` text;--> statement-breakpoint
ALTER TABLE `editor_sessions` ADD `template_metadata_json` text;
