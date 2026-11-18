-- An editing session may place the fields of an envelope draft whose document was uploaded with it (editor-routes.ts).
ALTER TABLE `editor_sessions` ADD `envelope_id` text;
