CREATE TABLE `admin_stakeholder_links` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`stakeholder_id` text NOT NULL,
	`source` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	`removed_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stakeholder_id`) REFERENCES `stakeholders`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "admin_stakeholder_links_email_check" CHECK(email = lower(email) AND length(email) <= 254 AND email LIKE '%_@_%._%'),
	CONSTRAINT "admin_stakeholder_links_source_check" CHECK(source IN ('directory', 'admin')),
	CONSTRAINT "admin_stakeholder_links_removed_together_check" CHECK((removed_at IS NULL) = (removed_by IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_stakeholder_links_live` ON `admin_stakeholder_links` (`org_id`,`email`,`stakeholder_id`) WHERE removed_at IS NULL;--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`org_id` text,
	`actor_kind` text DEFAULT 'user' NOT NULL,
	`actor_user_id` text,
	`actor_email` text,
	`auth_method` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`result` text NOT NULL,
	`reason` text,
	`ip` text,
	`user_agent` text,
	`request_id` text,
	`details` text,
	CONSTRAINT "audit_events_actor_kind_check" CHECK(actor_kind IN ('user', 'system', 'anonymous', 'import')),
	CONSTRAINT "audit_events_auth_method_check" CHECK(auth_method IN ('console')),
	CONSTRAINT "audit_events_actor_auth_method_check" CHECK((actor_kind = 'user' AND auth_method = 'console') OR (actor_kind <> 'user' AND auth_method IS NULL)),
	CONSTRAINT "audit_events_result_check" CHECK(result IN ('success', 'denied', 'error')),
	CONSTRAINT "audit_events_details_check" CHECK(details IS NULL OR json_valid(details))
);
--> statement-breakpoint
CREATE INDEX `audit_events_org` ON `audit_events` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_actor` ON `audit_events` (`actor_user_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_target` ON `audit_events` (`target_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_action` ON `audit_events` (`action`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_org_occurred` ON `audit_events` (`org_id`,occurred_at DESC,id DESC);--> statement-breakpoint
CREATE TABLE `batch_assertions` (
	`ok` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`security_id` text NOT NULL,
	`certificate_number` text NOT NULL,
	`status` text DEFAULT 'ISSUED' NOT NULL,
	`issued_date` text NOT NULL,
	`cancelled_date` text,
	`cancel_reason` text,
	`document_id` text,
	`signatories` text DEFAULT '[]' NOT NULL,
	`legends` text DEFAULT '[]' NOT NULL,
	`rendering_note` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`,`security_id`) REFERENCES `securities`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "certificates_certificate_number_check" CHECK(length(certificate_number) BETWEEN 1 AND 40),
	CONSTRAINT "certificates_status_check" CHECK(status IN ('ISSUED', 'CANCELLED', 'VOID')),
	CONSTRAINT "certificates_issued_date_check" CHECK(date(issued_date) IS issued_date),
	CONSTRAINT "certificates_cancelled_date_check" CHECK(date(cancelled_date) IS cancelled_date),
	CONSTRAINT "certificates_cancel_reason_check" CHECK(cancel_reason IS NULL OR length(cancel_reason) <= 500),
	CONSTRAINT "certificates_signatories_check" CHECK(json_valid(signatories)),
	CONSTRAINT "certificates_legends_check" CHECK(json_valid(legends)),
	CONSTRAINT "certificates_rendering_note_check" CHECK(rendering_note IS NULL OR length(rendering_note) <= 200),
	CONSTRAINT "certificates_cancelled_date_iff_cancelled_check" CHECK((status = 'ISSUED') = (cancelled_date IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `certificates_one_issued` ON `certificates` (`org_id`,`security_id`) WHERE status = 'ISSUED';--> statement-breakpoint
CREATE UNIQUE INDEX `certificates_pulley` ON `certificates` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `certificates_org_id_id_unique` ON `certificates` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `certificates_org_id_certificate_number_unique` ON `certificates` (`org_id`,`certificate_number`);--> statement-breakpoint
CREATE TABLE `command_dependencies` (
	`org_id` text NOT NULL,
	`command_id` text NOT NULL,
	`depends_on_command_id` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`command_id`, `depends_on_command_id`),
	FOREIGN KEY (`org_id`,`command_id`) REFERENCES `commands`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`depends_on_command_id`) REFERENCES `commands`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "command_dependencies_kind_check" CHECK(kind IN ('consumes_security', 'relies_on_deadline', 'relies_on_terms')),
	CONSTRAINT "command_dependencies_not_self_check" CHECK(command_id <> depends_on_command_id)
);
--> statement-breakpoint
CREATE INDEX `command_dependencies_target` ON `command_dependencies` (`org_id`,`depends_on_command_id`);--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`type` text NOT NULL,
	`idempotency_key_id` text NOT NULL,
	`request_sha256` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`auth_method` text,
	`note` text,
	`reverses_command_id` text,
	`expected_ledger_seq` integer,
	`declared_tx_count` integer NOT NULL,
	`first_seq` integer NOT NULL,
	`last_seq` integer NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`idempotency_key_id`) REFERENCES `idempotency_keys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`reverses_command_id`) REFERENCES `commands`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "commands_type_check" CHECK(length(type) BETWEEN 3 AND 64),
	CONSTRAINT "commands_request_sha256_check" CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "commands_actor_kind_check" CHECK(actor_kind IN ('user', 'system', 'import')),
	CONSTRAINT "commands_auth_method_check" CHECK(auth_method IN ('console')),
	CONSTRAINT "commands_actor_auth_method_check" CHECK((actor_kind = 'user' AND auth_method = 'console') OR (actor_kind <> 'user' AND auth_method IS NULL)),
	CONSTRAINT "commands_note_check" CHECK(note IS NULL OR length(note) <= 2000),
	CONSTRAINT "commands_declared_tx_count_check" CHECK(declared_tx_count >= 1),
	CONSTRAINT "commands_first_seq_check" CHECK(first_seq >= 1),
	CONSTRAINT "commands_result_check" CHECK(json_valid(result)),
	CONSTRAINT "commands_seq_range_check" CHECK(last_seq - first_seq + 1 = declared_tx_count),
	CONSTRAINT "commands_user_actor_check" CHECK((actor_kind = 'user') = (actor_user_id IS NOT NULL)),
	CONSTRAINT "commands_reversal_by_user_with_note_check" CHECK(reverses_command_id IS NULL OR (note IS NOT NULL AND actor_kind = 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commands_idempotency_key_id_unique` ON `commands` (`idempotency_key_id`);--> statement-breakpoint
CREATE INDEX `commands_created` ON `commands` (`org_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `commands_one_reversal` ON `commands` (`org_id`,`reverses_command_id`) WHERE reverses_command_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `commands_org_id_id_unique` ON `commands` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `document_blobs` (
	`org_id` text NOT NULL,
	`document_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`bytes` blob NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `chunk_index`),
	FOREIGN KEY (`org_id`,`document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_blobs_chunk_index_check" CHECK(chunk_index >= 0),
	CONSTRAINT "document_blobs_bytes_check" CHECK(length(bytes) BETWEEN 1 AND 524288)
);
--> statement-breakpoint
CREATE TABLE `document_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`source` text NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`parent_id`) REFERENCES `document_collections`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_collections_kind_check" CHECK(kind IN ('FOLDER', 'TEMPLATE_GROUP')),
	CONSTRAINT "document_collections_name_check" CHECK(length(name) BETWEEN 1 AND 200),
	CONSTRAINT "document_collections_source_check" CHECK(source IN ('app', 'pulley')),
	CONSTRAINT "document_collections_parent_not_self_check" CHECK(parent_id IS NULL OR parent_id <> id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_collections_org_id_id_unique` ON `document_collections` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `document_links` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`document_id` text NOT NULL,
	`role` text NOT NULL,
	`security_id` text,
	`stakeholder_id` text,
	`stock_plan_id` text,
	`stock_class_id` text,
	`valuation_id` text,
	`exercise_request_id` text,
	`transaction_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	`revoke_reason` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`security_id`) REFERENCES `securities`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stakeholder_id`) REFERENCES `stakeholders`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stock_plan_id`) REFERENCES `stock_plans`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stock_class_id`) REFERENCES `stock_classes`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`valuation_id`) REFERENCES `valuations`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`exercise_request_id`) REFERENCES `exercise_requests`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`transaction_id`) REFERENCES `transactions`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_links_role_check" CHECK(length(role) BETWEEN 2 AND 40 AND role = upper(role)),
	CONSTRAINT "document_links_revoke_reason_check" CHECK(revoke_reason IS NULL OR length(revoke_reason) <= 500),
	CONSTRAINT "document_links_one_target_check" CHECK((security_id IS NOT NULL) + (stakeholder_id IS NOT NULL) + (stock_plan_id IS NOT NULL) + (stock_class_id IS NOT NULL)
       + (valuation_id IS NOT NULL) + (exercise_request_id IS NOT NULL) + (transaction_id IS NOT NULL) = 1),
	CONSTRAINT "document_links_revoked_together_check" CHECK((revoked_at IS NULL) = (revoked_by IS NULL)),
	CONSTRAINT "document_links_revoked_with_reason_check" CHECK(revoked_at IS NULL OR revoke_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `document_links_document` ON `document_links` (`org_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `document_links_security` ON `document_links` (`org_id`,`security_id`) WHERE security_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `document_links_stakeholder` ON `document_links` (`org_id`,`stakeholder_id`) WHERE stakeholder_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `document_links_live` ON `document_links` (`document_id`,`role`,CASE WHEN security_id IS NOT NULL THEN security_id WHEN stakeholder_id IS NOT NULL THEN stakeholder_id WHEN stock_plan_id IS NOT NULL THEN stock_plan_id WHEN stock_class_id IS NOT NULL THEN stock_class_id WHEN valuation_id IS NOT NULL THEN valuation_id WHEN exercise_request_id IS NOT NULL THEN exercise_request_id WHEN transaction_id IS NOT NULL THEN transaction_id END) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE TABLE `document_upload_chunks` (
	`org_id` text NOT NULL,
	`document_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`bytes` blob NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `chunk_index`),
	CONSTRAINT "document_upload_chunks_chunk_index_check" CHECK(chunk_index >= 0),
	CONSTRAINT "document_upload_chunks_bytes_check" CHECK(length(bytes) BETWEEN 1 AND 262144)
);
--> statement-breakpoint
CREATE INDEX `document_upload_chunks_created` ON `document_upload_chunks` (`created_at`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`holder_visible` integer DEFAULT 0 NOT NULL,
	`holder_published_at` integer,
	`holder_published_by` text,
	`collection_id` text,
	`version_label` text,
	`supersedes_document_id` text,
	`description` text,
	`source_created_at` integer,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holder_published_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`collection_id`) REFERENCES `document_collections`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`supersedes_document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_filename_check" CHECK(length(filename) BETWEEN 1 AND 255),
	CONSTRAINT "documents_content_type_check" CHECK(content_type IN (
    'application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation')),
	CONSTRAINT "documents_byte_size_check" CHECK(byte_size > 0 AND byte_size <= 10485760),
	CONSTRAINT "documents_sha256_check" CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "documents_kind_check" CHECK(length(kind) BETWEEN 2 AND 40 AND kind = upper(kind)),
	CONSTRAINT "documents_source_check" CHECK(source IN ('upload', 'generated', 'pulley')),
	CONSTRAINT "documents_holder_visible_check" CHECK(holder_visible IN (0, 1)),
	CONSTRAINT "documents_version_label_check" CHECK(version_label IS NULL OR length(version_label) <= 40),
	CONSTRAINT "documents_description_check" CHECK(description IS NULL OR length(description) <= 2000),
	CONSTRAINT "documents_published_together_check" CHECK((holder_published_at IS NULL) = (holder_published_by IS NULL)),
	CONSTRAINT "documents_published_visible_check" CHECK(holder_published_at IS NULL OR holder_visible = 1),
	CONSTRAINT "documents_pptx_from_pulley_check" CHECK(content_type <> 'application/vnd.openxmlformats-officedocument.presentationml.presentation' OR source = 'pulley'),
	CONSTRAINT "documents_supersedes_not_self_check" CHECK(supersedes_document_id IS NULL OR supersedes_document_id <> id)
);
--> statement-breakpoint
CREATE INDEX `documents_kind` ON `documents` (`org_id`,`kind`,`created_at`) WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX `documents_sha256` ON `documents` (`org_id`,`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `documents_pulley` ON `documents` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `documents_org_id_id_unique` ON `documents` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `election_83b_records` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`security_id` text NOT NULL,
	`status` text NOT NULL,
	`transfer_date` text,
	`due_date` text,
	`filed_date` text,
	`proof_document_id` text,
	`supersedes_id` text,
	`recorded_by` text,
	`created_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`security_id`) REFERENCES `securities`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`proof_document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`supersedes_id`) REFERENCES `election_83b_records`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "election_83b_records_status_check" CHECK(status IN ('PENDING', 'FILED', 'NOT_REQUIRED', 'UNCONFIRMED_DEADLINE_PASSED', 'PROOF_MISSING')),
	CONSTRAINT "election_83b_records_transfer_date_check" CHECK(date(transfer_date) IS transfer_date),
	CONSTRAINT "election_83b_records_due_date_check" CHECK(date(due_date) IS due_date),
	CONSTRAINT "election_83b_records_filed_date_check" CHECK(date(filed_date) IS filed_date),
	CONSTRAINT "election_83b_records_filed_with_date_check" CHECK(status <> 'FILED' OR filed_date IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `election_83b_one_successor` ON `election_83b_records` (`org_id`,`supersedes_id`) WHERE supersedes_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `election_83b_records_org_id_id_unique` ON `election_83b_records` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `exercise_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`request_number` integer NOT NULL,
	`security_id` text NOT NULL,
	`stakeholder_id` text NOT NULL,
	`requested_by` text,
	`quantity` text NOT NULL,
	`iso_quantity` text DEFAULT '0' NOT NULL,
	`nso_quantity` text DEFAULT '0' NOT NULL,
	`exercise_price` text NOT NULL,
	`fmv_per_share` text,
	`valuation_id` text,
	`estimated_withholding` text,
	`total_cost` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`payment_method` text NOT NULL,
	`status` text DEFAULT 'NEEDS_REVIEW' NOT NULL,
	`pulley_status` text,
	`holder_details` text,
	`acknowledgement` text,
	`notice_document_id` text,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`payment_due_date` text,
	`payment_received_on` text,
	`exercise_date` text,
	`completed_command_id` text,
	`cancelled_by` text,
	`cancelled_at` integer,
	`cancel_note` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`security_id`) REFERENCES `securities`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stakeholder_id`) REFERENCES `stakeholders`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`valuation_id`) REFERENCES `valuations`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`notice_document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`completed_command_id`) REFERENCES `commands`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "exercise_requests_request_number_check" CHECK(request_number >= 1),
	CONSTRAINT "exercise_requests_quantity_check" CHECK(quantity NOT GLOB '*[^0-9.]*' AND quantity GLOB '[0-9]*' AND quantity NOT GLOB '*.*.*' AND quantity NOT GLOB '*.' AND quantity NOT GLOB '0[0-9]*' AND quantity NOT GLOB '*.*0' AND length(quantity) <= 40 AND (instr(quantity, '.') = 0 OR length(quantity) - instr(quantity, '.') <= 12) AND quantity <> '0'),
	CONSTRAINT "exercise_requests_iso_quantity_check" CHECK(iso_quantity NOT GLOB '*[^0-9.]*' AND iso_quantity GLOB '[0-9]*' AND iso_quantity NOT GLOB '*.*.*' AND iso_quantity NOT GLOB '*.' AND iso_quantity NOT GLOB '0[0-9]*' AND iso_quantity NOT GLOB '*.*0' AND length(iso_quantity) <= 40 AND (instr(iso_quantity, '.') = 0 OR length(iso_quantity) - instr(iso_quantity, '.') <= 12)),
	CONSTRAINT "exercise_requests_nso_quantity_check" CHECK(nso_quantity NOT GLOB '*[^0-9.]*' AND nso_quantity GLOB '[0-9]*' AND nso_quantity NOT GLOB '*.*.*' AND nso_quantity NOT GLOB '*.' AND nso_quantity NOT GLOB '0[0-9]*' AND nso_quantity NOT GLOB '*.*0' AND length(nso_quantity) <= 40 AND (instr(nso_quantity, '.') = 0 OR length(nso_quantity) - instr(nso_quantity, '.') <= 12)),
	CONSTRAINT "exercise_requests_exercise_price_check" CHECK(exercise_price NOT GLOB '*[^0-9.]*' AND exercise_price GLOB '[0-9]*' AND exercise_price NOT GLOB '*.*.*' AND exercise_price NOT GLOB '*.' AND exercise_price NOT GLOB '0[0-9]*' AND exercise_price NOT GLOB '*.*0' AND length(exercise_price) <= 40 AND (instr(exercise_price, '.') = 0 OR length(exercise_price) - instr(exercise_price, '.') <= 12)),
	CONSTRAINT "exercise_requests_fmv_per_share_check" CHECK(fmv_per_share NOT GLOB '*[^0-9.]*' AND fmv_per_share GLOB '[0-9]*' AND fmv_per_share NOT GLOB '*.*.*' AND fmv_per_share NOT GLOB '*.' AND fmv_per_share NOT GLOB '0[0-9]*' AND fmv_per_share NOT GLOB '*.*0' AND length(fmv_per_share) <= 40 AND (instr(fmv_per_share, '.') = 0 OR length(fmv_per_share) - instr(fmv_per_share, '.') <= 12)),
	CONSTRAINT "exercise_requests_estimated_withholding_check" CHECK(estimated_withholding NOT GLOB '*[^0-9.]*' AND estimated_withholding GLOB '[0-9]*' AND estimated_withholding NOT GLOB '*.*.*' AND estimated_withholding NOT GLOB '*.' AND estimated_withholding NOT GLOB '0[0-9]*' AND estimated_withholding NOT GLOB '*.*0' AND length(estimated_withholding) <= 40 AND (instr(estimated_withholding, '.') = 0 OR length(estimated_withholding) - instr(estimated_withholding, '.') <= 12)),
	CONSTRAINT "exercise_requests_total_cost_check" CHECK(total_cost NOT GLOB '*[^0-9.]*' AND total_cost GLOB '[0-9]*' AND total_cost NOT GLOB '*.*.*' AND total_cost NOT GLOB '*.' AND total_cost NOT GLOB '0[0-9]*' AND total_cost NOT GLOB '*.*0' AND length(total_cost) <= 40 AND (instr(total_cost, '.') = 0 OR length(total_cost) - instr(total_cost, '.') <= 12)),
	CONSTRAINT "exercise_requests_payment_method_check" CHECK(payment_method IN ('ACH', 'WIRE', 'CHECK', 'CASH', 'MANUAL_UNSPECIFIED', 'OTHER')),
	CONSTRAINT "exercise_requests_status_check" CHECK(status IN (
    'NEEDS_REVIEW', 'AWAITING_HOLDER_CONFIRMATION', 'AWAITING_PAYMENT', 'EXERCISED', 'REJECTED', 'CANCELLED', 'REVERSED')),
	CONSTRAINT "exercise_requests_holder_details_check" CHECK(holder_details IS NULL OR json_valid(holder_details)),
	CONSTRAINT "exercise_requests_acknowledgement_check" CHECK(acknowledgement IS NULL OR json_valid(acknowledgement)),
	CONSTRAINT "exercise_requests_payment_due_date_check" CHECK(date(payment_due_date) IS payment_due_date),
	CONSTRAINT "exercise_requests_payment_received_on_check" CHECK(date(payment_received_on) IS payment_received_on),
	CONSTRAINT "exercise_requests_exercise_date_check" CHECK(date(exercise_date) IS exercise_date),
	CONSTRAINT "exercise_requests_completed_iff_exercised_check" CHECK((status IN ('EXERCISED', 'REVERSED')) = (completed_command_id IS NOT NULL)),
	CONSTRAINT "exercise_requests_decided_check" CHECK(status NOT IN ('AWAITING_PAYMENT', 'EXERCISED', 'REJECTED', 'REVERSED') OR decided_at IS NOT NULL OR pulley_id IS NOT NULL),
	CONSTRAINT "exercise_requests_imported_status_check" CHECK(pulley_id IS NULL OR pulley_status IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `exercise_requests_status` ON `exercise_requests` (`org_id`,`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_requests_one_open` ON `exercise_requests` (`org_id`,`security_id`) WHERE status IN ('NEEDS_REVIEW', 'AWAITING_HOLDER_CONFIRMATION', 'AWAITING_PAYMENT');--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_requests_pulley` ON `exercise_requests` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_requests_org_id_id_unique` ON `exercise_requests` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_requests_org_id_request_number_unique` ON `exercise_requests` (`org_id`,`request_number`);--> statement-breakpoint
CREATE TABLE `expiry_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`local_date` text NOT NULL,
	`candidates` text NOT NULL,
	`created_at` integer NOT NULL,
	`confirmation` text,
	`confirmed_at` integer,
	`confirmed_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "expiry_runs_local_date_check" CHECK(date(local_date) IS local_date),
	CONSTRAINT "expiry_runs_candidates_check" CHECK(json_valid(candidates) AND json_type(candidates) = 'array'),
	CONSTRAINT "expiry_runs_confirmation_check" CHECK(confirmation IS NULL OR json_valid(confirmation)),
	CONSTRAINT "expiry_runs_confirmed_together_check" CHECK((confirmed_at IS NULL) = (confirmed_by IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expiry_runs_org_id_local_date_unique` ON `expiry_runs` (`org_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`actor` text NOT NULL,
	`route` text NOT NULL,
	`idem_key` text NOT NULL,
	`request_sha256` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "idempotency_keys_scope_check" CHECK(length(scope) BETWEEN 3 AND 64),
	CONSTRAINT "idempotency_keys_actor_check" CHECK(length(actor) BETWEEN 3 AND 80),
	CONSTRAINT "idempotency_keys_route_check" CHECK(length(route) BETWEEN 3 AND 200),
	CONSTRAINT "idempotency_keys_idem_key_check" CHECK(length(idem_key) BETWEEN 8 AND 200),
	CONSTRAINT "idempotency_keys_request_sha256_check" CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "idempotency_keys_response_status_check" CHECK(response_status BETWEEN 200 AND 299),
	CONSTRAINT "idempotency_keys_response_body_check" CHECK(json_valid(response_body) AND length(response_body) <= 65536)
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_created` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_scope_actor_route_idem_key_unique` ON `idempotency_keys` (`scope`,`actor`,`route`,`idem_key`);--> statement-breakpoint
CREATE TABLE `import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_system` text NOT NULL,
	`status` text DEFAULT 'previewed' NOT NULL,
	`file_hashes` text NOT NULL,
	`as_of_date` text,
	`plan_sha256` text NOT NULL,
	`counts` text NOT NULL,
	`created_by` text NOT NULL,
	`org_id` text,
	`error_message` text,
	`timezone` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`fiscal_year_end` text NOT NULL,
	`attempt_id` text,
	`attempt_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "import_runs_source_system_check" CHECK(source_system IN ('pulley', 'template')),
	CONSTRAINT "import_runs_status_check" CHECK(status IN ('previewed', 'committed', 'failed')),
	CONSTRAINT "import_runs_file_hashes_check" CHECK(json_valid(file_hashes) AND json_type(file_hashes) = 'array'),
	CONSTRAINT "import_runs_as_of_date_check" CHECK(date(as_of_date) IS as_of_date),
	CONSTRAINT "import_runs_plan_sha256_check" CHECK(length(plan_sha256) = 64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "import_runs_counts_check" CHECK(json_valid(counts) AND json_type(counts) = 'object'),
	CONSTRAINT "import_runs_error_message_check" CHECK(error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000),
	CONSTRAINT "import_runs_timezone_check" CHECK(length(timezone) BETWEEN 1 AND 64),
	CONSTRAINT "import_runs_jurisdiction_check" CHECK(length(jurisdiction) BETWEEN 2 AND 6),
	CONSTRAINT "import_runs_fiscal_year_end_check" CHECK(fiscal_year_end GLOB '[0-1][0-9]-[0-3][0-9]'),
	CONSTRAINT "import_runs_attempt_together_check" CHECK((attempt_id IS NULL) = (attempt_expires_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX `import_runs_created` ON `import_runs` (created_at DESC,id DESC);--> statement-breakpoint
CREATE INDEX `import_runs_org` ON `import_runs` (`org_id`);--> statement-breakpoint
CREATE TABLE `ledger_heads` (
	`org_id` text PRIMARY KEY NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`genesis_hash` text NOT NULL,
	`head_hash` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_heads_seq_check" CHECK(seq >= 0),
	CONSTRAINT "ledger_heads_genesis_hash_check" CHECK(length(genesis_hash) = 64 AND genesis_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "ledger_heads_head_hash_check" CHECK(head_hash IS NULL OR length(head_hash) = 64),
	CONSTRAINT "ledger_heads_empty_iff_no_head_check" CHECK((seq = 0) = (head_hash IS NULL))
);
--> statement-breakpoint
CREATE TABLE `legends` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text DEFAULT 'LEGEND' NOT NULL,
	`name` text NOT NULL,
	`text` text NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "legends_kind_check" CHECK(kind IN ('LEGEND', 'CERTIFICATE_TERMS')),
	CONSTRAINT "legends_name_check" CHECK(length(name) BETWEEN 1 AND 200),
	CONSTRAINT "legends_text_check" CHECK(length(text) BETWEEN 1 AND 20000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legends_pulley` ON `legends` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `legends_org_id_id_unique` ON `legends` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `org_signatories` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`title` text,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "org_signatories_name_check" CHECK(length(name) BETWEEN 1 AND 200),
	CONSTRAINT "org_signatories_title_check" CHECK(title IS NULL OR length(title) <= 100),
	CONSTRAINT "org_signatories_capabilities_check" CHECK(json_valid(capabilities) AND json_type(capabilities) = 'array'),
	CONSTRAINT "org_signatories_active_check" CHECK(active IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_signatories_org_id_id_unique` ON `org_signatories` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_key` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`legal_name` text NOT NULL,
	`display_name` text NOT NULL,
	`entity_type` text DEFAULT 'C_CORPORATION' NOT NULL,
	`jurisdiction` text DEFAULT 'US-DE' NOT NULL,
	`incorporation_date` text,
	`timezone` text DEFAULT 'America/Los_Angeles' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`fiscal_year_end` text DEFAULT '12-31' NOT NULL,
	`ein` text,
	`address` text,
	`share_unit` text DEFAULT '1' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	CONSTRAINT "orgs_org_key_check" CHECK(org_key GLOB '[a-z0-9]*' AND org_key NOT GLOB '*[^a-z0-9-]*' AND length(org_key) BETWEEN 2 AND 40),
	CONSTRAINT "orgs_slug_check" CHECK(slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 2 AND 60),
	CONSTRAINT "orgs_status_check" CHECK(status IN ('importing', 'active', 'archived')),
	CONSTRAINT "orgs_legal_name_check" CHECK(length(legal_name) BETWEEN 1 AND 200),
	CONSTRAINT "orgs_display_name_check" CHECK(length(display_name) BETWEEN 1 AND 100),
	CONSTRAINT "orgs_entity_type_check" CHECK(entity_type IN ('C_CORPORATION')),
	CONSTRAINT "orgs_jurisdiction_check" CHECK(length(jurisdiction) BETWEEN 2 AND 6),
	CONSTRAINT "orgs_incorporation_date_check" CHECK(date(incorporation_date) IS incorporation_date),
	CONSTRAINT "orgs_currency_check" CHECK(length(currency) = 3 AND currency = upper(currency)),
	CONSTRAINT "orgs_fiscal_year_end_check" CHECK(fiscal_year_end GLOB '[0-1][0-9]-[0-3][0-9]'),
	CONSTRAINT "orgs_ein_check" CHECK(ein IS NULL OR ein GLOB '[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
	CONSTRAINT "orgs_address_check" CHECK(address IS NULL OR json_valid(address)),
	CONSTRAINT "orgs_share_unit_check" CHECK(share_unit NOT GLOB '*[^0-9.]*' AND share_unit GLOB '[0-9]*' AND share_unit NOT GLOB '*.*.*' AND share_unit NOT GLOB '*.' AND share_unit NOT GLOB '0[0-9]*' AND share_unit NOT GLOB '*.*0' AND length(share_unit) <= 40 AND (instr(share_unit, '.') = 0 OR length(share_unit) - instr(share_unit, '.') <= 12) AND share_unit <> '0'),
	CONSTRAINT "orgs_settings_check" CHECK(json_valid(settings))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_slug_unique` ON `orgs` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `orgs_one_active` ON `orgs` (`status`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `payment_instructions` (
	`org_id` text PRIMARY KEY NOT NULL,
	`details` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_instructions_details_check" CHECK(json_valid(details) AND length(details) <= 8192)
);
--> statement-breakpoint
CREATE TABLE `scheduled_terminations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`stakeholder_id` text NOT NULL,
	`termination_date` text NOT NULL,
	`termination_type` text NOT NULL,
	`vesting_stop_date` text NOT NULL,
	`request` text NOT NULL,
	`request_sha256` text NOT NULL,
	`status` text DEFAULT 'SCHEDULED' NOT NULL,
	`applied_command_id` text,
	`cancelled_by` text,
	`cancelled_at` integer,
	`cancel_note` text,
	`created_by` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stakeholder_id`) REFERENCES `stakeholders`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`applied_command_id`) REFERENCES `commands`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scheduled_terminations_termination_date_check" CHECK(date(termination_date) IS termination_date),
	CONSTRAINT "scheduled_terminations_termination_type_check" CHECK(termination_type IN ('voluntary', 'involuntary', 'with_cause', 'death', 'disability', 'retirement')),
	CONSTRAINT "scheduled_terminations_vesting_stop_date_check" CHECK(date(vesting_stop_date) IS vesting_stop_date),
	CONSTRAINT "scheduled_terminations_request_check" CHECK(json_valid(request)),
	CONSTRAINT "scheduled_terminations_request_sha256_check" CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "scheduled_terminations_status_check" CHECK(status IN ('SCHEDULED', 'APPLIED', 'CANCELLED')),
	CONSTRAINT "scheduled_terminations_cancel_note_check" CHECK(cancel_note IS NULL OR length(cancel_note) <= 2000),
	CONSTRAINT "scheduled_terminations_applied_iff_command_check" CHECK((status = 'APPLIED') = (applied_command_id IS NOT NULL)),
	CONSTRAINT "scheduled_terminations_cancelled_with_note_check" CHECK((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_note IS NOT NULL)),
	CONSTRAINT "scheduled_terminations_vesting_stops_by_termination_check" CHECK(vesting_stop_date <= termination_date)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_terminations_one_live` ON `scheduled_terminations` (`org_id`,`stakeholder_id`) WHERE status = 'SCHEDULED';--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_terminations_org_id_id_unique` ON `scheduled_terminations` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `securities` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`family` text NOT NULL,
	`subtype` text NOT NULL,
	`stakeholder_id` text NOT NULL,
	`stock_class_id` text,
	`stock_plan_id` text,
	`display_id` text NOT NULL,
	`origin_command_id` text NOT NULL,
	`parent_security_id` text,
	`created_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stakeholder_id`) REFERENCES `stakeholders`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stock_class_id`) REFERENCES `stock_classes`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stock_plan_id`) REFERENCES `stock_plans`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`origin_command_id`) REFERENCES `commands`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`parent_security_id`) REFERENCES `securities`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "securities_family_check" CHECK(family IN ('STOCK', 'EQUITY_COMPENSATION', 'WARRANT', 'CONVERTIBLE')),
	CONSTRAINT "securities_display_id_check" CHECK(length(display_id) BETWEEN 1 AND 40),
	CONSTRAINT "securities_subtype_of_family_check" CHECK(
    (family = 'STOCK' AND subtype IN ('COMMON', 'PREFERRED')) OR
    (family = 'EQUITY_COMPENSATION' AND subtype IN ('OPTION_ISO', 'OPTION_NSO', 'RSU', 'SAR')) OR
    (family = 'WARRANT' AND subtype = 'WARRANT') OR
    (family = 'CONVERTIBLE' AND subtype IN ('SAFE', 'NOTE'))
  ),
	CONSTRAINT "securities_stock_has_class_check" CHECK(family <> 'STOCK' OR stock_class_id IS NOT NULL),
	CONSTRAINT "securities_parent_not_self_check" CHECK(parent_security_id IS NULL OR parent_security_id <> id)
);
--> statement-breakpoint
CREATE INDEX `securities_stakeholder` ON `securities` (`org_id`,`stakeholder_id`);--> statement-breakpoint
CREATE INDEX `securities_origin` ON `securities` (`org_id`,`origin_command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `securities_pulley` ON `securities` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `securities_org_id_id_unique` ON `securities` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `securities_org_id_display_id_unique` ON `securities` (`org_id`,`display_id`);--> statement-breakpoint
CREATE TABLE `signature_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`security_id` text,
	`exercise_request_id` text,
	`document_id` text,
	`signer_role` text NOT NULL,
	`signer_name` text,
	`signer_email` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`method` text,
	`evidence` text,
	`evidence_sha256` text,
	`signed_at` integer,
	`resolved_by` text,
	`resolved_at` integer,
	`resolution_note` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`security_id`) REFERENCES `securities`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`exercise_request_id`) REFERENCES `exercise_requests`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "signature_requests_signer_role_check" CHECK(signer_role IN ('COMPANY_SIGNATORY', 'HOLDER', 'SPOUSE', 'APPROVER')),
	CONSTRAINT "signature_requests_signer_name_check" CHECK(signer_name IS NULL OR length(signer_name) <= 200),
	CONSTRAINT "signature_requests_signer_email_check" CHECK(signer_email IS NULL OR signer_email = lower(signer_email)),
	CONSTRAINT "signature_requests_status_check" CHECK(status IN ('PENDING', 'SIGNED', 'WAIVED', 'CANCELLED')),
	CONSTRAINT "signature_requests_method_check" CHECK(method IN ('pulley', 'offline_upload', 'portal_acknowledgement', 'esign')),
	CONSTRAINT "signature_requests_evidence_check" CHECK(evidence IS NULL OR json_valid(evidence)),
	CONSTRAINT "signature_requests_evidence_sha256_check" CHECK(evidence_sha256 IS NULL OR length(evidence_sha256) = 64),
	CONSTRAINT "signature_requests_resolution_note_check" CHECK(resolution_note IS NULL OR length(resolution_note) <= 2000),
	CONSTRAINT "signature_requests_one_target_check" CHECK((security_id IS NULL) <> (exercise_request_id IS NULL)),
	CONSTRAINT "signature_requests_signed_iff_signed_at_check" CHECK((status = 'SIGNED') = (signed_at IS NOT NULL)),
	CONSTRAINT "signature_requests_resolved_with_evidence_check" CHECK(status = 'PENDING' OR (method IS NOT NULL AND evidence IS NOT NULL AND evidence_sha256 IS NOT NULL)),
	CONSTRAINT "signature_requests_waived_with_note_check" CHECK(status NOT IN ('WAIVED', 'CANCELLED') OR resolution_note IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `signature_requests_pending` ON `signature_requests` (`org_id`,`status`) WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX `signature_requests_security` ON `signature_requests` (`org_id`,`security_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `signature_requests_pulley` ON `signature_requests` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `signature_requests_org_id_id_unique` ON `signature_requests` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `stakeholder_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`stakeholder_id` text NOT NULL,
	`email` text NOT NULL,
	`kind` text DEFAULT 'self' NOT NULL,
	`contact_name` text,
	`contact_role` text,
	`authorizing_document_id` text,
	`added_by` text,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	`removed_by` text,
	`pulley_id` text,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stakeholder_id`) REFERENCES `stakeholders`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`authorizing_document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stakeholder_emails_email_check" CHECK(email = lower(email) AND length(email) <= 254 AND email LIKE '%_@_%._%'),
	CONSTRAINT "stakeholder_emails_kind_check" CHECK(kind IN ('self', 'contact', 'representative')),
	CONSTRAINT "stakeholder_emails_contact_name_check" CHECK(contact_name IS NULL OR length(contact_name) <= 200),
	CONSTRAINT "stakeholder_emails_contact_role_check" CHECK(contact_role IS NULL OR length(contact_role) <= 100),
	CONSTRAINT "stakeholder_emails_representative_document_check" CHECK(kind <> 'representative' OR authorizing_document_id IS NOT NULL),
	CONSTRAINT "stakeholder_emails_removed_together_check" CHECK((removed_at IS NULL) = (removed_by IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stakeholder_emails_live` ON `stakeholder_emails` (`org_id`,`stakeholder_id`,`email`) WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX `stakeholder_emails_active_email` ON `stakeholder_emails` (`email`) WHERE removed_at IS NULL;--> statement-breakpoint
CREATE TABLE `stakeholder_merge_link_moves` (
	`command_id` text NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`row_id` text NOT NULL,
	`action` text NOT NULL,
	PRIMARY KEY(`command_id`, `kind`, `row_id`),
	FOREIGN KEY (`org_id`,`command_id`) REFERENCES `commands`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stakeholder_merge_link_moves_kind_check" CHECK(kind IN ('admin_link', 'document_link')),
	CONSTRAINT "stakeholder_merge_link_moves_action_check" CHECK(action IN ('moved', 'deduplicated'))
);
--> statement-breakpoint
CREATE TABLE `stakeholders` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`legal_name` text,
	`relationship` text NOT NULL,
	`issuer_assigned_id` text,
	`address` text,
	`phone` text,
	`country_of_residence` text,
	`tax_status` text DEFAULT 'unknown' NOT NULL,
	`hire_date` text,
	`comments` text,
	`portal_access` text DEFAULT 'auto' NOT NULL,
	`outside_counsel` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	`pulley_stakeholder_id` text,
	`merged_into_id` text,
	`merged_at` integer,
	`merged_by_command_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_into_id`) REFERENCES `stakeholders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_by_command_id`) REFERENCES `commands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stakeholders_kind_check" CHECK(kind IN ('individual', 'institution')),
	CONSTRAINT "stakeholders_display_name_check" CHECK(length(display_name) BETWEEN 1 AND 200),
	CONSTRAINT "stakeholders_legal_name_check" CHECK(legal_name IS NULL OR length(legal_name) BETWEEN 1 AND 200),
	CONSTRAINT "stakeholders_relationship_check" CHECK(relationship IN (
    'founder', 'employee', 'ex_employee', 'officer', 'board_member', 'advisor', 'consultant', 'investor', 'other')),
	CONSTRAINT "stakeholders_issuer_assigned_id_check" CHECK(issuer_assigned_id IS NULL OR length(issuer_assigned_id) BETWEEN 1 AND 64),
	CONSTRAINT "stakeholders_address_check" CHECK(address IS NULL OR json_valid(address)),
	CONSTRAINT "stakeholders_phone_check" CHECK(phone IS NULL OR length(phone) <= 40),
	CONSTRAINT "stakeholders_country_of_residence_check" CHECK(country_of_residence IS NULL OR (length(country_of_residence) = 2 AND country_of_residence = upper(country_of_residence))),
	CONSTRAINT "stakeholders_tax_status_check" CHECK(tax_status IN ('us', 'non_us', 'unknown')),
	CONSTRAINT "stakeholders_hire_date_check" CHECK(date(hire_date) IS hire_date),
	CONSTRAINT "stakeholders_comments_check" CHECK(comments IS NULL OR length(comments) <= 4000),
	CONSTRAINT "stakeholders_portal_access_check" CHECK(portal_access IN ('auto', 'open', 'closed')),
	CONSTRAINT "stakeholders_outside_counsel_check" CHECK(outside_counsel IN (0, 1)),
	CONSTRAINT "stakeholders_counsel_access_not_open_check" CHECK(outside_counsel = 0 OR portal_access <> 'open')
);
--> statement-breakpoint
CREATE INDEX `stakeholders_name` ON `stakeholders` (`org_id`,`display_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `stakeholders_external_id` ON `stakeholders` (`org_id`,`issuer_assigned_id`) WHERE issuer_assigned_id IS NOT NULL AND archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `stakeholders_pulley` ON `stakeholders` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `stakeholders_merged_into` ON `stakeholders` (`org_id`,`merged_into_id`) WHERE merged_into_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `stakeholders_org_id_id_unique` ON `stakeholders` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `stock_classes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`class_type` text NOT NULL,
	`default_id_prefix` text NOT NULL,
	`par_value` text,
	`original_issue_price` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`is_certificated` integer DEFAULT 0 NOT NULL,
	`board_approval_date` text,
	`stockholder_approval_date` text,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_classes_name_check" CHECK(length(name) BETWEEN 1 AND 100),
	CONSTRAINT "stock_classes_class_type_check" CHECK(class_type IN ('COMMON', 'PREFERRED')),
	CONSTRAINT "stock_classes_default_id_prefix_check" CHECK(default_id_prefix GLOB '[A-Z]*' AND default_id_prefix NOT GLOB '*[^A-Z0-9]*' AND length(default_id_prefix) BETWEEN 1 AND 10),
	CONSTRAINT "stock_classes_par_value_check" CHECK(par_value NOT GLOB '*[^0-9.]*' AND par_value GLOB '[0-9]*' AND par_value NOT GLOB '*.*.*' AND par_value NOT GLOB '*.' AND par_value NOT GLOB '0[0-9]*' AND par_value NOT GLOB '*.*0' AND length(par_value) <= 40 AND (instr(par_value, '.') = 0 OR length(par_value) - instr(par_value, '.') <= 12)),
	CONSTRAINT "stock_classes_original_issue_price_check" CHECK(original_issue_price NOT GLOB '*[^0-9.]*' AND original_issue_price GLOB '[0-9]*' AND original_issue_price NOT GLOB '*.*.*' AND original_issue_price NOT GLOB '*.' AND original_issue_price NOT GLOB '0[0-9]*' AND original_issue_price NOT GLOB '*.*0' AND length(original_issue_price) <= 40 AND (instr(original_issue_price, '.') = 0 OR length(original_issue_price) - instr(original_issue_price, '.') <= 12)),
	CONSTRAINT "stock_classes_currency_check" CHECK(length(currency) = 3 AND currency = upper(currency)),
	CONSTRAINT "stock_classes_is_certificated_check" CHECK(is_certificated IN (0, 1)),
	CONSTRAINT "stock_classes_board_approval_date_check" CHECK(date(board_approval_date) IS board_approval_date),
	CONSTRAINT "stock_classes_stockholder_approval_date_check" CHECK(date(stockholder_approval_date) IS stockholder_approval_date)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_classes_name` ON `stock_classes` (`org_id`,`name`) WHERE archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `stock_classes_pulley` ON `stock_classes` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `stock_classes_org_id_id_unique` ON `stock_classes` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `stock_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`stock_class_id` text NOT NULL,
	`board_approval_date` text,
	`stockholder_approval_date` text,
	`effective_date` text,
	`expiration_date` text,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stock_class_id`) REFERENCES `stock_classes`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_plans_name_check" CHECK(length(name) BETWEEN 1 AND 200),
	CONSTRAINT "stock_plans_board_approval_date_check" CHECK(date(board_approval_date) IS board_approval_date),
	CONSTRAINT "stock_plans_stockholder_approval_date_check" CHECK(date(stockholder_approval_date) IS stockholder_approval_date),
	CONSTRAINT "stock_plans_effective_date_check" CHECK(date(effective_date) IS effective_date),
	CONSTRAINT "stock_plans_expiration_date_check" CHECK(date(expiration_date) IS expiration_date)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_plans_pulley` ON `stock_plans` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `stock_plans_org_id_id_unique` ON `stock_plans` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `transaction_types` (
	`code` text PRIMARY KEY NOT NULL,
	`family` text NOT NULL,
	`is_ocf` integer NOT NULL,
	`description` text NOT NULL,
	CONSTRAINT "transaction_types_code_check" CHECK(code GLOB 'TX_*' OR code GLOB 'X_*'),
	CONSTRAINT "transaction_types_family_check" CHECK(family IN ('STOCK', 'EQUITY_COMPENSATION', 'WARRANT', 'CONVERTIBLE', 'STOCK_CLASS', 'ISSUER', 'STOCK_PLAN', 'VESTING', 'STAKEHOLDER', 'LEDGER', 'MIGRATION')),
	CONSTRAINT "transaction_types_is_ocf_check" CHECK(is_ocf IN (0, 1)),
	CONSTRAINT "transaction_types_ocf_iff_tx_check" CHECK((code GLOB 'TX_*') = (is_ocf = 1))
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`seq` integer NOT NULL,
	`command_id` text NOT NULL,
	`type` text NOT NULL,
	`effective_date` text NOT NULL,
	`security_id` text,
	`stakeholder_id` text,
	`stock_class_id` text,
	`stock_plan_id` text,
	`valuation_id` text,
	`quantity` text,
	`amount` text,
	`currency` text,
	`payload` text NOT NULL,
	`payload_version` integer DEFAULT 1 NOT NULL,
	`payload_sha256` text NOT NULL,
	`reverses_tx_id` text,
	`supersedes_tx_id` text,
	`source` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`recorded_by` text,
	`prev_hash` text NOT NULL,
	`chain_hash` text NOT NULL,
	`pulley_ref` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`type`) REFERENCES `transaction_types`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`command_id`) REFERENCES `commands`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`security_id`) REFERENCES `securities`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stakeholder_id`) REFERENCES `stakeholders`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stock_class_id`) REFERENCES `stock_classes`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stock_plan_id`) REFERENCES `stock_plans`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`valuation_id`) REFERENCES `valuations`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`reverses_tx_id`) REFERENCES `transactions`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`supersedes_tx_id`) REFERENCES `transactions`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_seq_check" CHECK(seq >= 1),
	CONSTRAINT "transactions_effective_date_check" CHECK(date(effective_date) IS effective_date),
	CONSTRAINT "transactions_quantity_check" CHECK(quantity NOT GLOB '*[^0-9.]*' AND quantity GLOB '[0-9]*' AND quantity NOT GLOB '*.*.*' AND quantity NOT GLOB '*.' AND quantity NOT GLOB '0[0-9]*' AND quantity NOT GLOB '*.*0' AND length(quantity) <= 40 AND (instr(quantity, '.') = 0 OR length(quantity) - instr(quantity, '.') <= 12) AND quantity <> '0'),
	CONSTRAINT "transactions_amount_check" CHECK(amount NOT GLOB '*[^0-9.]*' AND amount GLOB '[0-9]*' AND amount NOT GLOB '*.*.*' AND amount NOT GLOB '*.' AND amount NOT GLOB '0[0-9]*' AND amount NOT GLOB '*.*0' AND length(amount) <= 40 AND (instr(amount, '.') = 0 OR length(amount) - instr(amount, '.') <= 12)),
	CONSTRAINT "transactions_currency_check" CHECK(currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
	CONSTRAINT "transactions_payload_check" CHECK(json_valid(payload) AND json_type(payload) = 'object' AND length(payload) <= 65536),
	CONSTRAINT "transactions_payload_version_check" CHECK(payload_version >= 1),
	CONSTRAINT "transactions_payload_sha256_check" CHECK(length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "transactions_source_check" CHECK(source IN ('app', 'import', 'system')),
	CONSTRAINT "transactions_prev_hash_check" CHECK(length(prev_hash) = 64 AND prev_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "transactions_chain_hash_check" CHECK(length(chain_hash) = 64 AND chain_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "transactions_reversal_target_check" CHECK((type = 'X_REVERSAL') = (reverses_tx_id IS NOT NULL)),
	CONSTRAINT "transactions_correction_target_check" CHECK((type = 'X_CORRECTION') = (supersedes_tx_id IS NOT NULL)),
	CONSTRAINT "transactions_chain_moves_check" CHECK(chain_hash <> prev_hash)
);
--> statement-breakpoint
CREATE INDEX `transactions_security` ON `transactions` (`org_id`,`security_id`,`seq`) WHERE security_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `transactions_stakeholder` ON `transactions` (`org_id`,`stakeholder_id`,`seq`) WHERE stakeholder_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `transactions_type` ON `transactions` (`org_id`,`type`,`effective_date`);--> statement-breakpoint
CREATE INDEX `transactions_command` ON `transactions` (`org_id`,`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_one_reversal` ON `transactions` (`org_id`,`reverses_tx_id`) WHERE reverses_tx_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_one_correction` ON `transactions` (`org_id`,`supersedes_tx_id`) WHERE supersedes_tx_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_pulley` ON `transactions` (`org_id`,`pulley_ref`) WHERE pulley_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_org_id_seq_unique` ON `transactions` (`org_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_org_id_id_unique` ON `transactions` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`display_name` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_email_check" CHECK(email = lower(email) AND length(email) <= 254 AND email LIKE '%_@_%._%'),
	CONSTRAINT "users_display_name_check" CHECK(display_name IS NULL OR length(display_name) <= 200)
);
--> statement-breakpoint
CREATE TABLE `valuation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`valuation_id` text NOT NULL,
	`kind` text NOT NULL,
	`event_date` text NOT NULL,
	`description` text NOT NULL,
	`document_id` text,
	`reverses_event_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`valuation_id`) REFERENCES `valuations`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`reverses_event_id`) REFERENCES `valuation_events`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "valuation_events_kind_check" CHECK(kind IN ('MATERIAL_EVENT', 'REVIEW_CLEARED', 'VOIDED', 'EVENT_REVERSED')),
	CONSTRAINT "valuation_events_event_date_check" CHECK(date(event_date) IS event_date),
	CONSTRAINT "valuation_events_description_check" CHECK(length(description) BETWEEN 1 AND 2000),
	CONSTRAINT "valuation_events_review_cleared_document_check" CHECK(kind <> 'REVIEW_CLEARED' OR document_id IS NOT NULL),
	CONSTRAINT "valuation_events_reversal_target_check" CHECK((kind = 'EVENT_REVERSED') = (reverses_event_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `valuation_events_one_reversal` ON `valuation_events` (`org_id`,`reverses_event_id`) WHERE reverses_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `valuation_events_valuation` ON `valuation_events` (`org_id`,`valuation_id`,`event_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `valuation_events_org_id_id_unique` ON `valuation_events` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `valuation_prices` (
	`org_id` text NOT NULL,
	`valuation_id` text NOT NULL,
	`stock_class_id` text NOT NULL,
	`price_per_share` text NOT NULL,
	PRIMARY KEY(`valuation_id`, `stock_class_id`),
	FOREIGN KEY (`org_id`,`valuation_id`) REFERENCES `valuations`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`stock_class_id`) REFERENCES `stock_classes`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "valuation_prices_price_per_share_check" CHECK(price_per_share NOT GLOB '*[^0-9.]*' AND price_per_share GLOB '[0-9]*' AND price_per_share NOT GLOB '*.*.*' AND price_per_share NOT GLOB '*.' AND price_per_share NOT GLOB '0[0-9]*' AND price_per_share NOT GLOB '*.*0' AND length(price_per_share) <= 40 AND (instr(price_per_share, '.') = 0 OR length(price_per_share) - instr(price_per_share, '.') <= 12) AND price_per_share <> '0')
);
--> statement-breakpoint
CREATE TABLE `valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`valuation_type` text DEFAULT '409A' NOT NULL,
	`name` text NOT NULL,
	`provider` text,
	`effective_date` text NOT NULL,
	`expiration_date` text,
	`board_approval_date` text,
	`report_version` text DEFAULT 'FINAL' NOT NULL,
	`method_notes` text,
	`report_document_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`report_document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "valuations_valuation_type_check" CHECK(valuation_type IN ('409A', 'OTHER')),
	CONSTRAINT "valuations_name_check" CHECK(length(name) BETWEEN 1 AND 200),
	CONSTRAINT "valuations_provider_check" CHECK(provider IS NULL OR length(provider) <= 200),
	CONSTRAINT "valuations_effective_date_check" CHECK(date(effective_date) IS effective_date),
	CONSTRAINT "valuations_expiration_date_check" CHECK(date(expiration_date) IS expiration_date),
	CONSTRAINT "valuations_board_approval_date_check" CHECK(date(board_approval_date) IS board_approval_date),
	CONSTRAINT "valuations_report_version_check" CHECK(report_version IN ('FINAL', 'DRAFT')),
	CONSTRAINT "valuations_method_notes_check" CHECK(method_notes IS NULL OR length(method_notes) <= 4000),
	CONSTRAINT "valuations_expires_after_effective_check" CHECK(expiration_date IS NULL OR expiration_date >= effective_date),
	CONSTRAINT "valuations_report_required_check" CHECK(pulley_id IS NOT NULL OR report_document_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `valuations_effective` ON `valuations` (`org_id`,`effective_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `valuations_pulley` ON `valuations` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `valuations_org_id_id_unique` ON `valuations` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `vesting_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_template` integer DEFAULT 0 NOT NULL,
	`template_id` text,
	`definition` text NOT NULL,
	`definition_sha256` text NOT NULL,
	`algorithm_version` integer DEFAULT 1 NOT NULL,
	`confirmed_by` text,
	`confirmed_at` integer,
	`archived_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`pulley_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`template_id`) REFERENCES `vesting_terms`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vesting_terms_name_check" CHECK(length(name) BETWEEN 1 AND 200),
	CONSTRAINT "vesting_terms_description_check" CHECK(description IS NULL OR length(description) <= 2000),
	CONSTRAINT "vesting_terms_is_template_check" CHECK(is_template IN (0, 1)),
	CONSTRAINT "vesting_terms_definition_check" CHECK(json_valid(definition) AND length(definition) <= 262144),
	CONSTRAINT "vesting_terms_definition_sha256_check" CHECK(length(definition_sha256) = 64 AND definition_sha256 NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "vesting_terms_algorithm_version_check" CHECK(algorithm_version >= 1),
	CONSTRAINT "vesting_terms_confirmed_together_check" CHECK((confirmed_by IS NULL) = (confirmed_at IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vesting_terms_pulley` ON `vesting_terms` (`org_id`,`pulley_id`) WHERE pulley_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `vesting_terms_org_id_id_unique` ON `vesting_terms` (`org_id`,`id`);