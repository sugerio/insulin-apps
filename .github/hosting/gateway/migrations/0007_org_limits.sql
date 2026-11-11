-- Organization limits (.github/hosting/DESIGN.md §3 and §3.1): an owner may invite only people in the organization's
-- verified e-mail domains, and each owner domain may have only so many organizations.

-- 1 while invitations, and their acceptance, are limited to addresses in the organization's verified domains (§3).
ALTER TABLE orgs ADD COLUMN invite_verified_domains_only INTEGER NOT NULL DEFAULT 0;

-- The domain of the creator's address, lower case and in punycode; for an address at a public mail provider
-- (gmail.com and the like), the address itself without a +tag, so each person there counts on their own. NULL counts
-- for nobody. Each owner domain may have at most two organizations, or what org_domain_allowances says (§3.1).
ALTER TABLE orgs ADD COLUMN owner_domain TEXT;

CREATE INDEX orgs_by_owner_domain ON orgs (owner_domain) WHERE owner_domain IS NOT NULL;

-- Exceptions an operator grants (.github/hosting/scripts/allow-orgs.mjs): how many organizations an owner domain may
-- have instead of the default.
CREATE TABLE org_domain_allowances (
  owner_domain TEXT PRIMARY KEY,
  max_orgs INTEGER NOT NULL CHECK (max_orgs BETWEEN 0 AND 1000),
  note TEXT,
  created_at INTEGER NOT NULL
) STRICT;

-- Requests for more organizations are limited per person, so the mail log notes who sent one.
ALTER TABLE mail_log ADD COLUMN user_id TEXT;

CREATE INDEX mail_log_by_user ON mail_log (user_id, kind, created_at) WHERE user_id IS NOT NULL;

-- Existing organizations get their creator's owner domain. Addresses are stored lower case already; SQL can't write
-- punycode, so a creator's non-ASCII domain stays as typed, and the gateway counts that form too (db/orgs.ts). The
-- providers are the list in src/db/sso.ts (SHARED_DOMAINS) as it is today. An organization whose creator's account is
-- gone keeps NULL.
UPDATE orgs SET owner_domain = (SELECT lower(u.email) FROM users u WHERE u.id = orgs.created_by) WHERE created_by IS NOT NULL;

UPDATE orgs SET owner_domain = CASE
    WHEN substr(owner_domain, instr(owner_domain, '@') + 1) IN (
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
      'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net',
      'mail.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'zoho.com', 'fastmail.com', 'hey.com',
      'tutanota.com'
    ) THEN CASE
      WHEN instr(substr(owner_domain, 1, instr(owner_domain, '@') - 1), '+') > 1
        THEN substr(owner_domain, 1, instr(owner_domain, '+') - 1) || substr(owner_domain, instr(owner_domain, '@'))
      ELSE owner_domain
    END
    ELSE substr(owner_domain, instr(owner_domain, '@') + 1)
  END
WHERE owner_domain IS NOT NULL;
