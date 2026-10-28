// The apex landing page and the signed-in home page on the auth host.
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { apexUrl, appUrl, authUrl, withReturnTo } from '../context.ts'
import type { InvitationRow } from '../db/invitations.ts'
import type { MembershipRow } from '../db/orgs.ts'
import { ROLE_LABELS } from '../roles.ts'
import type { ActiveOrg, Session } from '../auth/session.ts'
import { html, type Html, EMPTY } from './html.ts'
import { contactLink, notice, page, postButton } from './layout.ts'

function appCards(ctx: Context, apps: HostedApp[]): Html {
  if (!apps.length) return html`<p>No apps are deployed yet.</p>`
  return html`<div class="cards">
${apps.map((app) => html`<article class="card">
  <h3>${app.title}</h3>
  ${app.summary ? html`<p>${app.summary}</p>` : EMPTY}
  <p class="actions">
    ${app.service ? html`<a class="button" href="${appUrl(ctx, app)}">Open ${app.title}</a>` : html`<span class="muted">Not available right now</span>`}
    ${app.source ? html`<a href="${app.source}">Source</a>` : EMPTY}
  </p>
</article>`)}
</div>`
}

export function landingPage(ctx: Context, session: Session | null, active: ActiveOrg | null): Html {
  const status = session
    ? notice(html`Signed in as <strong>${session.user.name}</strong>${active ? html`, working in <strong>${active.name}</strong> as ${ROLE_LABELS[active.role]}` : EMPTY}. <a href="${authUrl(ctx, '/')}">Your organizations</a>`)
    : html`<p class="actions">
  <a class="button" href="${authUrl(ctx, withReturnTo('/signup', apexUrl(ctx)))}">Create an account</a>
  <a class="button secondary" href="${authUrl(ctx, withReturnTo('/login', apexUrl(ctx)))}">Sign in</a>
</p>`
  return page(ctx, { title: 'Open-source apps, hosted', user: session ? session.user : null }, html`<h1>Insulin Apps</h1>
<p class="lead">Insulin Apps hosts open-source business apps for your team. Create an account, set up your organization, invite teammates with a role, and work together in every app.</p>
${status}
<h2>Apps</h2>
${appCards(ctx, ctx.config.apps)}
<h2>How it works</h2>
<p>Each app runs on Cloudflare's network with its own database, and its source code is public. One organization spans every app: your role in the organization is your role in each app, from owner to viewer.</p>
<p>The service is provided as is, without an uptime guarantee. Read the <a href="${apexUrl(ctx, '/terms')}">Terms of use</a> and the <a href="${apexUrl(ctx, '/privacy')}">Privacy notice</a>. Questions: ${contactLink(ctx)}.</p>`)
}

const HOME_NOTICES: Record<string, string> = {
  'org-deleted': 'The organization was deleted.',
  'org-left': 'You left the organization.',
  'invitation-declined': 'Invitation declined.',
  'password-set': 'Your new password is saved, and every other session is signed out.',
  'verified': 'Your email address is confirmed.',
}

export function homePage(ctx: Context, session: Session, memberships: MembershipRow[], invitations: InvitationRow[], active: ActiveOrg | null): Html {
  const message = HOME_NOTICES[ctx.url.searchParams.get('notice') ?? '']
  return page(ctx, { title: 'Your organizations', user: session.user }, html`<h1>Welcome, ${session.user.name}</h1>
${message ? notice(message, 'ok') : EMPTY}
${invitationList(invitations, null)}
<h2>Your organizations</h2>
${memberships.length ? html`<table>
  <caption class="visually-hidden">Organizations you belong to</caption>
  <thead><tr><th scope="col">Organization</th><th scope="col">Your role</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
  <tbody>
  ${memberships.map((membership) => html`<tr>
    <td><a href="/orgs/${membership.org_id}">${membership.org_name}</a>${active?.id === membership.org_id ? html` <span class="badge">Active</span>` : EMPTY}</td>
    <td>${ROLE_LABELS[membership.role]}</td>
    <td>${active?.id === membership.org_id ? EMPTY : postButton('/orgs/switch', 'Make active', { org_id: membership.org_id }, 'link')}</td>
  </tr>`)}
  </tbody>
</table>
<p class="small muted">Apps open in your active organization. You can also switch from the account bar inside an app.</p>` : html`<p>You're not in an organization yet. Create one to start using the apps, or accept an invitation.</p>`}
<p class="actions"><a class="button" href="/orgs/new">Create an organization</a></p>
<h2>Apps</h2>
${appCards(ctx, ctx.config.apps)}`)
}

/** Open invitations for the signed-in user's address, with accept and decline buttons. */
export function invitationList(invitations: InvitationRow[], returnTo: string | null): Html {
  if (!invitations.length) return EMPTY
  return html`<h2>Invitations</h2>
<ul class="plain">
${invitations.map((invitation) => html`<li class="card">
  <p><strong>${invitation.org_name}</strong>: ${invitation.inviter_name ?? 'A member'} invited you as ${ROLE_LABELS[invitation.role]}.</p>
  <p class="actions">
    ${postButton(`/invitations/${invitation.id}/accept`, 'Accept', returnTo ? { return_to: returnTo } : {}, 'primary')}
    ${postButton(`/invitations/${invitation.id}/decline`, 'Decline')}
  </p>
</li>`)}
</ul>`
}
