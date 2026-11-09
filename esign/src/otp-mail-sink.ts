import { isValidOtpEmailAddress } from './cloudflare-otp-mail.ts';
import { isProd } from './environment.ts';
import { OTP_TTL_MS } from './otp.ts';

/**
 * Email from the Worker: one-time codes and signed copies, through a `send_email` binding
 * SEND_EMAIL and MAIL_FROM (an address on a domain onboarded to Cloudflare Email Sending).
 *
 * - dev (ESIGN_ENV, see environment.ts): every message goes to one fixed mailbox, MAIL_SINK,
 *   saying whom it was for. On Cloudflare the binding itself is pinned to that address with
 *   `destination_address`, so the Worker cannot mail anyone else. A code is then accepted for any
 *   recipient address, because none of them ever receives it.
 * - prod: every message goes to its recipient.
 */

export type MailAttachment = { disposition: 'attachment'; filename: string; type: string; content: Uint8Array };
type SendEmail = { send(message: { from: string; to: string; subject: string; text: string; attachments?: MailAttachment[] }): Promise<unknown> };
export type MailEnv = { ESIGN_ENV?: string; SEND_EMAIL?: SendEmail; MAIL_FROM?: string; MAIL_SINK?: string };
export type OtpMailer = { send(recipient: string, otp: string): Promise<void> };
/** Sends a message meant for `recipient`: to them (prod), or to the sink saying it was for them (dev). */
export type Mailer = { send(recipient: string, subject: string, text: string, attachments?: MailAttachment[]): Promise<void> };

/** Minutes a code stays valid (sendRecipientOtp). */
const OTP_MINUTES = OTP_TTL_MS / 60_000;

const usableBinding = (env: MailEnv) => {
  const binding = env.SEND_EMAIL, from = env.MAIL_FROM ?? '';
  return binding && typeof binding.send === 'function' && isValidOtpEmailAddress(from) ? { binding, from } : null;
};

/** dev: the sink, or null when any part of it is missing or not an email address. Never in prod. */
export function sinkMailer(env: MailEnv): Mailer | null {
  const configured = usableBinding(env), sink = env.MAIL_SINK ?? '';
  if (isProd(env) || !configured || !isValidOtpEmailAddress(sink)) return null;
  const { binding, from } = configured;
  return {
    async send(recipient, subject, text, attachments) {
      await binding.send({
        from, to: sink,
        subject: `[E-sign dev] ${subject} (for ${recipient})`,
        text: [`Intended recipient: ${recipient}`, '', text, '', `This E-sign environment emails every message to ${sink} instead of its recipient.`, 'Synthetic test documents only; not a production signature service.'].join('\n'),
        ...(attachments?.length ? { attachments } : {}),
      });
    },
  };
}

/** prod: each message to its own recipient, or null when mail is not configured. Never in dev. */
export function recipientMailer(env: MailEnv): Mailer | null {
  const configured = usableBinding(env);
  if (!isProd(env) || !configured) return null;
  const { binding, from } = configured;
  return {
    async send(recipient, subject, text, attachments) {
      if (!isValidOtpEmailAddress(recipient)) throw new Error('Invalid recipient address');
      await binding.send({ from, to: recipient, subject, text, ...(attachments?.length ? { attachments } : {}) });
    },
  };
}

/** The environment's mailer: the recipient in prod, the sink in dev; null when not configured. */
export const mailerFor = (env: MailEnv): Mailer | null => (isProd(env) ? recipientMailer(env) : sinkMailer(env));

/** One-time codes through the environment's mailer. */
export function otpMailer(env: MailEnv): OtpMailer | null {
  const mailer = mailerFor(env);
  if (!mailer) return null;
  return { send: (recipient, otp) => mailer.send(recipient, 'Your verification code', `Verification code: ${otp}\n\nIt expires in ${OTP_MINUTES} minutes. If you did not ask to sign a document, ignore this email.`) };
}
