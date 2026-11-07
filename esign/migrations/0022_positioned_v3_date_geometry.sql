-- Old preview rows have no trustworthy placement and must be refreshed.
ALTER TABLE positioned_v3_date_previews ADD COLUMN geometry_json TEXT;
