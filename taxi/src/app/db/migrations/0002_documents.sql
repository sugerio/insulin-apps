CREATE TABLE `document_chunks` (
	`document_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`org_id` text NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`document_id`, `chunk_index`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`tax_year_id` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`status` text NOT NULL,
	`message` text NOT NULL,
	`model_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tax_year_id`) REFERENCES `tax_years`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "documents_status" CHECK(status IN ('read', 'duplicate', 'not_a_slip', 'failed', 'not_available')),
	CONSTRAINT "documents_name_length" CHECK(length(name) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX `documents_year` ON `documents` (`tax_year_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `documents_year_sha` ON `documents` (`tax_year_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `documents_org` ON `documents` (`org_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_slips` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`tax_year_id` text NOT NULL,
	`person_id` text NOT NULL,
	`type` text NOT NULL,
	`issuer` text NOT NULL,
	`boxes` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`document_id` text,
	`unsure` text DEFAULT '[]' NOT NULL,
	`confirmed_at` integer,
	`confirmed_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tax_year_id`) REFERENCES `tax_years`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "slips_boxes_json" CHECK(json_valid(boxes) AND json_type(boxes) = 'object'),
	CONSTRAINT "slips_status" CHECK(status IN ('unconfirmed', 'confirmed')),
	CONSTRAINT "slips_source" CHECK(source IN ('manual', 'ai')),
	CONSTRAINT "slips_issuer_length" CHECK(length(issuer) BETWEEN 1 AND 100),
	CONSTRAINT "slips_unsure_json" CHECK(json_valid(unsure) AND json_type(unsure) = 'array')
);
--> statement-breakpoint
INSERT INTO `__new_slips`("id", "org_id", "tax_year_id", "person_id", "type", "issuer", "boxes", "status", "source", "confirmed_at", "confirmed_by", "created_at", "updated_at") SELECT "id", "org_id", "tax_year_id", "person_id", "type", "issuer", "boxes", "status", "source", "confirmed_at", "confirmed_by", "created_at", "updated_at" FROM `slips`;--> statement-breakpoint
DROP TABLE `slips`;--> statement-breakpoint
ALTER TABLE `__new_slips` RENAME TO `slips`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `slips_year_person` ON `slips` (`tax_year_id`,`person_id`);--> statement-breakpoint
CREATE INDEX `slips_org` ON `slips` (`org_id`);