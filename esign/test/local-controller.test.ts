import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const controller = resolve('scripts/local-controller.mjs');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'controller-test-'));
  const log = join(dir, 'log');
  const script = join(dir, 'mock.mjs');
  writeFileSync(script, `import { appendFileSync, writeFileSync } from 'node:fs';\nconst [log, name, mode, ready] = process.argv.slice(2);\nappendFileSync(log, name + '\\n');\nif (ready) writeFileSync(ready, 'ready');\nif (mode === 'wait') setInterval(() => {}, 1000);\nif (mode === 'fail') process.exit(7);\nif (mode === 'crash') process.kill(process.pid, 'SIGKILL');\n`);
  const cmd = (name: string, mode = 'ok', ready = '') => [process.execPath, script, log, name, mode, ready];
  const config = { timeoutMs: 250, cleanupTimeoutMs: 1000, run: cmd('run'), disableIngress: cmd('disable'), rollback: cmd('rollback'), verify: cmd('verify') };
  const path = join(dir, 'config.json');
  const save = () => writeFileSync(path, JSON.stringify(config));
  const lines = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { dir, log, config, cmd, path, save, lines };
}
function sync(path: string) { return spawnSync(process.execPath, [controller, path], { encoding: 'utf8', timeout: 5000 }); }

test('success and command failures always disable, rollback and verify in order', () => {
  for (const failing of ['', 'run', 'disableIngress', 'rollback', 'verify'] as const) {
    const f = fixture();
    try {
      if (failing) f.config[failing] = f.cmd(failing, 'fail');
      f.save(); const result = sync(f.path);
      assert.equal(result.status, failing ? 1 : 0, result.stderr);
      assert.deepEqual(f.lines(), ['run', 'disable', 'rollback', 'verify'].map(x => x === 'disable' && failing === 'disableIngress' ? failing : x));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('spawn failure and timeout fail closed', () => {
  for (const mode of ['spawn', 'timeout', 'crash']) {
    const f = fixture();
    try {
      f.config.run = mode === 'spawn' ? [join(f.dir, 'missing')] : f.cmd('run', mode === 'timeout' ? 'wait' : 'crash');
      f.save(); const result = sync(f.path);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(f.lines(), mode === 'spawn' ? ['disable', 'rollback', 'verify'] : ['run', 'disable', 'rollback', 'verify']);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('cleanup timeout still attempts rollback and verification', () => {
  const f = fixture();
  try {
    f.config.cleanupTimeoutMs = 250; f.config.disableIngress = f.cmd('disable', 'wait'); f.save();
    const result = sync(f.path); assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(f.lines(), ['run', 'disable', 'rollback', 'verify']);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`${signal} triggers cleanup before exit`, async () => {
  const f = fixture();
  try {
    const ready = join(f.dir, 'ready'); f.config.run = f.cmd('run', 'wait', ready); f.config.timeoutMs = 10000; f.save();
    const child = spawn(process.execPath, [controller, f.path], { stdio: 'ignore' });
    const exit = new Promise<number | null>(resolve => child.on('exit', resolve));
    for (let i = 0; i < 200 && !existsSync(ready); i++) await delay(10);
    assert.ok(existsSync(ready), 'child did not start'); child.kill(signal);
    assert.equal(await exit, 1); assert.deepEqual(f.lines(), ['run', 'disable', 'rollback', 'verify']);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('invalid configuration is rejected without executing commands', () => {
  const f = fixture();
  try { f.config.timeoutMs = 0; f.save(); assert.equal(sync(f.path).status, 1); assert.deepEqual(f.lines(), []); }
  finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('cleanup spawn failure does not prevent rollback and verification', () => {
  const f = fixture();
  try {
    f.config.disableIngress = [join(f.dir, 'missing')]; f.save();
    assert.equal(sync(f.path).status, 1);
    assert.deepEqual(f.lines(), ['run', 'rollback', 'verify']);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('signal during cleanup does not interrupt cleanup', async () => {
  const f = fixture();
  try {
    const ready = join(f.dir, 'ready');
    const release = join(f.dir, 'release');
    const completed = join(f.dir, 'completed');
    const script = join(f.dir, 'cleanup.mjs');
    writeFileSync(script, `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const [log, ready, release, completed] = process.argv.slice(2);
appendFileSync(log, 'disable\\n');
writeFileSync(ready, 'ready');
const timer = setInterval(() => {
  if (existsSync(release)) {
    writeFileSync(completed, 'completed');
    clearInterval(timer);
  }
}, 10);
`);
    f.config.disableIngress = [process.execPath, script, f.log, ready, release, completed];
    f.config.cleanupTimeoutMs = 5000; f.save();
    const child = spawn(process.execPath, [controller, f.path], { stdio: ['ignore', 'ignore', 'pipe'] });
    const exit = new Promise<number | null>(resolve => child.on('exit', resolve));
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.includes('Received SIGTERM; initiating cleanup') && !existsSync(release)) writeFileSync(release, 'release');
    });
    for (let i = 0; i < 200 && !existsSync(ready); i++) await delay(10);
    assert.ok(existsSync(ready)); child.kill('SIGTERM');
    assert.equal(await exit, 1);
    assert.ok(existsSync(completed), 'cleanup did not complete after signal');
    assert.deepEqual(f.lines(), ['run', 'disable', 'rollback', 'verify']);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('each command terminates surviving process-group descendants before proceeding', async () => {
  for (const stage of ['run', 'disableIngress', 'rollback', 'verify'] as const) {
    const f = fixture();
    try {
      const script = join(f.dir, 'descendant.mjs');
      const marker = join(f.dir, 'late-action');
      const term = join(f.dir, 'term');
      writeFileSync(script, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'child') {
  process.on('SIGTERM', () => writeFileSync(process.argv[4], 'term'));
  setTimeout(() => writeFileSync(process.argv[3], 'late'), 1200);
  setInterval(() => {}, 1000);
  process.send('ready');
} else {
  const child = spawn(process.execPath, [process.argv[1], 'child', process.argv[3], process.argv[4]], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', () => process.exit(0));
}
`);
      f.config[stage] = [process.execPath, script, 'parent', marker, term];
      f.config.timeoutMs = 3000; f.save();
      const result = sync(f.path);
      assert.ok(result.status === 0 || (result.status === 1 && /process group.*(remaining|exist|terminat)/i.test(result.stderr)), result.stderr);
      assert.ok(existsSync(term), `${stage}: descendant did not receive SIGTERM`);
      await delay(1500);
      assert.equal(existsSync(marker), false, `${stage}: descendant survived to act`);
      const expected = ['run', 'disable', 'rollback', 'verify'].filter(name => name !== (stage === 'disableIngress' ? 'disable' : stage));
      assert.deepEqual(f.lines(), expected);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});
