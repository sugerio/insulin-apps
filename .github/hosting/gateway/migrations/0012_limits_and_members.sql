-- App limits, where each app is used, and member events (.github/hosting/DESIGN.md §8.8, §8.9). Console admins set
-- an app's limits for everyone or for one organization, and the app reads them on its tick (GET /__insulin/limits).
-- Apps that let people share their records keep in step with who is still a member through GET
-- /__insulin/member-events, written here by triggers in the same transaction as each change they record, whichever
-- way it is made (a page, an invitation, single sign-on, SCIM, a domain's removal, an account's deletion, the
-- console). Triggers are written on one line each (the test harness splits statements at a semicolon that ends a line).

-- An app's limit catalog (its package.json insulin.limits), written by the deploy for the app version in production.
CREATE TABLE app_limit_catalog (
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('count', 'bytes', 'hours', 'days')),
  default_value INTEGER NOT NULL CHECK (default_value >= 0),
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app, key)
) STRICT;

-- The increasing number that stamps every change of a default or of an organization's overrides.
CREATE TABLE app_limit_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL
) STRICT;

INSERT INTO app_limit_sequence (id, seq) VALUES (1, 0);

-- A default the console's admins put in place of the catalog's: a number, or NULL for unlimited.
CREATE TABLE app_limit_defaults (
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER CHECK (value IS NULL OR value >= 0),
  reason TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (app, key)
) STRICT;

-- One organization's override of a limit: a number or NULL for unlimited, until an optional time, after which the
-- default applies again.
CREATE TABLE org_app_limits (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER CHECK (value IS NULL OR value >= 0),
  until INTEGER,
  reason TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (org_id, app, key)
) STRICT;

-- The latest change of each organization's overrides in an app, removals included, so an app asking for the changes
-- after its cursor gets that organization with all its current overrides (none, after the last is removed).
CREATE TABLE org_app_limit_changes (
  app TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  PRIMARY KEY (app, org_id)
) STRICT;

CREATE INDEX org_app_limit_changes_by_seq ON org_app_limit_changes (app, seq);

-- Where each app is used: written at the gateway's first request to the app for the organization (a page, an AI agent
-- or an API client). The limits, members and member events an app reads are only those of these organizations.
CREATE TABLE app_orgs (
  app TEXT NOT NULL,
  org_id TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (app, org_id)
) STRICT;

CREATE INDEX app_orgs_by_org ON app_orgs (org_id);

-- Where each app was used before this migration, so that its endpoints answer for those organizations from the start,
-- before anyone opens the app there again: an app acts for some of them without a request (Esign's scheduled sends
-- check whoever scheduled them with member status). Only from the app's own traces of use there, stored before this
-- migration: its usage reports for the organization (§8.6, the daily rows kept 400 days and the hourly) and its mail
-- through the relay (`app:<app>`). The app had no reason to name an organization it didn't serve in them, since they
-- admitted nothing then; a report after it admits nothing either (an app's token alone can name any organization).
-- Configuration alone is no use (an API client, an AI agent's grant, a stored credential or a specific-apps grant can
-- exist where the app was never opened). An organization whose first use of the app came after the app's last report
-- before this migration (under an hour: the release deploys apps before the gateway) is recorded at its next request
-- to the app, as a new one is (DESIGN.md §8.9). Never an organization that no longer exists; the app-wide report rows
-- (`''`) are no organization. `first_at` is the earliest trace.
INSERT INTO app_orgs (app, org_id, first_at) SELECT r.app, r.org_id, MIN(r.hour) FROM app_metrics_daily r JOIN orgs o ON o.id = r.org_id WHERE r.app <> '' GROUP BY r.app, r.org_id ON CONFLICT (app, org_id) DO UPDATE SET first_at = MIN(first_at, excluded.first_at);
INSERT INTO app_orgs (app, org_id, first_at) SELECT r.app, r.org_id, MIN(r.hour) FROM app_metrics_hourly r JOIN orgs o ON o.id = r.org_id WHERE r.app <> '' GROUP BY r.app, r.org_id ON CONFLICT (app, org_id) DO UPDATE SET first_at = MIN(first_at, excluded.first_at);
INSERT INTO app_orgs (app, org_id, first_at) SELECT substr(m.kind, 5), m.org_id, MIN(m.created_at) FROM mail_log m JOIN orgs o ON o.id = m.org_id WHERE m.kind LIKE 'app:_%' GROUP BY substr(m.kind, 5), m.org_id ON CONFLICT (app, org_id) DO UPDATE SET first_at = MIN(first_at, excluded.first_at);

-- An organization that starts using an app gets its overrides there at the app's next read, even if they were set
-- before (and the app's cursor has passed their change).
CREATE TRIGGER app_orgs_first_use_sends_limits AFTER INSERT ON app_orgs WHEN EXISTS (SELECT 1 FROM org_app_limits l WHERE l.org_id = NEW.org_id AND l.app = NEW.app) BEGIN UPDATE app_limit_sequence SET seq = seq + 1 WHERE id = 1; INSERT INTO org_app_limit_changes (app, org_id, seq) VALUES (NEW.app, NEW.org_id, (SELECT seq FROM app_limit_sequence WHERE id = 1)) ON CONFLICT (app, org_id) DO UPDATE SET seq = excluded.seq; END;

-- Who joined, left or changed, for one app ('*': every app) of one organization. `subject` is the person or API client
-- it is about. `payload` is what GET /__insulin/member-events turns into each app's view (gateway src/db/members.ts):
-- the roles after the change and, for a move between an organization role and specific apps, which apps the person had
-- before or has after. `at` is the database's clock in epoch milliseconds. Kept 90 days (housekeeping).
CREATE TABLE member_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('left', 'returned', 'role_changed', 'owners', 'client_revoked', 'org_deleted')),
  subject TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  at INTEGER NOT NULL
) STRICT;

CREATE INDEX member_events_by_at ON member_events (at);
CREATE INDEX member_events_by_subject ON member_events (org_id, subject, id);

-- A move from an organization role to specific apps, open for the length of the batch that makes it: the grants that
-- batch writes join the move's event (below), and the batch closes it before it commits (db/orgs.ts setAppAccess, the
-- only statement that moves a member to specific apps). A grant joins only a move of its own batch (the membership was
-- changed at the grant's time, both from the batch's clock), so a move left open by the gateway before this
-- migration's code ran, or by anything else, is ignored and deleted by the next grant, and by the cleanup.
CREATE TABLE member_event_moves (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
) STRICT;

-- The highest event id the cleanup has deleted: a cursor below it may have missed events, and gets 410.
CREATE TABLE member_events_pruned (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  through INTEGER NOT NULL
) STRICT;

INSERT INTO member_events_pruned (id, through) VALUES (1, 0);

-- Joining with an organization role gives every app; a specific-apps member gets each app with its grant (below).
CREATE TRIGGER memberships_insert_event AFTER INSERT ON memberships BEGIN INSERT INTO member_events (app, org_id, type, subject, payload, at) SELECT '*', NEW.org_id, 'returned', NEW.user_id, json_object('orgRole', NEW.role), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE NEW.role <> 'APPS'; INSERT INTO member_events (app, org_id, type, subject, payload, at) SELECT '*', NEW.org_id, 'owners', NULL, json_object('owners', json((SELECT json_group_array(json_object('user', o.user_id, 'since', o.updated_at)) FROM (SELECT user_id, updated_at FROM memberships WHERE org_id = NEW.org_id AND role = 'OWNER' ORDER BY updated_at, user_id) o))), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE NEW.role = 'OWNER'; END;

-- Leaving, being removed, or the account's deletion. Not when the organization itself goes (one org_deleted says it).
-- A specific-apps member's apps each say so as their grants go.
CREATE TRIGGER memberships_delete_event AFTER DELETE ON memberships WHEN EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id) BEGIN INSERT INTO member_events (app, org_id, type, subject, payload, at) SELECT '*', OLD.org_id, 'left', OLD.user_id, '{}', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE OLD.role <> 'APPS'; INSERT INTO member_events (app, org_id, type, subject, payload, at) SELECT '*', OLD.org_id, 'owners', NULL, json_object('owners', json((SELECT json_group_array(json_object('user', o.user_id, 'since', o.updated_at)) FROM (SELECT user_id, updated_at FROM memberships WHERE org_id = OLD.org_id AND role = 'OWNER' ORDER BY updated_at, user_id) o))), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE OLD.role = 'OWNER'; END;

-- A new organization role, written before the row changes so the apps a specific-apps member had are still there to
-- record (the role change drops them). A move to specific apps opens the move, which its batch's grants join.
CREATE TRIGGER memberships_role_event BEFORE UPDATE OF role ON memberships WHEN OLD.role <> NEW.role BEGIN DELETE FROM member_event_moves WHERE org_id = NEW.org_id AND user_id = NEW.user_id; INSERT INTO member_events (app, org_id, type, subject, payload, at) VALUES ('*', NEW.org_id, 'role_changed', NEW.user_id, json_object('orgRole', NEW.role, 'from', OLD.role, 'grantsBefore', json((SELECT json_group_array(g.app) FROM app_grants g WHERE g.org_id = OLD.org_id AND g.user_id = OLD.user_id)), 'grantsAfter', json('{}')), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); INSERT INTO member_event_moves (org_id, user_id, event_id) SELECT NEW.org_id, NEW.user_id, (SELECT MAX(id) FROM member_events) WHERE NEW.role = 'APPS'; END;

CREATE TRIGGER memberships_role_owners_event AFTER UPDATE OF role ON memberships WHEN OLD.role <> NEW.role AND (OLD.role = 'OWNER' OR NEW.role = 'OWNER') BEGIN INSERT INTO member_events (app, org_id, type, subject, payload, at) SELECT '*', NEW.org_id, 'owners', NULL, json_object('owners', json((SELECT json_group_array(json_object('user', o.user_id, 'since', o.updated_at)) FROM (SELECT user_id, updated_at FROM memberships WHERE org_id = NEW.org_id AND role = 'OWNER' ORDER BY updated_at, user_id) o))), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER); END;

-- A grant gives a specific-apps member one app; in the batch that moved them from an organization role (its open move,
-- with the membership changed at the grant's time), it joins that move's event instead, so the app sees one change and
-- no false departure. Any other open move of theirs is stale: the grant is an event of its own and the move goes.
CREATE TRIGGER app_grants_insert_event AFTER INSERT ON app_grants BEGIN UPDATE member_events SET payload = json_set(payload, '$.grantsAfter."' || NEW.app || '"', json_object('role', NEW.role, 'permissions', json((SELECT c.permissions FROM custom_roles c WHERE c.id = NEW.custom_role_id)))) WHERE id = (SELECT m.event_id FROM member_event_moves m JOIN memberships ms ON ms.org_id = m.org_id AND ms.user_id = m.user_id WHERE m.org_id = NEW.org_id AND m.user_id = NEW.user_id AND ms.updated_at = NEW.created_at); INSERT INTO member_events (app, org_id, type, subject, payload, at) SELECT NEW.app, NEW.org_id, 'returned', NEW.user_id, json_object('role', NEW.role, 'permissions', json((SELECT c.permissions FROM custom_roles c WHERE c.id = NEW.custom_role_id))), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE NOT EXISTS (SELECT 1 FROM member_event_moves m JOIN memberships ms ON ms.org_id = m.org_id AND ms.user_id = m.user_id WHERE m.org_id = NEW.org_id AND m.user_id = NEW.user_id AND ms.updated_at = NEW.created_at); DELETE FROM member_event_moves WHERE org_id = NEW.org_id AND user_id = NEW.user_id AND NOT EXISTS (SELECT 1 FROM memberships ms WHERE ms.org_id = NEW.org_id AND ms.user_id = NEW.user_id AND ms.updated_at = NEW.created_at); END;

CREATE TRIGGER app_grants_update_event AFTER UPDATE ON app_grants WHEN OLD.role IS NOT NEW.role OR OLD.custom_role_id IS NOT NEW.custom_role_id BEGIN INSERT INTO member_events (app, org_id, type, subject, payload, at) VALUES (NEW.app, NEW.org_id, 'role_changed', NEW.user_id, json_object('role', NEW.role, 'permissions', json((SELECT c.permissions FROM custom_roles c WHERE c.id = NEW.custom_role_id))), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- An app taken away from a specific-apps member (or their membership, or account, going with it). Not when an
-- organization role replaces their grants (the role event says so), nor when the organization goes.
CREATE TRIGGER app_grants_delete_event AFTER DELETE ON app_grants WHEN EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id) AND COALESCE((SELECT m.role FROM memberships m WHERE m.org_id = OLD.org_id AND m.user_id = OLD.user_id), 'APPS') = 'APPS' BEGIN INSERT INTO member_events (app, org_id, type, subject, payload, at) VALUES (OLD.app, OLD.org_id, 'left', OLD.user_id, '{}', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- A custom role's new permissions change the role of everyone who has it.
CREATE TRIGGER custom_roles_permissions_event AFTER UPDATE OF permissions ON custom_roles WHEN OLD.permissions IS NOT NEW.permissions BEGIN INSERT INTO member_events (app, org_id, type, subject, payload, at) SELECT NEW.app, g.org_id, 'role_changed', g.user_id, json_object('role', 'CUSTOM', 'permissions', json(NEW.permissions)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM app_grants g WHERE g.custom_role_id = NEW.id; END;

-- An API client revoked (on its own, or with its organization disabled) or deleted while live.
CREATE TRIGGER service_accounts_revoke_event AFTER UPDATE OF revoked_at ON service_accounts WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN INSERT INTO member_events (app, org_id, type, subject, payload, at) VALUES (NEW.app, NEW.org_id, 'client_revoked', NEW.id, '{}', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

CREATE TRIGGER service_accounts_delete_event AFTER DELETE ON service_accounts WHEN OLD.revoked_at IS NULL AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id) BEGIN INSERT INTO member_events (app, org_id, type, subject, payload, at) VALUES (OLD.app, OLD.org_id, 'client_revoked', OLD.id, '{}', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)); END;

-- A deleted organization: one event for each app it used, which then forgets it.
CREATE TRIGGER orgs_delete_event AFTER DELETE ON orgs BEGIN INSERT INTO member_events (app, org_id, type, subject, payload, at) SELECT a.app, OLD.id, 'org_deleted', NULL, '{}', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM app_orgs a WHERE a.org_id = OLD.id; DELETE FROM app_orgs WHERE org_id = OLD.id; END;
