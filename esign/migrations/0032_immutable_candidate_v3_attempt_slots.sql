-- Reservations are evidence and cannot be recycled or rewritten.
CREATE TRIGGER candidate_v3_attempt_slots_no_update
BEFORE UPDATE ON candidate_v3_attempt_slots
BEGIN
  SELECT RAISE(ABORT, 'candidate attempt reservations are immutable');
END;

CREATE TRIGGER candidate_v3_attempt_slots_no_delete
BEFORE DELETE ON candidate_v3_attempt_slots
BEGIN
  SELECT RAISE(ABORT, 'candidate attempt reservations are immutable');
END;
