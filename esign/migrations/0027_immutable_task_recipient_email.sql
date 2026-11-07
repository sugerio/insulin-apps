CREATE TRIGGER immutable_task_recipient_email
BEFORE UPDATE OF recipient_email ON tasks
WHEN NEW.recipient_email IS NOT OLD.recipient_email COLLATE BINARY
BEGIN
  SELECT RAISE(ABORT, 'task recipient email is immutable');
END;
