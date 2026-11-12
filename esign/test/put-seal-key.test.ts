// scripts/put-seal-key.mjs against a stand-in Cloudflare API (its global fetch replaced before it runs): it prints the
// keys.ts entry, never the private key, and prints it too when it can't confirm whether the key reached the Worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// mode: ok | list-fails | put-lost | put-refused | other-type. The PUT's body is saved to STUB_OUT for the test to read.
const stub = `data:text/javascript,${encodeURIComponent(`
import { writeFileSync } from 'node:fs';
const mode = process.env.STUB_MODE;
globalThis.fetch = async (url, init = {}) => {
  if ((init.method ?? 'GET') === 'PUT') {
    writeFileSync(process.env.STUB_OUT, String(init.body));
    if (mode === 'put-lost') throw new TypeError('fetch failed');
    if (mode === 'put-refused') return Response.json({ errors: [{ message: 'forbidden' }] }, { status: 403 });
    return Response.json({ success: true });
  }
  if (mode === 'list-fails') return Response.json({ errors: [{ message: 'unavailable' }] }, { status: 500 });
  return Response.json({ result: [{ name: 'ESIGN_SEAL_KEY', type: mode === 'other-type' ? 'secret_text' : 'secret_key' }] });
};`)}`;

async function run(mode: string) {
  const dir = await mkdtemp(join(tmpdir(), 'put-seal-key-'));
  try {
    const out = join(dir, 'put.json');
    const r = spawnSync(process.execPath, ['--import', stub, 'scripts/put-seal-key.mjs', '--worker', 'esign-synthetic'], {
      encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: 'synthetic-account', CLOUDFLARE_API_TOKEN: 'synthetic-token', STUB_MODE: mode, STUB_OUT: out },
    });
    const put = await readFile(out, 'utf8').then(JSON.parse).catch(() => null);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, put };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const entryOf = (stdout: string) => { try { return JSON.parse(stdout) as { id: string; spki: string; from: string }; } catch { return null; } };

test('put-seal-key prints the keys.ts entry, and never the private key', async () => {
  const r = await run('ok');
  assert.equal(r.status, 0, r.stderr);
  const entry = entryOf(r.stdout);
  assert.ok(entry && /^[0-9a-f]{64}$/.test(entry.id) && entry.spki && !Number.isNaN(Date.parse(entry.from)), r.stdout);
  assert.equal(r.put.type, 'secret_key');
  assert.ok(!(r.stdout + r.stderr).includes(r.put.key_base64), 'the private key is never printed');
});

test('put-seal-key prints the entry too when it can\'t confirm the key reached the Worker, and nothing when it surely didn\'t', async () => {
  for (const mode of ['list-fails', 'put-lost']) {
    const r = await run(mode);
    assert.equal(r.status, 1, `${mode}: ${r.stderr}`);
    assert.ok(entryOf(r.stdout)?.id, `${mode}: the public entry is printed, so the key that may now seal isn't lost: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /secret_key/, mode);
    assert.ok(!(r.stdout + r.stderr).includes(r.put.key_base64), `${mode}: the private key is never printed`);
  }
  for (const mode of ['put-refused', 'other-type']) {
    const r = await run(mode);
    assert.equal(r.status, 1, mode);
    assert.equal(entryOf(r.stdout), null, `${mode}: no entry for a key that can't seal`);
  }
});
