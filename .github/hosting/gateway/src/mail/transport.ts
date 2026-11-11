// Sends the gateway's e-mail through the Cloudflare Email Service binding or, in SITE_ENV=test only, stores it in the
// `mail_capture` table. Every message first takes a slot under the per-recipient (and per-organization) caps.
import type { Context } from '../context.ts'
import { sha256Hex } from '../crypto.ts'
import { captureMail, releaseMailSlot, reserveMailSlot, reserveOrgRequestSlot } from '../db/mail.ts'
import { errorCode, log } from '../log.ts'
import type { MailContent } from './templates.ts'

export type MailKind = 'verify_email' | 'signup_exists' | 'reset_password' | 'invitation' | 'mfa_changed' | 'mfa_locked' | 'sso_linked' | 'org_request'
export type SendOutcome = 'sent' | 'capped' | 'failed'

export async function sendMail(ctx: Context, kind: MailKind, to: string, content: MailContent, orgId: string | null = null): Promise<SendOutcome> {
  const db = ctx.config.db
  const slot = await reserveMailSlot(db, { recipientHash: await sha256Hex(to), kind, orgId, now: ctx.now })
  if (slot === null) {
    log('mail_capped', { kind, org: orgId })
    return 'capped'
  }
  return deliver(ctx, slot, { kind, orgId, to, from: ctx.config.mailFrom, content })
}

/**
 * Sends a request for more organizations (DESIGN.md §3.1) to Insulin Apps support at `to`, from the gateway's address
 * with Reply-To set to the requester: at most ORG_REQUEST_DAILY_LIMIT a day per requester.
 */
export async function sendOrgRequest(ctx: Context, to: string, requester: { id: string; email: string }, content: MailContent): Promise<SendOutcome> {
  const slot = await reserveOrgRequestSlot(ctx.config.db, { recipientHash: await sha256Hex(to), userId: requester.id, now: ctx.now })
  if (slot === null) {
    log('mail_capped', { kind: 'org_request', user: requester.id })
    return 'capped'
  }
  return deliver(ctx, slot, { kind: 'org_request', orgId: null, to, from: ctx.config.mailFrom, replyTo: requester.email, content })
}

/**
 * Sends one message that already holds a slot in `mail_log`: through the Email Service binding, or into
 * `mail_capture` in test mode. A failed send gives its slot back. Logs carry the kind and organization, never the
 * address or the text.
 */
export async function deliver(ctx: Context, slot: number, message: {
  kind: string
  orgId: string | null
  to: string
  from: { email: string; name: string }
  replyTo?: string | null
  content: MailContent
}): Promise<SendOutcome> {
  const db = ctx.config.db
  const { kind, orgId, to, from, replyTo, content } = message
  try {
    if (ctx.config.email) {
      await ctx.config.email.send({
        to,
        from,
        ...(replyTo ? { replyTo } : {}),
        subject: content.subject,
        text: content.text,
        ...(content.html ? { html: content.html } : {}),
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
