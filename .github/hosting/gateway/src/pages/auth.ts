// Account pages on the auth host: sign-up, sign-in, e-mail confirmation, resend, forgotten and reset passwords.
import type { Context } from '../context.ts'
import { apexUrl, withReturnTo } from '../context.ts'
import { PASSWORD_MAX, PASSWORD_MIN } from '../validate.ts'
import { html, type Html, EMPTY } from './html.ts'
import { errorSummary, hidden, input, notice, page, turnstileWidget } from './layout.ts'

export interface FormState {
  values?: { name?: string; email?: string }
  errors?: { name?: string | null; email?: string | null; password?: string | null; form?: string | null }
  returnTo?: string | null
  notice?: string | null
}

function googleOption(ctx: Context, returnTo: string | null | undefined, label: string): Html {
  if (!ctx.config.google) return EMPTY
  return html`<p><a class="button secondary wide" href="${withReturnTo('/auth/google/start', returnTo ?? null)}">${label}</a></p>
<p class="divider"><span>or</span></p>`
}

function agreement(ctx: Context): Html {
  return html`<p class="small">By creating an account you agree to the <a href="${apexUrl(ctx, '/terms')}">Terms of use</a> and acknowledge the <a href="${apexUrl(ctx, '/privacy')}">Privacy notice</a>.</p>`
}

function allErrors(state: FormState): (string | null | undefined)[] {
  const errors = state.errors ?? {}
  return [errors.form, errors.name, errors.email, errors.password]
}

export function signupPage(ctx: Context, state: FormState = {}): Html {
  const errors = state.errors ?? {}
  return page(ctx, { title: 'Create an account', turnstile: true }, html`<h1>Create an account</h1>
${errorSummary(allErrors(state))}
${googleOption(ctx, state.returnTo, 'Continue with Google')}
<form method="post" action="/signup">
  ${input({ label: 'Name', name: 'name', value: state.values?.name, autocomplete: 'name', maxlength: 100, error: errors.name })}
  ${input({ label: 'Email address', name: 'email', type: 'email', value: state.values?.email, autocomplete: 'email', maxlength: 254, error: errors.email })}
  ${input({ label: 'Password', name: 'password', type: 'password', autocomplete: 'new-password', minlength: PASSWORD_MIN, maxlength: PASSWORD_MAX, hint: `At least ${PASSWORD_MIN} characters.`, error: errors.password })}
  ${turnstileWidget(ctx, 'signup')}
  ${hidden('return_to', state.returnTo)}
  ${agreement(ctx)}
  <div class="actions"><button type="submit">Create account</button></div>
</form>
<p>Already have an account? <a href="${withReturnTo('/login', state.returnTo ?? null)}">Sign in</a></p>`)
}

export function checkInboxPage(ctx: Context, email: string): Html {
  return page(ctx, { title: 'Check your inbox' }, html`<h1>Check your inbox</h1>
${notice(html`We've sent an email to <strong>${email}</strong>. Open the link in it to continue.`, 'ok')}
<p>It can take a few minutes to arrive. If it doesn't, check your spam folder, or <a href="/resend-verification">ask for a new confirmation link</a>.</p>`)
}

export function loginPage(ctx: Context, state: FormState = {}): Html {
  const errors = state.errors ?? {}
  return page(ctx, { title: 'Sign in', turnstile: true }, html`<h1>Sign in</h1>
${state.notice ? notice(state.notice, 'ok') : EMPTY}
${errorSummary([errors.form, errors.email, errors.password])}
${googleOption(ctx, state.returnTo, 'Continue with Google')}
<form method="post" action="/login">
  ${input({ label: 'Email address', name: 'email', type: 'email', value: state.values?.email, autocomplete: 'username', maxlength: 254, error: errors.email })}
  ${input({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', maxlength: PASSWORD_MAX, error: errors.password })}
  ${turnstileWidget(ctx, 'login')}
  ${hidden('return_to', state.returnTo)}
  <div class="actions"><button type="submit">Sign in</button> <a href="/forgot-password">Forgot your password?</a></div>
</form>
<p>New here? <a href="${withReturnTo('/signup', state.returnTo ?? null)}">Create an account</a>${ctx.config.google ? '. Continuing with Google also creates an account if you don\'t have one' : ''}.</p>
${ctx.config.google ? agreement(ctx) : EMPTY}`)
}

/** Correct password, unconfirmed address: say so (only the account's owner can see this) and offer a new link. */
export function confirmFirstPage(ctx: Context, email: string, state: FormState = {}): Html {
  return page(ctx, { title: 'Confirm your email first', turnstile: true }, html`<h1>Confirm your email first</h1>
${errorSummary([state.errors?.form])}
<p>Open the confirmation link we emailed to <strong>${email}</strong>. If you can't find it, we can send a new one.</p>
<form method="post" action="/resend-verification">
  ${hidden('email', email)}
  ${turnstileWidget(ctx, 'resend')}
  ${hidden('return_to', state.returnTo)}
  <div class="actions"><button type="submit">Send a new link</button></div>
</form>`)
}

export function verifyEmailPage(ctx: Context, token: string, email: string): Html {
  return page(ctx, { title: 'Confirm your email' }, html`<h1>Confirm your email</h1>
<p>Confirm <strong>${email}</strong> to finish setting up your account. You'll be signed in.</p>
<form method="post" action="/verify-email">
  ${hidden('token', token)}
  <div class="actions"><button type="submit">Confirm my email</button></div>
</form>`)
}

export function linkInvalidPage(ctx: Context, kind: 'verify' | 'reset'): Html {
  const again = kind === 'verify'
    ? html`<a href="/resend-verification">Ask for a new confirmation link</a>`
    : html`<a href="/forgot-password">Ask for a new reset link</a>`
  return page(ctx, { title: 'Link expired' }, html`<h1>This link has expired or was already used</h1>
<p>Links in our emails work once, for a limited time. ${again}, or <a href="/login">sign in</a>.</p>`)
}

export function resendPage(ctx: Context, state: FormState & { done?: boolean } = {}): Html {
  if (state.done) {
    return page(ctx, { title: 'Check your inbox' }, html`<h1>Check your inbox</h1>
${notice('If an account with that email address still needs confirming, we\'ve sent it a new link.', 'ok')}
<p><a href="/login">Back to sign in</a></p>`)
  }
  return page(ctx, { title: 'Resend confirmation', turnstile: true }, html`<h1>Get a new confirmation link</h1>
${errorSummary([state.errors?.form, state.errors?.email])}
<form method="post" action="/resend-verification">
  ${input({ label: 'Email address', name: 'email', type: 'email', value: state.values?.email, autocomplete: 'email', maxlength: 254, error: state.errors?.email })}
  ${turnstileWidget(ctx, 'resend')}
  ${hidden('return_to', state.returnTo)}
  <div class="actions"><button type="submit">Send link</button></div>
</form>`)
}

export function forgotPage(ctx: Context, state: FormState & { done?: boolean } = {}): Html {
  if (state.done) {
    return page(ctx, { title: 'Check your inbox' }, html`<h1>Check your inbox</h1>
${notice('If there is an account with that email address, we\'ve sent it a link to choose a new password. The link expires in 1 hour.', 'ok')}
<p><a href="/login">Back to sign in</a></p>`)
  }
  return page(ctx, { title: 'Forgot your password', turnstile: true }, html`<h1>Forgot your password?</h1>
<p>Enter your email address and we'll send you a link to choose a new password. This also works if you've only signed in with Google so far.</p>
${errorSummary([state.errors?.form, state.errors?.email])}
<form method="post" action="/forgot-password">
  ${input({ label: 'Email address', name: 'email', type: 'email', value: state.values?.email, autocomplete: 'email', maxlength: 254, error: state.errors?.email })}
  ${turnstileWidget(ctx, 'forgot')}
  <div class="actions"><button type="submit">Send link</button></div>
</form>`)
}

export function resetPage(ctx: Context, token: string, email: string, error: string | null = null): Html {
  return page(ctx, { title: 'Choose a new password' }, html`<h1>Choose a new password</h1>
${errorSummary([error])}
<p>For <strong>${email}</strong>. Choosing a new password signs you out everywhere else.</p>
<form method="post" action="/reset-password">
  ${hidden('token', token)}
  <input type="text" name="username" value="${email}" autocomplete="username" hidden>
  ${input({ label: 'New password', name: 'password', type: 'password', autocomplete: 'new-password', minlength: PASSWORD_MIN, maxlength: PASSWORD_MAX, hint: `At least ${PASSWORD_MIN} characters.`, error })}
  <div class="actions"><button type="submit">Save password</button></div>
</form>`)
}

export function signedOutPage(ctx: Context): Html {
  return page(ctx, { title: 'Signed out', user: null }, html`<h1>You're signed out</h1>
<p><a href="/login">Sign in again</a> or <a href="${apexUrl(ctx)}">see all apps</a>.</p>`)
}

export const MAIL_FAILED = 'We couldn\'t send the email right now. Please try again in a few minutes.'
export const TURNSTILE_FAILED = 'Please complete the security check and try again.'
export const RATE_LIMITED = 'Too many attempts. Please wait a minute and try again.'
