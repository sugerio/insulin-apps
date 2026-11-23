CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`tax_year_id` text NOT NULL,
	`person_id` text NOT NULL,
	`question` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tax_year_id`) REFERENCES `tax_years`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "answers_value_json" CHECK(json_valid(value))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `answers_year_person_question` ON `answers` (`tax_year_id`,`person_id`,`question`);--> statement-breakpoint
CREATE INDEX `answers_org` ON `answers` (`org_id`);--> statement-breakpoint
CREATE TABLE `slips` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`tax_year_id` text NOT NULL,
	`person_id` text NOT NULL,
	`type` text NOT NULL,
	`issuer` text NOT NULL,
	`boxes` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`confirmed_at` integer,
	`confirmed_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tax_year_id`) REFERENCES `tax_years`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "slips_boxes_json" CHECK(json_valid(boxes) AND json_type(boxes) = 'object'),
	CONSTRAINT "slips_status" CHECK(status IN ('unconfirmed', 'confirmed')),
	CONSTRAINT "slips_source" CHECK(source IN ('manual')),
	CONSTRAINT "slips_issuer_length" CHECK(length(issuer) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE INDEX `slips_year_person` ON `slips` (`tax_year_id`,`person_id`);--> statement-breakpoint
CREATE INDEX `slips_org` ON `slips` (`org_id`);