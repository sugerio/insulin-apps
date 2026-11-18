CREATE TABLE `hint_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`tax_year_id` text NOT NULL,
	`person_id` text NOT NULL,
	`hint` text NOT NULL,
	`decision` text NOT NULL,
	`effect` text,
	`previous` text DEFAULT '{}' NOT NULL,
	`decided_by` text NOT NULL,
	`decided_at` integer NOT NULL,
	FOREIGN KEY (`tax_year_id`) REFERENCES `tax_years`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "hint_decisions_decision" CHECK(decision IN ('accepted', 'dismissed')),
	CONSTRAINT "hint_decisions_previous_json" CHECK(json_valid(previous))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hint_decisions_year_person_hint` ON `hint_decisions` (`tax_year_id`,`person_id`,`hint`);--> statement-breakpoint
CREATE INDEX `hint_decisions_org` ON `hint_decisions` (`org_id`);