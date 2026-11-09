import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { databaseIdFrom, deployConfig, environmentOfTarget, parseJsonc, REQUIRED_SECRETS, resourceNames, settingsFromEnv } from '../scripts/deploy.ts';

const ENV = {
  ESIGN_MAIL_FROM: 'sign@sender.example',
  ESIGN_MAIL_SINK: 'inbox@sink.example',
  ESIGN_FRAME_ANCESTORS: 'https://console.example http://localhost:3000',
  ESIGN_KMS_KEY_ARN: 'arn:aws:kms:us-west-2:000000000000:key/00000000-0000-4000-8000-000000000000',
  ESIGN_KMS_PUBLIC_KEY: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
  ESIGN_AWS_ROLE_ARN: 'arn:aws:iam::000000000000:role/esign-example-signer',
};

test('deploy settings come from the environment, and every missing or invalid one is named without its value', () => {
  assert.equal(settingsFromEnv(ENV, 'dev').mailSink, 'inbox@sink.example');
  assert.throws(() => settingsFromEnv({ ...ENV, ESIGN_MAIL_SINK: '', ESIGN_AWS_ROLE_ARN: 'not-an-arn' }, 'dev'), (e: Error) =>
    /ESIGN_MAIL_SINK is not set/.test(e.message) && /ESIGN_AWS_ROLE_ARN is invalid/.test(e.message) && !e.message.includes('not-an-arn'));
  assert.throws(() => settingsFromEnv({ ...ENV, ESIGN_FRAME_ANCESTORS: 'http://console.example' }, 'dev'), /ESIGN_FRAME_ANCESTORS is invalid/);
  assert.throws(() => settingsFromEnv(ENV, 'Dev Env'), /target/);
});

test('the generated configuration names every resource after the target and keeps nothing account-specific from the repository', () => {
  const base = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal((base.vars as Record<string, string>).SIGNING_PAGE_FRAME_ANCESTORS, 'http://localhost:3000', 'a // inside a string survives');
  assert.equal(base.env, undefined, 'no deployment is described in the repository');
  const config = deployConfig(base, settingsFromEnv(ENV, 'dev'), 'db-uuid', { bundle: '/b', assets: '/a', migrations: '/m' });
  assert.equal(config.name, 'esign-dev');
  assert.equal(config.main, '/b/worker.js');
  assert.equal(config.no_bundle, true);
  assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: 'esign-dev', database_id: 'db-uuid', migrations_dir: '/m' }]);
  assert.deepEqual(config.r2_buckets.map(b => b.bucket_name), ['esign-dev-artifacts', 'esign-dev-test-mail']);
  assert.deepEqual(config.send_email, [{ name: 'SEND_EMAIL', destination_address: 'inbox@sink.example' }]);
  assert.equal(config.vars.MAIL_SINK, 'inbox@sink.example');
  assert.equal(config.vars.ESIGN_ENV, 'dev');
  assert.equal('LOCAL_TEST_MODE' in config.vars, false);
  assert.deepEqual(config.assets, { directory: '/a', binding: 'ASSETS', run_worker_first: true });
  assert.deepEqual(config.triggers, { crons: ['*/5 * * * *'] });
  assert.equal('account_id' in config, false);
  assert.equal(deployConfig(base, settingsFromEnv(ENV, 'dev'), 'db-uuid', { assets: '/a', migrations: '/m' }).no_bundle, undefined);
});

test('prod is the prod target only: no test mailbox, no sink, mail to recipients, https framing', () => {
  assert.equal(environmentOfTarget('prod'), 'prod');
  assert.equal(environmentOfTarget('dev'), 'dev');
  assert.equal(environmentOfTarget('staging'), 'dev');
  const { ESIGN_MAIL_SINK: _sink, ...prodEnv } = { ...ENV, ESIGN_FRAME_ANCESTORS: 'https://console.example' };
  const settings = settingsFromEnv(prodEnv, 'prod');
  assert.equal(settings.environment, 'prod');
  assert.equal(settings.mailSink, '');
  // A sink, or http framing even on a loopback host, is refused for prod.
  assert.throws(() => settingsFromEnv({ ...prodEnv, ESIGN_MAIL_SINK: 'inbox@sink.example' }, 'prod'), /ESIGN_MAIL_SINK must not be set/);
  assert.throws(() => settingsFromEnv({ ...prodEnv, ESIGN_FRAME_ANCESTORS: 'https://console.example http://localhost:3000' }, 'prod'), /ESIGN_FRAME_ANCESTORS is invalid/);
  const base = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const config = deployConfig(base, settings, 'db-uuid', { assets: '/a', migrations: '/m' });
  assert.equal(config.name, 'esign-prod');
  assert.deepEqual(config.r2_buckets.map(b => b.bucket_name), ['esign-prod-artifacts']);
  assert.deepEqual(config.send_email, [{ name: 'SEND_EMAIL' }]);
  assert.equal(config.vars.ESIGN_ENV, 'prod');
  assert.equal('MAIL_SINK' in config.vars, false);
  assert.equal(config.vars.MAIL_FROM, 'sign@sender.example');
  // Deployed Workers seal with KMS and TSA, so neither needs the HMAC test seal's key.
  assert.deepEqual(REQUIRED_SECRETS, ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'OTP_KEY']);
});

test('the D1 database is found by its exact name', () => {
  const list = JSON.stringify([{ name: 'esign-dev-old', uuid: 'x' }, { name: 'esign-dev', uuid: 'y' }]);
  assert.equal(databaseIdFrom(list, resourceNames('dev').database), 'y');
  assert.throws(() => databaseIdFrom('[]', 'esign-dev'), /not found/);
});
