import { isValidOtpEmailAddress } from './email-address.ts';
import { isProd } from './environment.ts';
import { OTP_TTL_MS } from './otp.ts';

/**
 * Email: one-time codes and completion notices. An Insulin app has no email binding, so Esign
 * sends through the hosting platform's mail relay: `POST <SUGER_MAIL_URL>` with the app's token
 * (`SUGER_APP_TOKEN`) and the organization the mail is for (`x-suger-organization-id`), one
 * recipient per message. The relay answers 202 once it has sent it; anything else (a refusal, a
 * limit, a failed send) is an error here, and nothing is marked delivered.
 *
 * Without the relay (the local preview), nothing is emailed: codes are kept in the preview's test
 * mailbox (signing-routes.ts) and completion notices are skipped.
 */
export type MailEnv = {
  ESIGN_ENV?: string;
  SUGER_MAIL_URL?: string;
  SUGER_APP_TOKEN?: string;
  /** The fetch the relay is called with (tests replace it). */
  MAIL_FETCH?: typeof fetch;
};
export type OtpMailer = { send(recipient: string, otp: string): Promise<void> };
/** Sends a plain-text message to one recipient of an organization. */
export type Mailer = { send(recipient: string, subject: string, text: string): Promise<void> };

/** Minutes a code stays valid (sendRecipientOtp). */
const OTP_MINUTES = OTP_TTL_MS / 60_000;

/** The relay's address and token, when both are set and the address is https (http only on loopback). */
export function relayConfig(env: MailEnv): { url: string; token: string } | null {
  const url = env.SUGER_MAIL_URL?.trim() ?? '', token = env.SUGER_APP_TOKEN?.trim() ?? '';
  if (!url || !token) return null;
  try {
    const parsed = new URL(url);
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname.endsWith('.localhost');
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
  } catch {
    return null;
  }
  return { url, token };
}

export class MailRelayError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Mail relay answered ${status}`); this.status = status; }
}

/** The organization's mailer through the relay, or null when the relay isn't configured. */
export function mailerFor(env: MailEnv, tenantId: string): Mailer | null {
  const relay = relayConfig(env);
  if (!relay || !tenantId) return null;
  const prod = isProd(env);
  const send = env.MAIL_FETCH ?? fetch;
  return {
    async send(recipient, subject, text) {
      if (!isValidOtpEmailAddress(recipient)) throw new Error('Invalid recipient address');
      const body = { to: recipient, subject, text: prod ? text : `${text}\n\nSent by an Esign test deployment. Synthetic test documents only.` };
      const response = await send(relay.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${relay.token}`, 'x-suger-organization-id': tenantId, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
      });
      if (response.status !== 202) throw new MailRelayError(response.status);
    },
  };
}

/** One-time codes through the organization's mailer. */
export function otpMailer(env: MailEnv, tenantId: string): OtpMailer | null {
  const mailer = mailerFor(env, tenantId);
  if (!mailer) return null;
  return { send: (recipient, otp) => mailer.send(recipient, 'Your verification code', `Verification code: ${otp}\n\nIt expires in ${OTP_MINUTES} minutes. If you did not ask to sign a document, ignore this email.`) };
}
