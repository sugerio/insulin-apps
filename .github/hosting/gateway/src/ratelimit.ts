// Cloudflare rate limit bindings. RL_AUTH counts per IP and per e-mail (hashed) for each auth action; RL_APP counts
// per user on proxied app requests, and per IP on public paths; RL_PUBLIC counts, per app and IP, the requests to public
// paths that change something. The limit and period come from the bindings' configuration.
import type { Context } from './context.ts'
import { sha256Hex } from './crypto.ts'
import { log, logError } from './log.ts'

export type AuthAction = 'signup' | 'login' | 'resend' | 'forgot' | 'reset' | 'verify' | 'google' | 'password' | 'mfa' | 'sso' | 'org_request'

/**
 * True while the action is within its limits for this IP (and e-mail address or user, when given). Fails closed: if
 * the rate limiter itself errors, the attempt is refused.
 */
export async function allowAuth(ctx: Context, action: AuthAction, subject?: string): Promise<boolean> {
  const keys = [`${action}:ip:${ctx.clientIp ?? 'unknown'}`]
  if (subject) keys.push(`${action}:sub:${await sha256Hex(subject)}`)
  for (const key of keys) {
    try {
      const { success } = await ctx.config.rlAuth.limit({ key })
      if (!success) {
        log('rate_limited', { action, scope: key.includes(':ip:') ? 'ip' : 'subject' })
        return false
      }
    } catch (error) {
      logError('rate_limit_failed', error, { action })
      return false
    }
  }
  return true
}

/**
 * True while `key` is within RL_AUTH's limit: the OAuth endpoints, keyed per IP (registration) or per client (tokens).
 * Fails closed, as allowAuth does.
 */
export async function allowOAuth(ctx: Context, key: string): Promise<boolean> {
  try {
    const { success } = await ctx.config.rlAuth.limit({ key: `oauth:${key}` })
    if (!success) log('rate_limited', { action: 'oauth', scope: key.split(':')[0] })
    return success
  } catch (error) {
    logError('rate_limit_failed', error, { action: 'oauth' })
    return false
  }
}

/**
 * True while an app is within RL_AUTH's limit for the mail relay (DESIGN.md §8.2), counted per organization so one
 * organization's mail can't hold up another's. Fails closed, as allowAuth does.
 */
export async function allowAppMail(ctx: Context, app: string, orgId: string): Promise<boolean> {
  try {
    const { success } = await ctx.config.rlAuth.limit({ key: `app-mail:${app}:${orgId}` })
    if (!success) log('rate_limited', { action: 'app_mail', app })
    return success
  } catch (error) {
    logError('rate_limit_failed', error, { action: 'app_mail' })
    return false
  }
}

/**
 * True while this IP is within the app request limit for public paths (DESIGN.md §8.1). Fails open, as allowApp does.
 */
export async function allowPublic(ctx: Context): Promise<boolean> {
  try {
    const { success } = await ctx.config.rlApp.limit({ key: `public:${ctx.clientIp ?? 'unknown'}` })
    if (!success) log('rate_limited', { action: 'public' })
    return success
  } catch (error) {
    logError('rate_limit_failed', error, { action: 'public' })
    return true
  }
}

/**
 * True while this IP is within the stricter limit for requests to the app's public paths that aren't GET or HEAD
 * (DESIGN.md §8.1): code exchanges, code sends and code checks, say. Counted on top of `allowPublic`. Fails open, as
 * allowPublic does: the app keeps its own limits on what these requests reach.
 */
export async function allowPublicChange(ctx: Context, app: string): Promise<boolean> {
  try {
    const { success } = await ctx.config.rlPublic.limit({ key: `public-post:${app}:${ctx.clientIp ?? 'unknown'}` })
    if (!success) log('rate_limited', { action: 'public_post', app })
    return success
  } catch (error) {
    logError('rate_limit_failed', error, { action: 'public_post' })
    return true
  }
}

/**
 * True while the user is within the app request limit. Fails open: this is abuse protection for the apps, and an
 * outage of the limiter should not take every app down.
 */
export async function allowApp(ctx: Context, userId: string): Promise<boolean> {
  try {
    const { success } = await ctx.config.rlApp.limit({ key: `app:user:${userId}` })
    if (!success) log('rate_limited', { action: 'app', user: userId })
    return success
  } catch (error) {
    logError('rate_limit_failed', error, { action: 'app' })
    return true
  }
}
