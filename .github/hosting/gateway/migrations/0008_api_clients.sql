-- OAuth clients for API access (.github/hosting/DESIGN.md §5.3): rotating a client secret keeps the previous one valid
-- for 24 hours next to the new one, so a running program can switch over without downtime. At most two secrets are
-- ever valid: rotating again replaces the previous one.
ALTER TABLE service_accounts ADD COLUMN previous_secret_hash TEXT;
ALTER TABLE service_accounts ADD COLUMN previous_secret_expires_at INTEGER;
-- When the current secret was made by a rotation (NULL: the client still has the secret it was created with).
ALTER TABLE service_accounts ADD COLUMN secret_rotated_at INTEGER;

-- The SHA-256 of the client secret that issued a service account's access token, so ending a secret early ("Revoke
-- previous secret now", or a second rotation) ends that secret's tokens and no others. NULL for a person's tokens, and
-- for service tokens issued before this migration, which are treated as the previous secret's (they last an hour).
ALTER TABLE oauth_tokens ADD COLUMN client_secret_hash TEXT;
