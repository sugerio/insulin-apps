// Cloudflare Turnstile, checked on the server with the secret key and the client's IP.
import type { Context } from './context.ts'
import { log } from './log.ts'

export const TURNSTILE_FIELD = 'cf-turnstile-response'

/** Each form's widget carries its own action, and its token is accepted for that form only. */
export type TurnstileAction = 'signup' | 'login' | 'resend' | 'forgot'
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

// Cloudflare's published dummy secrets and the token its dummy site keys produce. In SITE_ENV=test they are answered
// here, exactly as siteverify answers them, so local development needs no network access. Production never takes
// this path: testMode is false there, and real secrets are never on this list.
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
const DUMMY_SECRETS: Record<string, boolean> = {
  '1x0000000000000000000000000000000AA': true,
  '2x0000000000000000000000000000000AA': false,
  '3x0000000000000000000000000000000AA': false,
}

interface SiteverifyResult {
  success?: unknown
  hostname?: unknown
  action?: unknown
  'error-codes'?: unknown
}

/**
 * True when the widget's token is valid for this form: `success`, the exact `action` the form's widget carries, and
 * outside SITE_ENV=test, issued for the auth host.
 */
export async function verifyTurnstile(ctx: Context, token: string, action: TurnstileAction): Promise<boolean> {
  if (!token || token.length > 2048) return false
  const { secretKey } = ctx.config.turnstile
  if (ctx.config.testMode && secretKey in DUMMY_SECRETS) return DUMMY_SECRETS[secretKey] === true && token === DUMMY_TOKEN

  const body = new URLSearchParams({ secret: secretKey, response: token })
  if (ctx.clientIp) body.set('remoteip', ctx.clientIp)
  let result: SiteverifyResult
  try {
    const response = await fetch(SITEVERIFY, { method: 'POST', body, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) {
      log('turnstile_unavailable', { status: response.status })
      return false
    }
    result = await response.json<SiteverifyResult>()
  } catch {
    log('turnstile_unavailable', { status: null })
    return false
  }
  if (result.success !== true) {
    const codes = Array.isArray(result['error-codes'])
      ? result['error-codes'].filter((code): code is string => typeof code === 'string' && /^[a-z0-9-]{1,40}$/.test(code))
      : []
    log('turnstile_rejected', { codes: codes.join(',').slice(0, 200) })
    return false
  }
  if (result.action !== action) {
    log('turnstile_wrong_action', { expected: action })
    return false
  }
  if (!ctx.config.testMode && result.hostname !== ctx.config.authHost) {
    log('turnstile_wrong_hostname')
    return false
  }
  return true
}
