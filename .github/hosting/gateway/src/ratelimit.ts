// Cloudflare rate limit bindings. RL_AUTH counts per IP and per e-mail (hashed) for each auth action; RL_APP counts
// per user on proxied app requests. The limit and period come from the bindings' configuration.
import type { Context } from './context.ts'
import { sha256Hex } from './crypto.ts'
import { log, logError } from './log.ts'

export type AuthAction = 'signup' | 'login' | 'resend' | 'forgot' | 'reset' | 'verify' | 'google' | 'password'

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
