-- Each committed reservation consumes quota even if dispatch or its response fails.
CREATE TABLE isolated_otp_quota_reservations (
 reservation_id TEXT PRIMARY KEY NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 session_hash TEXT UNIQUE NOT NULL,
 reserved_at INTEGER NOT NULL
);
CREATE INDEX isolated_otp_quota_task_time ON isolated_otp_quota_reservations(task_id,reserved_at);
CREATE TRIGGER isolated_otp_quota_no_update BEFORE UPDATE ON isolated_otp_quota_reservations BEGIN SELECT RAISE(ABORT,'immutable quota'); END;
CREATE TRIGGER isolated_otp_quota_no_delete BEFORE DELETE ON isolated_otp_quota_reservations BEGIN SELECT RAISE(ABORT,'immutable quota'); END;
