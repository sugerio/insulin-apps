-- An API client's documents are seen, as admin, by every person on its list (api_client_people), worked out when they
-- are read (ownership.ts), instead of one person they were shared with when created (api_clients, dropped: nothing
-- was set there since the database was recreated).
CREATE TABLE `api_client_people` (
	`tenant_id` text NOT NULL,
	`client_user_id` text NOT NULL,
	`email_key` text NOT NULL,
	`email` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `client_user_id`, `email_key`)
);
--> statement-breakpoint
CREATE INDEX `api_client_people_by_email` ON `api_client_people` (`tenant_id`,`email_key`);--> statement-breakpoint
DROP TABLE `api_clients`;
