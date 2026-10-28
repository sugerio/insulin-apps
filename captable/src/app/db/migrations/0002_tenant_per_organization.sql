DROP INDEX `idempotency_keys_scope_actor_route_idem_key_unique`;--> statement-breakpoint
ALTER TABLE `idempotency_keys` ADD `console_organization_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_console_org_scope_actor_route_idem_key_unique` ON `idempotency_keys` (`console_organization_id`,`scope`,`actor`,`route`,`idem_key`);--> statement-breakpoint
DROP INDEX `orgs_slug_unique`;--> statement-breakpoint
DROP INDEX `orgs_one_active`;--> statement-breakpoint
ALTER TABLE `orgs` ADD `console_organization_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_console_organization_slug` ON `orgs` (`console_organization_id`,`slug`) WHERE console_organization_id IS NOT NULL AND status <> 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_one_active_per_console_organization` ON `orgs` (`console_organization_id`) WHERE console_organization_id IS NOT NULL AND status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_one_importing_per_console_organization` ON `orgs` (`console_organization_id`) WHERE console_organization_id IS NOT NULL AND status = 'importing';--> statement-breakpoint
ALTER TABLE `audit_events` ADD `console_organization_id` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `org_seq` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_org_seq_unique` ON `audit_events` (`org_id`,`org_seq`);--> statement-breakpoint
CREATE INDEX `audit_events_org_occurred_seq` ON `audit_events` (`org_id`,occurred_at DESC,org_seq DESC);--> statement-breakpoint
ALTER TABLE `document_upload_chunks` ADD `console_organization_id` text;--> statement-breakpoint
ALTER TABLE `expiry_runs` ADD `org_seq` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `expiry_runs_org_id_org_seq_unique` ON `expiry_runs` (`org_id`,`org_seq`);--> statement-breakpoint
ALTER TABLE `import_runs` ADD `console_organization_id` text;