CREATE TABLE internal_demo_recipient_bindings (
  token_hash TEXT PRIMARY KEY NOT NULL REFERENCES recipient_page_sessions(token_hash),
  subject TEXT NOT NULL,
  email TEXT NOT NULL
);
