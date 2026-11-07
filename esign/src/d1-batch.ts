/** D1 transaction experiment only: this is not an authorization or signing API. */
type Statement = { bind(...values: string[]): Statement };
type Database = { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown> };
type Command = { tenantId: string; taskId: string; recipientId: string; inputArtifactId: string; eventId: string; outboxId: string };

export async function recordTaskTransition(db: Database, cmd: Command): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO assertions (ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM tasks WHERE id = ? AND tenant_id = ? AND recipient_id = ? AND artifact_id = ? AND status = 'ACTIVE') THEN 1 ELSE 0 END")
      .bind(cmd.taskId, cmd.tenantId, cmd.recipientId, cmd.inputArtifactId),
    db.prepare("UPDATE tasks SET status = 'SIGNED' WHERE id = ? AND tenant_id = ? AND recipient_id = ? AND artifact_id = ? AND status = 'ACTIVE'")
      .bind(cmd.taskId, cmd.tenantId, cmd.recipientId, cmd.inputArtifactId),
    db.prepare('INSERT INTO events (id, task_id, artifact_id) VALUES (?, ?, ?)').bind(cmd.eventId, cmd.taskId, cmd.inputArtifactId),
    db.prepare('INSERT INTO outbox (id, event_id) VALUES (?, ?)').bind(cmd.outboxId, cmd.eventId),
    db.prepare('DELETE FROM assertions'),
  ]);
}
