// Organization pages: create, overview with members and invitations (what each role may see and do), invitations.
import type { Context } from '../context.ts'
import { authUrl, withReturnTo } from '../context.ts'
import type { InvitationRow } from '../db/invitations.ts'
import type { MemberRow } from '../db/orgs.ts'
import {
  ROLE_LABELS, canChangeRole, canDeleteOrg, canHandleInvitation, canManageMembers, canRemoveMember, canRenameOrg,
  grantableRoles, type Role,
} from '../roles.ts'
import type { Session } from '../auth/session.ts'
import { ORG_NAME_MAX } from '../validate.ts'
import { html, type Html, EMPTY } from './html.ts'
import { invitationList } from './home.ts'
import { errorSummary, hidden, input, notice, page, postButton, select } from './layout.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function roleChoices(roles: Role[]): { value: string; label: string }[] {
  return roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))
}

function expiry(ctx: Context, expiresAt: number): string {
  if (expiresAt <= ctx.now) return 'Expired'
  const days = Math.ceil((expiresAt - ctx.now) / DAY_MS)
  return days <= 1 ? 'Expires within a day' : `Expires in ${days} days`
}

export function newOrgPage(ctx: Context, session: Session, invitations: InvitationRow[], state: { name?: string; error?: string | null; returnTo?: string | null } = {}): Html {
  return page(ctx, { title: 'Create an organization', user: session.user }, html`<h1>Create an organization</h1>
<p>An organization is a shared workspace: one organization spans every app, and each member's role applies in all of them. You'll be its owner.</p>
${errorSummary([state.error])}
${invitationList(invitations, state.returnTo ?? null)}
${invitations.length ? html`<h2>Or start your own</h2>` : EMPTY}
<form method="post" action="/orgs/new">
  ${input({ label: 'Organization name', name: 'name', value: state.name, maxlength: ORG_NAME_MAX, autocomplete: 'organization', error: state.error })}
  ${hidden('return_to', state.returnTo)}
  <div class="actions"><button type="submit">Create organization</button></div>
</form>`)
}

export interface OrgPageData {
  orgId: string
  orgName: string
  role: Role
  active: boolean
  members: MemberRow[] | null
  invitations: InvitationRow[] | null
  ownerCount: number
  notice?: string | null
  error?: string | null
}

function memberActions(data: OrgPageData, member: MemberRow, self: boolean): Html {
  const parts: Html[] = []
  if (canChangeRole(data.role, member.role, member.role)) {
    const id = `role-${member.user_id}`
    parts.push(html`<form method="post" action="/orgs/${data.orgId}/members/${member.user_id}/role" class="inline-form">
  <label class="visually-hidden" for="${id}">Role for ${member.name}</label>
  <select id="${id}" name="role">
  ${roleChoices(grantableRoles(data.role)).map((choice) => html`<option value="${choice.value}"${choice.value === member.role ? html` selected` : EMPTY}>${choice.label}</option>`)}
  </select>
  <button type="submit" class="secondary">Change</button>
</form>`)
  }
  if (!self && canRemoveMember(data.role, member.role)) {
    parts.push(postButton(`/orgs/${data.orgId}/members/${member.user_id}/remove`, `Remove ${member.name}`, {}, 'link'))
  }
  return html`${parts}`
}

export function orgPage(ctx: Context, session: Session, data: OrgPageData): Html {
  const lastOwner = data.role === 'OWNER' && data.ownerCount <= 1
  const members = data.members
    ? html`<h2>Members</h2>
<table>
  <caption class="visually-hidden">Members of ${data.orgName}</caption>
  <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th>${canManageMembers(data.role) ? html`<th scope="col"><span class="visually-hidden">Actions</span></th>` : EMPTY}</tr></thead>
  <tbody>
  ${data.members.map((member) => html`<tr>
    <td>${member.name}${member.user_id === session.user.id ? html` <span class="badge">You</span>` : EMPTY}</td>
    <td>${member.email}</td>
    <td>${ROLE_LABELS[member.role]}</td>
    ${canManageMembers(data.role) ? html`<td>${memberActions(data, member, member.user_id === session.user.id)}</td>` : EMPTY}
  </tr>`)}
  </tbody>
</table>`
    : html`<p>Only editors, admins and owners can see the member list.</p>`

  const invitations = data.invitations
    ? html`<h2>Invite people</h2>
<form method="post" action="/orgs/${data.orgId}/invitations">
  ${input({ label: 'Email address', name: 'email', type: 'email', autocomplete: 'off', maxlength: 254 })}
  ${select({ label: 'Role', name: 'role', choices: roleChoices(grantableRoles(data.role)), selected: 'USER' })}
  <div class="actions"><button type="submit">Send invitation</button></div>
</form>
<h2>Pending invitations</h2>
${data.invitations.length ? html`<table>
  <caption class="visually-hidden">Pending invitations</caption>
  <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
  <tbody>
  ${data.invitations.map((invitation) => html`<tr>
    <td>${invitation.email}</td>
    <td>${ROLE_LABELS[invitation.role]}</td>
    <td>${expiry(ctx, invitation.expires_at)}</td>
    <td>${canHandleInvitation(data.role, invitation.role)
      ? html`${postButton(`/orgs/${data.orgId}/invitations/${invitation.id}/resend`, `Resend to ${invitation.email}`, {}, 'link')}
      ${postButton(`/orgs/${data.orgId}/invitations/${invitation.id}/revoke`, `Revoke for ${invitation.email}`, {}, 'link')}`
      : EMPTY}</td>
  </tr>`)}
  </tbody>
</table>` : html`<p>No pending invitations.</p>`}`
    : EMPTY

  const settings = canRenameOrg(data.role) || canDeleteOrg(data.role)
    ? html`<h2>Settings</h2>
${canRenameOrg(data.role) ? html`<form method="post" action="/orgs/${data.orgId}/rename">
  ${input({ label: 'Organization name', name: 'name', value: data.orgName, maxlength: ORG_NAME_MAX })}
  <div class="actions"><button type="submit" class="secondary">Rename</button></div>
</form>` : EMPTY}
${canDeleteOrg(data.role) ? html`<h3>Delete this organization</h3>
<p>This removes the organization, its members and its invitations from Insulin Apps sign-in. Apps keep the data they stored for it, but nobody can reach that data again, because this organization's id is never issued again. This can't be undone.</p>
<form method="post" action="/orgs/${data.orgId}/delete">
  ${input({ label: 'Type the organization name to confirm', name: 'confirm', autocomplete: 'off', hint: data.orgName })}
  <div class="actions"><button type="submit" class="danger">Delete organization</button></div>
</form>` : EMPTY}`
    : EMPTY

  return page(ctx, { title: data.orgName, user: session.user }, html`<h1>${data.orgName}</h1>
<p>Your role: <strong>${ROLE_LABELS[data.role]}</strong>${data.active ? html` · <span class="badge">Active organization</span>` : EMPTY} · <a href="/">All your organizations</a></p>
${data.notice ? notice(data.notice, 'ok') : EMPTY}
${errorSummary([data.error])}
${data.active ? EMPTY : html`<p>${postButton('/orgs/switch', 'Make this my active organization', { org_id: data.orgId, return_to: authUrl(ctx, `/orgs/${data.orgId}`) }, 'secondary')}</p>`}
${members}
${invitations}
<h2>Leave</h2>
${lastOwner
    ? html`<p>You're the only owner, so you can't leave. Make another member an owner first${canDeleteOrg(data.role) ? ', or delete the organization' : ''}.</p>`
    : html`<p>${postButton(`/orgs/${data.orgId}/leave`, 'Leave this organization', {}, 'secondary')}</p>`}
${settings}`)
}

export type InvitationView = 'signed-out' | 'mismatch' | 'open' | 'closed'

export function invitationPage(ctx: Context, session: Session | null, invitation: InvitationRow | null, view: InvitationView, error: string | null = null): Html {
  const user = session ? session.user : null
  if (!invitation || view === 'closed') {
    return page(ctx, { title: 'Invitation', user }, html`<h1>This invitation is no longer valid</h1>
<p>It may have expired, been revoked, or already been answered. Ask the person who invited you to send a new one.</p>
<p><a href="/">Go to your organizations</a></p>`)
  }
  const summary = html`<p><strong>${invitation.inviter_name ?? 'A member'}</strong> invited <strong>${invitation.email}</strong> to join <strong>${invitation.org_name}</strong> as ${ROLE_LABELS[invitation.role]}.</p>`
  const self = `/invitations/${invitation.id}`
  if (view === 'signed-out') {
    const back = authUrl(ctx, self)
    return page(ctx, { title: 'Invitation', user: null }, html`<h1>You're invited</h1>
${summary}
<p>To accept, sign in or create an account with that email address.</p>
<p class="actions">
  <a class="button" href="${withReturnTo(`/signup?email=${encodeURIComponent(invitation.email)}`, back)}">Create an account</a>
  <a class="button secondary" href="${withReturnTo(`/login?email=${encodeURIComponent(invitation.email)}`, back)}">Sign in</a>
</p>`)
  }
  if (view === 'mismatch') {
    return page(ctx, { title: 'Invitation', user }, html`<h1>This invitation is for another email address</h1>
${summary}
<p>You're signed in as <strong>${session!.user.email}</strong>. Sign out, then sign in or create an account with <strong>${invitation.email}</strong> to accept it.</p>
<form method="post" action="/logout"><button type="submit" class="secondary">Sign out</button></form>`)
  }
  return page(ctx, { title: 'Invitation', user }, html`<h1>You're invited</h1>
${errorSummary([error])}
${summary}
<p class="actions">
  ${postButton(`${self}/accept`, 'Accept invitation', {}, 'primary')}
  ${postButton(`${self}/decline`, 'Decline')}
</p>`)
}
