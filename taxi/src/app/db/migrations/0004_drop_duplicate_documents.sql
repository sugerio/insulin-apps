-- A file whose content or slips were already in the year used to be saved as a `duplicate` row, with no bytes and no
-- slips. Uploads no longer save one, so the old rows go. The status stays in the CHECK: changing it would rebuild the
-- table, and dropping `documents` would cascade to `document_chunks`.
DELETE FROM documents WHERE status = 'duplicate';
