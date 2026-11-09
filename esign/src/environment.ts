/**
 * The one switch that sets how the Worker behaves: ESIGN_ENV, `dev` or `prod` (WORKER-MODE.md).
 * Locally and on esign-dev it is `dev`; on esign-prod it is `prod`. Everything else is a value
 * for the environment (addresses, origins, keys), never a second switch.
 *
 * |                              | dev                                               | prod                         |
 * |------------------------------|---------------------------------------------------|------------------------------|
 * | Codes and signed copies      | to the sink mailbox (MAIL_SINK), saying for whom; | to their recipients          |
 * |                              | without a sink, codes only for synthetic          |                              |
 * |                              | addresses, kept in TEST_MAIL                      |                              |
 * | Test mailbox (TEST_MAIL)     | every code is kept there for tests to read        | never written or read        |
 * | Seal                         | KMS + TSA when configured, else the HMAC test     | KMS + TSA, nothing else      |
 * |                              | seal (TEST_SEAL_KEY)                              |                              |
 * | Signing page hosts           | the Worker, plus SIGNING_PAGE_ORIGINS             | the Worker only              |
 * | Origins that may embed pages | https, or http on a loopback host                 | https only                   |
 *
 * Signing, the demo page and the cron run in both, once configured (signingEnabled).
 */
import { isValidOtpEmailAddress } from './cloudflare-otp-mail.ts';

export type EsignEnvironment = 'dev' | 'prod';

export type EnvironmentEnv = {
  ESIGN_ENV?: string;
  /** Pepper of the one-time codes (secret, at least 32 characters). */
  OTP_KEY?: string;
  /** Key of the HMAC test seal (secret; dev only, where no managed seal is configured). */
  TEST_SEAL_KEY?: string;
  TEST_MAIL?: R2Bucket;
  SEND_EMAIL?: unknown;
  MAIL_FROM?: string;
  MAIL_SINK?: string;
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
  if (!otpKey(env)) problems.push('OTP_KEY is not set');
  if (!env.SEND_EMAIL) problems.push('the SEND_EMAIL binding is missing');
  if (!isValidOtpEmailAddress(env.MAIL_FROM ?? '')) problems.push('MAIL_FROM is not set');
  if (env.MAIL_SINK) problems.push('MAIL_SINK is set: prod emails recipients, never a sink');
  if (env.TEST_MAIL) problems.push('the TEST_MAIL bucket is bound: prod keeps no codes');
  if (!env.KMS_KEY_ARN) problems.push('KMS_KEY_ARN is not set: prod seals with KMS and TSA only');
  return problems;
}

/**
 * Whether recipients can sign: the signing API and page, the demo page and the cron. dev needs
 * the code pepper and the test mailbox codes are kept in; prod needs all of its configuration
 * (prodProblems).
 */
export function signingEnabled(env: EnvironmentEnv): boolean {
  if (!otpKey(env)) return false;
  return isProd(env) ? prodProblems(env).length === 0 : !!env.TEST_MAIL;
}
