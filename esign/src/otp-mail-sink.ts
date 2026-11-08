import { isValidOtpEmailAddress } from './cloudflare-otp-mail.ts';
import { OTP_TTL_MS } from './page-authorization.ts';

/**
 * One-time codes emailed to one fixed mailbox instead of the recipient (test environments).
 * Configured by a `send_email` binding SEND_EMAIL (on Cloudflare, pinned to the same address
 * with `destination_address`, so the Worker cannot mail anyone else), OTP_MAIL_FROM (an address
 * on a domain onboarded to Cloudflare Email Sending) and OTP_MAIL_SINK. With a sink, a code is
 * accepted for any recipient address, because none of them ever receives it.
 */

export type MailAttachment = { disposition: 'attachment'; filename: string; type: string; content: Uint8Array };
type SendEmail = { send(message: { from: string; to: string; subject: string; text: string; attachments?: MailAttachment[] }): Promise<unknown> };
export type OtpSinkEnv = { SEND_EMAIL?: SendEmail; OTP_MAIL_FROM?: string; OTP_MAIL_SINK?: string };
export type OtpSink = { send(recipient: string, otp: string): Promise<void> };
/** Any message meant for `recipient`, delivered to the sink instead, saying whom it was for. */
export type SinkMailer = { sink: string; send(recipient: string, subject: string, text: string, attachments?: MailAttachment[]): Promise<void> };

/** Minutes a code stays valid (sendRecipientOtp). */
const OTP_MINUTES = OTP_TTL_MS / 60_000;

/** The configured sink, or null when any part of it is missing or not an email address. */
export function sinkMailer(env: OtpSinkEnv): SinkMailer | null {
  const binding = env.SEND_EMAIL, from = env.OTP_MAIL_FROM ?? '', sink = env.OTP_MAIL_SINK ?? '';
  if (!binding || typeof binding.send !== 'function' || !isValidOtpEmailAddress(from) || !isValidOtpEmailAddress(sink)) return null;
  return {
    sink,
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

/** One-time codes through the sink. */
export function otpSink(env: OtpSinkEnv): OtpSink | null {
  const mailer = sinkMailer(env);
  if (!mailer) return null;
  return { send: (recipient, otp) => mailer.send(recipient, `Verification code for ${recipient}`, `Verification code: ${otp}\n\nIt expires in ${OTP_MINUTES} minutes.`) };
}
