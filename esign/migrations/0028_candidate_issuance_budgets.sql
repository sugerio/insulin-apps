CREATE INDEX candidate_codes_expiry ON recipient_page_codes(expires_at);
CREATE INDEX candidate_codes_tenant_expiry ON recipient_page_codes(tenant_id, expires_at);
