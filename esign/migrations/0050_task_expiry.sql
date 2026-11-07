-- A recipient's sign-by deadline (epoch ms), kept beside the task so the tasks table (and every
-- positional INSERT into it) is unchanged. Past it, while the task is not SIGNED, the envelope
-- expires (src/task-expiry.ts). No row: no deadline.
CREATE TABLE task_deadlines (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX task_deadlines_expires_at ON task_deadlines (expires_at);
