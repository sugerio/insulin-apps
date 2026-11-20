ALTER TABLE `org_holds` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `org_holds` ADD `delivered` integer DEFAULT 0 NOT NULL;