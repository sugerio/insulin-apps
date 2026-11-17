CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text,
	`access_via` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_org_at` ON `audit_events` (`org_id`,`at`);--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `households_org_unique` ON `households` (`org_id`);--> statement-breakpoint
CREATE TABLE `metrics_reports` (
	`hour` integer PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`relationship` text NOT NULL,
	`birth_date` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "people_relationship" CHECK(relationship IN ('self', 'spouse', 'child', 'other_dependant')),
	CONSTRAINT "people_name_length" CHECK(length(name) BETWEEN 1 AND 100),
	CONSTRAINT "people_birth_date" CHECK(birth_date GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
);
--> statement-breakpoint
CREATE INDEX `people_org` ON `people` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `people_one_self` ON `people` (`household_id`) WHERE relationship = 'self';--> statement-breakpoint
CREATE UNIQUE INDEX `people_one_spouse` ON `people` (`household_id`) WHERE relationship = 'spouse';--> statement-breakpoint
CREATE TABLE `returns` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`tax_year_id` text NOT NULL,
	`person_id` text NOT NULL,
	`province` text,
	`resident_all_year` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tax_year_id`) REFERENCES `tax_years`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "returns_province" CHECK(province IS NULL OR province IN ('AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `returns_year_person` ON `returns` (`tax_year_id`,`person_id`);--> statement-breakpoint
CREATE INDEX `returns_org` ON `returns` (`org_id`);--> statement-breakpoint
CREATE TABLE `tax_years` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`household_id` text NOT NULL,
	`year` integer NOT NULL,
	`marital_status` text,
	`prepare_together` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tax_years_marital_status" CHECK(marital_status IS NULL OR marital_status IN ('married', 'common_law', 'widowed', 'divorced', 'separated', 'single')),
	CONSTRAINT "tax_years_revision" CHECK(revision >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_years_household_year` ON `tax_years` (`household_id`,`year`);--> statement-breakpoint
CREATE INDEX `tax_years_org` ON `tax_years` (`org_id`);