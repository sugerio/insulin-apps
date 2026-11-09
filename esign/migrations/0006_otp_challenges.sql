-- The emailed one-time code (OTP) of a recipient's task (src/page-authorization.ts). One row per
-- task, so the limits are counted per task and a new page session does not reset them. The code
-- is six digits and only its HMAC is stored, keyed by OTP_KEY over the task, the task's email and
-- the code. The email itself is not stored here, because a task's email cannot change (0027).
--
-- session_hash: the recipient session (access_sessions) the code was sent for. Only that session
--   can enter it.
-- expires_at: ten minutes after the send.
-- used_at: when the code was entered correctly. A code is used once.
-- attempts, sends: entries and sends in the current window, which opens at a send
--   (window_started_at) and lasts fifteen minutes: at most 5 entries and 3 sends per window.
-- last_sent_at: the latest send. The next send is allowed 60 seconds later.
--
-- Entering the code sets access_sessions.otp_verified_at on that session (0005).
CREATE TABLE otp_challenges (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
  session_hash TEXT NOT NULL REFERENCES access_sessions(token_hash),
  otp_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  sends INTEGER NOT NULL DEFAULT 1 CHECK (sends BETWEEN 1 AND 3),
  window_started_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL
);
