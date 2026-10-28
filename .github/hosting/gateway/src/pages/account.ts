import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import type { Session } from '../auth/session.ts'
import { NAME_MAX, PASSWORD_MAX, PASSWORD_MIN } from '../validate.ts'
import { html, type Html, EMPTY } from './html.ts'
import { errorSummary, input, notice, page } from './layout.ts'

export interface AccountState {
  notice?: string | null
  errors?: { name?: string | null; current?: string | null; password?: string | null; delete?: string | null }
  blockingOrgs?: { id: string; name: string }[]
}

export function accountPage(ctx: Context, session: Session, state: AccountState = {}): Html {
  const errors = state.errors ?? {}
  const user = session.user
  return page(ctx, { title: 'Account', user }, html`<h1>Account</h1>
${state.notice ? notice(state.notice, 'ok') : EMPTY}
${errorSummary([errors.name, errors.current, errors.password, errors.delete])}
<p>Signed in as <strong>${user.email}</strong>.</p>

<h2>Name</h2>
<form method="post" action="/account/name">
  ${input({ label: 'Name', name: 'name', value: user.name, autocomplete: 'name', maxlength: NAME_MAX, error: errors.name })}
  <div class="actions"><button type="submit" class="secondary">Save name</button></div>
</form>

<h2>${user.hasPassword ? 'Change password' : 'Set a password'}</h2>
${user.hasPassword ? EMPTY : html`<p>You sign in with Google. Set a password to sign in with your email address as well.</p>`}
<form method="post" action="/account/password">
  <input type="text" name="username" value="${user.email}" autocomplete="username" hidden>
  ${user.hasPassword ? input({ label: 'Current password', name: 'current_password', type: 'password', autocomplete: 'current-password', maxlength: PASSWORD_MAX, error: errors.current }) : EMPTY}
  ${input({ label: 'New password', name: 'password', type: 'password', autocomplete: 'new-password', minlength: PASSWORD_MIN, maxlength: PASSWORD_MAX, hint: `At least ${PASSWORD_MIN} characters. Saving it signs you out on your other devices.`, error: errors.password })}
  <div class="actions"><button type="submit" class="secondary">Save password</button></div>
</form>

<h2>Delete account</h2>
<p>This deletes your account, signs you out everywhere, and deletes every organization where you are the only member. Apps keep the data they stored for those organizations, but nobody can reach it again. See the <a href="${apexUrl(ctx, '/privacy')}">Privacy notice</a> for details.</p>
${state.blockingOrgs?.length ? html`<div class="errors" role="alert"><p>You're the only owner of ${state.blockingOrgs.map((org, index) => html`${index ? ', ' : ''}<a href="/orgs/${org.id}">${org.name}</a>`)}, which ${state.blockingOrgs.length === 1 ? 'has' : 'have'} other members. Make another member an owner, or remove the other members, first.</p></div>` : EMPTY}
<form method="post" action="/account/delete">
  ${input({ label: 'Type your email address to confirm', name: 'confirm', type: 'email', autocomplete: 'off', maxlength: 254, error: errors.delete })}
  <div class="actions"><button type="submit" class="danger">Delete my account</button></div>
</form>`)
}

export function accountDeletedPage(ctx: Context): Html {
  return page(ctx, { title: 'Account deleted', user: null }, html`<h1>Your account was deleted</h1>
<p><a href="${apexUrl(ctx)}">See all apps</a>.</p>`)
}
