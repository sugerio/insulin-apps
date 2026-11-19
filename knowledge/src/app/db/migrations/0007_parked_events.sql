CREATE TABLE `parked_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`event` text NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`parked_at` integer NOT NULL,
	`tried_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `parked_events_by_collection` ON `parked_events` (`org_id`,`collection_id`);