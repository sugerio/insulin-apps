// Sends the gateway's e-mail through the Cloudflare Email Service binding or, in SITE_ENV=test only, stores it in the
// `mail_capture` table. Every message first takes a slot under the per-recipient (and per-organization) caps.
import type { Context } from '../context.ts'
import { sha256Hex } from '../crypto.ts'
import { captureMail, releaseMailSlot, reserveMailSlot } from '../db/mail.ts'
import { errorCode, log } from '../log.ts'
import type { MailContent } from './templates.ts'

export type MailKind = 'verify_email' | 'signup_exists' | 'reset_password' | 'invitation'
export type SendOutcome = 'sent' | 'capped' | 'failed'

export async function sendMail(ctx: Context, kind: MailKind, to: string, content: MailContent, orgId: string | null = null): Promise<SendOutcome> {
  const db = ctx.config.db
  const slot = await reserveMailSlot(db, { recipientHash: await sha256Hex(to), kind, orgId, now: ctx.now })
  if (slot === null) {
    log('mail_capped', { kind, org: orgId })
    return 'capped'
  }
  try {
    if (ctx.config.email) {
      await ctx.config.email.send({
        to,
        from: ctx.config.mailFrom,
        subject: content.subject,
        text: content.text,
        html: content.html,
      })
    } else {
      await captureMail(db, { to, subject: content.subject, text: content.text, html: content.html, now: ctx.now })
    }
  } catch (error) {
    // The code only (E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED, …): never the address or the message.
    log('mail_failed', { kind, code: errorCode(error) })
    await releaseMailSlot(db, slot)
    return 'failed'
  }
  log('mail_sent', { kind, org: orgId })
  return 'sent'
}
