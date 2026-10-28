-- A credential version per user, raised by every password set, change or reset and by other security changes. A
-- session records the version it was created under and is valid only while the two match, so a credential change
-- ends every session at once, and a sign-in that verified an older credential cannot create one afterwards.
ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0;
