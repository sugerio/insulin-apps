-- Owner domains (.github/hosting/DESIGN.md §3.1), for the gateway that counts an organization against its creator's
-- registrable domain, its subdomains included (src/owner-domain.ts), and writes a Gmail address in one form.

-- Organizations without an owner domain get one: their creator's, or, when that account is gone, that of their
-- earliest current OWNER. This covers organizations whose creator was gone at 0007, and those the Worker from before
-- 0007 created while that deploy rolled out. The rules are 0007's: addresses are stored lower case already; at a public
-- mail provider (0007's list) the address without its +tag, else its whole domain, which the gateway counts with its
-- registrable domain; SQL can't write punycode, so a non-ASCII domain stays as typed, and the gateway counts that form
-- too. An organization without either keeps NULL, which counts for nobody.
UPDATE orgs SET owner_domain = CASE
    WHEN substr(f.email, instr(f.email, '@') + 1) IN (
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
      'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net',
      'mail.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'zoho.com', 'fastmail.com', 'hey.com',
      'tutanota.com'
    ) THEN CASE
      WHEN instr(substr(f.email, 1, instr(f.email, '@') - 1), '+') > 1
        THEN substr(f.email, 1, instr(f.email, '+') - 1) || substr(f.email, instr(f.email, '@'))
      ELSE f.email
    END
    ELSE substr(f.email, instr(f.email, '@') + 1)
  END
FROM (
  SELECT o.id, COALESCE(
    (SELECT lower(u.email) FROM users u WHERE u.id = o.created_by),
    (SELECT lower(u.email) FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = o.id AND m.role = 'OWNER' ORDER BY m.created_at, m.user_id LIMIT 1)
  ) AS email
  FROM orgs o WHERE o.owner_domain IS NULL
) AS f
WHERE orgs.id = f.id AND f.email IS NOT NULL;

-- Gmail ignores dots in an address and answers at googlemail.com too, so one person's Gmail owner domain is their
-- address without dots at gmail.com, as the gateway now writes it. Allowances given to a Gmail address follow, unless
-- one for the new form exists already.
UPDATE orgs SET owner_domain = replace(substr(owner_domain, 1, instr(owner_domain, '@') - 1), '.', '') || '@' || 'gmail.com'
WHERE instr(owner_domain, '@') > 0 AND substr(owner_domain, instr(owner_domain, '@') + 1) IN ('gmail.com', 'googlemail.com');

UPDATE OR IGNORE org_domain_allowances
SET owner_domain = replace(substr(owner_domain, 1, instr(owner_domain, '@') - 1), '.', '') || '@' || 'gmail.com'
WHERE instr(owner_domain, '@') > 0 AND substr(owner_domain, instr(owner_domain, '@') + 1) IN ('gmail.com', 'googlemail.com');

-- Requests for more organizations are also limited per owner domain: the mail log notes a request's owner domain, as a
-- SHA-256 like the recipient's address (it can be an address).
ALTER TABLE mail_log ADD COLUMN owner_domain_hash TEXT;

CREATE INDEX mail_log_by_owner_domain ON mail_log (owner_domain_hash, created_at) WHERE owner_domain_hash IS NOT NULL;
