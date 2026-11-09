CREATE TABLE editor_allowed_origins (tenant_id TEXT NOT NULL REFERENCES tenants(id), origin TEXT NOT NULL, PRIMARY KEY (tenant_id, origin));
