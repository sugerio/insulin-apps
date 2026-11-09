// Deploys the Worker to Cloudflare as esign-<target> (WORKER-MODE.md, "Deploy"). Nothing about the
// account or its resources is kept in this repository: the deployment's settings come from the
// environment, the D1 database id is looked up by name, and the Wrangler configuration is generated
// into .deploy/ for this run only. Secrets are never handled here; they stay on the Worker
// (`wrangler secret put --name esign-<target>`), and the deploy fails if one is missing.
//
//   node scripts/deploy.ts [--target dev] [--bundle dist] [--assets dist-ui] [--config-only] [--dry-run]
//
// The target decides the environment (ESIGN_ENV, src/environment.ts): `prod` deploys esign-prod in
// prod; any other target (`dev`) deploys in dev. dev binds the test mailbox bucket and pins the
// send_email binding to the sink; prod has no test mailbox, no sink, and mails recipients.
//
// --bundle deploys an already built bundle (dist/worker.js from `npm run build`) as is, which is how
// CI deploys what its unprivileged job built; without it Wrangler bundles src/worker.ts.
//
// Required environment: CLOUDFLARE_ACCOUNT_ID (and CLOUDFLARE_API_TOKEN outside an interactive
// login), ESIGN_MAIL_FROM, ESIGN_FRAME_ANCESTORS (https only in prod), ESIGN_KMS_KEY_ARN,
// ESIGN_KMS_PUBLIC_KEY, ESIGN_AWS_ROLE_ARN, and in dev ESIGN_MAIL_SINK.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameAncestors } from '../src/signing-page.ts';
import type { EsignEnvironment } from '../src/environment.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Secrets the deployed Worker needs; they are set on the Worker, never passed through here. A
 * deployed Worker seals with KMS and TSA, so it needs no TEST_SEAL_KEY.
 */
export const REQUIRED_SECRETS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'OTP_KEY'];

/** The environment a target deploys in: only `prod` is prod. */
export const environmentOfTarget = (target: string): EsignEnvironment => (target === 'prod' ? 'prod' : 'dev');

export type DeploySettings = {
  target: string;
  environment: EsignEnvironment;
  mailFrom: string;
  /** dev only: the one mailbox every message goes to. Empty in prod. */
  mailSink: string;
  frameAncestors: string;
  kmsKeyArn: string;
  kmsPublicKey: string;
  awsRoleArn: string;
};

const EMAIL = /^[^@\s]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const KMS_KEY_ARN = /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/;
const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The deployment's settings from the environment; throws naming every missing or invalid one (never its value). */
export function settingsFromEnv(env: Record<string, string | undefined>, target: string): DeploySettings {
  const read = (name: string) => (env[name] ?? '').trim();
  const problems: string[] = [];
  const check = (name: string, ok: (v: string) => boolean) => { const v = read(name); if (!v) problems.push(`${name} is not set`); else if (!ok(v)) problems.push(`${name} is invalid`); return v; };
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(target)) problems.push('the target must be a short lowercase name');
  const environment = environmentOfTarget(target), prod = environment === 'prod';
  if (prod && read('ESIGN_MAIL_SINK')) problems.push('ESIGN_MAIL_SINK must not be set for prod, which emails recipients');
  const settings = {
    target,
    environment,
    mailFrom: check('ESIGN_MAIL_FROM', v => EMAIL.test(v)),
    mailSink: prod ? '' : check('ESIGN_MAIL_SINK', v => EMAIL.test(v)),
    frameAncestors: check('ESIGN_FRAME_ANCESTORS', v => frameAncestors(v, prod).length === v.split(/\s+/).length),
    kmsKeyArn: check('ESIGN_KMS_KEY_ARN', v => KMS_KEY_ARN.test(v)),
    kmsPublicKey: check('ESIGN_KMS_PUBLIC_KEY', v => BASE64.test(v)),
    awsRoleArn: check('ESIGN_AWS_ROLE_ARN', v => ROLE_ARN.test(v)),
  };
  if (problems.length) throw new Error(`Deploy settings: ${problems.join('; ')}`);
  return settings;
}

/** wrangler.jsonc without its comments (a // or /* inside a string is kept). */
export function parseJsonc(text: string): Record<string, unknown> {
  let out = '', inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) throw new Error('Unterminated comment'); i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

/** Resource names of a target: one Worker, one D1 database and R2 buckets, all named after it (dev also has the test mailbox). */
export const resourceNames = (target: string) => ({
  worker: `esign-${target}`,
  database: `esign-${target}`,
  artifacts: `esign-${target}-artifacts`,
  testMail: `esign-${target}-test-mail`,
});

/** The Wrangler configuration of one deployment, from the repository's local configuration and the settings. */
export function deployConfig(base: Record<string, unknown>, s: DeploySettings, databaseId: string, paths: { bundle?: string; assets: string; migrations: string }) {
  const names = resourceNames(s.target), prod = s.environment === 'prod';
  const assets = base.assets as Record<string, unknown>;
  return {
    name: names.worker,
    main: paths.bundle ? join(paths.bundle, 'worker.js') : resolve(ROOT, String(base.main)),
    ...(paths.bundle ? { no_bundle: true } : {}),
    compatibility_date: base.compatibility_date,
    workers_dev: true,
    preview_urls: false,
    assets: { ...assets, directory: paths.assets },
    d1_databases: [{ binding: 'DB', database_name: names.database, database_id: databaseId, migrations_dir: paths.migrations }],
    r2_buckets: [
      { binding: 'ARTIFACTS', bucket_name: names.artifacts },
      // dev keeps every code in a test mailbox for tests to read; prod keeps none.
      ...(prod ? [] : [{ binding: 'TEST_MAIL', bucket_name: names.testMail }]),
    ],
    // dev: the binding itself can only ever send to the sink (src/otp-mail-sink.ts). prod: to recipients.
    send_email: [prod ? { name: 'SEND_EMAIL' } : { name: 'SEND_EMAIL', destination_address: s.mailSink }],
    vars: {
      ESIGN_ENV: s.environment,
      KMS_KEY_ARN: s.kmsKeyArn,
      KMS_PUBLIC_KEY: s.kmsPublicKey,
      AWS_ROLE_ARN: s.awsRoleArn,
      MAIL_FROM: s.mailFrom,
      ...(prod ? {} : { MAIL_SINK: s.mailSink }),
      COMPLETE_AFTER_SIGN: 'true',
      SIGNING_PAGE_FRAME_ANCESTORS: s.frameAncestors,
    },
    triggers: base.triggers,
    observability: { enabled: true },
  };
}

/** The id of the D1 database with this name, from `wrangler d1 list --json` output. */
export function databaseIdFrom(listJson: string, name: string): string {
  const list = JSON.parse(listJson) as { name?: unknown; uuid?: unknown }[];
  if (!Array.isArray(list)) throw new Error('Wrangler returned an unexpected database list');
  const found = list.filter(d => d.name === name);
  if (found.length !== 1 || typeof found[0].uuid !== 'string') throw new Error(`D1 database ${name} not found (create it once with: wrangler d1 create ${name})`);
  return found[0].uuid;
}

function parseArgs(argv: string[]) {
  const args = { target: 'dev', bundle: '', assets: '', configOnly: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' || a === '--bundle' || a === '--assets') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      args[a.slice(2) as 'target' | 'bundle' | 'assets'] = v;
    } else if (a === '--config-only') args.configOnly = true;
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = settingsFromEnv(process.env, args.target);
  if (!/^[0-9a-f]{32}$/.test((process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim())) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set or invalid');
  const wrangler = (wranglerArgs: string[], capture = false) =>
    execFileSync(join(ROOT, 'node_modules', '.bin', 'wrangler'), wranglerArgs, { cwd: ROOT, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  const names = resourceNames(settings.target);
  const databaseId = databaseIdFrom(wrangler(['d1', 'list', '--json'], true), names.database);
  const base = parseJsonc(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'));
  const config = deployConfig(base, settings, databaseId, {
    bundle: args.bundle ? resolve(args.bundle) : undefined,
    assets: resolve(args.assets || join(ROOT, 'dist-ui')),
    migrations: join(ROOT, 'migrations'),
  });
  mkdirSync(join(ROOT, '.deploy'), { recursive: true });
  const configFile = join(ROOT, '.deploy', `wrangler.${settings.target}.json`);
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  console.log(`Wrangler configuration for ${names.worker} written to .deploy/`);
  if (args.configOnly) return;
  if (args.dryRun) { wrangler(['deploy', '--dry-run', '--config', configFile]); return; }
  const secrets = (JSON.parse(wrangler(['secret', 'list', '--name', names.worker, '--format', 'json'], true)) as { name: string }[]).map(s => s.name);
  const missing = REQUIRED_SECRETS.filter(n => !secrets.includes(n));
  if (missing.length) throw new Error(`Set these secrets on ${names.worker} first (wrangler secret put <name> --name ${names.worker}): ${missing.join(', ')}`);
  wrangler(['d1', 'migrations', 'apply', names.database, '--remote', '--config', configFile]);
  wrangler(['deploy', '--config', configFile]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
