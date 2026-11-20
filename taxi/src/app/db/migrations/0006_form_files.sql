CREATE TABLE `form_files` (
	`org_id` text NOT NULL,
	`url` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` blob NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `url`)
);
