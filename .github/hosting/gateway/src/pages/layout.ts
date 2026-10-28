// The page shell and form helpers shared by every server-rendered page. No inline scripts or styles: one stylesheet,
// and Cloudflare's Turnstile script on the forms that need it.
import type { Context } from '../context.ts'
import { apexUrl, authUrl, withReturnTo } from '../context.ts'
import type { TurnstileAction } from '../turnstile.ts'
import { html, type Html, EMPTY } from './html.ts'

export interface PageOptions {
  title: string
  /** Who is signed in, for the header; omit on pages that must not depend on the session. */
  user?: { name: string } | null
  /** Load the Turnstile widget script. */
  turnstile?: boolean
  /** Continue to this URL at once (a meta refresh; the page also links to it). */
  refreshTo?: string
}

const SITE_NAME = 'Insulin Apps'

function accountNav(ctx: Context, user: { name: string } | null | undefined): Html {
  if (user === undefined) return EMPTY
  if (user) {
    // Sign-out posts to the page's own host, so the Origin check and the CSP form-action both allow it.
    const action = ctx.site === 'auth' ? '/logout' : '/__insulin/logout'
    return html`<nav class="account" aria-label="Account">
  <span class="muted">Signed in as ${user.name}</span>
  <a href="${authUrl(ctx, '/')}">Your organizations</a>
  <a href="${authUrl(ctx, '/account')}">Account</a>
  <form method="post" action="${action}"><button type="submit" class="link">Sign out</button></form>
</nav>`
  }
  const back = ctx.site === 'apex' ? apexUrl(ctx) : null
  return html`<nav class="account" aria-label="Account">
  <a href="${authUrl(ctx, withReturnTo('/login', back))}">Sign in</a>
  <a href="${authUrl(ctx, withReturnTo('/signup', back))}">Create an account</a>
</nav>`
}

export function contactLink(ctx: Context): Html {
  if (ctx.config.supportEmail) return html`<a href="mailto:${ctx.config.supportEmail}">${ctx.config.supportEmail}</a>`
  if (ctx.config.issuesUrl) return html`<a href="${ctx.config.issuesUrl}">the project's GitHub issues</a>`
  return html`the project's public repository`
}

export function page(ctx: Context, options: PageOptions, content: Html): Html {
  const turnstile = options.turnstile
    ? html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : EMPTY
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title} · ${SITE_NAME}</title>
${options.refreshTo ? html`<meta http-equiv="refresh" content="0; url=${options.refreshTo}">` : EMPTY}
<link rel="stylesheet" href="/__insulin/gateway.css">
<link rel="icon" href="data:,">
${turnstile}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site">
  <a class="brand" href="${apexUrl(ctx)}">Insulin Apps</a>
  ${accountNav(ctx, options.user)}
</header>
<main id="main">
${content}
</main>
<footer class="site">
  <p><a href="${apexUrl(ctx, '/privacy')}">Privacy notice</a> · <a href="${apexUrl(ctx, '/terms')}">Terms of use</a> · <a href="${apexUrl(ctx)}">All apps</a></p>
</footer>
</body>
</html>
`
}

export interface InputOptions {
  label: string
  name: string
  type?: 'text' | 'email' | 'password'
  value?: string
  autocomplete?: string
  required?: boolean
  hint?: string
  error?: string | null
  minlength?: number
  maxlength?: number
  readonly?: boolean
}

/** A labelled input; its hint and error are tied to it with aria-describedby, and an error sets aria-invalid. */
export function input(options: InputOptions): Html {
  const id = `field-${options.name}`
  const described = [options.hint ? `${id}-hint` : '', options.error ? `${id}-error` : ''].filter(Boolean).join(' ')
  return html`<label for="${id}">${options.label}</label>
${options.hint ? html`<span class="hint" id="${id}-hint">${options.hint}</span>` : EMPTY}
<input id="${id}" name="${options.name}" type="${options.type ?? 'text'}"${options.value ? html` value="${options.value}"` : EMPTY}${options.autocomplete ? html` autocomplete="${options.autocomplete}"` : EMPTY}${options.required === false ? EMPTY : html` required`}${options.minlength ? html` minlength="${options.minlength}"` : EMPTY}${options.maxlength ? html` maxlength="${options.maxlength}"` : EMPTY}${options.readonly ? html` readonly` : EMPTY}${described ? html` aria-describedby="${described}"` : EMPTY}${options.error ? html` aria-invalid="true"` : EMPTY}>
${options.error ? html`<p class="field-error" id="${id}-error">${options.error}</p>` : EMPTY}`
}

export function select(options: { label: string; name: string; choices: { value: string; label: string }[]; selected?: string; id?: string; hint?: string }): Html {
  const id = options.id ?? `field-${options.name}`
  return html`<label for="${id}">${options.label}</label>
${options.hint ? html`<span class="hint" id="${id}-hint">${options.hint}</span>` : EMPTY}
<select id="${id}" name="${options.name}"${options.hint ? html` aria-describedby="${id}-hint"` : EMPTY}>
${options.choices.map((choice) => html`<option value="${choice.value}"${choice.value === options.selected ? html` selected` : EMPTY}>${choice.label}</option>`)}
</select>`
}

export function hidden(name: string, value: string | null | undefined): Html {
  return value ? html`<input type="hidden" name="${name}" value="${value}">` : EMPTY
}

/** Problems with a submitted form, announced by screen readers and focused on load. */
export function errorSummary(errors: (string | null | undefined)[]): Html {
  const list = errors.filter((error): error is string => Boolean(error))
  if (!list.length) return html`<div class="live" aria-live="polite"></div>`
  return html`<div class="errors" role="alert" aria-live="assertive" tabindex="-1" autofocus>
  <p><strong>${list.length === 1 ? 'There is a problem' : 'There are problems'}</strong></p>
  <ul>${list.map((error) => html`<li>${error}</li>`)}</ul>
</div>`
}

export function notice(text: Html | string, kind: 'info' | 'ok' = 'info'): Html {
  return html`<div class="notice${kind === 'ok' ? ' ok' : ''}" role="status">${text}</div>`
}

export function turnstileWidget(ctx: Context, action: TurnstileAction): Html {
  return html`<div class="cf-turnstile" data-sitekey="${ctx.config.turnstile.siteKey}" data-action="${action}" data-theme="auto" data-size="flexible"></div>`
}

/** A one-button POST form. */
export function postButton(action: string, label: string, fields: Record<string, string> = {}, variant: 'primary' | 'secondary' | 'danger' | 'link' = 'secondary'): Html {
  return html`<form method="post" action="${action}" class="inline">
${Object.entries(fields).map(([name, value]) => hidden(name, value))}
<button type="submit" class="${variant}">${label}</button>
</form>`
}
