-- Roles for every app (.github/hosting/DESIGN.md §2). A member has one organization role (OWNER, ADMIN, EDITOR,
-- VIEWER) or access to specific apps instead (APPS), with a role per app in app_grants; never both. The console's
-- USER role is retired: Cap Table shows USER and VIEWER the same holder view, so USER memberships and invitations
-- become VIEWER and nobody sees more or less.
--
-- memberships and invitations are rebuilt because SQLite can't change a CHECK in place. Nothing references either
-- table yet, so the rebuild drops no foreign key. Triggers are written on one line each (the test harness splits
-- statements at a semicolon that ends a line).

CREATE TABLE memberships_next (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'EDITOR', 'VIEWER', 'APPS')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
) STRICT;

INSERT INTO memberships_next (org_id, user_id, role, created_at, updated_at)
  SELECT org_id, user_id, CASE role WHEN 'USER' THEN 'VIEWER' ELSE role END, created_at, updated_at FROM memberships;

DROP TABLE memberships;

ALTER TABLE memberships_next RENAME TO memberships;

CREATE INDEX memberships_by_user ON memberships (user_id, created_at);

CREATE TABLE invitations_next (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'EDITOR', 'VIEWER', 'APPS')),
  invited_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  responded_at INTEGER
) STRICT;

INSERT INTO invitations_next (id, org_id, email, role, invited_by, status, created_at, expires_at, last_sent_at, responded_at)
  SELECT id, org_id, email, CASE role WHEN 'USER' THEN 'VIEWER' ELSE role END, invited_by, status, created_at, expires_at,
    last_sent_at, responded_at
  FROM invitations;

DROP TABLE invitations;

ALTER TABLE invitations_next RENAME TO invitations;

CREATE UNIQUE INDEX invitations_one_pending ON invitations (org_id, email) WHERE status = 'pending';

CREATE INDEX invitations_by_email ON invitations (email, status);

-- A custom role belongs to one organization and one app, and lists permissions from that app's catalog (a JSON array
-- of keys). Only the organization's OWNERs create, change and delete them.
CREATE TABLE custom_roles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL CHECK (json_valid(permissions) AND json_type(permissions) = 'array'),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (org_id, app, id)
) STRICT;

CREATE UNIQUE INDEX custom_roles_unique_name ON custom_roles (org_id, app, name COLLATE NOCASE);

-- A specific-apps member's role in one app: a built-in role, or CUSTOM with a custom role of the same organization
-- and app (the composite key). Deleting a custom role in use fails; deleting the membership removes its grants.
CREATE TABLE app_grants (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'EDITOR', 'VIEWER', 'CUSTOM')),
  custom_role_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id, app),
  FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, app, custom_role_id) REFERENCES custom_roles (org_id, app, id),
  CHECK ((role = 'CUSTOM') = (custom_role_id IS NOT NULL))
) STRICT;

CREATE INDEX app_grants_by_app ON app_grants (org_id, app);

CREATE INDEX app_grants_by_custom_role ON app_grants (custom_role_id) WHERE custom_role_id IS NOT NULL;

-- The apps an APPS invitation grants, copied to app_grants when it is accepted.
CREATE TABLE invitation_grants (
  invitation_id TEXT NOT NULL REFERENCES invitations (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  app TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'EDITOR', 'VIEWER', 'CUSTOM')),
  custom_role_id TEXT,
  PRIMARY KEY (invitation_id, app),
  FOREIGN KEY (org_id, app, custom_role_id) REFERENCES custom_roles (org_id, app, id),
  CHECK ((role = 'CUSTOM') = (custom_role_id IS NOT NULL))
) STRICT;

CREATE INDEX invitation_grants_by_custom_role ON invitation_grants (custom_role_id) WHERE custom_role_id IS NOT NULL;

-- One kind of access or the other: app grants only for an APPS membership, and an organization role drops them.
CREATE TRIGGER app_grants_need_apps_member BEFORE INSERT ON app_grants WHEN (SELECT role FROM memberships WHERE org_id = NEW.org_id AND user_id = NEW.user_id) IS NOT 'APPS' BEGIN SELECT RAISE(ABORT, 'app grants need a specific-apps membership'); END;

CREATE TRIGGER app_grants_keep_apps_member BEFORE UPDATE ON app_grants WHEN (SELECT role FROM memberships WHERE org_id = NEW.org_id AND user_id = NEW.user_id) IS NOT 'APPS' BEGIN SELECT RAISE(ABORT, 'app grants need a specific-apps membership'); END;

CREATE TRIGGER memberships_org_role_drops_grants AFTER UPDATE OF role ON memberships WHEN NEW.role <> 'APPS' BEGIN DELETE FROM app_grants WHERE org_id = NEW.org_id AND user_id = NEW.user_id; END;
