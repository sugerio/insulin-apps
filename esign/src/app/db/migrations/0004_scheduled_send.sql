-- What drizzle-kit can't express: send later (server/esign/scheduled-send.ts) keeps a draft's time to send inside its
-- request, `draft_json`, under `schedule.at`, not in a column. The tick finds the drafts due through this partial index
-- on that expression, drafts only; queries must spell the expression exactly so. Safe to run again.
CREATE INDEX IF NOT EXISTS `envelopes_scheduled` ON `envelopes` (json_extract(`draft_json`, '$.schedule.at')) WHERE `status` = 'DRAFT';
