// The gateway's e-mails, as plain text and HTML. Names and organization names are user input: the HTML part escapes
// them through the `html` tag, and they never contain line breaks (validate.ts removes control characters).
import { html, type Html } from '../pages/html.ts'
import { ROLE_LABELS, type Role } from '../roles.ts'

export interface MailContent {
  subject: string
  text: string
  html: string
}

const PRODUCT = 'Insulin Apps'

function htmlBody(paragraphs: Html[], action?: { label: string; url: string }): string {
  const button = action
    ? html`<p style="margin:24px 0"><a href="${action.url}" style="background:#2f5d8a;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${action.label}</a></p>
<p style="font-size:13px;color:#5f6368">If the button doesn't work, copy this address into your browser:<br>${action.url}</p>`
    : ''
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f7f7f5;color:#1d1d1f;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dcdcd7;border-radius:8px;padding:24px">
${paragraphs.map((paragraph) => html`<p>${paragraph}</p>`)}
${button}
<p style="font-size:13px;color:#5f6368;margin-top:24px">${PRODUCT}: open-source apps, hosted for you.</p>
</div></body></html>`.value
}

function textBody(lines: string[]): string {
  return `${lines.join('\n\n')}\n\n-- \n${PRODUCT}: open-source apps, hosted for you.\n`
}

export function verifyEmailMail(name: string, link: string): MailContent {
  return {
    subject: `Confirm your email for ${PRODUCT}`,
    text: textBody([
      `Hi ${name},`,
      `Confirm your email address to finish creating your ${PRODUCT} account:`,
      link,
      'The link works once and expires in 24 hours. If you didn\'t create an account, ignore this email: nothing happens unless you confirm.',
    ]),
    html: htmlBody([
      html`Hi ${name},`,
      html`Confirm your email address to finish creating your ${PRODUCT} account.`,
      html`The link works once and expires in 24 hours. If you didn't create an account, ignore this email: nothing happens unless you confirm.`,
    ], { label: 'Confirm my email', url: link }),
  }
}

export function signupExistsMail(loginUrl: string, forgotUrl: string): MailContent {
  return {
    subject: `Someone tried to sign up for ${PRODUCT} with your email`,
    text: textBody([
      `Someone, maybe you, tried to create a ${PRODUCT} account with this email address. You already have an account, so nothing was changed.`,
      `Sign in: ${loginUrl}`,
      `Forgot your password? Reset it: ${forgotUrl}`,
      'If this wasn\'t you, you can ignore this email.',
    ]),
    html: htmlBody([
      html`Someone, maybe you, tried to create a ${PRODUCT} account with this email address. You already have an account, so nothing was changed.`,
      html`Forgot your password? <a href="${forgotUrl}">Reset it here</a>.`,
      html`If this wasn't you, you can ignore this email.`,
    ], { label: 'Sign in', url: loginUrl }),
  }
}

export function resetPasswordMail(name: string, link: string): MailContent {
  return {
    subject: `Reset your ${PRODUCT} password`,
    text: textBody([
      `Hi ${name},`,
      'Someone, hopefully you, asked to reset your password. Choose a new one here:',
      link,
      'The link works once and expires in 1 hour. If you didn\'t ask, ignore this email: your password stays the same.',
    ]),
    html: htmlBody([
      html`Hi ${name},`,
      html`Someone, hopefully you, asked to reset your password.`,
      html`The link works once and expires in 1 hour. If you didn't ask, ignore this email: your password stays the same.`,
    ], { label: 'Choose a new password', url: link }),
  }
}

export function invitationMail(inviter: string, orgName: string, role: Role, link: string): MailContent {
  const label = ROLE_LABELS[role]
  return {
    subject: `${inviter} invited you to ${orgName} on ${PRODUCT}`,
    text: textBody([
      `${inviter} invited you to join the organization "${orgName}" as ${label} on ${PRODUCT}.`,
      `Open the invitation: ${link}`,
      'To accept, sign in or create an account with this email address. The invitation expires in 7 days. If you don\'t know the sender, you can ignore this email.',
    ]),
    html: htmlBody([
      html`${inviter} invited you to join the organization <strong>${orgName}</strong> as ${label} on ${PRODUCT}.`,
      html`To accept, sign in or create an account with this email address. The invitation expires in 7 days. If you don't know the sender, you can ignore this email.`,
    ], { label: 'Open the invitation', url: link }),
  }
}
