ALTER TABLE `imports` ADD `sends` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `sent_at` integer;--> statement-breakpoint
UPDATE `imports` SET `sends` = COALESCE(json_extract(`request`, '$.sends'), 0), `sent_at` = json_extract(`request`, '$.sentAt') WHERE `request` IS NOT NULL;
