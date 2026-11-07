import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

import * as core from '../src/d1-batch.ts';

test('D1 batch rejects a stale task and rolls back an outbox failure', async () => {
  assert.equal(typeof core.recordTaskTransition, 'function', 'D1 batch transition is not implemented');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    await db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, recipient_id TEXT NOT NULL, artifact_id TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE assertions (ok INTEGER NOT NULL CHECK (ok = 1));
CREATE TABLE events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, artifact_id TEXT NOT NULL);
CREATE TABLE outbox (id TEXT PRIMARY KEY, event_id TEXT NOT NULL);`);
    await db.prepare("INSERT INTO tasks VALUES ('task-1', 'tenant-1', 'ana', 'd0', 'ACTIVE')").run();
    const cmd = { tenantId: 'tenant-1', taskId: 'task-1', recipientId: 'ana', inputArtifactId: 'd0', eventId: 'event-1', outboxId: 'outbox-1' };
    for (const bad of [{ ...cmd, inputArtifactId: 'old' }, { ...cmd, recipientId: 'marcus' }, { ...cmd, tenantId: 'other' }]) {
      await assert.rejects(() => core.recordTaskTransition!(db, bad));
    }
    await db.prepare("INSERT INTO outbox VALUES ('outbox-1', 'existing')").run();
    await assert.rejects(() => core.recordTaskTransition!(db, cmd));
    assert.equal((await db.prepare('SELECT status FROM tasks').first())!.status, 'ACTIVE');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM events').first())!.n, 0);
    await db.prepare("DELETE FROM outbox WHERE id = 'outbox-1'").run();
    await core.recordTaskTransition!(db, cmd);
    await assert.rejects(() => core.recordTaskTransition!(db, cmd));
    assert.equal((await db.prepare('SELECT status FROM tasks').first())!.status, 'SIGNED');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM events').first())!.n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM outbox').first())!.n, 1);
    await db.prepare("INSERT INTO tasks VALUES ('task-2', 'tenant-1', 'ana', 'd0', 'ACTIVE')").run();
    const races = await Promise.allSettled([
      core.recordTaskTransition(db, { ...cmd, taskId: 'task-2', eventId: 'event-2', outboxId: 'outbox-2' }),
      core.recordTaskTransition(db, { ...cmd, taskId: 'task-2', eventId: 'event-3', outboxId: 'outbox-3' }),
    ]);
    assert.equal(races.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM events WHERE task_id = 'task-2'").first())!.n, 1);
  } finally { await mf.dispose(); }
});
