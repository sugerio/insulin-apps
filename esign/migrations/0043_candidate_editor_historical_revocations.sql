-- Earlier bindings have no complete revocation history, including restorations
-- before 0042. Preserve their evidence but fail closed on all existing pages.
INSERT OR IGNORE INTO candidate_editor_revocations (page_id)
SELECT page_id FROM candidate_editor_bindings;
