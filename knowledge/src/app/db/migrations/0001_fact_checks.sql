CREATE TABLE `fact_checks` (
	`collection_id` text NOT NULL,
	`fact_id` text NOT NULL,
	`org_id` text NOT NULL,
	`checked_by` text NOT NULL,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`collection_id`, `fact_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fact_checks_by_org` ON `fact_checks` (`org_id`,`collection_id`);