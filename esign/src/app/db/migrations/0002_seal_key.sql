-- The managed seal is signed with E-sign's own seal key (seal/keys.ts) instead of an AWS KMS key: the mode KMS_TSA
-- becomes KEY_TSA and key_arn becomes key_id, the key's fingerprint. SQLite can't change a CHECK constraint in place,
-- so the table is rebuilt (seals has no triggers and nothing references it). Seals made with the KMS key keep their
-- rows, now KEY_TSA with the ARN as key_id; they no longer verify, since keys.ts doesn't trust that key.
CREATE TABLE `__new_seals` (
	`envelope_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`key_id` text,
	`timestamp_time` integer,
	FOREIGN KEY (`envelope_id`) REFERENCES `envelopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "seals_mode" CHECK("mode" IN ('LOCAL_TEST', 'KEY_TSA')),
	CONSTRAINT "seals_managed" CHECK(("mode" = 'KEY_TSA') = ("key_id" IS NOT NULL AND "timestamp_time" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_seals`("envelope_id", "mode", "object_key", "sha256", "key_id", "timestamp_time") SELECT "envelope_id", CASE "mode" WHEN 'KMS_TSA' THEN 'KEY_TSA' ELSE "mode" END, "object_key", "sha256", "key_arn", "timestamp_time" FROM `seals`;--> statement-breakpoint
DROP TABLE `seals`;--> statement-breakpoint
ALTER TABLE `__new_seals` RENAME TO `seals`;--> statement-breakpoint
CREATE UNIQUE INDEX `seals_object_key_unique` ON `seals` (`object_key`);
