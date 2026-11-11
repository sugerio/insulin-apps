/**
 * dev or prod. Published, Esign is `prod`; the local preview (`import.meta.env.DEV`, see
 * src/app/server/router.ts) is `dev`. The router derives ESIGN_ENV from that; nothing configures it.
 *
 * |                          | dev (local preview)                               | prod (published)              |
 * |--------------------------|---------------------------------------------------|-------------------------------|
 * | Codes and notices        | kept in the preview's test mailbox; emailed only  | emailed through the mail relay |
 * |                          | if a mail relay is configured                     |                               |
 * | Test mailbox (TEST_MAIL) | every code is kept there for tests to read        | none                          |
 * | Seal                     | KMS + TSA when configured, else the HMAC test     | KMS + TSA, nothing else       |
 * |                          | seal (TEST_SEAL_KEY)                              |                               |
 * | Signing page hosts       | the app, plus SIGNING_PAGE_ORIGINS                | the app only                  |
 * | Origins that may embed   | https, or http on a loopback host                 | https only                    |
 *
 * Signing and the demo page run in both, once configured (signingEnabled).
 */
import { relayConfig } from './mail.ts';

export type EsignEnvironment = 'dev' | 'prod';

export type EnvironmentEnv = {
  ESIGN_ENV?: string;
  /** Pepper of the one-time codes (secret, at least 32 characters). */
  OTP_KEY?: string;
  /** Key of the HMAC test seal (dev only, where no managed seal is configured). */
  TEST_SEAL_KEY?: string;
  /** The local preview's test mailbox: a bucket in the D1 object store (blob-store.ts). */
  TEST_MAIL?: unknown;
  SUGER_MAIL_URL?: string;
  SUGER_APP_TOKEN?: string;
  KMS_KEY_ARN?: string;
};

/** `prod` only when said so; anything else, including unset, is `dev`. */
export const environmentOf = (env: { ESIGN_ENV?: string }): EsignEnvironment => (env.ESIGN_ENV === 'prod' ? 'prod' : 'dev');
export const isProd = (env: { ESIGN_ENV?: string }) => environmentOf(env) === 'prod';

/** The OTP pepper, or null when it is missing or too short. */
export function otpKey(env: { OTP_KEY?: string }): Uint8Array | null {
  return (env.OTP_KEY?.length ?? 0) >= 32 ? new TextEncoder().encode(env.OTP_KEY!) : null;
}

/** The HMAC test seal's key, in dev only; never in prod, whatever is configured. */
export function testSealKey(env: EnvironmentEnv): Uint8Array | null {
  if (isProd(env) || (env.TEST_SEAL_KEY?.length ?? 0) < 32) return null;
  return new TextEncoder().encode(env.TEST_SEAL_KEY!);
}

/** What keeps prod from signing, named but never with its value. Empty in dev: dev is lenient. */
export function prodProblems(env: EnvironmentEnv): string[] {
  if (!isProd(env)) return [];
  const problems: string[] = [];
  if (!otpKey(env)) problems.push('ESIGN_OTP_KEY is not set');
  if (!relayConfig(env)) problems.push('the mail relay (SUGER_MAIL_URL, SUGER_APP_TOKEN) is not configured');
  if (env.TEST_MAIL) problems.push('a test mailbox is bound: prod keeps no codes');
  if (!env.KMS_KEY_ARN) problems.push('ESIGN_KMS_KEY_ARN is not set: prod seals with KMS and TSA only');
  return problems;
}

/**
 * Whether recipients can sign: the signing API and pages. dev needs the code pepper and the test
 * mailbox codes are kept in; prod needs all of its configuration (prodProblems).
 */
export function signingEnabled(env: EnvironmentEnv): boolean {
  if (!otpKey(env)) return false;
  return isProd(env) ? prodProblems(env).length === 0 : !!env.TEST_MAIL;
}
