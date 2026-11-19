-- An uploaded PDF flattened or reoriented before it was stored (pdf-upload.ts): the SHA-256 of the file as uploaded,
-- and what was changed, on the envelope's document, the template and the editor's staged source.
ALTER TABLE `artifacts` ADD `uploaded_sha256` text;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `upload_changes_json` text;--> statement-breakpoint
ALTER TABLE `editor_sessions` ADD `staged_uploaded_sha256` text;--> statement-breakpoint
ALTER TABLE `editor_sessions` ADD `staged_changes_json` text;--> statement-breakpoint
ALTER TABLE `templates` ADD `uploaded_sha256` text;--> statement-breakpoint
ALTER TABLE `templates` ADD `upload_changes_json` text;