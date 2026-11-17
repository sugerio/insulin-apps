-- The pre-filled fields a host fills in, given when it opens the embedded editor (editor-routes.ts): the editor offers
-- those to place and no others.
ALTER TABLE `editor_sessions` ADD `prefill_catalog_json` text;
