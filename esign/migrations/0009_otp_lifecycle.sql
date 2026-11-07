ALTER TABLE recipient_otp_challenges ADD COLUMN window_started_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipient_otp_challenges ADD COLUMN next_send_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipient_otp_challenges ADD COLUMN sends INTEGER NOT NULL DEFAULT 1;
UPDATE recipient_otp_challenges SET window_started_at = expires_at - 300000, next_send_at = expires_at - 240000;
