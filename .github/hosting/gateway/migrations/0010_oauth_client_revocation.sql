-- Revoking an OAuth client (.github/hosting/DESIGN.md §5.4): an organization's owners and admins revoke an app's OAuth
-- client for API access, or a person's AI agent, on /settings/oauth-clients. Revoking ends its access at once (its secrets,
-- its grant and every token) but keeps it listed, marked revoked, with who revoked it and when, until someone deletes it;
-- an agent's revoked grant goes when it would have expired, or when its person leaves the organization. A revoked
-- client gets no token again.
ALTER TABLE service_accounts ADD COLUMN revoked_at INTEGER;
ALTER TABLE service_accounts ADD COLUMN revoked_by TEXT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE oauth_grants ADD COLUMN revoked_at INTEGER;
ALTER TABLE oauth_grants ADD COLUMN revoked_by TEXT REFERENCES users (id) ON DELETE SET NULL;

-- A credential change still ends every live agent of the person (0004), and now leaves a revoked one's record, which
-- holds no token.
DROP TRIGGER users_credential_change_ends_grants;
CREATE TRIGGER users_credential_change_ends_grants AFTER UPDATE OF credential_version ON users WHEN NEW.credential_version <> OLD.credential_version BEGIN DELETE FROM oauth_grants WHERE user_id = NEW.id AND revoked_at IS NULL; END;
