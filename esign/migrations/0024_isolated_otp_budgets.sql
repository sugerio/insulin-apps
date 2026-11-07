ALTER TABLE recipient_otp_challenges ADD COLUMN isolated_issue_id TEXT;
CREATE TABLE isolated_otp_send_budgets (
 scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account','tenant')),
 scope_id TEXT NOT NULL,
 window_started_at INTEGER NOT NULL,
 window_ms INTEGER NOT NULL,
 send_limit INTEGER NOT NULL CHECK (send_limit > 0),
 send_count INTEGER NOT NULL CHECK (send_count > 0),
 reservation_id TEXT NOT NULL,
 PRIMARY KEY (scope_kind,scope_id)
);
