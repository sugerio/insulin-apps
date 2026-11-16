ALTER TABLE `envelopes` ADD `draft_json` text;--> statement-breakpoint
ALTER TABLE `templates` ADD `status` text DEFAULT 'active' NOT NULL;