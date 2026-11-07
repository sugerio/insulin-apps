INSERT OR IGNORE INTO tenants (id) VALUES ('local-test-tenant');
INSERT OR IGNORE INTO api_keys (key_hash,tenant_id) VALUES ('f7d524df9c3a709327d8c5fc116d00d79041242d62ee15d8342f17d967800e6d','local-test-tenant');
INSERT OR IGNORE INTO tenant_page_origins (tenant_id,origin) VALUES ('local-test-tenant','http://127.0.0.1:5173');
