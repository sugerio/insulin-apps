// Error and status pages, and the step that follows a successful form POST.
import type { Context } from '../context.ts'
import { apexUrl, authUrl, ownOrigin } from '../context.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { html, type Html } from './html.ts'
import { page } from './layout.ts'

export function messagePage(ctx: Context, status: number, title: string, body: Html, options: { user?: { name: string } | null } = {}): Response {
  return htmlResponse(page(ctx, { title, user: options.user }, html`<h1>${title}</h1>
${body}`), { status })
}

export function notFoundPage(ctx: Context): Response {
  const body = ctx.site === 'other'
    ? html`<p>There's no app at this address.</p><p><a href="${apexUrl(ctx)}">See all apps</a></p>`
    : html`<p>We couldn't find that page.</p><p><a href="${apexUrl(ctx)}">See all apps</a></p>`
  return messagePage(ctx, 404, 'Page not found', body)
}

export function methodNotAllowed(ctx: Context, allow: string[]): Response {
  const response = messagePage(ctx, 405, 'Not allowed', html`<p>This address doesn't accept that kind of request.</p>`)
  response.headers.set('Allow', allow.join(', '))
  return response
}

export function forbiddenPage(ctx: Context): Response {
  return messagePage(ctx, 403, 'Request blocked', html`<p>This request didn't come from this site's own pages, so it was blocked. Go back, reload the page and try again.</p>`)
}

export function rateLimitedPage(ctx: Context): Response {
  const response = messagePage(ctx, 429, 'Too many attempts', html`<p>Please wait a minute, then try again.</p>`)
  response.headers.set('Retry-After', '60')
  return response
}

export function badRequestPage(ctx: Context, status: 400 | 413 | 415, text: string): Response {
  return messagePage(ctx, status, 'Something is wrong with that request', html`<p>${text}</p>`)
}

/** Shown without any configuration: every host answers 503 and redirects nowhere. */
export function notConfiguredResponse(): Response {
  const body = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not configured · Insulin Apps</title>
<link rel="stylesheet" href="/__insulin/gateway.css">
<link rel="icon" href="data:,">
</head>
<body>
<main id="main">
<h1>This service is not configured yet</h1>
<p>Please come back later.</p>
</main>
</body>
</html>
`
  return htmlResponse(body, { status: 503, headers: { 'Retry-After': '300' } })
}

/**
 * Where a successful form POST goes next. Same-origin targets get a 303. A target on another of the site's hosts gets
 * a short page that continues with a meta refresh and a link: the CSP's `form-action 'self'` makes browsers block a
 * cross-origin redirect that follows a form submission.
 */
export function afterPost(ctx: Context, target: string): Response {
  if (new URL(target).origin === ownOrigin(ctx)) return redirect(target, 303)
  return htmlResponse(page(ctx, { title: 'Continue', refreshTo: target }, html`<h1>Continue</h1>
<p><a href="${target}">Continue to ${describe(ctx, target)}</a></p>`))
}

function describe(ctx: Context, target: string): string {
  const host = new URL(target).hostname
  const app = ctx.config.appsByHost.get(host)
  if (app) return app.title
  if (host === ctx.config.domain) return 'Insulin Apps'
  return 'your account'
}

/** The auth home page, the default destination. */
export function home(ctx: Context): string {
  return authUrl(ctx, '/')
}
