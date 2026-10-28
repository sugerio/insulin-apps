// Local development only: the mail captured by the test transport. Served when SITE_ENV=test on a *.localhost host.
import type { Context } from '../context.ts'
import type { CapturedMail } from '../db/mail.ts'
import { html, type Html } from './html.ts'
import { page } from './layout.ts'

export function mailLinks(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"']+/g)].map((match) => match[0])
}

export function devMailPage(ctx: Context, mails: CapturedMail[]): Html {
  return page(ctx, { title: 'Captured mail' }, html`<h1>Captured mail</h1>
<p class="muted">SITE_ENV=test: these emails were stored instead of sent. Newest first.</p>
${mails.length ? mails.map((mail) => html`<article class="card">
  <h2 class="mail-subject">${mail.subject}</h2>
  <p class="small muted">To ${mail.recipient} · ${new Date(mail.created_at).toISOString()}</p>
  <ul>${mailLinks(mail.body_text).map((link) => html`<li><a href="${link}">${link}</a></li>`)}</ul>
  <pre>${mail.body_text}</pre>
</article>`) : html`<p>No mail yet.</p>`}`)
}
