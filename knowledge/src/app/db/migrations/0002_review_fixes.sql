CREATE TABLE `correction_checks` (
	`collection_id` text NOT NULL,
	`note_id` text NOT NULL,
	`document_id` text NOT NULL,
	`text_hash` text NOT NULL,
	`org_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`collection_id`, `note_id`, `document_id`, `text_hash`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `correction_checks_by_org` ON `correction_checks` (`org_id`,`collection_id`);--> statement-breakpoint
ALTER TABLE `imports` ADD `request` text;--> statement-breakpoint
ALTER TABLE `members` ADD `permissions` text;