CREATE TABLE synthetic_tsa_test_reservations (
 envelope_id TEXT PRIMARY KEY NOT NULL REFERENCES envelopes(id),
 object_key TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL
);
CREATE TRIGGER synthetic_tsa_test_reservations_no_update BEFORE UPDATE ON synthetic_tsa_test_reservations BEGIN SELECT RAISE(ABORT, 'immutable synthetic reservation'); END;
CREATE TRIGGER synthetic_tsa_test_reservations_no_delete BEFORE DELETE ON synthetic_tsa_test_reservations BEGIN SELECT RAISE(ABORT, 'immutable synthetic reservation'); END;
