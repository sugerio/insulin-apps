CREATE TABLE `org_holds` (
	`org_id` text PRIMARY KEY NOT NULL,
	`until` integer NOT NULL,
	`held_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `collections` ADD `settings_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD `settings_pushed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `collections` ADD `settings_tried_at` integer;--> statement-breakpoint
-- Corrections were kept as written, values the hiding rules remove included. They are kept hidden from now on (and
-- shown as the engine learned them); what was kept before goes. Waiting notes are hidden by the next tick.
UPDATE `corrections` SET `text` = '', `question` = NULL;
